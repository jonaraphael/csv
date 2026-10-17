import assert from 'assert';
import { describe, it } from 'node:test';
import { createEditorHarness, createWebviewDom } from './edit-integrity-harness';

describe('table switching commits the actual webview draft before replacement', () => {
  for (const separator of [',', '\t']) {
    it(`waits for a delayed multiline edit before acknowledging (${JSON.stringify(separator)})`, async () => {
      const host = await createEditorHarness({ separator });
      const view = createWebviewDom(host.panel.webview.html);
      try {
        view.start(view.cell()); view.key('Enter', { shiftKey: true }); view.type('switch draft');
        host.deferEdits(); let committed = false;
        const commit = host.commitPendingDraft().then(result => { committed = result; });
        const request = host.messages.find(message => message.type === 'prepareViewRefresh');
        assert.ok(request);
        view.window.dispatchEvent(new view.window.MessageEvent('message', { data: request }));
        const messages = view.messages.filter(message => message.type === 'editCell' || message.type === 'viewRefreshReady');
        assert.deepStrictEqual(messages.map(message => message.type), ['editCell', 'viewRefreshReady']);
        const operations = messages.map(message => host.receive(message));
        await new Promise(resolve => setImmediate(resolve));
        assert.strictEqual(host.pendingEdits, 1); assert.strictEqual(committed, false);
        host.releaseEdit(); await Promise.all(operations); await commit;
        assert.strictEqual(committed, true);
        assert.strictEqual(host.rows()[1][0], 'one\nswitch draft');
        assert.ok(!host.diskText.includes('switch draft'), 'switching must not save');
      } finally { view.close(); }
    });
  }

  for (const failure of ['false', 'throw'] as const) {
    it(`keeps and can retry the live draft when applyEdit returns ${failure}`, async () => {
      const host = await createEditorHarness();
      const view = createWebviewDom(host.panel.webview.html);
      try {
        view.start(view.cell()); view.type('failure draft');
        host.failEdits(failure);
        const html = host.panel.webview.html;
        const pending = host.commitPendingDraft();
        const request = host.messages.at(-1);
        view.window.dispatchEvent(new view.window.MessageEvent('message', { data: request }));
        await Promise.all(view.messages.filter(message => ['editCell', 'viewRefreshReady'].includes(message.type)).map(message => host.receive(message)));
        assert.strictEqual(await pending, false);
        assert.strictEqual(host.panel.webview.html, html);
        assert.strictEqual(host.rows()[1][0], 'one');
        assert.ok(view.cell().textContent.includes('failure draft'));
        const failed = host.messages.find(message => message.type === 'editCellFailed');
        assert.ok(failed);
        view.window.dispatchEvent(new view.window.MessageEvent('message', { data: failed }));
        assert.strictEqual(view.cell().getAttribute('contenteditable'), 'true', 'retry keeps the failed draft editable');
        host.failEdits(undefined); view.messages.length = 0;
        const retry = host.commitPendingDraft();
        view.window.dispatchEvent(new view.window.MessageEvent('message', { data: host.messages.at(-1) }));
        await Promise.all(view.messages.filter(message => ['editCell', 'viewRefreshReady'].includes(message.type)).map(message => host.receive(message)));
        assert.strictEqual(await retry, true);
        assert.strictEqual(host.rows()[1][0], 'onefailure draft');
      } finally { view.close(); }
    });
  }

  it('does not authorize a hidden view with a failed edit', async () => {
    const host = await createEditorHarness();
    host.failEdits('false');
    await host.receive({ type: 'editCell', row: 1, col: 0, value: 'failed' });
    host.panel.visible = false;
    assert.strictEqual(await host.commitPendingDraft(), false);
  });

  it('keeps the active DOM during a structural virtual-row commit', async () => {
    const host = await createEditorHarness();
    const view = createWebviewDom(host.panel.webview.html);
    try {
      view.start(view.cell(2, 0)); view.type('appended row');
      const html = host.panel.webview.html;
      const pending = host.commitPendingDraft();
      view.window.dispatchEvent(new view.window.MessageEvent('message', { data: host.messages.at(-1) }));
      const edit = view.messages.find(message => message.type === 'editCell');
      await host.receive(edit);
      assert.strictEqual(host.panel.webview.html, html, 'structural edits cannot replace the DOM before acknowledgment');
      await host.receive(view.messages.find(message => message.type === 'viewRefreshReady'));
      assert.strictEqual(await pending, true);
      assert.strictEqual(host.rows()[2][0], 'appended row');
    } finally { view.close(); }
  });

  it('resends initialization-time requests, ignores stale acks, and aborts on disposal', async () => {
    const host = await createEditorHarness();
    let settled = false; const pending = host.commitPendingDraft().then(result => { settled = true; return result; });
    const request = host.messages.at(-1);
    await host.receive({ type: 'webviewReady' }); assert.deepStrictEqual(host.messages.at(-1), request);
    await host.receive({ type: 'viewRefreshReady', requestId: request.requestId - 1 });
    assert.strictEqual(settled, false);
    host.panel.dispose(); assert.strictEqual(await pending, false);
  });
});
