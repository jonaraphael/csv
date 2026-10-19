import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { describe, it } from 'node:test';
import { createEditorHarness } from './edit-integrity-harness';
const { JSDOM } = require('jsdom');

type Position = { left?: number; top?: number; behavior?: string };

// This geometry model runs the shipped script. Smooth native scrolls remain
// pending until explicitly completed; immediate scrolls cancel them, even at
// zero delta. Keyboard animation frames are controlled independently.
async function fixture(options: { separator?: string; rowCount?: number; columnCount?: number } = {}) {
  const rowCount = options.rowCount ?? 40, columnCount = options.columnCount ?? 12;
  const rows = Array.from({ length: rowCount }, (_, row) => Array.from({ length: columnCount }, (_, column) => `r${row}c${column}`));
  const host = await createEditorHarness({ rows, separator: options.separator, header: false, serialIndex: false });
  const dom = new JSDOM(host.panel.webview.html, { runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const container = window.document.querySelector('.table-container');
  const table = container.querySelector('table');
  const width = 240, height = 120, cellWidth = 80, cellHeight = 24;
  const viewport = { left: 37.5, top: 29.25, right: 277.5, bottom: 149.25, width, height };
  let scrollLeft = 0, scrollTop = 0, state: any = {};
  let pendingSmooth: { left: number; top: number } | undefined;
  let clock = 0, nextFrame = 1, nextTimer = 1;
  const frames = new Map<number, (time: number) => void>();
  const timers = new Map<number, () => void>();
  const messages: any[] = [];
  const scrollCalls: Array<Position> = [];
  const focusCalls: Array<{ cell: any; options: any }> = [];
  const renderedHeight = () => (Number(table.querySelector('tr:last-child [data-row]')?.getAttribute('data-row') ?? 0) + 1) * cellHeight;
  const clamp = (value: number, maximum: number) => Math.max(0, Math.min(value, Math.max(0, maximum)));
  const notifyScroll = () => container.dispatchEvent(new window.Event('scroll'));
  const instant = (position: Position) => {
    pendingSmooth = undefined;
    if (position.left !== undefined) { scrollLeft = clamp(position.left, columnCount * cellWidth - width); }
    if (position.top !== undefined) { scrollTop = clamp(position.top, renderedHeight() - height); }
    notifyScroll();
  };
  const scroll = (position: Position) => {
    scrollCalls.push({ ...position });
    const left = clamp(position.left ?? scrollLeft, columnCount * cellWidth - width);
    const top = clamp(position.top ?? scrollTop, renderedHeight() - height);
    if (position.behavior === 'smooth') {
      // A no-op smooth reveal does not cancel an already running native scroll.
      if (left !== scrollLeft || top !== scrollTop) { pendingSmooth = { left, top }; }
    } else { instant({ left, top }); }
  };
  Object.defineProperties(container, {
    clientWidth: { get: () => width }, clientHeight: { get: () => height },
    clientLeft: { get: () => 0 }, clientTop: { get: () => 0 },
    scrollWidth: { get: () => columnCount * cellWidth }, scrollHeight: { get: renderedHeight },
    scrollLeft: { get: () => scrollLeft, set: (value: number) => instant({ left: value }) },
    scrollTop: { get: () => scrollTop, set: (value: number) => instant({ top: value }) }
  });
  container.getBoundingClientRect = () => ({ ...viewport });
  container.scrollTo = scroll;
  window.scrollTo = scroll;
  window.requestAnimationFrame = (callback: (time: number) => void) => { const id = nextFrame++; frames.set(id, callback); return id; };
  window.cancelAnimationFrame = (id: number) => { frames.delete(id); };
  window.setTimeout = (callback: () => void) => { const id = nextTimer++; timers.set(id, callback); return id; };
  window.clearTimeout = (id: number) => { timers.delete(id); };
  window.IntersectionObserver = class { observe() {} disconnect() {} };
  window.acquireVsCodeApi = () => ({ postMessage: (message: any) => messages.push(message), getState: () => state, setState: (value: any) => { state = value; } });
  const nativeRect = window.HTMLElement.prototype.getBoundingClientRect;
  window.HTMLElement.prototype.getBoundingClientRect = function (this: any) {
    if (!this.hasAttribute('data-row') || !this.hasAttribute('data-col')) { return nativeRect.call(this); }
    const row = Number(this.getAttribute('data-row')), column = Number(this.getAttribute('data-col'));
    let left = column * cellWidth - scrollLeft, top = row * cellHeight - scrollTop;
    if (this.style.position === 'sticky') {
      if (this.style.left !== '') { left = Math.max(left, Number.parseFloat(this.style.left)); }
      if (this.style.top !== '') { top = Math.max(top, Number.parseFloat(this.style.top)); }
    }
    left += viewport.left;
    top += viewport.top;
    return { left, top, right: left + cellWidth, bottom: top + cellHeight, width: cellWidth, height: cellHeight };
  };
  window.HTMLElement.prototype.scrollIntoView = function (this: any, settings: any = {}) {
    const rect = this.getBoundingClientRect();
    const nearest = (start: number, end: number, low: number, high: number) => start < low ? start - low : end > high ? end - high : 0;
    scroll({
      left: scrollLeft + (settings.inline === 'center' ? (rect.left + rect.right - viewport.left - viewport.right) / 2 : nearest(rect.left, rect.right, viewport.left, viewport.right)),
      top: scrollTop + (settings.block === 'center' ? (rect.top + rect.bottom - viewport.top - viewport.bottom) / 2 : nearest(rect.top, rect.bottom, viewport.top, viewport.bottom)),
      behavior: settings.behavior
    });
  };
  const nativeFocus = window.HTMLElement.prototype.focus;
  window.HTMLElement.prototype.focus = function (this: any, settings: any) {
    focusCalls.push({ cell: this, options: settings });
    nativeFocus.call(this, settings);
  };
  const flush = () => {
    for (let guard = 0; (frames.size || timers.size) && guard < 20; guard++) {
      const pendingTimers = [...timers.values()];
      timers.clear();
      pendingTimers.forEach(callback => callback());
      const callbacks = [...frames.values()];
      frames.clear();
      clock += 16;
      callbacks.forEach(callback => callback(clock));
    }
    assert.ok(!frames.size && !timers.size, 'scheduled work settles without another key');
  };
  const finishSmooth = () => {
    if (!pendingSmooth) { return; }
    const position = pendingSmooth;
    instant(position);
  };
  const scriptPath = process.env.CSV_NAVIGATION_TEST_SCRIPT || path.join(process.cwd(), 'media/main.js');
  window.eval(`${fs.readFileSync(scriptPath, 'utf8')}\nwindow.navigationTestApi = { select: setSingleSelection, anchor: () => anchorCell, endpoint: () => rangeEndCell };`);
  flush();
  const cell = (row: number, column: number) => table.querySelector(`[data-row="${row}"][data-col="${column}"]`);
  const select = (row: number, column: number) => {
    window.navigationTestApi.select(cell(row, column));
    flush();
    finishSmooth(); // settle only the explicit starting selection, before held keys
    scrollCalls.length = 0;
    focusCalls.length = 0;
  };
  const key = (name: string, settings: Record<string, unknown> = {}) => {
    const event = new window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...settings });
    window.document.activeElement.dispatchEvent(event);
    return event;
  };
  const visible = (target: any, topInset = 0, leftInset = 0) => {
    const rect = target.getBoundingClientRect();
    assert.ok(rect.top >= viewport.top + topInset && rect.bottom <= viewport.bottom, `row ${target.getAttribute('data-row')} must remain in the usable viewport`);
    assert.ok(rect.left >= viewport.left + leftInset && rect.right <= viewport.right, `column ${target.getAttribute('data-col')} must remain in the usable viewport`);
  };
  return { host, window, container, table, messages, scrollCalls, focusCalls, cell, select, key, flush, finishSmooth, visible,
    get state() { return state; }, get pendingSmooth() { return pendingSmooth; },
    anchor: () => window.navigationTestApi.anchor(), endpoint: () => window.navigationTestApi.endpoint(),
    close: () => window.close() };
}

describe('Keyboard navigation viewport reveal', () => {
  for (const separator of [',', '\t']) {
    it(`keeps held vertical arrows revealed at every paint without a fresh key (${JSON.stringify(separator)})`, async () => {
      const view = await fixture({ separator });
      try {
        view.select(0, 0);
        for (let row = 1; row <= 16; row++) {
          assert.strictEqual(view.key('ArrowDown', { repeat: row > 1 }).defaultPrevented, true);
          view.flush();
          assert.strictEqual(view.window.document.activeElement, view.cell(row, 0));
          view.visible(view.cell(row, 0));
        }
        assert.strictEqual(view.pendingSmooth, undefined);
        assert.ok(view.scrollCalls.every(call => call.behavior !== 'smooth'));
        assert.deepStrictEqual(view.host.rows()[0][0], 'r0c0');
        assert.strictEqual(view.host.document.version, 1);
      } finally { view.close(); }
    });
  }

  it('coalesces a burst to its newest horizontal target and reveals reversals', async () => {
    const view = await fixture();
    try {
      view.select(1, 0);
      view.messages.length = 0;
      for (let column = 1; column <= 10; column++) { view.key('ArrowRight', { repeat: true }); }
      assert.strictEqual(view.window.document.activeElement, view.cell(1, 10));
      assert.strictEqual(view.scrollCalls.length, 0, 'reveals wait for the next paint');
      view.flush();
      assert.strictEqual(view.scrollCalls.length, 1, 'one reveal for the newest target');
      const selections = view.messages.filter(message => message.type === 'selectionChanged');
      assert.strictEqual(selections.length, 1, 'selection reporting also coalesces the burst');
      assert.strictEqual(selections[0].selection.minCol, 10);
      assert.strictEqual(selections[0].selection.maxCol, 10);
      view.visible(view.cell(1, 10));
      for (let column = 9; column >= 1; column--) {
        view.key('ArrowLeft', { repeat: true });
        view.flush();
        view.visible(view.cell(1, column));
      }
      assert.strictEqual(view.window.document.activeElement, view.cell(1, 1));
      assert.strictEqual(view.pendingSmooth, undefined);
    } finally { view.close(); }
  });

  it('cancels an older native smooth scroll even when the new target is already visible', async () => {
    const view = await fixture();
    try {
      view.select(0, 0);
      view.container.scrollTo({ top: 700, left: 700, behavior: 'smooth' });
      assert.ok(view.pendingSmooth);
      view.key('ArrowRight');
      view.flush();
      assert.strictEqual(view.pendingSmooth, undefined);
      view.finishSmooth();
      assert.strictEqual(view.container.scrollTop, 0);
      assert.strictEqual(view.container.scrollLeft, 0);
      view.visible(view.cell(0, 1));
    } finally { view.close(); }
  });

  it('keeps the Shift endpoint revealed while focus and persisted anchor remain fixed', async () => {
    const view = await fixture();
    try {
      view.select(1, 1);
      for (let row = 2; row <= 15; row++) {
        view.key('ArrowDown', { shiftKey: true, repeat: true });
        view.flush();
        view.visible(view.cell(row, 1));
        assert.strictEqual(view.window.document.activeElement, view.cell(1, 1));
      }
      for (let column = 2; column <= 8; column++) {
        view.key('ArrowRight', { shiftKey: true, repeat: true });
        view.flush();
        view.visible(view.cell(15, column));
      }
      assert.strictEqual(view.endpoint(), view.cell(15, 8));
      assert.strictEqual(view.anchor(), view.cell(1, 1));
      assert.strictEqual(view.state.anchorRow, 1);
      assert.strictEqual(view.state.anchorCol, 1);
      assert.strictEqual(view.window.document.querySelectorAll('td.selected').length, 15 * 8);
      assert.ok(view.focusCalls.every(call => call.options?.preventScroll === true));
    } finally { view.close(); }
  });

  it('reveals a quick-edit commit and subsequent repeat navigation without saving or re-entering edit', async () => {
    const view = await fixture();
    try {
      view.select(3, 1);
      view.key('x');
      assert.strictEqual(view.cell(3, 1).getAttribute('contenteditable'), 'true');
      for (let row = 4; row <= 14; row++) {
        view.key('ArrowDown', { repeat: row > 4 });
        view.flush();
        view.visible(view.cell(row, 1));
      }
      const edits = view.messages.filter(message => message.type === 'editCell');
      assert.strictEqual(edits.length, 1);
      assert.strictEqual(edits[0].value, 'x');
      assert.strictEqual(view.window.document.activeElement, view.cell(14, 1));
      assert.strictEqual(view.window.document.querySelector('[contenteditable="true"]'), null);
      assert.ok(!view.messages.some(message => message.type === 'save'));
    } finally { view.close(); }
  });

  it('persists final scroll/focus after repetition and restores without viewport drift', async () => {
    const view = await fixture();
    try {
      view.select(0, 0);
      for (let index = 0; index < 12; index++) { view.key('ArrowDown', { repeat: true }); }
      for (let index = 0; index < 7; index++) { view.key('ArrowRight', { repeat: true }); }
      view.flush();
      const top = view.container.scrollTop, left = view.container.scrollLeft;
      assert.ok(top > 0 && left > 0);
      view.window.dispatchEvent(new view.window.Event('blur'));
      assert.strictEqual(view.state.scrollY, top);
      assert.strictEqual(view.state.scrollX, left);
      assert.strictEqual(view.state.anchorRow, 12);
      assert.strictEqual(view.state.anchorCol, 7);
      view.window.dispatchEvent(new view.window.Event('focus'));
      view.flush();
      assert.strictEqual(view.container.scrollTop, top);
      assert.strictEqual(view.container.scrollLeft, left);
      assert.strictEqual(view.window.document.activeElement, view.cell(12, 7));
      view.visible(view.cell(12, 7));
      assert.ok(view.focusCalls.every(call => call.options?.preventScroll === true));
    } finally { view.close(); }
  });

  it('reveals a modified jump and a following reversal from the latest target', async () => {
    const view = await fixture();
    try {
      view.select(3, 1);
      view.key('ArrowRight', { metaKey: true });
      view.flush();
      view.visible(view.cell(3, 11));
      assert.strictEqual(view.window.document.activeElement, view.cell(3, 11));
      view.key('ArrowLeft', { repeat: true });
      view.key('ArrowUp', { repeat: true });
      view.flush();
      view.visible(view.cell(2, 10));
      assert.strictEqual(view.pendingSmooth, undefined);
    } finally { view.close(); }
  });

  it('keeps navigation visible at the existing loaded-chunk boundary without mutating rows', async () => {
    const view = await fixture({ rowCount: 1100, columnCount: 2 });
    try {
      const last = Number(view.table.querySelector('tr:last-child [data-row]').getAttribute('data-row'));
      assert.ok(last < 1099);
      view.select(last - 2, 1);
      for (let index = 0; index < 6; index++) { view.key('ArrowDown', { repeat: true }); view.flush(); }
      assert.strictEqual(view.window.document.activeElement, view.cell(last, 1));
      view.visible(view.cell(last, 1));
      assert.strictEqual(view.host.rows().length, 1100);
      assert.strictEqual(view.host.document.version, 1);
      assert.ok(!view.messages.some(message => message.type === 'editCell'));
    } finally { view.close(); }
  });

  it('reveals ordinary endpoints beyond sticky rows and columns without scrolling a frozen axis', async () => {
    const view = await fixture();
    try {
      for (const row of Array.from(view.table.rows) as any[]) {
        for (const cell of Array.from(row.cells) as any[]) {
          const r = Number(cell.getAttribute('data-row')), column = Number(cell.getAttribute('data-col'));
          if (r < 2) { cell.classList.add('csv-frozen-row'); cell.style.position = 'sticky'; cell.style.top = `${r * 24}px`; }
          if (column === 0) { cell.classList.add('csv-frozen-column'); cell.style.position = 'sticky'; cell.style.left = '0px'; }
        }
      }
      view.select(2, 1);
      for (let index = 0; index < 12; index++) { view.key('ArrowDown', { repeat: true }); }
      for (let index = 0; index < 7; index++) { view.key('ArrowRight', { repeat: true }); }
      view.flush();
      view.visible(view.cell(14, 8), 48, 80);
      const frozenTop = view.container.scrollTop, frozenLeft = view.container.scrollLeft;
      assert.ok(frozenTop > 0 && frozenLeft > 0);
      view.window.navigationTestApi.select(view.cell(1, 8));
      view.flush();
      assert.strictEqual(view.container.scrollTop, frozenTop, 'frozen row selection keeps the scrolled vertical axis');
      view.window.navigationTestApi.select(view.cell(14, 0));
      view.flush();
      assert.strictEqual(view.container.scrollLeft, frozenLeft, 'frozen column selection keeps the scrolled horizontal axis');
      view.window.navigationTestApi.select(view.cell(14, 8));
      view.flush();
      for (let index = 0; index < 12; index++) { view.key('ArrowUp', { repeat: true }); }
      for (let index = 0; index < 7; index++) { view.key('ArrowLeft', { repeat: true }); }
      view.flush();
      view.visible(view.cell(2, 1), 48, 80);
      const top = view.container.scrollTop;
      view.key('ArrowUp');
      view.flush();
      assert.strictEqual(view.container.scrollTop, top, 'a frozen target retains its own vertical axis');
      view.visible(view.cell(1, 1));
    } finally { view.close(); }
  });
});
