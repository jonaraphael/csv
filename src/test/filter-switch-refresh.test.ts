import assert from 'assert';
import { describe, it } from 'node:test';
import { createEditorHarness, createWebviewDom, flushViewCommits } from './edit-integrity-harness';

describe('filter refresh coalesced with a view switch', () => {
  it('applies cleared filters to the DOM before resolving a pending draft commit', async () => {
    const host = await createEditorHarness({ rows: [['name'], ['one'], ['two']],
      filters: [{ column: 0, operator: 'equals', value: 'one' }] });
    const view = createWebviewDom(host.panel.webview.html);
    try {
      assert.strictEqual(view.window.document.getElementById('csv-root').dataset.filtered, '1');
      const pending = host.commitPendingDraft();
      await host.receive({ type: 'clearAllFilters' });
      await flushViewCommits(host, view);
      assert.strictEqual(await pending, true);
      const refreshed = createWebviewDom(host.panel.webview.html);
      try {
        assert.strictEqual(refreshed.window.document.getElementById('csv-root').dataset.filtered, '0');
        assert.strictEqual(refreshed.cell(2, 0).textContent, 'two');
      } finally { refreshed.close(); }
    } finally { view.close(); host.dispose(); }
  });
});
