import assert from 'assert';
import { describe, it } from 'node:test';
import { createEditorHarness, createWebviewDom } from './edit-integrity-harness';

describe('Integrated view refresh and save ordering', () => {
  it('saves an active draft and completes a filter refresh without dropping hidden records', async () => {
    const host = await createEditorHarness({
      rows: [['protocol', 'notes'], ['TCP', 'before'], ['UDP', 'hidden']],
      filters: [{ column: 0, operator: 'equals', value: 'TCP' }]
    });
    const view = createWebviewDom(host.panel.webview.html);
    try {
      const cell = view.cell(1, 1);
      view.start(cell);
      cell.textContent = 'unsaved\nmultiline';
      await host.receive({ type: 'clearAllFilters' });
      const prepare = host.messages.find((message: any) => message.type === 'prepareViewRefresh');
      assert.ok(prepare && Number.isInteger(prepare.requestId));
      host.deferEdits();
      view.key('s', { ctrlKey: true });
      const operations = view.messages.filter((message: any) => ['editCell', 'save'].includes(message.type));
      assert.deepStrictEqual(operations.map((message: any) => message.type), ['editCell', 'save']);
      const pending = operations.map((message: any) => host.receive(message));
      for (let attempt = 0; attempt < 10 && host.pendingEdits === 0; attempt++) {
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      assert.strictEqual(host.pendingEdits, 1);
      assert.ok(!host.diskText.includes('multiline'));
      view.window.dispatchEvent(new view.window.MessageEvent('message', { data: prepare }));
      const ack = view.messages.find((message: any) => message.type === 'viewRefreshReady');
      pending.push(host.receive(ack));
      host.releaseEdit();
      await Promise.all(pending);
      assert.ok(host.diskText.includes('unsaved\nmultiline'));
      assert.ok(host.diskText.includes('UDP,hidden'));
      assert.ok(host.panel.webview.html.includes('UDP'), 'a coalesced save must also finish the requested filter refresh');
      assert.ok(!host.panel.webview.html.includes('id="filterStatus"'));
    } finally { view.close(); }
  });

  it('does not suggest a file-decoding repair for newly typed untitled replacement characters', async () => {
    const host = await createEditorHarness({ untitled: true, rows: [['name'], ['literal �']] });
    assert.deepStrictEqual(host.warnings, []);
    host.dispose();
  });
});
