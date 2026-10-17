import assert from 'assert';
import { describe, it } from 'node:test';
import { createEditorHarness, createWebviewDom } from './edit-integrity-harness';

type View = ReturnType<typeof createWebviewDom>;
const rows = [['Name', 'Value', 'https://example.com'], ['one', 'two', 'three'], ['four', 'five', 'six']];
async function fixture(separator = ',', header = true) {
  const host = await createEditorHarness({ rows, separator, header });
  const view = createWebviewDom(host.panel.webview.html);
  const table = view.window.document.querySelector('table');
  table.getBoundingClientRect = () => ({ left: 0, right: 400, top: 0, bottom: 120, width: 400, height: 120 });
  for (const cell of Array.from(table.querySelectorAll('[data-row][data-col]')) as any[]) {
    const col = Number(cell.dataset.col), top = Number(cell.dataset.row) * 30;
    cell.getBoundingClientRect = () => {
      let left = 0;
      for (let previous = -1; previous < col; previous++) {
        const sibling = table.querySelector(`[data-row="${cell.dataset.row}"][data-col="${previous}"]`);
        left += Number.parseFloat(sibling?.style.width) || 100;
      }
      const width = Number.parseFloat(cell.style.width) || 100;
      return { left, right: left + width, top, bottom: top + 30, width, height: 30 };
    };
  }
  return { host, view };
}
function mouse(view: View, target: any, type: string, options: Record<string, unknown> = {}) {
  const cell = target.closest('td, th');
  const rect = cell.getBoundingClientRect();
  const event = new view.window.MouseEvent(type, { button: 0, buttons: type === 'mousemove' ? 1 : 0, detail: 1, bubbles: true, cancelable: true, clientX: rect.left + rect.width / 2, clientY: rect.top + 15, ...options });
  target.dispatchEvent(event);
  return event;
}
function click(view: View, target: any, detail = 1, options: Record<string, unknown> = {}) {
  for (const type of ['mousedown', 'mouseup', 'click']) { mouse(view, target, type, { detail, ...options }); }
}
function selected(view: View) { return Array.from(view.window.document.querySelectorAll('td.selected, th.selected')) as any[]; }
function column(view: View, index: number) { return Array.from(view.window.document.querySelectorAll(`[data-col="${index}"]`)); }

describe('Separate header clicks', () => {
  for (const separator of [',', '\t']) {
    it(`selects a new column immediately, then only its header on a second separate click (${JSON.stringify(separator)})`, async () => {
      const { host, view } = await fixture(separator);
      try {
        const header = view.cell(0, 1);
        const span = view.window.document.createElement('span');
        span.textContent = header.textContent;
        header.replaceChildren(span);
        mouse(view, span, 'mousedown');
        assert.deepStrictEqual(selected(view), column(view, 1), 'first press retains immediate whole-column selection');
        mouse(view, span, 'mouseup'); mouse(view, span, 'click');
        mouse(view, span, 'mousedown');
        assert.deepStrictEqual(selected(view), column(view, 1), 'a potential reorder keeps the column selected until release');
        mouse(view, span, 'mouseup'); mouse(view, span, 'click');
        assert.deepStrictEqual(selected(view), [header]);
        assert.strictEqual(view.window.document.activeElement, header);
        assert.strictEqual(header.getAttribute('contenteditable'), null);
        assert.strictEqual(view.window.acquireVsCodeApi().getState().anchorRow, 0);
        assert.strictEqual(view.window.acquireVsCodeApi().getState().anchorCol, 1);
        view.key('c', { metaKey: true });
        const copy = view.messages.filter(message => message.type === 'copyCells').pop();
        assert.deepStrictEqual(JSON.parse(JSON.stringify(copy.matrix)), [['Value']]);
        assert.ok(!view.messages.some(message => message.type === 'reorderColumns' || message.type === 'editCell'));
        assert.strictEqual(host.document.version, 1);
        assert.strictEqual(host.document.getText(), host.diskText);
      } finally { view.close(); }
    });
  }

  it('keeps a true detail-2 double-click available for editing and committing the header', async () => {
    const { host, view } = await fixture();
    try {
      const header = view.cell(0, 1);
      click(view, header, 1);
      click(view, header, 2);
      assert.deepStrictEqual(selected(view), column(view, 1));
      mouse(view, header, 'dblclick', { detail: 2 });
      assert.strictEqual(header.getAttribute('contenteditable'), 'true');
      header.textContent = 'Changed header';
      header.blur();
      const edit = view.messages.find(message => message.type === 'editCell');
      assert.deepStrictEqual(JSON.parse(JSON.stringify(edit)), { type: 'editCell', row: 0, col: 1, value: 'Changed header' });
      await host.receive(edit);
      assert.strictEqual(host.rows()[0][1], 'Changed header');
      assert.ok(!host.diskText.includes('Changed header'));
      assert.ok(!view.messages.some(message => message.type === 'reorderColumns'));
    } finally { view.close(); }
  });

  it('continues to reorder an already selected header instead of collapsing it during a drag', async () => {
    const { view } = await fixture();
    try {
      const header = view.cell(0, 1);
      click(view, header);
      mouse(view, header, 'mousedown');
      mouse(view, view.cell(0, 2), 'mousemove', { clientX: 390 });
      mouse(view, view.cell(0, 2), 'mouseup', { clientX: 390 });
      assert.deepStrictEqual(selected(view), column(view, 1));
      const reorder = view.messages.find(message => message.type === 'reorderColumns');
      assert.deepStrictEqual(JSON.parse(JSON.stringify(reorder)), { type: 'reorderColumns', indices: [1], beforeIndex: 3 });
    } finally { view.close(); }
  });

  it('preserves Shift column groups, dragging those groups, and right-click selection', async () => {
    const { view } = await fixture();
    try {
      const first = view.cell(0, 0), second = view.cell(0, 1);
      click(view, first);
      click(view, first, 1, { shiftKey: true });
      assert.deepStrictEqual(selected(view), column(view, 0));
      click(view, second, 1, { shiftKey: true });
      const group = selected(view);
      assert.strictEqual(group.length, column(view, 0).length + column(view, 1).length);
      mouse(view, first, 'mousedown', { button: 2 });
      mouse(view, first, 'mouseup', { button: 2 });
      assert.deepStrictEqual(selected(view), group);
      mouse(view, second, 'mousedown');
      mouse(view, view.cell(0, 2), 'mousemove', { clientX: 390 });
      mouse(view, view.cell(0, 2), 'mouseup', { clientX: 390 });
      assert.deepStrictEqual(selected(view), group);
      const reorder = view.messages.find(message => message.type === 'reorderColumns');
      assert.deepStrictEqual(JSON.parse(JSON.stringify(reorder.indices)), [0, 1]);
    } finally { view.close(); }
  });

  it('keeps resize boundaries ahead of repeat-click selection and double-click editing', async () => {
    const { view } = await fixture();
    try {
      const header = view.cell(0, 1);
      click(view, header);
      mouse(view, header, 'mousedown', { clientX: 299 });
      mouse(view, header, 'mousemove', { clientX: 339 });
      mouse(view, header, 'mouseup', { clientX: 339 });
      assert.strictEqual(header.style.width, '140px');
      assert.deepStrictEqual(selected(view), column(view, 1));
      mouse(view, header, 'dblclick', { detail: 2, clientX: 339 });
      assert.strictEqual(header.style.width, '');
      assert.notStrictEqual(header.getAttribute('contenteditable'), 'true');
      assert.deepStrictEqual(selected(view), column(view, 1));
    } finally { view.close(); }
  });

  it('leaves Cmd/Ctrl link clicks and repeated serial-index clicks unchanged', async () => {
    const { view } = await fixture();
    try {
      click(view, view.cell(0, 1));
      const before = selected(view);
      const link = view.cell(0, 2).querySelector('.csv-link');
      assert.ok(link);
      click(view, link, 1, { metaKey: true });
      assert.deepStrictEqual(selected(view), before);
      assert.strictEqual(view.messages.filter(message => message.type === 'openLink').length, 1);
      const index = view.cell(1, -1);
      click(view, index); click(view, index);
      assert.strictEqual(selected(view).length, 4);
      assert.ok(selected(view).every(cell => cell.dataset.row === '1'));
    } finally { view.close(); }
  });
});
