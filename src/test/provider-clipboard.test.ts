import { TestExtensionUri } from './test-extension-uri';
import assert from 'assert';
import Module from 'module';
import Papa from 'papaparse';
import { describe, it } from 'node:test';

let writeClipboard: (text: string) => Promise<void>;
let readClipboard: () => Promise<string>;
let applyEdit: (edit: any) => Promise<boolean>;
const errors: string[] = [];
const originalRequire = Module.prototype.require;
Module.prototype.require = function (id: string) {
  if (id === 'vscode') {
    return {
      Uri: { file: (filePath: string) => ({ fsPath: filePath, toString: () => filePath }) },
      Range: class {},
      WorkspaceEdit: class { text = ''; replace(_uri: any, _range: any, text: string) { this.text = text; } },
      env: { clipboard: { writeText: (text: string) => writeClipboard(text), readText: () => readClipboard() } },
      window: { activeColorTheme: { kind: 1 }, showErrorMessage: (message: string) => errors.push(message) },
      ColorThemeKind: { Dark: 1 },
      commands: { executeCommand: async () => {} },
      workspace: {
        getConfiguration: () => ({ get: (key: string, fallback: any) => key === 'maxFileSizeMB' ? 0 : fallback }),
        onDidChangeTextDocument: () => ({ dispose() {} }),
        onWillSaveTextDocument: () => ({ dispose() {} }),
        applyEdit: (edit: any) => applyEdit(edit)
      }
    };
  }
  return originalRequire.apply(this, arguments as any);
};
import { CsvEditorProvider } from '../CsvEditorProvider';
Module.prototype.require = originalRequire;

async function createEditor(initial: string, extension = 'csv') {
  let text = initial;
  let version = 1;
  let receive: (message: any) => Promise<void> = async () => {};
  const clipboardWrites: string[] = [];
  const events: string[] = [];
  const messages: any[] = [];
  errors.length = 0;
  writeClipboard = async value => { clipboardWrites.push(value); events.push('write'); };
  readClipboard = async () => clipboardWrites[clipboardWrites.length - 1] || '';
  applyEdit = async edit => { events.push('edit'); text = edit.text; version++; return true; };
  const uri = { fsPath: `/test.${extension}`, toString: () => `file:///test.${extension}` };
  const document = {
    uri, getText: () => text, get version() { return version; },
    get lineCount() { return text.split('\n').length; }, lineAt: (index: number) => ({ text: text.split('\n')[index] })
  };
  const webview = {
    html: '', cspSource: 'test:', options: {}, asWebviewUri: (value: any) => value.toString(),
    postMessage: (message: any) => { messages.push(message); return Promise.resolve(true); },
    onDidReceiveMessage: (callback: any) => { receive = callback; }
  };
  const panel = { active: true, title: 'test', webview, onDidChangeViewState() {}, onDidDispose() {} };
  const context = { extensionPath: process.cwd(), extensionUri: new TestExtensionUri(), workspaceState: { get: (_key: string, fallback: any) => fallback } };
  await new CsvEditorProvider(context as any).resolveCustomTextEditor(document as any, panel as any, { isCancellationRequested: false } as any);
  return {
    receive: (message: any) => receive(message), clipboardWrites, events, messages,
    get text() { return text; }, mutate: () => { text = 'newer,value'; version++; }
  };
}

describe('Provider system clipboard integration', () => {
  it('writes an ordinary cell without CSV wrapper quotes and pastes it without changing source quoting', async () => {
    for (const extension of ['csv', 'tsv']) {
      const delimiter = extension === 'csv' ? ',' : '\t';
      const source = `name${delimiter}value\nhello world${delimiter}before`;
      const editor = await createEditor(source, extension);
      await editor.receive({ type: 'copyCells', matrix: [['hello world']], rowIds: [1], startRow: 1, startCol: 0, cut: false });
      assert.deepStrictEqual(editor.clipboardWrites, ['hello world']);
      assert.strictEqual(editor.text, source);
      await editor.receive({ type: 'pasteFromClipboard', anchorRow: 1, anchorCol: 1 });
      assert.strictEqual(editor.text, `name${delimiter}value\nhello world${delimiter}hello world`);
    }
  });

  it('writes a mixed column with plain neighbors unquoted and real blanks explicit', async () => {
    for (const extension of ['csv', 'tsv']) {
      const editor = await createEditor('Name,Other\nplain,1\n"with,comma",2\nlast,3', extension);
      await editor.receive({ type: 'copyCells', matrix: [['Name'], ['plain'], ['with,comma'], [''], ['last']], rowIds: [0, 1, 2, 3, 4], startCol: 0, cut: false });
      assert.deepStrictEqual(editor.clipboardWrites, ['Name\r\nplain\r\n"with,comma"\r\n""\r\nlast']);
      assert.strictEqual(editor.events.includes('edit'), false);
    }
  });

  it('writes quoted CSV/TSV to the system clipboard and round-trips paste through the document', async () => {
    for (const extension of ['csv', 'tsv']) {
      const delimiter = extension === 'csv' ? ',' : '\t';
      const editor = await createEditor(`old${delimiter}old\nold${delimiter}old`, extension);
      const matrix = [['literal,comma', 'line\nvalue'], ['"quote"', '']];
      await editor.receive({ type: 'copyCells', matrix, rowIds: [0, 1], startCol: 0, cut: false });
      assert.strictEqual(editor.clipboardWrites.length, 1);
      assert.deepStrictEqual(Papa.parse(editor.clipboardWrites[0], { delimiter }).data, matrix);
      assert.strictEqual(editor.text, `old${delimiter}old\nold${delimiter}old`);
      await editor.receive({ type: 'pasteFromClipboard', anchorRow: 0, anchorCol: 0 });
      assert.deepStrictEqual(Papa.parse(editor.text, { delimiter }).data, matrix);
      assert.strictEqual(editor.messages[editor.messages.length - 1].type, 'pasteApplied');
    }
  });

  it('clears cut cells in one batch only after the clipboard write succeeds', async () => {
    const editor = await createEditor('one,two\nthree,four');
    let finishWrite: () => void = () => {};
    let signalWriteStarted: () => void = () => {};
    const writeStarted = new Promise<void>(resolve => { signalWriteStarted = resolve; });
    writeClipboard = async () => {
      const pendingWrite = new Promise<void>(resolve => { finishWrite = resolve; });
      signalWriteStarted();
      await pendingWrite;
      editor.events.push('write');
    };
    const cut = editor.receive({ type: 'copyCells', matrix: [['one', 'two']], rowIds: [0], startCol: 0, cut: true });
    await writeStarted;
    assert.strictEqual(editor.text, 'one,two\nthree,four');
    finishWrite();
    await cut;
    assert.deepStrictEqual(editor.events, ['write', 'edit']);
    assert.deepStrictEqual(Papa.parse(editor.text).data, [['', ''], ['three', 'four']]);
  });

  it('keeps cut data when the clipboard write fails', async () => {
    const editor = await createEditor('one,two');
    writeClipboard = async () => { throw new Error('clipboard unavailable'); };
    await editor.receive({ type: 'copyCells', matrix: [['one']], rowIds: [0], startCol: 0, cut: true });
    assert.strictEqual(editor.text, 'one,two');
    assert.deepStrictEqual(editor.events, []);
    assert.strictEqual(errors.length, 1);
  });

  it('keeps newer document contents if a cut write completes after another edit', async () => {
    const editor = await createEditor('one,two');
    writeClipboard = async () => { editor.mutate(); };
    await editor.receive({ type: 'copyCells', matrix: [['one']], rowIds: [0], startCol: 0, cut: true });
    assert.strictEqual(editor.text, 'newer,value');
    assert.deepStrictEqual(editor.events, []);
  });
});
