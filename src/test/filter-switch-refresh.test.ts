import assert from 'assert';
import { describe, it } from 'node:test';
import { createEditorHarness, createWebviewDom, flushViewCommits } from './edit-integrity-harness';

describe('inline filter refresh with a view switch', () => {
  it('applies an accepted inline Clear all before resolving a pending draft commit and reopening', async () => {
    const host = await createEditorHarness({ rows: [['name'], ['one'], ['two']],
      filters: [{ column: 0, operator: 'equals', value: 'one' }] });
    const view = createWebviewDom(host.panel.webview.html);
    try {
      const document = view.window.document;
      const table = document.querySelector('table');
      const originalHtml = host.panel.webview.html;
      const originalSource = host.document.getText();
      assert.strictEqual(document.getElementById('csv-root').dataset.filtered, '1');
      assert.strictEqual(view.cell(2, 0), null);
      const start = view.messages.length;
      document.getElementById('clearAllFilters').click();
      await new Promise(resolve => setTimeout(resolve, 140));
      const outgoing = view.messages.slice(start);
      const request = outgoing.find(message => message.type === 'updateColumnFilters');
      assert.ok(request, 'the inline Clear all control submits a current empty snapshot');
      assert.strictEqual(request.filters.length, 0);
      await Promise.all(outgoing.map(message => host.receive(message)));
      const result = host.messages.find(message => message.type === 'columnFiltersResult' && message.revision === request.revision);
      assert.ok(result && !result.error && !result.errors?.length);

      let finished = false;
      const pending = host.commitPendingDraft().then(success => { finished = true; return success; });
      view.window.dispatchEvent(new view.window.MessageEvent('message', { data: result }));
      assert.strictEqual(document.querySelector('table'), table, 'live filtering preserves the delegated table');
      assert.strictEqual(document.getElementById('csv-root').dataset.filtered, '0');
      assert.strictEqual(view.cell(2, 0).textContent, 'two');
      assert.strictEqual(document.getElementById('filterStatus').hidden, true);
      assert.strictEqual(finished, false, 'the source-view commit still waits for its real webview acknowledgment');
      await flushViewCommits(host, view);
      assert.strictEqual(await pending, true);
      assert.strictEqual(host.panel.webview.html, originalHtml, 'the live clear and draft-only commit do not replace the webview');
      assert.strictEqual(host.document.getText(), originalSource);
      assert.strictEqual(host.diskText, originalSource);
      assert.strictEqual(host.document.version, 1);

      await host.view(false, false);
      await host.view(true, true);
      const reopened = createWebviewDom(host.panel.webview.html);
      try {
        assert.strictEqual(reopened.window.document.getElementById('csv-root').dataset.filtered, '0');
        assert.strictEqual(reopened.cell(2, 0).textContent, 'two');
      } finally { reopened.close(); }
    } finally { view.close(); host.dispose(); }
  });
});
