import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createEditorHarness, createWebviewDom, flushViewCommits } from './edit-integrity-harness';

const nextTurn = () => new Promise(resolve => setImmediate(resolve));
function prepare(host: Awaited<ReturnType<typeof createEditorHarness>>, view: ReturnType<typeof createWebviewDom>) {
  const request = host.messages.filter(message => message.type === 'prepareViewRefresh').slice(-1)[0];
  assert.ok(request);
  const cursor = view.messages.length;
  view.window.dispatchEvent(new view.window.MessageEvent('message', { data: request }));
  return { request, outgoing: view.messages.slice(cursor) };
}

describe('File-backed disable preserves active drafts', () => {
  for (const separator of [',', '\t']) {
    it(`commits the live multiline draft before one native handoff (${JSON.stringify(separator)})`, async () => {
      const host = await createEditorHarness({ separator });
      const view = createWebviewDom(host.panel.webview.html);
      try {
        view.start(view.cell());
        view.cell().textContent = 'latest\nunsaved';
        const disk = host.diskText;
        host.deferEdits();
        host.setEnabled(false);
        host.refresh();
        assert.strictEqual(host.panel.disposed, false);
        assert.strictEqual(host.recordedCommands.length, 0);
        const { outgoing } = prepare(host, view);
        const pending = outgoing.map(message => host.receive(message));
        await nextTurn();
        assert.strictEqual(host.pendingEdits, 1);
        assert.strictEqual(host.recordedCommands.length, 0);
        assert.strictEqual(host.panel.disposed, false);
        host.releaseEdit();
        await Promise.all(pending);
        await flushViewCommits(host, view);
        assert.strictEqual(host.rows()[1][0], 'latest\nunsaved');
        assert.strictEqual(host.diskText, disk, 'disabling does not force a save');
        assert.strictEqual(host.panel.disposed, true);
        assert.deepStrictEqual(host.recordedCommands, [['vscode.openWith', host.document.uri, 'default', { viewColumn: 2, preserveFocus: false }]]);
      } finally { view.close(); host.dispose(); }
    });
  }

  for (const failure of ['false', 'throw'] as const) {
    it(`keeps a failed ${failure} disable draft and pending handoff until retry succeeds`, async () => {
      const host = await createEditorHarness();
      const view = createWebviewDom(host.panel.webview.html);
      try {
        view.start(view.cell());
        view.cell().textContent = 'not applied';
        const original = host.document.getText();
        host.failEdits(failure);
        host.setEnabled(false);
        const { outgoing } = prepare(host, view);
        await Promise.all(outgoing.map(message => host.receive(message)));
        assert.strictEqual(host.panel.disposed, false);
        assert.strictEqual(host.document.getText(), original);
        assert.strictEqual(host.recordedCommands.length, 0);
        assert.strictEqual(view.cell().textContent, 'not applied');
        host.failEdits(undefined);
        view.start(view.cell());
        const cursor = view.messages.length;
        view.cell().blur();
        await Promise.all(view.messages.slice(cursor).map(message => host.receive(message)));
        await flushViewCommits(host, view);
        assert.strictEqual(host.rows()[1][0], 'not applied');
        assert.strictEqual(host.panel.disposed, true);
        assert.strictEqual(host.recordedCommands.length, 1);
        assert.strictEqual(host.diskText, original);
      } finally { view.close(); host.dispose(); }
    });
  }

  it('requires a fresh ACK after a newer live edit and cancels teardown after rapid re-enable', async () => {
    const host = await createEditorHarness();
    const view = createWebviewDom(host.panel.webview.html);
    try {
      host.setEnabled(false);
      const old = prepare(host, view);
      const ack = old.outgoing.find(message => message.type === 'viewRefreshReady');
      // Gate the ordered queue so the old ACK is received before a new edit starts,
      // then ensure the raw activity invalidates that queued authorization.
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      (host.activeController as any).pendingOperation = gate;
      const stale = host.receive(ack);
      view.start(view.cell());
      view.cell().textContent = 'newest draft';
      const activity = view.messages.filter(message => message.type === 'cellEditStarted').slice(-1)[0];
      const observing = host.receive(activity);
      release();
      await Promise.all([stale, observing]);
      assert.strictEqual(host.panel.disposed, false);
      assert.strictEqual(host.recordedCommands.length, 0);
      assert.notStrictEqual(host.pendingDraftRequestId, old.request.requestId);
      host.setEnabled(true);
      await flushViewCommits(host, view);
      assert.strictEqual(host.rows()[1][0], 'newest draft');
      assert.strictEqual(host.panel.disposed, false);
      assert.strictEqual(host.recordedCommands.length, 0);
      assert.ok(host.panel.webview.html.includes('<table>'));
    } finally { view.close(); host.dispose(); }
  });
});
