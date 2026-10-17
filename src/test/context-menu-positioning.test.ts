import assert from 'assert';
import { describe, it } from 'node:test';
import { createEditorHarness, createWebviewDom } from './edit-integrity-harness';

async function fixture(separator = ',') {
  const host = await createEditorHarness({ rows: [['Name', 'Value'], ['one', 'two']], header: true, separator });
  const view = createWebviewDom(host.panel.webview.html);
  const { window } = view;
  const menu = window.document.getElementById('contextMenu');
  let naturalSize: { width: number; height: number } | undefined;
  const measurements: Array<{ left: string; top: string; display: string }> = [];
  const baseFontSize = Number.parseFloat(window.getComputedStyle(window.document.body).fontSize);
  const natural = () => {
    if (naturalSize) { return naturalSize; }
    const scale = Number.parseFloat(window.getComputedStyle(window.document.body).fontSize) / baseFontSize;
    return {
      width: Math.max(...Array.from(menu.children).map((item: any) => item.textContent.length * 8 * scale + 26)),
      height: Array.from(menu.children).reduce((sum: number, item: any) => sum + (item.textContent ? 24 * scale : 4), 2)
    };
  };
  const size = () => ({
    width: Math.min(natural().width, Number.parseFloat(menu.style.maxWidth)),
    height: Math.min(natural().height, Number.parseFloat(menu.style.maxHeight))
  });
  menu.getBoundingClientRect = () => {
    measurements.push({ left: menu.style.left, top: menu.style.top, display: menu.style.display });
    const { width, height } = size();
    const left = Number.parseFloat(menu.style.left), top = Number.parseFloat(menu.style.top);
    return { left, top, right: left + width, bottom: top + height, width, height };
  };
  Object.defineProperty(menu, 'scrollHeight', { get: () => natural().height });
  Object.defineProperty(menu, 'clientHeight', { get: () => size().height });
  const viewport = (width: number, height: number) => {
    Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: height, configurable: true });
  };
  viewport(1000, 700);
  const open = (x: number, y: number, row = 1, column = 0, pageOffsetX = 0, pageOffsetY = 0) => {
    const target = view.cell(row, column);
    target.dispatchEvent(new window.MouseEvent('mousedown', { button: 2, bubbles: true, cancelable: true, clientX: x, clientY: y }));
    const event = new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y });
    Object.defineProperty(event, 'pageX', { value: x + pageOffsetX });
    Object.defineProperty(event, 'pageY', { value: y + pageOffsetY });
    target.dispatchEvent(event);
    assert.strictEqual(event.defaultPrevented, true);
    return { left: Number.parseFloat(menu.style.left), top: Number.parseFloat(menu.style.top), ...size() };
  };
  return { ...view, menu, measurements, viewport, open, setSize: (width: number, height: number) => { naturalSize = { width, height }; } };
}

describe('Context menu viewport positioning', () => {
  it('renders the provider popup at natural width with bounded wrapping and scrolling', async () => {
    const view = await fixture();
    try {
      const css = view.window.getComputedStyle(view.menu);
      assert.strictEqual(css.position, 'fixed');
      assert.strictEqual(css.width, 'max-content');
      assert.strictEqual(css.boxSizing, 'border-box');
      assert.strictEqual(css.overflow, 'auto');
      assert.strictEqual(css.overflowWrap, 'anywhere');
    } finally { view.close(); }
  });

  for (const separator of [',', '\t']) {
    it(`flips at the measured right-space threshold, including fractional coordinates (${JSON.stringify(separator)})`, async () => {
      const view = await fixture(separator);
      try {
        view.setSize(200, 120);
        assert.strictEqual(view.open(792, 100).left, 792, 'exact fit stays on the right, beyond the screen midpoint');
        assert.strictEqual(view.open(792.5, 100).left, 592.5, 'half a pixel beyond the measured threshold opens left');
        assert.ok(view.measurements.every(measurement => measurement.left === '8px' && measurement.top === '8px' && measurement.display === 'block'));
      } finally { view.close(); }
    });
  }

  it('chooses a side again for differently sized menus at the same pointer position', async () => {
    const view = await fixture();
    try {
      view.setSize(100, 120);
      assert.strictEqual(view.open(650, 100).left, 650);
      view.setSize(400, 120);
      assert.strictEqual(view.open(650, 100).left, 250);
    } finally { view.close(); }
  });

  it('measures the completed header menu, including its extra actions', async () => {
    const view = await fixture();
    try {
      const body = view.open(100, 100, 1);
      const x = 1000 - 8 - body.width;
      const y = 700 - 8 - body.height;
      const fittedBody = view.open(x, y, 1);
      assert.strictEqual(fittedBody.left, x);
      assert.strictEqual(fittedBody.top, y);
      const header = view.open(x, y, 0);
      assert.ok(header.width >= body.width);
      assert.ok(header.height > body.height);
      assert.strictEqual(header.left, header.width > body.width ? x - header.width : x);
      assert.strictEqual(header.top, Math.max(8, y - header.height));
      assert.ok(Array.from(view.menu.children).some((item: any) => item.textContent === 'Treat first row as data'));
      assert.ok(Array.from(view.menu.children).some((item: any) => item.textContent === 'Sort: A-Z'));
    } finally { view.close(); }
  });

  it('flips upward at the measured bottom-space threshold', async () => {
    const view = await fixture();
    try {
      view.setSize(200, 120);
      assert.strictEqual(view.open(100, 572).top, 572);
      assert.strictEqual(view.open(100, 572.5).top, 452.5);
    } finally { view.close(); }
  });

  it('clamps all four corners inside the viewport margins', async () => {
    const view = await fixture();
    try {
      view.setSize(200, 120);
      for (const [x, y, left, top] of [[0, 0, 8, 8], [1000, 0, 792, 8], [0, 700, 8, 572], [1000, 700, 792, 572]]) {
        const placed = view.open(x, y);
        assert.strictEqual(placed.left, left);
        assert.strictEqual(placed.top, top);
        assert.ok(placed.left + placed.width <= 992);
        assert.ok(placed.top + placed.height <= 692);
      }
    } finally { view.close(); }
  });

  it('uses viewport client coordinates independently of document and table scrolling', async () => {
    const view = await fixture();
    try {
      view.setSize(200, 120);
      Object.defineProperty(view.window, 'scrollX', { value: 5000 });
      Object.defineProperty(view.window, 'scrollY', { value: 7000 });
      const container = view.window.document.querySelector('.table-container');
      container.scrollLeft = 300;
      container.scrollTop = 600;
      const placed = view.open(100, 200, 1, 0, 5000, 7000);
      assert.strictEqual(placed.left, 100);
      assert.strictEqual(placed.top, 200);
      assert.strictEqual(container.scrollLeft, 300);
      assert.strictEqual(container.scrollTop, 600);
    } finally { view.close(); }
  });

  it('bounds tiny editor menus and retains reachable actions through vertical scrolling', async () => {
    const view = await fixture();
    try {
      view.setSize(300, 500);
      for (const [width, height] of [[120, 90], [16, 12]]) {
        view.viewport(width, height);
        const placed = view.open(width - 1, height - 1);
        assert.ok(placed.width <= width - 2 * Math.min(8, width / 4));
        assert.ok(placed.height <= height - 2 * Math.min(8, height / 4));
        assert.ok(placed.left >= 0 && placed.left + placed.width <= width);
        assert.ok(placed.top >= 0 && placed.top + placed.height <= height);
        assert.ok(view.menu.scrollHeight > view.menu.clientHeight);
      }
      view.menu.scrollTop = view.menu.scrollHeight - view.menu.clientHeight;
      const last = view.menu.lastElementChild;
      assert.strictEqual(last.textContent, 'Delete COLUMN');
      last.click();
      assert.strictEqual(view.messages.at(-1).type, 'deleteColumn');
      assert.strictEqual(view.messages.at(-1).index, 0);
      assert.strictEqual(view.menu.style.display, 'none');
    } finally { view.close(); }
  });

  it('dismisses only when CSV zoom changes and measures the enlarged menu on reopen', async () => {
    const view = await fixture();
    try {
      const original = view.open(100, 100);
      const x = 1000 - 8 - original.width;
      assert.strictEqual(view.open(x, 100).left, x);
      view.key('0', { ctrlKey: true });
      assert.strictEqual(view.menu.style.display, 'block', 'reset at the existing zoom leaves the menu open');
      const originalFontSize = Number.parseFloat(view.window.getComputedStyle(view.window.document.body).fontSize);
      view.key('+', { ctrlKey: true });
      assert.strictEqual(view.menu.style.display, 'none');
      assert.ok(Number.parseFloat(view.window.document.body.style.fontSize) > originalFontSize);
      const enlarged = view.open(x, 100);
      assert.ok(enlarged.width > original.width);
      assert.strictEqual(enlarged.left, x - enlarged.width);
      assert.ok(enlarged.left + enlarged.width <= 992);
      assert.strictEqual(view.menu.style.display, 'block');
    } finally { view.close(); }
  });

  it('dismisses on viewport resize and remeasures/reset scroll when reopened', async () => {
    const view = await fixture();
    try {
      view.viewport(120, 90);
      view.setSize(300, 500);
      view.open(119, 89);
      view.menu.scrollTop = 200;
      view.menu.scrollLeft = 20;
      view.viewport(1000, 700);
      view.window.dispatchEvent(new view.window.Event('resize'));
      assert.strictEqual(view.menu.style.display, 'none');
      view.setSize(180, 100);
      const placed = view.open(100, 100);
      assert.strictEqual(placed.left, 100);
      assert.strictEqual(placed.top, 100);
      assert.strictEqual(placed.width, 180);
      assert.strictEqual(placed.height, 100);
      assert.strictEqual(view.menu.scrollTop, 0);
      assert.strictEqual(view.menu.scrollLeft, 0);
      assert.strictEqual(view.menu.style.display, 'block');
      assert.ok(Array.from(view.menu.children).some((item: any) => item.textContent === 'Copy'));
    } finally { view.close(); }
  });
});
