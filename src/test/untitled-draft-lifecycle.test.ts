import assert from 'assert';
import Papa from 'papaparse';
import { describe, it } from 'node:test';
import { createEditorHarness, createWebviewDom } from './edit-integrity-harness';

const nextTurn = () => new Promise(resolve => setImmediate(resolve));
function currentFilterSession(host: Awaited<ReturnType<typeof createEditorHarness>>): string {
  const metadata = /<script id="__csvFilters"[^>]*>(.*?)<\/script>/s.exec(host.panel.webview.html);
  assert.ok(metadata);
  return JSON.parse(metadata[1]).session;
}

function sendPrepare(host: Awaited<ReturnType<typeof createEditorHarness>>, view: ReturnType<typeof createWebviewDom>) {
  const request = host.messages.filter(message => message.type === 'prepareViewRefresh').at(-1);
  assert.ok(request);
  view.window.dispatchEvent(new view.window.MessageEvent('message', { data: request }));
  return view.messages.filter(message => message.type === 'editCell' || message.type === 'viewRefreshReady')
    .map(message => host.receive(message));
}
function startMultiline(view: ReturnType<typeof createWebviewDom>) {
  view.start(view.cell());
  view.key('Enter', { shiftKey: true });
  view.type('latest draft');
}

describe('untitled controller and webview draft lifecycle', () => {
  for (const separator of [',', '\t']) {
    const nextLanguage = separator === ',' ? 'tsv' : 'csv';
    const nextSeparator = separator === ',' ? '\t' : ',';
    it(`commits a live multiline draft using the original grammar before ${nextLanguage} rebind`, async () => {
      const host = await createEditorHarness({ separator, untitled: true });
      const view = createWebviewDom(host.panel.webview.html);
      try {
        startMultiline(view);
        const html = host.panel.webview.html;
        host.deferEdits();
        const replacement = host.rebindDocument(nextLanguage);
        host.document.isClosed = true;
        host.document.getText = () => { throw new Error('old TextDocument is closed'); };
        assert.strictEqual(host.panel.webview.html, html, 'no reload may destroy the active DOM draft');
        assert.strictEqual(host.getCurrentSeparator(), separator);
        const operations = sendPrepare(host, view);
        await nextTurn();
        assert.strictEqual(host.pendingEdits, 1);
        assert.strictEqual(host.panel.webview.html, html);
        host.releaseEdit();
        await Promise.all(operations);
        assert.strictEqual(Papa.parse<string[]>(replacement.getText(), { delimiter: separator }).data[1][0], 'one\nlatest draft');
        assert.strictEqual(host.getCurrentSeparator(), nextSeparator, 'language owns logical extension in both directions');
        assert.strictEqual(host.panel.disposed, false);
      } finally { view.close(); }
    });

    it(`keeps the grid after rapid disable/re-enable while ${nextLanguage} rebind is pending`, async () => {
      const host = await createEditorHarness({ separator, untitled: true });
      const view = createWebviewDom(host.panel.webview.html);
      try {
        startMultiline(view);
        host.rebindDocument(nextLanguage);
        host.revealSourceAfterCommit();
        host.setEnabled(true);
        await Promise.all(sendPrepare(host, view));
        assert.strictEqual(host.rows()[1][0], 'one\nlatest draft');
        assert.strictEqual(host.getCurrentSeparator(), nextSeparator);
        assert.strictEqual(host.panel.disposed, false);
        assert.strictEqual(host.sourceReveals.length, 0);
      } finally { view.close(); }
    });

    it(`keeps deliberate disable priority over a pending language rebind (${JSON.stringify(separator)})`, async () => {
      const host = await createEditorHarness({ separator, untitled: true });
      const view = createWebviewDom(host.panel.webview.html);
      try {
        startMultiline(view);
        host.revealSourceAfterCommit();
        const replacement = host.rebindDocument(nextLanguage);
        host.saveUntitledAfterCommit();
        await Promise.all(sendPrepare(host, view));
        assert.strictEqual(host.rows()[1][0], 'one\nlatest draft');
        assert.strictEqual(host.sourceReveals[0], replacement.getText());
        assert.strictEqual(host.nativeSaveCommands.length, 0);
        assert.strictEqual(host.panel.disposed, true);
      } finally { view.close(); }
    });
  }

  it('retains explicit separator overrides across associated-path language changes', async () => {
    const host = await createEditorHarness({ separator: '\t', untitled: true, fileName: '/data.tsv', separatorOverride: '|' });
    const view = createWebviewDom(host.panel.webview.html);
    try {
      host.rebindDocument('csv');
      await Promise.all(sendPrepare(host, view));
      assert.strictEqual(host.getCurrentSeparator(), '|');
    } finally { view.close(); }
  });

  it('cancels stale disable teardown when re-enabled before acknowledgment', async () => {
    const host = await createEditorHarness({ untitled: true });
    const view = createWebviewDom(host.panel.webview.html);
    try {
      startMultiline(view);
      host.revealSourceAfterCommit();
      host.setEnabled(true);
      await Promise.all(sendPrepare(host, view));
      assert.strictEqual(host.rows()[1][0], 'one\nlatest draft');
      assert.strictEqual(host.panel.disposed, false);
      assert.strictEqual(host.sourceReveals.length, 0);
    } finally { view.close(); }
  });

  it('ignores stale acknowledgments and resends a pending commit when a webview finishes loading', async () => {
    const host = await createEditorHarness({ untitled: true });
    const original = host.panel.webview.html;
    host.rebindDocument('tsv');
    const request = host.messages.at(-1);
    await host.receive({ type: 'webviewReady' });
    assert.deepStrictEqual(host.messages.at(-1), request);
    await host.receive({ type: 'viewRefreshReady', session: currentFilterSession(host), requestId: request.requestId - 1 });
    assert.strictEqual(host.panel.webview.html, original);
    assert.strictEqual(host.getCurrentSeparator(), ',');
    await host.receive({ type: 'viewRefreshReady', session: currentFilterSession(host), requestId: request.requestId });
    assert.strictEqual(host.getCurrentSeparator(), '\t');
    const current = host.panel.webview.html;
    await host.receive({ type: 'viewRefreshReady', session: currentFilterSession(host), requestId: request.requestId });
    assert.strictEqual(host.panel.webview.html, current);
  });

  it('does not register a controller or touch the webview after immediate panel cancellation', async () => {
    const host = await createEditorHarness({ untitled: true, cancelInitialization: true });
    assert.strictEqual(host.panel.disposed, true);
    assert.strictEqual(host.panel.webview.html, '');
    assert.strictEqual(host.messages.length, 0);
    assert.ok(!host.activeController || host.activeController.getDocumentUri() !== host.document.uri);
  });

  it('does not register a controller after the owner closes during initialization', async () => {
    const host = await createEditorHarness({ untitled: true, closeDuringInitialization: true });
    assert.strictEqual(host.panel.webview.html, '');
    assert.strictEqual(host.messages.length, 0);
    assert.ok(!host.activeController || host.activeController.getDocumentUri() !== host.document.uri);
  });

  it('waits for the active draft before revealing the native owner for Save As', async () => {
    const host = await createEditorHarness({ untitled: true });
    const view = createWebviewDom(host.panel.webview.html);
    try {
      startMultiline(view);
      host.deferEdits();
      host.saveUntitledAfterCommit();
      const pending = sendPrepare(host, view);
      await nextTurn();
      assert.strictEqual(host.pendingEdits, 1);
      assert.strictEqual(host.sourceReveals.length, 0);
      assert.strictEqual(host.nativeSaveCommands.length, 0);
      host.releaseEdit();
      await Promise.all(pending);
      assert.strictEqual(host.rows()[1][0], 'one\nlatest draft');
      assert.strictEqual(host.diskText, host.document.getText());
      assert.deepStrictEqual(host.nativeSaveCommands, ['workbench.action.files.save']);
    } finally { view.close(); }
  });

  it('preserves a saved-document save received while a view refresh is awaiting its draft', async () => {
    const host = await createEditorHarness();
    const view = createWebviewDom(host.panel.webview.html);
    try {
      startMultiline(view);
      // Exercise the shared handshake without importing the separate filter PR.
      host.requestViewCommit();
      await host.receive({ type: 'save' });
      await Promise.all(sendPrepare(host, view));
      assert.strictEqual(host.rows()[1][0], 'one\nlatest draft');
      assert.strictEqual(host.diskText, host.document.getText());
      assert.strictEqual(host.sourceReveals.length, 0);
    } finally { view.close(); }
  });

  for (const modifier of ['ctrlKey', 'metaKey']) {
    for (const editing of [false, true]) {
      it(`routes ${modifier}+S from ${editing ? 'editing' : 'selection'} mode to the native owner`, async () => {
        const host = await createEditorHarness({ untitled: true });
        const view = createWebviewDom(host.panel.webview.html);
        try {
          if (editing) { startMultiline(view); }
          view.key('s', { [modifier]: true });
          const operations = view.messages.filter(message => message.type === 'editCell' || message.type === 'save');
          assert.deepStrictEqual(operations.map(message => message.type), editing ? ['editCell', 'save'] : ['save']);
          await Promise.all(operations.map(message => host.receive(message)));
          assert.strictEqual(host.nativeSaveCommands.length, 1);
          assert.strictEqual(host.diskText, host.document.getText());
          if (editing) { assert.strictEqual(host.rows()[1][0], 'one\nlatest draft'); }
        } finally { view.close(); }
      });
    }
  }
});
