import assert from 'assert';
import { describe, it } from 'node:test';
import { createEditorHarness, createWebviewDom, flushViewCommits } from './edit-integrity-harness';
const { CsvEditorProvider } = require('../CsvEditorProvider') as typeof import('../CsvEditorProvider');

type Host = Awaited<ReturnType<typeof createEditorHarness>>;
type View = ReturnType<typeof createWebviewDom>;
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

function dispatchHostMessage(view: View, message: unknown) {
  const cursor = view.messages.length;
  view.window.dispatchEvent(new view.window.MessageEvent('message', { data: message }));
  return view.messages.slice(cursor);
}

async function startDraft(host: Host, view: View, value: string) {
  const cursor = view.messages.length;
  view.start(view.cell());
  view.cell().textContent = value;
  await Promise.all(view.messages.slice(cursor).map(message => host.receive(message)));
}

async function requestHide(host: Host) {
  const html = host.panel.webview.html;
  await host.receive({ type: 'setSerialIndex', enabled: false });
  assert.strictEqual(host.panel.webview.html, html, 'hide must wait for the live view acknowledgment');
  assert.ok(Number.isInteger(host.pendingDraftRequestId), 'serial changes must request the existing draft handshake');
  const request = host.messages.find(message => message.type === 'prepareViewRefresh' && message.requestId === host.pendingDraftRequestId);
  assert.ok(request);
  return { html, request };
}

function assertHidden(host: Host) {
  assert.strictEqual(CsvEditorProvider.getSerialIndexForUri(host.context as any, host.document.uri as any), false);
  const next = createWebviewDom(host.panel.webview.html);
  try {
    assert.strictEqual(next.window.document.querySelector('[data-col="-1"]'), null);
    assert.ok(next.cell(1, 0), 'data cells remain available after hiding the presentation index');
  } finally { next.close(); }
}

describe('Serial index refresh preserves integrated document ownership', () => {
  for (const separator of [',', '\t']) {
    it(`commits an unposted multiline draft before hiding the index (${JSON.stringify(separator)})`, async () => {
      const host = await createEditorHarness({ separator });
      const view = createWebviewDom(host.panel.webview.html);
      const disk = host.diskText;
      const draft = 'unsaved first\nsecond line';
      try {
        await startDraft(host, view, draft);
        const { html } = await requestHide(host);
        assert.strictEqual(view.cell().getAttribute('contenteditable'), 'true');
        assert.strictEqual(host.rows()[1][0], 'one', 'the active draft has not reached its document yet');
        assert.ok(view.cell(1, -1));
        assert.strictEqual(host.panel.webview.html, html);
        await flushViewCommits(host, view);
        assert.deepStrictEqual(host.rows(), [['name', 'value'], [draft, 'two']]);
        assert.strictEqual(host.diskText, disk, 'changing presentation must not save');
        assert.strictEqual(host.isOpen, true);
        assertHidden(host);
        const next = createWebviewDom(host.panel.webview.html);
        try { assert.strictEqual(next.cell().textContent, draft); } finally { next.close(); }
      } finally { view.close(); host.dispose(); }
    });
  }

  it('retains the old DOM and index until a delayed edit and its acknowledgment complete', async () => {
    const host = await createEditorHarness();
    const view = createWebviewDom(host.panel.webview.html);
    const disk = host.diskText;
    try {
      await startDraft(host, view, 'delayed\nserial draft');
      host.deferEdits();
      const { html, request } = await requestHide(host);
      const messages = dispatchHostMessage(view, request);
      assert.deepStrictEqual(messages.map(message => message.type), ['editCell', 'viewRefreshReady']);
      const pending = messages.map(message => host.receive(message));
      await settle();
      assert.strictEqual(host.pendingEdits, 1);
      assert.strictEqual(host.panel.webview.html, html);
      assert.strictEqual(view.cell().textContent, 'delayed\nserial draft');
      assert.ok(view.cell(1, -1));
      assert.strictEqual(host.rows()[1][0], 'one');
      host.resumeEdits(); host.releaseEdit();
      await Promise.all(pending);
      await flushViewCommits(host, view);
      assert.strictEqual(host.rows()[1][0], 'delayed\nserial draft');
      assert.strictEqual(host.diskText, disk);
      assertHidden(host);
    } finally { view.close(); host.dispose(); }
  });

  for (const failure of ['false', 'throw'] as const) {
    for (const recovery of ['retry', 'discard'] as const) {
      it(`retains a failed ${failure} draft until ${recovery} before applying the hidden index`, async () => {
        const host = await createEditorHarness();
        const view = createWebviewDom(host.panel.webview.html);
        const disk = host.diskText;
        const draft = 'failed first\nsecond line';
        try {
          await startDraft(host, view, draft);
          const { html, request } = await requestHide(host);
          host.failEdits(failure);
          await Promise.all(dispatchHostMessage(view, request).map(message => host.receive(message)));
          assert.strictEqual(host.panel.webview.html, html, 'an unapplied draft must retain its DOM');
          assert.strictEqual(view.cell().textContent, draft);
          assert.ok(view.cell(1, -1));
          assert.strictEqual(host.rows()[1][0], 'one');
          assert.strictEqual(host.diskText, disk);
          assert.strictEqual(host.isOpen, true);
          const failed = host.messages.find(message => message.type === 'editCellFailed');
          assert.ok(failed);
          await Promise.all(dispatchHostMessage(view, failed).map(message => host.receive(message)));
          assert.strictEqual(view.cell().getAttribute('contenteditable'), 'true');
          host.failEdits(undefined);
          const cursor = view.messages.length;
          if (recovery === 'discard') { view.key('Escape'); }
          else { view.cell().blur(); }
          const recovered = view.messages.slice(cursor);
          assert.deepStrictEqual(recovered.map(message => message.type), [recovery === 'discard' ? 'discardCellDraft' : 'editCell']);
          await Promise.all(recovered.map(message => host.receive(message)));
          await flushViewCommits(host, view);
          assert.strictEqual(host.rows()[1][0], recovery === 'retry' ? draft : 'one');
          assert.strictEqual(host.diskText, disk, 'neither retry nor discard may force a save');
          assertHidden(host);
        } finally { view.close(); host.dispose(); }
      });
    }
  }

  for (const separator of [',', '\t']) {
    for (const targetKind of ['body index', 'corner'] as const) {
      it(`keeps the Hide-click data anchor through the safe-refresh acknowledgment (${targetKind}, ${JSON.stringify(separator)})`, async () => {
        const rows = [['metadata', 'private'], ['Name', 'State'], ['one', 'keep'], ['hidden', 'drop'], ['three', 'KEEP']];
        const host = await createEditorHarness({ rows, separator, hiddenRows: 1,
          filters: [{ column: 1, operator: 'equals', value: 'keep' }] });
        const view = createWebviewDom(host.panel.webview.html);
        try {
          const container = view.window.document.querySelector('.table-container');
          container.scrollLeft = 37;
          const target = targetKind === 'corner'
            ? view.window.document.querySelector('thead [data-serial-index]') : view.cell(4, -1);
          assert.ok(target);
          const expectedRow = targetKind === 'corner' ? 1 : 4;
          target.dispatchEvent(new view.window.MouseEvent('mousedown', { button: 2, bubbles: true, cancelable: true, clientX: 120, clientY: 60 }));
          target.dispatchEvent(new view.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 60 }));
          const hide = Array.from(view.window.document.querySelectorAll('#contextMenu div')).find((item: any) => /^hide serial index column$/i.test(item.textContent)) as any;
          assert.ok(hide);
          hide.click();
          const message = view.messages.slice().reverse().find(message => message.type === 'setSerialIndex');
          assert.ok(message);
          await host.receive(message);
          await flushViewCommits(host, view);
          const saved = view.window.acquireVsCodeApi().getState();
          assert.strictEqual(saved.anchorCol, 0, 'the ACK must persist the remapped in-memory anchor, not the removed index');
          assert.strictEqual(saved.anchorRow, expectedRow);
          assert.strictEqual(saved.scrollX, 37);
          const next = createWebviewDom(host.panel.webview.html);
          try {
            let attemptedChunks = 0;
            const load = next.window.__csvLoadNextChunk;
            next.window.__csvLoadNextChunk = (...args: unknown[]) => { attemptedChunks++; return load(...args); };
            next.window.acquireVsCodeApi().setState(saved);
            next.window.dispatchEvent(new next.window.Event('focus'));
            await new Promise(resolve => setTimeout(resolve, 20));
            assert.ok(next.cell(expectedRow, 0).classList.contains('selected'));
            assert.strictEqual(next.window.document.activeElement, next.cell(expectedRow, 0));
            assert.strictEqual(next.window.document.querySelector('[data-col="-1"]'), null);
            assert.strictEqual(attemptedChunks, 0, 'restoring a valid data anchor must not search chunks for a removed index');
            assert.ok(!next.messages.some(message => message.type === 'requestChunk'));
          } finally { next.close(); }
          assert.deepStrictEqual(host.rows(), rows);
        } finally { view.close(); host.dispose(); }
      });
    }
  }

  for (const separator of [',', '\t']) {
    it(`preserves metadata, filtered gaps and absolute source IDs across a serial refresh (${JSON.stringify(separator)})`, async () => {
      const text = [
        ['"metadata"', '"private"'].join(separator),
        ['"Name"', '"State"'].join(separator),
        ['"one"', '"keep"'].join(separator),
        ['"hidden"', '"drop"'].join(separator),
        ['"three"', '"KEEP"'].join(separator)
      ].join('\r\n');
      const host = await createEditorHarness({ text, separator, hiddenRows: 1,
        filters: [{ column: 1, operator: 'equals', value: 'keep' }], frozenRows: 2, frozenColumns: 1 });
      const view = createWebviewDom(host.panel.webview.html);
      try {
        const version = host.document.version;
        const order = view.window.document.getElementById('csv-root').dataset.roworder;
        assert.strictEqual(view.cell(2, 0).textContent, 'one');
        assert.strictEqual(view.cell(4, 0).textContent, 'three');
        assert.strictEqual(view.cell(3, 0), null);
        assert.strictEqual(view.cell(0, 0), null);
        await requestHide(host);
        await flushViewCommits(host, view);
        const next = createWebviewDom(host.panel.webview.html);
        try {
          assert.strictEqual(next.window.document.querySelector('[data-col="-1"]'), null);
          assert.strictEqual(next.window.document.getElementById('csv-root').dataset.roworder, order);
          assert.strictEqual(next.cell(1, 0).tagName, 'TH');
          assert.strictEqual(next.cell(2, 0).textContent, 'one');
          assert.strictEqual(next.cell(4, 0).textContent, 'three');
          assert.strictEqual(next.cell(3, 0), null);
          assert.strictEqual(next.cell(0, 0), null);
          assert.ok(next.window.document.getElementById('filterStatus'));
        } finally { next.close(); }
        assert.strictEqual(host.document.getText(), text, 'a view-only change must preserve exact quoting and CRLF bytes');
        assert.strictEqual(host.document.version, version);
        assert.strictEqual(host.diskText, text);
        await host.receive({ type: 'findMatches', requestId: 70, query: 'three', options: {} });
        const found = host.messages.slice().reverse().find(message => message.type === 'findMatchesResult' && message.requestId === 70);
        assert.ok(found);
        assert.deepStrictEqual(found.matches.map((match: any) => match.row), [4]);
      } finally { view.close(); host.dispose(); }
    });
  }
});
