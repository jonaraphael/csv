import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createEditorHarness, createWebviewDom, flushViewCommits } from './edit-integrity-harness';
const turn = () => new Promise(resolve => setImmediate(resolve));
function prepare(host: Awaited<ReturnType<typeof createEditorHarness>>, view: ReturnType<typeof createWebviewDom>) {
  const request = host.messages.filter(message => message.type === 'prepareViewRefresh').at(-1);
  assert.ok(request);
  const cursor = view.messages.length;
  view.window.dispatchEvent(new view.window.MessageEvent('message', { data: request }));
  return view.messages.slice(cursor);
}
describe('Saved CSV disable uses the existing draft commit before native handoff', () => {
  for (const separator of [',', '\t']) {
    it(`waits for the live multiline ${JSON.stringify(separator)} draft and hands off once without saving`, async () => {
      const host = await createEditorHarness({ separator }), view = createWebviewDom(host.panel.webview.html);
      try {
        view.start(view.cell()); view.key('Enter', { shiftKey: true }); view.type('disable draft');
        host.deferEdits(); host.setEnabled(false); host.refresh(); host.refresh();
        assert.strictEqual(host.panel.disposed, false); assert.deepStrictEqual(host.commands, []);
        const pending = prepare(host, view).map(message => host.receive(message));
        await turn(); assert.strictEqual(host.pendingEdits, 1); assert.deepStrictEqual(host.commands, []);
        host.releaseEdit(); await Promise.all(pending); await flushViewCommits(host, view); await turn();
        assert.strictEqual(host.rows()[1][0], 'one\ndisable draft');
        assert.ok(!host.diskText.includes('disable draft'));
        assert.strictEqual(host.panel.disposed, true);
        assert.deepStrictEqual(host.commands, [['vscode.openWith', host.document.uri, 'default', { viewColumn: 2, preserveFocus: false }]]);
      } finally { view.close(); host.dispose(); }
    });
  }
  for (const failure of ['false', 'throw'] as const) {
    it(`keeps the ${failure} draft on disable and completes handoff after a successful retry`, async () => {
      const host = await createEditorHarness(), view = createWebviewDom(host.panel.webview.html);
      try {
        view.start(view.cell()); view.type('failed draft'); host.failEdits(failure);
        host.setEnabled(false); host.refresh();
        await Promise.all(prepare(host, view).map(message => host.receive(message))); await turn();
        assert.strictEqual(host.panel.disposed, false); assert.strictEqual(host.rows()[1][0], 'one');
        assert.deepStrictEqual(host.commands, []); assert.ok(view.cell().textContent.includes('failed draft'));
        host.failEdits(undefined);
        const failed = host.messages.find(message => message.type === 'editCellFailed');
        view.window.dispatchEvent(new view.window.MessageEvent('message', { data: failed }));
        const cursor = view.messages.length; view.cell().blur();
        await Promise.all(view.messages.slice(cursor).map(message => host.receive(message)));
        await flushViewCommits(host, view); await turn();
        // Recovery can start a final disable commit after its own ACK resolves.
        await flushViewCommits(host, view); await turn();
        assert.strictEqual(host.rows()[1][0], 'onefailed draft');
        assert.strictEqual(host.panel.disposed, true); assert.strictEqual(host.commands.length, 1);
        assert.ok(!host.diskText.includes('failed draft'));
      } finally { view.close(); host.dispose(); }
    });
  }
  it('joins an already pending draft round and cancels teardown after rapid re-enable', async () => {
    const host = await createEditorHarness(), view = createWebviewDom(host.panel.webview.html);
    try {
      view.start(view.cell()); view.type('retained');
      const commit = host.commitPendingDraft(), requestId = host.pendingDraftRequestId;
      host.setEnabled(false); host.refresh(); host.refresh();
      assert.strictEqual(host.pendingDraftRequestId, requestId);
      host.setEnabled(true); host.refresh();
      await Promise.all(prepare(host, view).map(message => host.receive(message)));
      assert.strictEqual(await commit, true); await turn();
      assert.strictEqual(host.rows()[1][0], 'oneretained'); assert.strictEqual(host.panel.disposed, false);
      assert.deepStrictEqual(host.commands, []);
    } finally { view.close(); host.dispose(); }
  });
});
