import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { describe, it } from 'node:test';
import { createEditorHarness, createWebviewDom } from './edit-integrity-harness';
const { CsvEditorProvider } = require('../CsvEditorProvider') as typeof import('../CsvEditorProvider');

describe('Default hidden rows', () => {
  it('inherits resource-specific defaults while explicit per-file zero wins until reset', async () => {
    const host = await createEditorHarness({ defaultIgnoreRows: 1 });
    const uri = host.document.uri as any;
    assert.strictEqual(CsvEditorProvider.getHiddenRowsForUri(host.context as any, uri), 1);
    assert.ok(host.configurationRequests.includes(uri));
    const other = { toString: () => 'file:///other.csv' } as any;
    host.resourceDefaults[other.toString()] = 3;
    assert.strictEqual(CsvEditorProvider.getHiddenRowsForUri(host.context as any, other), 3);
    await CsvEditorProvider.setHiddenRowsForUri(host.context as any, uri, 0);
    host.defaultIgnoreRows = 2;
    assert.strictEqual(CsvEditorProvider.getHiddenRowsForUri(host.context as any, uri), 0);
    await CsvEditorProvider.setHiddenRowsForUri(host.context as any, uri, 4);
    assert.strictEqual(CsvEditorProvider.getHiddenRowsForUri(host.context as any, uri), 4);
    await CsvEditorProvider.setHiddenRowsForUri(host.context as any, uri, undefined);
    assert.strictEqual(CsvEditorProvider.getHiddenRowsForUri(host.context as any, uri), 2);
    assert.strictEqual(CsvEditorProvider.getHiddenRowsForUri(host.context as any, other), 3);
  });

  it('hides inherited metadata from the view while preserving source rows and frozen-row identities', async () => {
    const rows = [['metadata', 'preserve'], ['Name', 'Value'], ['one', 'two']];
    const host = await createEditorHarness({ rows, defaultIgnoreRows: 1, frozenRows: 2 });
    const view = createWebviewDom(host.panel.webview.html);
    try {
      assert.strictEqual(view.cell(0, 0), null);
      assert.strictEqual(view.cell(1, 0).tagName, 'TH');
      assert.strictEqual(view.cell(2, 0).textContent, 'one');
      view.window.csvFrozenPanes.layout();
      assert.ok(view.cell(1, 0).classList.contains('csv-frozen-row'));
      assert.ok(view.cell(2, 0).classList.contains('csv-frozen-row'));
      assert.deepStrictEqual(host.rows(), rows);
    } finally { view.close(); }
  });

  it('commits an active multiline draft before refreshing an inherited default', async () => {
    const host = await createEditorHarness({ rows: [['metadata', 'keep'], ['Name', 'Value'], ['one', 'two'], ['three', 'four']], defaultIgnoreRows: 1 });
    const view = createWebviewDom(host.panel.webview.html);
    try {
      const cell = view.cell(2, 0);
      view.start(cell);
      cell.textContent = 'unsaved\nmultiline draft';
      host.defaultIgnoreRows = 2;
      CsvEditorProvider.currentActive!.refreshViewSafely();
      const prepare = host.messages.slice().reverse().find((message: any) => message.type === 'prepareViewRefresh');
      assert.ok(prepare);
      view.window.dispatchEvent(new view.window.MessageEvent('message', { data: prepare }));
      const messages = view.messages.filter((message: any) => ['editCell', 'viewRefreshReady'].includes(message.type));
      assert.deepStrictEqual(messages.map((message: any) => message.type), ['editCell', 'viewRefreshReady']);
      for (const message of messages) { await host.receive(message); }
      assert.strictEqual(host.rows()[2][0], 'unsaved\nmultiline draft');
      assert.deepStrictEqual(host.rows()[0], ['metadata', 'keep']);
      assert.ok(host.panel.webview.html.includes('data-firstrow="2"'));
      assert.ok(host.panel.webview.html.includes('unsaved'));
    } finally { view.close(); }
  });

  it('declares one resource-scoped integer setting and documents explicit zero/inherit reset', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
    const setting = manifest.contributes.configuration.properties['csv.defaultIgnoreRows'];
    assert.strictEqual(setting.type, 'integer');
    assert.strictEqual(setting.default, 0);
    assert.strictEqual(setting.minimum, 0);
    assert.strictEqual(setting.scope, 'resource');
    const readme = fs.readFileSync(path.join(process.cwd(), 'README.md'), 'utf8');
    assert.ok(readme.includes('csv.defaultIgnoreRows'));
    assert.ok(readme.includes('blank'));
    assert.ok(readme.includes('explicit `0`'));
  });
});
