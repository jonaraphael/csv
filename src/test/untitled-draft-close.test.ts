import assert from 'assert';
import { describe, it } from 'node:test';
import { createEditorHarness, createWebviewDom, flushViewCommits } from './edit-integrity-harness';

describe('untitled grid closes after its final active draft commits', () => {
  for (const separator of [',', '\t']) {
    it(`preserves the active multiline draft when disabled (${JSON.stringify(separator)})`, async () => {
      const host = await createEditorHarness({ separator, untitled: true });
      const view = createWebviewDom(host.panel.webview.html);
      try {
        view.start(view.cell());
        view.key('Enter', { shiftKey: true });
        view.type('latest draft');
        host.deferEdits();
        host.revealSourceAfterCommit();
        const request = host.messages.find(message => message.type === 'prepareViewRefresh');
        assert.ok(request);
        assert.strictEqual(host.panel.disposed, false);
        view.window.dispatchEvent(new view.window.MessageEvent('message', { data: request }));
        const operations = view.messages.filter(message => message.type === 'editCell' || message.type === 'viewRefreshReady');
        assert.deepStrictEqual(operations.map(message => message.type), ['editCell', 'viewRefreshReady']);
        const pending = operations.map(message => host.receive(message));
        await new Promise(resolve => setImmediate(resolve));
        assert.strictEqual(host.pendingEdits, 1);
        assert.strictEqual(host.panel.disposed, false);
        assert.strictEqual(host.sourceReveals.length, 0);
        host.releaseEdit();
        await Promise.all(pending);
        assert.strictEqual(host.rows()[1][0], 'one\nlatest draft');
        assert.strictEqual(host.sourceReveals[0], host.document.getText());
        assert.strictEqual(host.panel.disposed, true);
      } finally {
        view.close();
      }
    });
  }
  it('closes an unsupported-language table after a fresh draft ACK while CSV remains enabled', async () => {
    const host = await createEditorHarness({ untitled: true });
    const view = createWebviewDom(host.panel.webview.html);
    try {
      view.start(view.cell());
      view.cell().textContent = 'language change draft';
      host.rebindDocument('plaintext');
      host.activeController!.revealSourceAfterCommit('language');
      await flushViewCommits(host, view);
      assert.strictEqual(host.rows()[1][0], 'language change draft');
      assert.strictEqual(host.panel.disposed, true);
      assert.strictEqual(host.sourceReveals.at(-1), host.document.getText());
      assert.strictEqual(host.diskText.includes('language change draft'), false);
    } finally { view.close(); host.dispose(); }
  });

});
