import assert from 'assert';
import { describe, it } from 'node:test';
import { createEditorHarness, createWebviewDom } from './edit-integrity-harness';

type View = ReturnType<typeof createWebviewDom>;
const rows = [['A', 'B', 'C', 'D'], ['a1', 'a2', 'a3', 'a4'], ['b1', 'b2', 'b3', 'b4'], ['c1', 'c2', 'c3', 'c4'], ['d1', 'd2', 'd3', 'd4']];

async function fixture(options: Parameters<typeof createEditorHarness>[0] = {}) {
  const host = await createEditorHarness({ rows, ...options });
  const view = createWebviewDom(host.panel.webview.html);
  const container = view.window.document.querySelector('.table-container');
  container.scrollTo = (position: { left?: number; top?: number }) => {
    if (position.left !== undefined) { container.scrollLeft = position.left; }
    if (position.top !== undefined) { container.scrollTop = position.top; }
  };
  view.window.scrollTo = () => {};
  return { host, view };
}

function select(view: View, row = 2, column = 1) {
  view.window.editingTestApi.setSingleSelection(view.cell(row, column));
}
function selected(view: View, includeIndex = false): number[][] {
  return Array.from(view.window.document.querySelectorAll('td.selected, th.selected'))
    .filter((cell: any) => cell.hasAttribute('data-row') && Number(cell.getAttribute('data-col')) >= (includeIndex ? -1 : 0))
    .map((cell: any) => [Number(cell.getAttribute('data-row')), Number(cell.getAttribute('data-col'))]);
}
function rectangle(minRow: number, maxRow: number, minColumn: number, maxColumn: number) {
  return Array.from({ length: maxRow - minRow + 1 }, (_, row) =>
    Array.from({ length: maxColumn - minColumn + 1 }, (_, column) => [minRow + row, minColumn + column])
  ).flat();
}
function mouseSelect(view: View, row: number, column: number) {
  const cell = view.cell(row, column);
  const left = (column + 1) * 100;
  cell.getBoundingClientRect = () => ({ left, right: left + 100, top: row * 30, bottom: row * 30 + 30, width: 100, height: 30 });
  cell.dispatchEvent(new view.window.MouseEvent('mousedown', { button: 0, clientX: left + 50, clientY: row * 30 + 15, bubbles: true, cancelable: true }));
  cell.dispatchEvent(new view.window.MouseEvent('mouseup', { button: 0, bubbles: true }));
}
function dispatch(view: View, key: string, options: Record<string, unknown>) {
  const event = new view.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options });
  view.window.document.activeElement.dispatchEvent(event);
  return event;
}

describe('Modified arrow range selection', () => {
  for (const modifier of ['metaKey', 'ctrlKey']) {
    for (const [key, bounds] of [
      ['ArrowLeft', [2, 2, 0, 1]], ['ArrowRight', [2, 2, 1, 3]],
      ['ArrowUp', [1, 2, 1, 1]], ['ArrowDown', [2, 5, 1, 1]]
    ] as const) {
      it(`extends from a fixed anchor with ${modifier} + Shift + ${key}`, async () => {
        const { host, view } = await fixture();
        const source = host.document.getText();
        try {
          select(view);
          const anchor = view.cell(2, 1);
          const event = dispatch(view, key, { [modifier]: true, shiftKey: true });
          assert.strictEqual(event.defaultPrevented, true);
          assert.deepStrictEqual(selected(view), rectangle(bounds[0], bounds[1], bounds[2], bounds[3]));
          assert.strictEqual(view.window.document.activeElement, anchor);
          assert.strictEqual(view.window.acquireVsCodeApi().getState().anchorRow, 2);
          assert.strictEqual(view.window.acquireVsCodeApi().getState().anchorCol, 1);
          assert.strictEqual(host.document.getText(), source);
          assert.ok(!view.messages.some((message: any) => message.type === 'editCell'));
        } finally { view.close(); }
      });
    }

    it(`continues and shrinks a rectangle from its endpoint with ${modifier}`, async () => {
      const { view } = await fixture();
      try {
        select(view);
        view.key('ArrowDown', { shiftKey: true });
        view.key('ArrowRight', { [modifier]: true, shiftKey: true });
        assert.deepStrictEqual(selected(view), rectangle(2, 3, 1, 3));
        view.key('ArrowLeft', { shiftKey: true });
        assert.deepStrictEqual(selected(view), rectangle(2, 3, 1, 2));
        view.key('ArrowLeft', { [modifier]: true, shiftKey: true });
        assert.deepStrictEqual(selected(view), rectangle(2, 3, 0, 1));
        view.key('ArrowUp', { [modifier]: true, shiftKey: true });
        assert.deepStrictEqual(selected(view), rectangle(1, 2, 0, 1));
        assert.strictEqual(view.window.document.activeElement, view.cell(2, 1));
      } finally { view.close(); }
    });

    it(`retains whole-column groups during horizontal and vertical extension with ${modifier}`, async () => {
      const { view } = await fixture();
      try {
        mouseSelect(view, 0, 1);
        view.key('ArrowRight', { [modifier]: true, shiftKey: true });
        assert.deepStrictEqual(selected(view), rectangle(0, 5, 1, 3));
        view.key('ArrowDown', { [modifier]: true, shiftKey: true });
        assert.deepStrictEqual(selected(view), rectangle(0, 5, 1, 3));
        view.key('ArrowLeft', { [modifier]: true, shiftKey: true });
        assert.deepStrictEqual(selected(view), rectangle(0, 5, 0, 1));
        assert.strictEqual(view.window.document.activeElement, view.cell(0, 1));
      } finally { view.close(); }
    });

    it(`retains whole-row groups during vertical and horizontal extension with ${modifier}`, async () => {
      const { view } = await fixture();
      try {
        mouseSelect(view, 2, -1);
        view.key('ArrowDown', { [modifier]: true, shiftKey: true });
        assert.deepStrictEqual(selected(view, true), rectangle(2, 5, -1, 3));
        view.key('ArrowRight', { [modifier]: true, shiftKey: true });
        assert.deepStrictEqual(selected(view, true), rectangle(2, 5, -1, 3));
        view.key('ArrowUp', { [modifier]: true, shiftKey: true });
        assert.deepStrictEqual(selected(view, true), rectangle(1, 2, -1, 3));
        assert.strictEqual(view.window.document.activeElement, view.cell(2, -1));
      } finally { view.close(); }
    });

    it(`keeps a backwards drag anchor through repeated and mixed jumps with ${modifier}`, async () => {
      const { view } = await fixture();
      try {
        mouseSelect(view, 3, 2);
        view.cell(3, 2).dispatchEvent(new view.window.MouseEvent('mousedown', { button: 0, clientX: 350, clientY: 105, bubbles: true }));
        view.cell(1, 0).dispatchEvent(new view.window.MouseEvent('mousemove', { buttons: 1, bubbles: true }));
        view.cell(1, 0).dispatchEvent(new view.window.MouseEvent('mouseup', { button: 0, bubbles: true }));
        assert.deepStrictEqual(selected(view), rectangle(1, 3, 0, 2));
        for (let repeat = 0; repeat < 2; repeat++) {
          view.key('ArrowRight', { [modifier]: true, shiftKey: true });
          assert.deepStrictEqual(selected(view), rectangle(1, 3, 2, 3));
        }
        view.key('ArrowDown', { [modifier]: true, shiftKey: true });
        assert.deepStrictEqual(selected(view), rectangle(3, 5, 2, 3));
        view.key('ArrowLeft', { [modifier]: true, shiftKey: true });
        assert.deepStrictEqual(selected(view), rectangle(3, 5, 0, 2));
        view.key('ArrowUp', { shiftKey: true });
        assert.deepStrictEqual(selected(view), rectangle(3, 4, 0, 2));
        view.key('ArrowUp', { [modifier]: true, shiftKey: true });
        assert.deepStrictEqual(selected(view), rectangle(1, 3, 0, 2));
        assert.strictEqual(view.window.document.activeElement, view.cell(3, 2));
      } finally { view.close(); }
    });

    it(`preserves Select All after a stale range endpoint with ${modifier}`, async () => {
      const { host, view } = await fixture();
      try {
        select(view);
        view.key('ArrowDown', { shiftKey: true });
        const corner = view.window.document.querySelector('thead th:not([data-col])');
        corner.dispatchEvent(new view.window.MouseEvent('mousedown', { button: 0, bubbles: true }));
        corner.dispatchEvent(new view.window.MouseEvent('mouseup', { button: 0, bubbles: true }));
        const all = selected(view, true);
        assert.ok(all.length > 1);
        for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
          view.key(key, { [modifier]: true, shiftKey: true });
          assert.deepStrictEqual(selected(view, true), all);
        }
        assert.deepStrictEqual(host.rows(), rows);
      } finally { view.close(); }
    });

    it(`preserves plain ${modifier} jump behavior without Shift`, async () => {
      const { view } = await fixture();
      try {
        select(view);
        view.key('ArrowRight', { [modifier]: true });
        assert.deepStrictEqual(selected(view), [[2, 3]]);
        assert.strictEqual(view.window.document.activeElement, view.cell(2, 3));
        view.key('ArrowDown', { [modifier]: true });
        assert.deepStrictEqual(selected(view), [[5, 3]]);
      } finally { view.close(); }
    });
  }

  it('extends to the existing loaded-row boundary in a chunked table', async () => {
    const source = [['A', 'B'], ...Array.from({ length: 1100 }, (_, row) => [`row${row}`, String(row)])];
    const { host, view } = await fixture({ rows: source });
    try {
      const rendered = Array.from(view.window.document.querySelectorAll('tbody td[data-col="1"]')) as any[];
      const lastRow = Number(rendered[rendered.length - 1].getAttribute('data-row'));
      assert.ok(lastRow < source.length - 1, 'fixture must retain unloaded source rows');
      select(view, lastRow - 2, 1);
      view.key('ArrowDown', { metaKey: true, shiftKey: true });
      assert.deepStrictEqual(selected(view), rectangle(lastRow - 2, lastRow, 1, 1));
      assert.strictEqual(view.window.document.activeElement, view.cell(lastRow - 2, 1));
      assert.deepStrictEqual(host.rows(), source);
    } finally { view.close(); }
  });

  it('copies the entire extended rectangle rather than only its edge cell', async () => {
    const { view } = await fixture();
    try {
      select(view);
      view.key('ArrowDown', { shiftKey: true });
      view.key('ArrowRight', { metaKey: true, shiftKey: true });
      view.key('c', { metaKey: true });
      const copy = view.messages.slice().reverse().find((message: any) => message.type === 'copyCells');
      assert.deepStrictEqual(JSON.parse(JSON.stringify(copy.matrix)), [['b2', 'b3', 'b4'], ['c2', 'c3', 'c4']]);
    } finally { view.close(); }
  });

  it('supports headers off and Home/End aliases without losing the anchor', async () => {
    const { view } = await fixture({ header: false, separator: '\t' });
    try {
      select(view);
      view.key('End', { metaKey: true, shiftKey: true });
      assert.deepStrictEqual(selected(view), rectangle(2, 2, 1, 3));
      view.key('Home', { metaKey: true, shiftKey: true });
      assert.deepStrictEqual(selected(view), rectangle(2, 2, 0, 1));
      view.key('ArrowUp', { metaKey: true, shiftKey: true });
      assert.deepStrictEqual(selected(view), rectangle(0, 2, 0, 1));
    } finally { view.close(); }
  });

  it('leaves native selection in Find, Replace and cell text edits outside the grid handler', async () => {
    const { view } = await fixture();
    try {
      select(view);
      const before = selected(view);
      for (const id of ['findInput', 'replaceInput']) {
        view.window.document.getElementById(id).focus();
        for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
          assert.strictEqual(dispatch(view, key, { metaKey: true, shiftKey: true }).defaultPrevented, false);
        }
        assert.deepStrictEqual(selected(view), before);
      }
      view.start(view.cell(2, 1));
      for (const key of ['ArrowLeft', 'ArrowRight']) {
        assert.strictEqual(dispatch(view, key, { metaKey: true, shiftKey: true }).defaultPrevented, false);
      }
    } finally { view.close(); }
  });
});
