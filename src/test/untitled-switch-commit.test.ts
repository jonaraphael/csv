import assert from 'assert';
import { describe, it } from 'node:test';
import { createEditorHarness, createWebviewDom } from './edit-integrity-harness';

const turn = () => new Promise(resolve => setImmediate(resolve));
function deliver(host: Awaited<ReturnType<typeof createEditorHarness>>, view: ReturnType<typeof createWebviewDom>) {
  const request = host.messages.filter(message => message.type === 'prepareViewRefresh').at(-1);
  assert.ok(request);
  const start = view.messages.length;
  view.window.dispatchEvent(new view.window.MessageEvent('message', { data: request }));
  return Promise.all(view.messages.slice(start).map(message => host.receive(message)));
}

describe('awaitable untitled draft commit', () => {
  for (const separator of [',', '\t']) {
    it(`waits for a real multiline DOM draft and delayed WorkspaceEdit without saving (${JSON.stringify(separator)})`, async () => {
      const host = await createEditorHarness({ untitled: true, separator });
      const view = createWebviewDom(host.panel.webview.html);
      try {
        view.start(view.cell());
        view.key('Enter', { shiftKey: true });
        view.type('pending draft');
        host.deferEdits();
        const html = host.panel.webview.html;
        const disk = host.diskText;
        let finished = false;
        const commit = host.commitPendingDraft().then(success => { finished = true; return success; });
        const operation = deliver(host, view);
        await turn();
        assert.strictEqual(host.pendingEdits, 1);
        assert.strictEqual(finished, false);
        assert.strictEqual(host.panel.webview.html, html);
        host.releaseEdit();
        await operation;
        assert.strictEqual(await commit, true);
        assert.strictEqual(host.rows()[1][0], 'one\npending draft');
        assert.strictEqual(host.panel.webview.html, html, 'commit helper must not replace its live view');
        assert.strictEqual(host.diskText, disk);
        assert.deepStrictEqual(host.sourceReveals, []);
        assert.deepStrictEqual(host.nativeSaveCommands, []);
        assert.strictEqual(host.activeController!.getViewColumn(), 2);
      } finally { view.close(); host.panel.dispose(); }
    });
  }

  for (const failure of ['false', 'throw']) {
    it(`rejects an edit returning ${failure}, retains the DOM draft, and permits an explicit same-cell retry`, async () => {
      const host = await createEditorHarness({ untitled: true });
      const view = createWebviewDom(host.panel.webview.html);
      const apply = host.applyEdit;
      try {
        view.start(view.cell());
        view.key('Enter', { shiftKey: true });
        view.type('retained draft');
        const html = host.panel.webview.html;
        host.applyEdit = async () => { if (failure === 'throw') { throw new Error('fixture edit rejected'); } return false; };
        const commit = host.commitPendingDraft();
        await deliver(host, view);
        assert.strictEqual(await commit, false);
        assert.strictEqual(view.cell().textContent, 'one\nretained draft');
        assert.strictEqual(host.panel.webview.html, html);
        assert.strictEqual(host.panel.disposed, false);
        assert.strictEqual(host.rows()[1][0], 'one');
        assert.deepStrictEqual(host.nativeSaveCommands, []);
        host.applyEdit = apply;
        view.start(view.cell());
        const retry = host.commitPendingDraft();
        await deliver(host, view);
        assert.strictEqual(await retry, true);
        assert.strictEqual(host.rows()[1][0], 'one\nretained draft');
      } finally { view.close(); host.panel.dispose(); }
    });
  }

  it('resolves false on disposal and ignores its late acknowledgment', async () => {
    const host = await createEditorHarness({ untitled: true });
    const commit = host.commitPendingDraft();
    const request = host.messages.at(-1);
    host.panel.dispose();
    assert.strictEqual(await commit, false);
    assert.strictEqual(await host.commitPendingDraft(), false);
    await host.receive({ type: 'viewRefreshReady', requestId: request.requestId });
    assert.deepStrictEqual(host.sourceReveals, []);
  });

  it('returns false when the commit request cannot reach the webview', async () => {
    const host = await createEditorHarness({ untitled: true });
    const post = host.panel.webview.postMessage;
    try {
      host.panel.webview.postMessage = async () => { throw new Error('panel unavailable'); };
      assert.strictEqual(await host.commitPendingDraft(), false);
      assert.strictEqual(host.panel.disposed, false);
      host.panel.webview.postMessage = post;
      const view = createWebviewDom(host.panel.webview.html);
      try {
        const retry = host.commitPendingDraft();
        await deliver(host, view);
        assert.strictEqual(await retry, true);
      } finally { view.close(); }
    } finally { host.panel.dispose(); }
  });

  it('times out without discarding a draft or opening another view', async () => {
    const host = await createEditorHarness({ untitled: true });
    const view = createWebviewDom(host.panel.webview.html);
    const type = host.activeController!.constructor as any;
    const timeout = type.DRAFT_COMMIT_TIMEOUT_MS;
    type.DRAFT_COMMIT_TIMEOUT_MS = 10;
    try {
      view.start(view.cell());
      view.type('still editing');
      assert.strictEqual(await host.commitPendingDraft(), false);
      assert.strictEqual(view.cell().textContent, 'onestill editing');
      assert.ok(view.cell().isContentEditable || view.cell().getAttribute('contenteditable') === 'true');
      assert.strictEqual(host.panel.disposed, false);
      assert.deepStrictEqual(host.sourceReveals, []);
    } finally { type.DRAFT_COMMIT_TIMEOUT_MS = timeout; view.close(); host.panel.dispose(); }
  });

  it('drains already pending edits for a hidden view and keeps an explicitly pending save action', async () => {
    const host = await createEditorHarness({ untitled: true });
    host.deferEdits();
    const edit = host.receive({ type: 'editCell', row: 1, col: 0, value: 'queued' });
    await turn();
    host.panel.visible = false;
    let done = false;
    const commit = host.commitPendingDraft().then(success => { done = true; return success; });
    await turn();
    assert.strictEqual(done, false);
    host.releaseEdit();
    await edit;
    assert.strictEqual(await commit, true);
    assert.strictEqual(host.rows()[1][0], 'queued');
    assert.deepStrictEqual(host.nativeSaveCommands, []);
    host.panel.visible = true;
    const view = createWebviewDom(host.panel.webview.html);
    try {
      host.saveUntitledAfterCommit();
      const pending = host.commitPendingDraft();
      await deliver(host, view);
      assert.strictEqual(await pending, true);
      assert.deepStrictEqual(host.nativeSaveCommands, ['workbench.action.files.save']);
    } finally { view.close(); host.panel.dispose(); }
  });
});
