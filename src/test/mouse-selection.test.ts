import assert from 'assert';
import { describe, it } from 'node:test';
import { createEditorHarness, createWebviewDom } from './edit-integrity-harness';

type View = ReturnType<typeof createWebviewDom>;
const rows = [['Name', 'Value', 'Note'], ['one', 'two', 'three'], ['four', 'five', 'six'], ['seven', 'eight', 'nine']];
const mouse = (view: View, target: any, type: string, options: Record<string, unknown> = {}) =>
  target.dispatchEvent(new view.window.MouseEvent(type, { button: 0, bubbles: true, cancelable: true, clientX: 60, clientY: 45, ...options }));
const selected = (view: View) => Array.from(view.window.document.querySelectorAll('td.selected, th.selected')) as any[];
const coordinates = (view: View) => selected(view).map(cell => [Number(cell.dataset.row), Number(cell.dataset.col)]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);

async function fixture(separator = ',') {
  const host = await createEditorHarness({ rows, separator });
  return { host, view: createWebviewDom(host.panel.webview.html) };
}

describe('Immediate mouse selection', () => {
  for (const separator of [',', '\t']) {
    it(`selects a body cell on mousedown and replaces the old selection on a new target (${JSON.stringify(separator)})`, async () => {
      const { host, view } = await fixture(separator);
      try {
        const first = view.cell(1, 0);
        mouse(view, first, 'mousedown');
        assert.strictEqual(first.classList.contains('selected'), true, 'selection color must apply before mouseup');
        assert.deepStrictEqual(coordinates(view), [[1, 0]]);
        mouse(view, first, 'mouseup');
        const next = view.cell(2, 1);
        mouse(view, next, 'mousedown');
        assert.deepStrictEqual(coordinates(view), [[2, 1]], 'a new press must immediately replace the prior selection');
        assert.strictEqual(view.window.document.activeElement, next);
        mouse(view, next, 'mouseup');
        assert.deepStrictEqual(coordinates(view), [[2, 1]]);
        assert.deepStrictEqual(host.rows(), rows);
        assert.strictEqual(host.document.version, 1);
        assert.strictEqual(host.document.getText(), host.diskText);
      } finally { view.close(); }
    });
  }

  it('expands and shrinks a held body drag without retaining cells outside its current rectangle', async () => {
    const { view } = await fixture();
    try {
      mouse(view, view.cell(1, 0), 'mousedown');
      assert.deepStrictEqual(coordinates(view), [[1, 0]]);
      mouse(view, view.cell(3, 2), 'mousemove');
      assert.strictEqual(selected(view).length, 9);
      mouse(view, view.cell(2, 1), 'mousemove');
      assert.deepStrictEqual(coordinates(view), [[1, 0], [1, 1], [2, 0], [2, 1]]);
      mouse(view, view.cell(2, 1), 'mouseup');
      assert.deepStrictEqual(coordinates(view), [[1, 0], [1, 1], [2, 0], [2, 1]]);
    } finally { view.close(); }
  });

  it('selects the full new header column on mousedown before a column drag', async () => {
    const { view } = await fixture();
    try {
      const column = view.cell(0, 1);
      mouse(view, column, 'mousedown');
      assert.deepStrictEqual(selected(view), Array.from(view.window.document.querySelectorAll('[data-col="1"]')));
      mouse(view, view.cell(0, 2), 'mousemove');
      assert.ok(selected(view).every(cell => cell.dataset.col === '1' || cell.dataset.col === '2'));
      assert.strictEqual(selected(view).length, view.window.document.querySelectorAll('[data-col="1"], [data-col="2"]').length);
      mouse(view, column, 'mousemove');
      mouse(view, column, 'mouseup');
      assert.deepStrictEqual(selected(view), Array.from(view.window.document.querySelectorAll('[data-col="1"]')));
    } finally { view.close(); }
  });

  it('selects the full new serial row on mousedown before a row drag', async () => {
    const { view } = await fixture();
    try {
      const row = view.cell(1, -1);
      mouse(view, row, 'mousedown');
      assert.deepStrictEqual(selected(view), Array.from(view.window.document.querySelectorAll('[data-row="1"]')));
      mouse(view, view.cell(3, -1), 'mousemove');
      assert.strictEqual(selected(view).length, 12);
      mouse(view, view.cell(2, -1), 'mousemove');
      assert.strictEqual(selected(view).length, 8);
      mouse(view, view.cell(2, -1), 'mouseup');
      assert.ok(selected(view).every(cell => cell.dataset.row === '1' || cell.dataset.row === '2'));
    } finally { view.close(); }
  });

  it('preserves Shift range extension and an existing range on right-click', async () => {
    const { view } = await fixture();
    try {
      mouse(view, view.cell(1, 0), 'mousedown');
      mouse(view, view.cell(1, 0), 'mouseup');
      mouse(view, view.cell(3, 2), 'mousedown', { shiftKey: true });
      assert.strictEqual(selected(view).length, 9);
      const before = coordinates(view);
      mouse(view, view.cell(2, 1), 'mousedown', { button: 2 });
      assert.deepStrictEqual(coordinates(view), before);
    } finally { view.close(); }
  });

  it('commits edited A and copies only newly pressed B before and after mouseup', async () => {
    const { host, view } = await fixture();
    try {
      const first = view.cell(1, 0);
      const next = view.cell(2, 1);
      view.start(first);
      first.textContent = 'committed draft\nsecond line';
      const cursor = view.messages.length;
      mouse(view, next, 'mousedown');
      const edit = view.messages.slice(cursor).find(message => message.type === 'editCell');
      assert.ok(edit, 'pressing a different cell must still commit the active edit');
      assert.deepStrictEqual(JSON.parse(JSON.stringify(edit)), { type: 'editCell', row: 1, col: 0, value: 'committed draft\nsecond line' });
      next.dispatchEvent(new view.window.Event('copy', { bubbles: true, cancelable: true }));
      const beforeMouseup = view.messages.slice(cursor).filter(message => message.type === 'copyCells').slice(-1)[0];
      assert.ok(beforeMouseup);
      assert.deepStrictEqual(JSON.parse(JSON.stringify(beforeMouseup.matrix)), [['five']], 'only B may be copied while the mouse is held');
      assert.strictEqual(beforeMouseup.startRow, 2);
      mouse(view, next, 'mouseup');
      next.dispatchEvent(new view.window.Event('copy', { bubbles: true, cancelable: true }));
      const afterMouseup = view.messages.slice(cursor).filter(message => message.type === 'copyCells').slice(-1)[0];
      assert.deepStrictEqual(JSON.parse(JSON.stringify(afterMouseup.matrix)), [['five']], 'mouseup must retain the same single-cell copy');
      assert.strictEqual(afterMouseup.startRow, 2);
      await host.receive(edit);
      assert.strictEqual(host.rows()[1][0], 'committed draft\nsecond line');
      assert.strictEqual(host.rows()[2][1], 'five');
      assert.ok(!host.diskText.includes('committed draft'));
    } finally { view.close(); }
  });

  it('keeps native text editing when mousedown stays inside the active edited cell', async () => {
    const { host, view } = await fixture();
    try {
      const cell = view.cell(1, 0);
      view.start(cell);
      const event = new view.window.MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true, clientX: 60, clientY: 45 });
      cell.dispatchEvent(event);
      assert.strictEqual(event.defaultPrevented, false);
      assert.strictEqual(cell.getAttribute('contenteditable'), 'true');
      assert.strictEqual(cell.classList.contains('selected'), false);
      assert.strictEqual(view.messages.some(message => message.type === 'editCell'), false);
      assert.strictEqual(host.document.version, 1);
    } finally { view.close(); }
  });
});
