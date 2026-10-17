import assert from 'assert';
import { describe, it } from 'node:test';
import { createEditorHarness, createWebviewDom, flushViewCommits } from './edit-integrity-harness';

function deliver(host: Awaited<ReturnType<typeof createEditorHarness>>, view: ReturnType<typeof createWebviewDom>) {
  const messages = host.messages.splice(0);
  messages.forEach(message => {
    if (message.type === 'prepareViewRefresh') { host.messages.push(message); }
    else { view.window.dispatchEvent(new view.window.MessageEvent('message', { data: message })); }
  });
}

describe('unapplied ordinary cell drafts keep source row identities intact', () => {
  for (const failure of ['false', 'throw'] as const) {
    it(`blocks row deletion after an ordinary ${failure} failure until Escape discards the draft`, async () => {
      const host = await createEditorHarness({ rows: [['name', 'value'], ['one', 'two'], ['three', 'four']] });
      const view = createWebviewDom(host.panel.webview.html);
      try {
        view.start(view.cell()); view.type(' failed draft'); view.cell().blur();
        host.failEdits(failure);
        await host.receive(view.messages.find(message => message.type === 'editCell'));
        deliver(host, view);
        assert.ok(view.cell().textContent.includes('failed draft'));
        assert.strictEqual(view.cell().getAttribute('contenteditable'), null, 'ordinary failure must not repeatedly steal focus');
        host.failEdits(undefined);
        await host.receive({ type: 'deleteRow', index: 1 });
        assert.deepStrictEqual(host.rows(), [['name', 'value'], ['one', 'two'], ['three', 'four']]);
        assert.strictEqual(host.errors.length, 1);
        deliver(host, view);
        assert.strictEqual(view.cell().getAttribute('contenteditable'), 'true', 'blocked mutation returns to the failed draft');
        view.messages.length = 0;
        view.key('Escape');
        assert.deepStrictEqual(view.messages.map(message => message.type), ['discardCellDraft']);
        await host.receive(view.messages[0]);
        deliver(host, view);
        assert.strictEqual(view.cell().textContent, 'one');
        assert.deepStrictEqual(host.rows(), [['name', 'value'], ['one', 'two'], ['three', 'four']], 'discard must not write stale DOM text');
        await host.receive({ type: 'deleteRow', index: 1 });
        assert.deepStrictEqual(host.rows(), [['name', 'value'], ['three', 'four']]);
        await flushViewCommits(host, view);
        const fresh = createWebviewDom(host.panel.webview.html);
        try { assert.strictEqual(fresh.cell().textContent, 'three'); } finally { fresh.close(); }
      } finally { view.close(); }
    });
  }

  it('clears the failure when the user explicitly reverts to the original source value', async () => {
    const host = await createEditorHarness({ rows: [['name'], ['one'], ['three']] });
    const view = createWebviewDom(host.panel.webview.html);
    try {
      view.start(view.cell()); view.type('failed'); view.cell().blur();
      host.failEdits('false'); await host.receive(view.messages.find(message => message.type === 'editCell'));
      deliver(host, view); host.failEdits(undefined); view.messages.length = 0;
      view.start(view.cell()); view.cell().textContent = 'one'; view.cell().blur();
      await host.receive(view.messages.find(message => message.type === 'editCell'));
      deliver(host, view);
      await host.receive({ type: 'deleteRow', index: 1 });
      assert.deepStrictEqual(host.rows(), [['name'], ['three']]);
      assert.strictEqual(host.errors.length, 0);
      await flushViewCommits(host, view);
    } finally { view.close(); }
  });

  it('keeps the rendered delimiter while a failed draft is retried after a separator change', async () => {
    const host = await createEditorHarness();
    const view = createWebviewDom(host.panel.webview.html);
    try {
      view.start(view.cell()); view.type(' draft'); view.cell().blur();
      host.failEdits('false'); await host.receive(view.messages.find(message => message.type === 'editCell'));
      deliver(host, view); host.failEdits(undefined);
      await host.setSeparator('|');
      view.messages.length = 0; view.start(view.cell());
      const pending = host.commitPendingDraft();
      view.window.dispatchEvent(new view.window.MessageEvent('message', { data: host.messages.at(-1) }));
      await Promise.all(view.messages.filter(message => ['editCell', 'viewRefreshReady'].includes(message.type)).map(message => host.receive(message)));
      await flushViewCommits(host, view);
      assert.strictEqual(await pending, true);
      assert.deepStrictEqual(host.rows(), [['name', 'value'], ['one draft', 'two']]);
      const fresh = createWebviewDom(host.panel.webview.html);
      try { assert.strictEqual(fresh.window.document.getElementById('csv-root').dataset.sepcode, '124'); }
      finally { fresh.close(); }
    } finally { view.close(); }
  });

  for (const existingCommit of [false, true]) {
    it(`preserves a new live B draft while recovered A applies (${existingCommit ? 'existing ACK' : 'ordinary blur'})`, async () => {
      const host = await createEditorHarness();
      const view = createWebviewDom(host.panel.webview.html);
      try {
        view.start(view.cell()); view.type(' recovered'); view.cell().blur();
        host.failEdits('false'); await host.receive(view.messages.find(message => message.type === 'editCell'));
        deliver(host, view); host.failEdits(undefined); view.messages.length = 0;
        view.start(view.cell());
        host.deferEdits();
        let commit: Promise<boolean> | undefined;
        if (existingCommit) {
          commit = host.commitPendingDraft();
          view.window.dispatchEvent(new view.window.MessageEvent('message', { data: host.messages.at(-1) }));
        } else { view.cell().blur(); }
        const queuedA = view.messages.filter(message => ['cellEditStarted', 'editCell', 'viewRefreshReady'].includes(message.type)).map(message => host.receive(message));
        await new Promise(resolve => setImmediate(resolve));
        assert.strictEqual(host.pendingEdits, 1);
        const html = host.panel.webview.html;
        const cursor = view.messages.length;
        view.start(view.cell(1, 1)); view.type(' SECOND-LIVE-DRAFT');
        const startedB = view.messages.slice(cursor).map(message => host.receive(message));
        host.resumeEdits(); host.releaseEdit();
        await Promise.all([...queuedA, ...startedB]);
        assert.strictEqual(host.panel.webview.html, html, 'recovery cannot replace the DOM while B remains unposted');
        assert.ok(view.cell(1, 1).textContent.includes('SECOND-LIVE-DRAFT'));
        assert.strictEqual(host.rows()[1][1], 'two');
        await flushViewCommits(host, view);
        if (commit) { assert.strictEqual(await commit, true); }
        assert.deepStrictEqual(host.rows(), [['name', 'value'], ['one recovered', 'two SECOND-LIVE-DRAFT']]);
        const fresh = createWebviewDom(host.panel.webview.html);
        try { assert.strictEqual(fresh.cell(1, 1).textContent, 'two SECOND-LIVE-DRAFT'); }
        finally { fresh.close(); }
      } finally { view.close(); }
    });
  }

  it('renews a fresh recovery ACK if another draft starts while its edit is applying', async () => {
    const host = await createEditorHarness({ rows: [['a', 'b', 'c'], ['one', 'two', 'three']] });
    const view = createWebviewDom(host.panel.webview.html);
    try {
      view.start(view.cell()); view.type(' recovered'); view.cell().blur();
      host.failEdits('false'); await host.receive(view.messages.find(message => message.type === 'editCell'));
      deliver(host, view); host.failEdits(undefined); view.messages.length = 0;
      view.start(view.cell()); view.cell().blur(); host.deferEdits();
      const queuedA = view.messages.map(message => host.receive(message));
      await new Promise(resolve => setImmediate(resolve));
      const html = host.panel.webview.html;
      let cursor = view.messages.length;
      view.start(view.cell(1, 1)); view.type(' SECOND-DRAFT');
      const startB = view.messages.slice(cursor).map(message => host.receive(message));
      host.releaseEdit(); await Promise.all([...queuedA, ...startB]);
      cursor = view.messages.length;
      const firstRequest = host.messages.find(message => message.type === 'prepareViewRefresh' && message.requestId === host.pendingDraftRequestId);
      view.window.dispatchEvent(new view.window.MessageEvent('message', { data: firstRequest }));
      const queuedB = view.messages.slice(cursor).map(message => host.receive(message));
      await new Promise(resolve => setImmediate(resolve));
      assert.strictEqual(host.pendingEdits, 1);
      cursor = view.messages.length;
      view.start(view.cell(1, 2)); view.type(' THIRD-LIVE-DRAFT');
      const startC = view.messages.slice(cursor).map(message => host.receive(message));
      host.resumeEdits(); host.releaseEdit();
      await Promise.all([...queuedB, ...startC]);
      assert.notStrictEqual(host.pendingDraftRequestId, firstRequest.requestId, 'the received new draft invalidates the earlier ACK');
      assert.strictEqual(host.panel.webview.html, html);
      assert.ok(view.cell(1, 2).textContent.includes('THIRD-LIVE-DRAFT'));
      assert.strictEqual(host.rows()[1][2], 'three');
      await flushViewCommits(host, view);
      assert.deepStrictEqual(host.rows(), [['a', 'b', 'c'], ['one recovered', 'two SECOND-DRAFT', 'three THIRD-LIVE-DRAFT']]);
    } finally { view.close(); }
  });

  it('discard restores the current owner after an external edit without applying the failed DOM value', async () => {
    const host = await createEditorHarness();
    const view = createWebviewDom(host.panel.webview.html);
    try {
      view.start(view.cell()); view.type('failed'); view.cell().blur();
      host.failEdits('false'); await host.receive(view.messages.find(message => message.type === 'editCell'));
      deliver(host, view); host.failEdits(undefined);
      await host.applyEdit('name,value\nexternal,change');
      await host.receive({ type: 'deleteRow', index: 1 }); deliver(host, view);
      view.messages.length = 0; view.key('Escape');
      await host.receive(view.messages.find(message => message.type === 'discardCellDraft'));
      assert.deepStrictEqual(host.rows(), [['name', 'value'], ['external', 'change']]);
      await flushViewCommits(host, view);
      const fresh = createWebviewDom(host.panel.webview.html);
      try { assert.strictEqual(fresh.cell().textContent, 'external'); } finally { fresh.close(); }
    } finally { view.close(); }
  });
});
