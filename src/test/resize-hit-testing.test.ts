import assert from 'assert';
import { describe, it } from 'node:test';
import { createEditorHarness, createWebviewDom } from './edit-integrity-harness';

type Rect = { left: number; right: number; top: number; bottom: number; width: number; height: number };

async function fixture(header = true, widths = [100, 17, 100], separator = ',') {
  const host = await createEditorHarness({ rows: [['name', '', 'value'], ['one', '', 'three']], header, separator });
  const view = createWebviewDom(host.panel.webview.html);
  const { window } = view;
  const table = window.document.querySelector('table');
  const cells = Array.from(table.querySelectorAll('[data-row][data-col]')) as any[];
  const fixed = new Map<any, Rect>();
  let probes = 0;
  let border: number | undefined;
  let cover: any;
  const rect = (cell: any): Rect => {
    if (fixed.has(cell)) { return fixed.get(cell)!; }
    const row = Number(cell.dataset.row), column = Number(cell.dataset.col);
    const widthOf = (col: number) => Number.parseFloat(view.cell(row, col)?.style.width) || widths[col];
    const left = column < 0 ? 0 : 30 + widths.slice(0, column).reduce((sum, _width, col) => sum + widthOf(col), 0);
    const width = column < 0 ? 30 : widthOf(column);
    return { left, right: left + width, top: row * 30, bottom: row * 30 + 30, width, height: 30 };
  };
  for (const cell of cells) { cell.getBoundingClientRect = () => rect(cell); }
  window.document.elementFromPoint = (x: number, y: number) => {
    probes++;
    const contains = (cell: any) => {
      const box = rect(cell);
      return box.width > 0 && box.height > 0 && x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
    };
    if (cover && contains(cover)) { return cover; }
    const hit = cells.slice().reverse().find(contains);
    if (border !== undefined && Math.abs(x - border) < 0.2) { return hit?.parentElement ?? table; }
    return hit ?? table;
  };
  const mouse = (target: any, type: string, x: number, y = 15) => {
    const event = new window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });
    target.dispatchEvent(event);
    return event;
  };
  return { ...view, table, fixed, rect, mouse, setBorder: (x: number) => { border = x; }, setCover: (cell: any) => { cover = cell; }, get probes() { return probes; } };
}

describe('Resize boundary event hit testing', () => {
  for (const header of [true, false]) {
    for (const separator of [',', '\t']) {
      it(`leaves a blank 17px cell center selectable and editable (header ${header}, ${JSON.stringify(separator)})`, async () => {
        const view = await fixture(header, [100, 17, 100], separator);
        try {
          const cell = view.cell(0, 1);
          const x = view.rect(cell).left + 8.5;
          view.mouse(cell, 'mousemove', x);
          assert.strictEqual(view.table.style.cursor, '');
          view.mouse(cell, 'mousedown', x);
          view.mouse(cell, 'mouseup', x);
          assert.ok(cell.classList.contains('selected'));
          view.mouse(cell, 'dblclick', x);
          assert.strictEqual(cell.getAttribute('contenteditable'), 'true');
          assert.ok(!view.messages.some(message => message.type === 'columnSizesChanged'));
        } finally { view.close(); }
      });
    }
  }

  it('shrinks both boundaries further on 8px cells while preserving their center', async () => {
    const view = await fixture(false, [100, 8, 100]);
    try {
      const cell = view.cell(0, 1);
      for (const x of [132.1, 134, 135.9]) {
        view.mouse(cell, 'mousemove', x);
        assert.strictEqual(view.table.style.cursor, '');
      }
      for (const x of [130, 131.9, 136.1, 138]) {
        view.mouse(cell, 'mousemove', x);
        assert.strictEqual(view.table.style.cursor, 'col-resize');
      }
    } finally { view.close(); }
  });

  for (const targetKind of ['row', 'table', 'previous', 'next']) {
    it(`shares hover/drag/reset at a fractional border targeted as ${targetKind}`, async () => {
      const view = await fixture(false);
      try {
        const first = view.cell(0, 0), next = view.cell(0, 1);
        view.fixed.set(first, { left: 30, right: 130.25, top: 0, bottom: 30, width: 100.25, height: 30 });
        view.fixed.set(next, { left: 130.75, right: 147.75, top: 0, bottom: 30, width: 17, height: 30 });
        view.setBorder(130.5);
        const target = targetKind === 'row' ? first.parentElement : targetKind === 'table' ? view.table : targetKind === 'previous' ? first : next;
        view.mouse(target, 'mousemove', 130.5);
        assert.strictEqual(view.table.style.cursor, 'col-resize');
        assert.strictEqual(view.mouse(target, 'mousedown', 130.5).defaultPrevented, true);
        view.mouse(target, 'mousemove', 150.5);
        view.mouse(target, 'mouseup', 150.5);
        assert.strictEqual(first.style.width, '120px');
        assert.strictEqual(first.style.boxSizing, 'border-box');
        assert.strictEqual(next.style.width, '');
        assert.deepStrictEqual({ ...view.messages.filter(message => message.type === 'columnSizesChanged').at(-1).columnSizes }, { '0': 120 });
        assert.strictEqual(view.mouse(target, 'dblclick', 130.5).defaultPrevented, true);
        assert.strictEqual(first.style.width, '');
        assert.strictEqual(first.style.boxSizing, '');
        assert.deepStrictEqual({ ...view.messages.filter(message => message.type === 'columnSizesChanged').at(-1).columnSizes }, {});
      } finally { view.close(); }
    });
  }

  it('resolves the painted frozen neighbor rather than an occluded logical predecessor', async () => {
    const view = await fixture(false);
    try {
      const frozen = view.cell(0, 0), covered = view.cell(0, 1), visible = view.cell(0, 2);
      view.fixed.set(frozen, { left: 100, right: 150, top: 0, bottom: 30, width: 50, height: 30 });
      view.fixed.set(covered, { left: 130, right: 147, top: 0, bottom: 30, width: 17, height: 30 });
      view.fixed.set(visible, { left: 150, right: 250, top: 0, bottom: 30, width: 100, height: 30 });
      view.setCover(frozen);
      view.mouse(covered, 'mousemove', 143);
      assert.strictEqual(view.table.style.cursor, '', 'covered source boundary cannot resize');
      view.mouse(visible, 'mousemove', 150);
      assert.strictEqual(view.table.style.cursor, 'col-resize');
      view.mouse(visible, 'mousedown', 150);
      view.mouse(visible, 'mousemove', 170);
      view.mouse(visible, 'mouseup', 170);
      assert.strictEqual(frozen.style.width, '70px');
      assert.strictEqual(covered.style.width, '');
      assert.deepStrictEqual({ ...view.messages.filter(message => message.type === 'columnSizesChanged').at(-1).columnSizes }, { '0': 70 });
    } finally { view.close(); }
  });

  for (const x of [149, 151]) {
    it(`shares hover/drag/reset on either side of a partially occluded frozen seam at ${x}`, async () => {
      const view = await fixture(false);
      try {
        const frozen = view.cell(0, 0), covered = view.cell(0, 1), visible = view.cell(0, 2);
        view.fixed.set(frozen, { left: 100, right: 150, top: 0, bottom: 30, width: 50, height: 30 });
        view.fixed.set(covered, { left: 120, right: 145, top: 0, bottom: 30, width: 25, height: 30 });
        view.fixed.set(visible, { left: 140, right: 250, top: 0, bottom: 30, width: 110, height: 30 });
        view.setCover(frozen);
        const target = x < 150 ? frozen : visible;
        view.mouse(target, 'mousemove', x);
        assert.strictEqual(view.table.style.cursor, 'col-resize');
        assert.strictEqual(view.mouse(target, 'mousedown', x).defaultPrevented, true);
        view.mouse(target, 'mousemove', x + 20);
        view.mouse(target, 'mouseup', x + 20);
        assert.strictEqual(frozen.style.width, '70px');
        assert.strictEqual(covered.style.width, '');
        assert.strictEqual(visible.style.width, '');
        assert.deepStrictEqual({ ...view.messages.filter(message => message.type === 'columnSizesChanged').at(-1).columnSizes }, { '0': 70 });
        assert.strictEqual(view.mouse(target, 'dblclick', x).defaultPrevented, true);
        assert.strictEqual(frozen.style.width, '');
        assert.strictEqual(frozen.style.boxSizing, '');
        assert.deepStrictEqual({ ...view.messages.filter(message => message.type === 'columnSizesChanged').at(-1).columnSizes }, {});
      } finally { view.close(); }
    });
  }

  it('keeps the painted center of a partially covered narrow cell selectable', async () => {
    const view = await fixture(false);
    try {
      const frozen = view.cell(0, 0), covered = view.cell(0, 1), visible = view.cell(0, 2);
      view.fixed.set(frozen, { left: 100, right: 150, top: 0, bottom: 30, width: 50, height: 30 });
      view.fixed.set(covered, { left: 120, right: 145, top: 0, bottom: 30, width: 25, height: 30 });
      view.fixed.set(visible, { left: 140, right: 158, top: 0, bottom: 30, width: 18, height: 30 });
      view.setCover(frozen);
      for (const x of [152.1, 154, 155.9]) {
        view.mouse(visible, 'mousemove', x);
        assert.strictEqual(view.table.style.cursor, '');
      }
      view.mouse(visible, 'mousedown', 154);
      view.mouse(visible, 'mouseup', 154);
      assert.ok(visible.classList.contains('selected'));
      assert.ok(!view.messages.some(message => message.type === 'columnSizesChanged'));
      for (const x of [150, 151.9, 156.1, 158]) {
        view.mouse(x < 150 ? frozen : visible, 'mousemove', x);
        assert.strictEqual(view.table.style.cursor, 'col-resize');
      }
    } finally { view.close(); }
  });

  it('ignores links, controls, hidden columns and active editors', async () => {
    const view = await fixture(false);
    try {
      const cell = view.cell(0, 0);
      for (const tag of ['a', 'button', 'input']) {
        const control = view.window.document.createElement(tag);
        cell.appendChild(control);
        view.mouse(control, 'mousemove', 130);
        assert.strictEqual(view.table.style.cursor, '');
        control.remove();
      }
      const hidden = view.cell(0, 1);
      view.fixed.set(hidden, { left: 140, right: 140, top: 0, bottom: 30, width: 0, height: 30 });
      view.mouse(hidden, 'mousemove', 140);
      assert.strictEqual(view.table.style.cursor, '');
      view.start(cell);
      view.mouse(cell, 'mousemove', 130);
      assert.strictEqual(view.table.style.cursor, '');
    } finally { view.close(); }
  });

  it('keeps hover work bounded to painted points and leaves row-index resizing unchanged', async () => {
    const view = await fixture(false);
    try {
      const cell = view.cell(0, 1);
      const query = view.table.querySelectorAll;
      view.table.querySelectorAll = () => { throw new Error('hover must not scan rendered cells'); };
      view.mouse(cell, 'mousemove', 130);
      assert.strictEqual(view.table.style.cursor, 'col-resize');
      assert.ok(view.probes <= 10);
      view.table.querySelectorAll = query;
      const index = view.cell(0, -1);
      view.mouse(index, 'mousemove', 15, 29);
      assert.strictEqual(view.table.style.cursor, 'row-resize');
      view.mouse(index, 'mousedown', 15, 29);
      view.mouse(index, 'mousemove', 15, 39);
      view.mouse(index, 'mouseup', 15, 39);
      assert.strictEqual(index.style.height, '40px');
    } finally { view.close(); }
  });
});
