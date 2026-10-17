import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { describe, it } from 'node:test';
import { createEditorHarness } from './edit-integrity-harness';
import iconv from 'iconv-lite';

describe('Explicit source decoding preserves original non-UTF8 characters', () => {
  const original = fs.readFileSync(path.join(process.cwd(), 'src', 'test', 'fixtures', 'issue-76-products.csv'));
  const decoded = iconv.decode(original, 'cp437');

  it('keeps the reporter fixture byte-for-byte and establishes the supported decoding ambiguity', () => {
    assert.strictEqual(original.length, 4052);
    assert.ok(original.toString('utf8').includes('\uFFFD'));
    assert.ok(!decoded.includes('\uFFFD'));
    assert.strictEqual(iconv.decode(original, 'cp850'), decoded);
    assert.deepStrictEqual(iconv.encode(decoded, 'cp437'), original);
    for (const name of ['Knäckebröd', 'Thüringer', 'Guaraná', 'Nuß']) {
      assert.ok(decoded.includes(name));
    }
  });

  it('renders and edits the correctly decoded document without changing accented names', async () => {
    const host = await createEditorHarness({ text: decoded });
    assert.strictEqual(host.warnings.length, 0);
    assert.ok(host.panel.webview.html.includes('Knäckebröd'));
    const row = host.rows().findIndex(record => record[1]?.includes('Knäckebröd'));
    await host.receive({ type: 'editCell', row, col: 5, value: '22.00' });
    await host.receive({ type: 'save' });
    const saved = iconv.decode(iconv.encode(host.diskText, 'cp437'), 'cp437');
    for (const name of ['Knäckebröd', 'Thüringer', 'Guaraná', 'Nuß']) {
      assert.ok(saved.includes(name));
    }
  });
});

describe('Possible decoding mismatches use an explicit encoding workflow', () => {
  it('warns once without changing already decoded data when dismissed', async () => {
    const host = await createEditorHarness({ rows: [['text'], ['replacement � may be intentional']] });
    const originalText = host.document.getText();
    assert.strictEqual(host.warnings.length, 1);
    assert.match(host.warnings[0], /can indicate a decoding mismatch/);
    await host.view(false, false);
    await host.view(true, true);
    assert.strictEqual(host.warnings.length, 1);
    assert.strictEqual(host.executedCommands.length, 0);
    assert.strictEqual(host.document.getText(), originalText);
  });

  it('binds the warning action to the originating document URI', async () => {
    const host = await createEditorHarness({ rows: [['text'], ['�']], warningChoice: 'Change File Encoding' });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepStrictEqual(host.executedCommands, [{ name: 'csv.changeEncoding', args: [host.document.uri] }]);
  });

  it('does not act on a warning from a disposed editor', async () => {
    let choose!: (value: string) => void;
    const choice = new Promise<string>(resolve => { choose = resolve; });
    const host = await createEditorHarness({ rows: [['text'], ['�']], warningChoice: choice });
    host.dispose();
    choose('Change File Encoding');
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(host.executedCommands.length, 0);
  });

  it('handles a rejected warning action without an unhandled promise rejection', async () => {
    let choose!: (value: string) => void;
    const choice = new Promise<string>(resolve => { choose = resolve; });
    const host = await createEditorHarness({ rows: [['text'], ['�']], warningChoice: choice });
    host.commandError = new Error('test command rejection');
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    try {
      choose('Change File Encoding');
      await new Promise(resolve => setImmediate(resolve));
      assert.strictEqual(warnings[0]?.[0], 'CSV: Encoding warning action failed');
    } finally {
      console.warn = originalWarn;
    }
  });

  it('stops the encoding command when the user cancels closing a dirty document', async () => {
    const host = await createEditorHarness();
    await host.receive({ type: 'editCell', row: 1, col: 0, value: 'unsaved' });
    host.closeResult = false;
    host.registerCommands();
    await host.commands.get('csv.changeEncoding')?.();
    assert.strictEqual(host.executedCommands.length, 0);
    assert.strictEqual(host.rows()[1][0], 'unsaved');
    assert.ok(!host.diskText.includes('unsaved'));
  });

  it('opens the native encoding picker and returns to the CSV view after a successful close', async () => {
    const host = await createEditorHarness();
    host.registerCommands();
    await host.commands.get('csv.changeEncoding')?.(host.document.uri);
    assert.deepStrictEqual(host.executedCommands.map(command => command.name), [
      'vscode.openWith', 'workbench.action.editor.changeEncoding', 'vscode.openWith'
    ]);
    assert.strictEqual(host.executedCommands[0].args[0], host.document.uri);
    assert.strictEqual(host.executedCommands[2].args[1], 'csv.editor');
  });

  it('waits for the native picker command to finish before reopening the CSV view', async () => {
    const host = await createEditorHarness();
    let complete!: () => void;
    host.commandWait = new Promise<void>(resolve => { complete = resolve; });
    host.registerCommands();
    const changing = host.commands.get('csv.changeEncoding')?.();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepStrictEqual(host.executedCommands.map(command => command.name), ['vscode.openWith', 'workbench.action.editor.changeEncoding']);
    complete();
    await changing;
    assert.strictEqual(host.executedCommands[2].name, 'vscode.openWith');
  });

  it('round-trips UTF-8 accented CSV and TSV without triggering a warning', async () => {
    for (const separator of [',', '\t']) {
      const host = await createEditorHarness({ separator, rows: [['name', 'value'], ['éäöüßøå', 'before']] });
      await host.receive({ type: 'editCell', row: 1, col: 1, value: 'after' });
      await host.receive({ type: 'save' });
      assert.strictEqual(host.warnings.length, 0);
      assert.strictEqual(host.rows()[1][0], 'éäöüßøå');
      assert.ok(Buffer.from(host.diskText, 'utf8').toString('utf8').includes('éäöüßøå'));
    }
  });
});
