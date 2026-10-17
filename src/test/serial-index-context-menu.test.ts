import assert from 'assert';
import { describe, it } from 'node:test';
import { createEditorHarness, createWebviewDom } from './edit-integrity-harness';
const { CsvEditorProvider } = require('../CsvEditorProvider') as typeof import('../CsvEditorProvider');

type Host = Awaited<ReturnType<typeof createEditorHarness>>;
type View = ReturnType<typeof createWebviewDom>;
const rows = [['Name', 'Value'], ['one', 'two'], ['three', 'four']];
const settle = () => new Promise(resolve => setTimeout(resolve, 20));

function openMenu(view: View, target: any) {
  assert.ok(target);
  target.dispatchEvent(new view.window.MouseEvent('mousedown', { button: 2, bubbles: true, cancelable: true, clientX: 100, clientY: 100 }));
  const event = new view.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 100, clientY: 100 });
  target.dispatchEvent(event);
  return { event, items: Array.from(view.window.document.querySelectorAll('#contextMenu div')) as any[] };
}

function chooseHide(view: View, target: any) {
  const item = openMenu(view, target).items.find(element => element.textContent === 'Hide serial index column');
  assert.ok(item);
  item.click();
  const message = view.messages.slice().reverse().find(item => item.type === 'setSerialIndex');
  assert.strictEqual(message.enabled, false);
  return message;
}

async function finishRefresh(host: Host, view: View, start = 0) {
  let cursor = start;
  for (let guard = 0; guard < 5; guard++) {
    const pending = host.messages.slice(cursor).filter((item: any) => item.type === 'prepareViewRefresh');
    cursor = host.messages.length;
    if (!pending.length) { break; }
    for (const prepare of pending) {
      const begin = view.messages.length;
      view.window.dispatchEvent(new view.window.MessageEvent('message', { data: prepare }));
      for (const item of view.messages.slice(begin)) { await host.receive(item); }
    }
  }
  await settle();
}

async function applySerialIndex(host: Host, view: View, message: unknown) {
  const start = host.messages.length;
  await host.receive(message);
  await finishRefresh(host, view, start);
}

async function mountThrough(view: View, host: Host, row: number) {
  let begin = 0;
  for (let guard = 0; !view.cell(row, -1) && guard < 10; guard++) {
    view.window.__csvLoadNextChunk();
    const pending = view.messages.slice(begin).filter(message => message.type === 'requestChunk');
    begin = view.messages.length;
    for (const request of pending) {
      await host.receive(request);
      const response = host.messages.slice().reverse().find((message: any) => message.type === 'chunkData' && message.requestId === request.requestId);
      view.window.dispatchEvent(new view.window.MessageEvent('message', { data: response }));
    }
  }
  assert.ok(view.cell(row, -1), `serial cell in row ${row} should be mounted`);
}

describe('Serial index context action', () => {
  for (const separator of [',', '\t']) {
    for (const header of [false, true]) {
      it(`hides only the serial column without changing source (${JSON.stringify(separator)}, header ${header})`, async () => {
        const host = await createEditorHarness({ rows, separator, header });
        const view = createWebviewDom(host.panel.webview.html);
        const source = host.document.getText(), version = host.document.version, disk = host.diskText;
        try {
          for (const row of [1, 2, 3]) {
            assert.ok(openMenu(view, view.cell(row, -1)).items.some(item => item.textContent === 'Hide serial index column'));
          }
          for (const row of [0, 1, 3]) {
            for (const column of [0, 1]) {
              assert.ok(!openMenu(view, view.cell(row, column)).items.some(item => item.textContent === 'Hide serial index column'));
            }
          }
          await applySerialIndex(host, view, chooseHide(view, view.cell(1, -1)));
          const next = createWebviewDom(host.panel.webview.html);
          try {
            assert.strictEqual(next.window.document.querySelector('[data-col="-1"], [data-serial-index]'), null);
            assert.ok(!openMenu(next, next.cell(1, 0)).items.some(item => item.textContent === 'Hide serial index column'));
          } finally { next.close(); }
          assert.strictEqual(CsvEditorProvider.getSerialIndexForUri(host.context as any, host.document.uri as any), false);
          assert.strictEqual(host.document.getText(), source);
          assert.strictEqual(host.document.version, version);
          assert.strictEqual(host.diskText, disk);
          // The existing command uses this setter and refresh route to restore the column.
          await CsvEditorProvider.setSerialIndexForUri(host.context as any, host.document.uri as any, true);
          CsvEditorProvider.getActiveProvider()!.refresh();
          await settle();
          const restored = createWebviewDom(host.panel.webview.html);
          try { assert.ok(restored.cell(1, -1)); } finally { restored.close(); }
        } finally { view.close(); }
      });
    }
  }

  it('offers the corner action while preserving Select All and excluding invalid data actions', async () => {
    const host = await createEditorHarness({ rows });
    const view = createWebviewDom(host.panel.webview.html);
    try {
      const corner = view.window.document.querySelector('thead th[data-serial-index]');
      assert.ok(corner);
      assert.ok(!corner.hasAttribute('data-row') && !corner.hasAttribute('data-col'));
      corner.dispatchEvent(new view.window.MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true }));
      assert.strictEqual(view.window.document.querySelectorAll('td.selected, th.selected').length, view.window.document.querySelectorAll('td, th').length);
      const menu = openMenu(view, corner);
      assert.strictEqual(menu.event.defaultPrevented, true);
      assert.ok(menu.items.some(item => item.textContent === 'Hide serial index column'));
      assert.ok(!menu.items.some(item => /Sort:|COLUMN:|Delete COLUMN|first row as/.test(item.textContent)));
      await applySerialIndex(host, view, chooseHide(view, corner));
      assert.ok(!host.panel.webview.html.includes('data-serial-index'));
      assert.deepStrictEqual(host.rows(), rows);
    } finally { view.close(); }
  });

  it('hides an empty/header-off serial column and accepts a boolean restore idempotently', async () => {
    const host = await createEditorHarness({ rows: [], header: false });
    const view = createWebviewDom(host.panel.webview.html);
    try {
      await applySerialIndex(host, view, chooseHide(view, view.cell(0, -1)));
      assert.ok(!host.panel.webview.html.includes('data-col="-1"'));
      await applySerialIndex(host, view, { type: 'setSerialIndex', enabled: true });
      const restored = createWebviewDom(host.panel.webview.html);
      try { assert.ok(restored.cell(0, -1)); } finally { restored.close(); }
      const html = host.panel.webview.html;
      await applySerialIndex(host, view, { type: 'setSerialIndex', enabled: true });
      assert.strictEqual(host.panel.webview.html, html);
      assert.strictEqual(host.document.getText(), '');
      assert.strictEqual(host.document.version, 1);
    } finally { view.close(); }
  });

  it('targets its owner URI and refreshes every view of that URI, even with another active file', async () => {
    const host = await createEditorHarness({ rows });
    const view = createWebviewDom(host.panel.webview.html);
    const second = await createEditorHarness({ rows });
    const secondView = createWebviewDom(second.panel.webview.html);
    second.context.workspaceState = host.context.workspaceState;
    const other = await createEditorHarness({ rows, separator: '\t' });
    const otherHtml = other.panel.webview.html;
    try {
      await applySerialIndex(host, view, chooseHide(view, view.cell(1, -1)));
      assert.ok(!host.panel.webview.html.includes('data-col="-1"'));
      await finishRefresh(second, secondView);
      assert.ok(!second.panel.webview.html.includes('data-col="-1"'));
      assert.strictEqual(other.panel.webview.html, otherHtml);
      assert.strictEqual(CsvEditorProvider.getSerialIndexForUri(other.context as any, other.document.uri as any), true);
      assert.deepStrictEqual(host.rows(), rows);
      assert.deepStrictEqual(second.rows(), rows);
    } finally { view.close(); secondView.close(); }
  });

  it('rejects malformed preferences and ignores repeated requests without extra writes or reloads', async () => {
    const host = await createEditorHarness({ rows });
    const view = createWebviewDom(host.panel.webview.html);
    const update = host.context.workspaceState.update.bind(host.context.workspaceState);
    let serialWrites = 0;
    host.context.workspaceState.update = async (key: string, value: unknown) => {
      if (key === CsvEditorProvider.serialKey) { serialWrites++; }
      await update(key, value);
    };
    try {
      const original = host.panel.webview.html;
      for (const enabled of [undefined, null, 'false', 0, 1, {}, []]) {
        await applySerialIndex(host, view, { type: 'setSerialIndex', enabled });
      }
      assert.strictEqual(host.panel.webview.html, original);
      assert.strictEqual(serialWrites, 0);
      await applySerialIndex(host, view, chooseHide(view, view.cell(1, -1)));
      const hidden = host.panel.webview.html;
      await applySerialIndex(host, view, { type: 'setSerialIndex', enabled: false });
      assert.strictEqual(host.panel.webview.html, hidden);
      assert.strictEqual(serialWrites, 1);
      assert.strictEqual(host.document.version, 1);
    } finally { view.close(); }
  });

  for (const corner of [false, true]) {
    it(`preserves scroll and a surviving data anchor with hidden metadata (corner ${corner})`, async () => {
      const host = await createEditorHarness({ rows: [['metadata', ''], ...rows], header: true });
      await CsvEditorProvider.setHiddenRowsForUri(host.context as any, host.document.uri as any, 1);
      CsvEditorProvider.getActiveProvider()!.refresh();
      await settle();
      const view = createWebviewDom(host.panel.webview.html);
      try {
        const container = view.window.document.querySelector('.table-container');
        container.scrollLeft = 40;
        container.scrollTop = 120;
        const target = corner ? view.window.document.querySelector('[data-serial-index]') : view.cell(2, -1);
        const message = chooseHide(view, target);
        view.window.dispatchEvent(new view.window.Event('blur'));
        view.window.dispatchEvent(new view.window.Event('focus'));
        await settle();
        view.window.dispatchEvent(new view.window.Event('blur'));
        await applySerialIndex(host, view, message);
        const state = view.window.acquireVsCodeApi().getState();
        assert.strictEqual(state.anchorRow, corner ? 1 : 2);
        assert.strictEqual(state.anchorCol, 0);
        assert.strictEqual(state.scrollX, 40);
        assert.strictEqual(state.scrollY, 120);
        const next = createWebviewDom(host.panel.webview.html);
        try {
          next.window.acquireVsCodeApi().setState(state);
          next.window.dispatchEvent(new next.window.Event('focus'));
          await settle();
          assert.ok(next.cell(state.anchorRow, 0).classList.contains('selected'));
          assert.strictEqual(next.window.document.querySelector('.table-container').scrollLeft, 40);
          assert.strictEqual(next.window.document.querySelector('.table-container').scrollTop, 120);
        } finally { next.close(); }
      } finally { view.close(); }
    });
  }

  it('retains an existing data anchor when the selected serial cell opens the menu', async () => {
    const host = await createEditorHarness({ rows });
    const view = createWebviewDom(host.panel.webview.html);
    try {
      view.window.editingTestApi.setSingleSelection(view.cell(1, 1));
      view.key('a', { ctrlKey: true });
      assert.ok(view.cell(1, -1).classList.contains('selected'));
      const message = chooseHide(view, view.cell(1, -1));
      view.window.dispatchEvent(new view.window.Event('blur'));
      const state = view.window.acquireVsCodeApi().getState();
      assert.strictEqual(state.anchorRow, 1);
      assert.strictEqual(state.anchorCol, 1);
      await applySerialIndex(host, view, message);
      assert.deepStrictEqual(host.rows(), rows);
    } finally { view.close(); }
  });

  it('keeps remote later-chunk index cells actionable and preserves the source', async () => {
    const data = [['Name', 'Value'], ...Array.from({ length: 1100 }, (_, row) => [`row-${row}`, 'value'])];
    const host = await createEditorHarness({ rows: data, remote: true });
    const view = createWebviewDom(host.panel.webview.html);
    try {
      await mountThrough(view, host, 1050);
      await applySerialIndex(host, view, chooseHide(view, view.cell(1050, -1)));
      assert.strictEqual(view.window.acquireVsCodeApi().getState().anchorRow, 1050);
      assert.strictEqual(view.window.acquireVsCodeApi().getState().anchorCol, 0);
      await host.receive({ type: 'requestChunk', start: 1001, requestId: 99 });
      const response = host.messages.slice().reverse().find((message: any) => message.type === 'chunkData' && message.requestId === 99);
      assert.ok(!response.html.includes('data-col="-1"'));
      assert.deepStrictEqual(host.rows(), data);
      assert.strictEqual(host.document.version, 1);
    } finally { view.close(); }
  });

  it('retains native context menus while editing and drains queued multiline edits before refresh', async () => {
    const host = await createEditorHarness({ rows });
    const view = createWebviewDom(host.panel.webview.html);
    try {
      view.start(view.cell(1, 0));
      view.type('draft\nline');
      const menu = openMenu(view, view.cell(1, -1));
      assert.strictEqual(menu.event.defaultPrevented, false);
      assert.ok(!menu.items.some(item => item.textContent === 'Hide serial index column'));
      view.cell(1, 0).blur();
      const editMessage = view.messages.find(message => message.type === 'editCell');
      assert.ok(editMessage);
      host.deferEdits();
      const edit = host.receive(editMessage);
      await new Promise(resolve => setImmediate(resolve));
      assert.strictEqual(host.pendingEdits, 1);
      const hide = host.receive({ type: 'setSerialIndex', enabled: false });
      assert.ok(host.panel.webview.html.includes('data-col="-1"'));
      host.releaseEdit();
      await edit;
      await hide;
      await finishRefresh(host, view);
      assert.strictEqual(host.rows()[1][0], editMessage.value);
      assert.ok(!host.panel.webview.html.includes('data-col="-1"'));
      assert.ok(!host.diskText.includes('draft'));
    } finally { view.close(); }
  });
});
