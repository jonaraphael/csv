import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createEditorHarness, createWebviewDom } from './edit-integrity-harness';
import { parseClipboardMatrix, serializeClipboardMatrix } from '../clipboard';

const select = (view: ReturnType<typeof createWebviewDom>, start: any, end = start) => {
  start.dispatchEvent(new view.window.MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 100, clientY: 50 }));
  if (end !== start) { end.dispatchEvent(new view.window.MouseEvent('mousemove', { bubbles: true, clientX: 100, clientY: 50 })); }
  end.dispatchEvent(new view.window.MouseEvent('mouseup', { bubbles: true, button: 0 }));
};
const copy = (view: ReturnType<typeof createWebviewDom>, target: any, route: string) => {
  if (route === 'copy' || route === 'cut') {
    const event = new view.window.Event(route, { bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
  }
  if (route === 'keyboard-copy' || route === 'keyboard-cut') {
    const event = new view.window.KeyboardEvent('keydown', { key: route === 'keyboard-copy' ? 'c' : 'x', metaKey: true, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
  }
  target.dispatchEvent(new view.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 100, clientY: 50 }));
  const label = route === 'context-copy' ? 'Copy' : 'Cut';
  const item = Array.from(view.window.document.querySelectorAll('#contextMenu div')).find((element: any) => element.textContent === label) as any;
  assert.ok(item);
  item.click();
};

describe('Whole-column clipboard and the append row', () => {
  it('copies ordinary header columns without quotes or the virtual append cell', async () => {
    for (const separator of [',', '\t']) {
      const host = await createEditorHarness({ rows: [['Name'], ['alpha'], ['beta']], separator });
      const view = createWebviewDom(host.panel.webview.html);
      try {
        const header = view.cell(0, 0);
        select(view, header);
        copy(view, header, 'copy');
        const message = view.messages.find(item => item.type === 'copyCells');
        assert.deepStrictEqual(JSON.parse(JSON.stringify(message.matrix)), [['Name'], ['alpha'], ['beta']]);
        assert.strictEqual(serializeClipboardMatrix(message.matrix, separator), 'Name\r\nalpha\r\nbeta');
        assert.strictEqual(host.document.getText(), host.diskText);
      } finally { view.close(); }
    }
  });

  it('quotes only the real complex/empty values in a selected column and preserves every real source row', async () => {
    for (const separator of [',', '\t']) {
      const host = await createEditorHarness({ rows: [['Name', 'Other'], ['plain', 'value'], ['', 'keep'], ['with,comma', 'value'], ['last', 'value']], separator });
      const view = createWebviewDom(host.panel.webview.html);
      try {
        const header = view.cell(0, 0);
        select(view, header);
        copy(view, header, 'keyboard-copy');
        const matrix = view.messages.find(item => item.type === 'copyCells').matrix;
        assert.strictEqual(serializeClipboardMatrix(matrix, separator), 'Name\r\nplain\r\n""\r\n"with,comma"\r\nlast');
        assert.deepStrictEqual(parseClipboardMatrix(serializeClipboardMatrix(matrix, separator), separator), [['Name'], ['plain'], [''], ['with,comma'], ['last']]);
        assert.strictEqual(view.window.document.querySelector('#csv-root').dataset.realrowcount, '5');
      } finally { view.close(); }
    }
  });

  it('excludes ghost rows from range and Select All Copy/Cut routes, and consumes ghost-only copies without touching clipboard', async () => {
    for (const route of ['copy', 'cut', 'keyboard-copy', 'keyboard-cut', 'context-copy', 'context-cut']) {
      for (const selection of ['range', 'all', 'ghost']) {
        const host = await createEditorHarness({ rows: [['Name', 'Other'], ['', ''], ['last', 'value']] });
        const view = createWebviewDom(host.panel.webview.html);
        try {
          const ghost = view.cell(3, 0);
          assert.ok(ghost);
          if (selection === 'all') {
            view.window.editingTestApi.setSingleSelection(view.cell(1, 0));
            view.key('a', { metaKey: true });
          } else if (selection === 'range') {
            select(view, view.cell(1, 0), ghost);
          } else {
            view.window.editingTestApi.setSingleSelection(ghost);
          }
          const event = copy(view, ghost, route);
          const messages = view.messages.filter(item => item.type === 'copyCells');
          if (selection === 'ghost') {
            assert.strictEqual(messages.length, 0, `${route}: do not send a clipboard write for append-row-only selection`);
            if (event) { assert.strictEqual(event.defaultPrevented, true, 'native empty copy must not overwrite the existing system clipboard'); }
          } else {
            assert.strictEqual(messages.length, 1);
            const expected = selection === 'all' ? [['Name', 'Other'], ['', ''], ['last', 'value']] : [[''], ['last']];
            assert.deepStrictEqual(JSON.parse(JSON.stringify(messages[0].matrix)), expected, route);
            assert.strictEqual(messages[0].cut, route.includes('cut'));
          }
          assert.strictEqual(host.document.getText(), host.diskText);
        } finally { view.close(); }
      }
    }
  });
  it('uses the full source count instead of treating the last loaded chunk row as a ghost', async () => {
    const rows = [['Name'], ...Array.from({ length: 1002 }, (_value, index) => [`row-${index}`])];
    const host = await createEditorHarness({ rows, remote: true });
    const view = createWebviewDom(host.panel.webview.html);
    try {
      assert.strictEqual(view.window.document.querySelector('#csv-root').dataset.realrowcount, '1003');
      const header = view.cell(0, 0);
      select(view, header);
      copy(view, header, 'copy');
      const first = view.messages.filter(item => item.type === 'copyCells').slice(-1)[0];
      assert.strictEqual(first.matrix.length, 1001);
      assert.strictEqual(first.matrix[1000][0], 'row-999', 'the last loaded real source row is retained');
      let cursor = view.messages.length;
      view.window.__csvLoadNextChunk();
      for (let guard = 0; guard < 5 && !view.cell(1003, 0); guard++) {
        const requests = view.messages.slice(cursor).filter(item => item.type === 'requestChunk');
        cursor = view.messages.length;
        for (const request of requests) {
          await host.receive(request);
          const response = host.messages.filter(item => item.type === 'chunkData' && item.requestId === request.requestId).slice(-1)[0];
          view.window.dispatchEvent(new view.window.MessageEvent('message', { data: response }));
          view.window.__csvLoadNextChunk();
        }
      }
      assert.ok(view.cell(1003, 0), 'the remote append row is eventually rendered');
      view.window.editingTestApi.setSingleSelection(view.cell(1, 0));
      select(view, header);
      copy(view, header, 'copy');
      const complete = view.messages.filter(item => item.type === 'copyCells').slice(-1)[0];
      assert.strictEqual(complete.matrix.length, 1003);
      assert.strictEqual(complete.matrix[1002][0], 'row-1001');
    } finally { view.close(); }
  });

  it('does not copy the only ghost cell in an empty file', async () => {
    const host = await createEditorHarness({ rows: [] });
    const view = createWebviewDom(host.panel.webview.html);
    try {
      assert.strictEqual(view.window.document.querySelector('#csv-root').dataset.realrowcount, '0');
      const ghost = view.cell(0, 0);
      view.window.editingTestApi.setSingleSelection(ghost);
      const event = copy(view, ghost, 'cut');
      assert.strictEqual(event.defaultPrevented, true);
      assert.strictEqual(view.messages.some(item => item.type === 'copyCells'), false);
      assert.strictEqual(host.document.getText(), '');
    } finally { view.close(); }
  });

});
