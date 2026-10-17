import assert from 'assert';
import { describe, it } from 'node:test';
import { createEditorHarness, createWebviewDom } from './edit-integrity-harness';

describe('Integrated view refresh and save ordering', () => {
  it('saves an active draft before applying inline Clear all without dropping hidden records', async () => {
    const host = await createEditorHarness({
      rows: [['protocol', 'notes'], ['TCP', 'before'], ['UDP', 'hidden']],
      filters: [{ column: 0, operator: 'equals', value: 'TCP' }]
    });
    const view = createWebviewDom(host.panel.webview.html);
    try {
      const document = view.window.document;
      const table = document.querySelector('table');
      const originalHtml = host.panel.webview.html;
      assert.strictEqual(view.cell(2, 0), null, 'the UDP source record starts outside the filtered view');
      const start = view.messages.length;
      const cell = view.cell(1, 1);
      view.start(cell);
      cell.textContent = 'unsaved\nmultiline';
      host.deferEdits();
      view.key('s', { ctrlKey: true });
      const saveMessages = view.messages.slice(start);
      const operations = saveMessages.filter(message => ['editCell', 'save'].includes(message.type));
      assert.deepStrictEqual(operations.map(message => message.type), ['editCell', 'save']);
      const pending = saveMessages.map(message => host.receive(message));
      for (let attempt = 0; attempt < 10 && host.pendingEdits === 0; attempt++) {
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      assert.strictEqual(host.pendingEdits, 1);
      assert.ok(!host.diskText.includes('multiline'));

      const clearStart = view.messages.length;
      document.getElementById('clearAllFilters').click();
      await new Promise(resolve => setTimeout(resolve, 140));
      const clearMessages = view.messages.slice(clearStart);
      const request = clearMessages.find(message => message.type === 'updateColumnFilters');
      assert.ok(request && request.filters.length === 0);
      pending.push(...clearMessages.map(message => host.receive(message)));
      assert.ok(!host.messages.some(message => message.type === 'columnFiltersResult'), 'live filtering stays behind the pending source edit and save');
      assert.ok(!host.diskText.includes('multiline'));
      host.releaseEdit();
      await Promise.all(pending);
      const result = host.messages.find(message => message.type === 'columnFiltersResult' && message.revision === request.revision);
      assert.ok(result && !result.error && !result.errors?.length);
      view.window.dispatchEvent(new view.window.MessageEvent('message', { data: result }));

      assert.strictEqual(host.rows()[1][1], 'unsaved\nmultiline');
      assert.deepStrictEqual(host.rows()[2], ['UDP', 'hidden']);
      assert.ok(host.diskText.includes('unsaved\nmultiline'));
      assert.ok(host.diskText.includes('UDP,hidden'));
      assert.strictEqual(host.diskText, host.document.getText());
      assert.strictEqual(document.querySelector('table'), table, 'the accepted filter snapshot only replaces table children');
      assert.strictEqual(host.panel.webview.html, originalHtml, 'save and inline filtering keep the current webview');
      assert.strictEqual(view.cell(1, 1).textContent, 'unsaved\nmultiline');
      assert.strictEqual(view.cell(2, 0).textContent, 'UDP');
      assert.strictEqual(document.getElementById('csv-root').dataset.filtered, '0');
      assert.strictEqual(document.getElementById('filterStatus').hidden, true, 'the persistent filter region becomes hidden when conditions are cleared');
    } finally { view.close(); host.dispose(); }
  });

  it('does not suggest a file-decoding repair for newly typed untitled replacement characters', async () => {
    const host = await createEditorHarness({ untitled: true, rows: [['name'], ['literal �']] });
    assert.deepStrictEqual(host.warnings, []);
    host.dispose();
  });
});
