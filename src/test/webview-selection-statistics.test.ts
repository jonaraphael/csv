import assert from 'assert';
import { describe, it } from 'node:test';
import { createEditorHarness, createWebviewDom } from './edit-integrity-harness';

type Host = Awaited<ReturnType<typeof createEditorHarness>>;
type View = ReturnType<typeof createWebviewDom>;
const paint = (view: View) => new Promise<void>(resolve => view.window.requestAnimationFrame(() => resolve()));
const status = (host: Host) => host.statusBarItems.find(item => item.visible)?.text;
const deliver = async (host: Host, view: View) => {
  await paint(view);
  for (const message of view.messages.splice(0)) { await host.receive(message); }
};
const click = (view: View, row: number, col: number, options: Record<string, unknown> = {}) => {
  const cell = view.cell(row, col);
  for (const type of ['mousedown', 'mouseup', 'click']) {
    cell.dispatchEvent(new view.window.MouseEvent(type, { button: 0, detail: 1, bubbles: true, cancelable: true, clientX: 60, clientY: 45, ...options }));
  }
};

describe('Selection statistics in the native status bar', () => {
  for (const separator of [',', '\t']) {
    it(`updates mouse, keyboard, row and rectangular selections (${JSON.stringify(separator)})`, async () => {
      const host = await createEditorHarness({ separator, rows: [['2026', 'Value'], ['2', 'text'], ['4', '6'], ['', '0']] });
      const view = createWebviewDom(host.panel.webview.html);
      try {
        await deliver(host, view);
        assert.strictEqual(status(host), undefined);
        click(view, 1, 0);
        await deliver(host, view);
        assert.strictEqual(status(host), 'Sum: 2  Average: 2  Count: 1');
        click(view, 2, 1, { shiftKey: true });
        await deliver(host, view);
        assert.strictEqual(status(host), 'Sum: 12  Average: 4  Count: 3');
        click(view, 2, -1);
        await deliver(host, view);
        assert.strictEqual(status(host), 'Sum: 10  Average: 5  Count: 2');
        click(view, 1, 0);
        view.key('ArrowDown', { shiftKey: true });
        await deliver(host, view);
        assert.strictEqual(status(host), 'Sum: 6  Average: 3  Count: 2');
        view.key('a', { ctrlKey: true });
        await deliver(host, view);
        assert.strictEqual(status(host), 'Sum: 12  Average: 3  Count: 4');
        view.key('Escape');
        await deliver(host, view);
        assert.strictEqual(status(host), undefined);
        click(view, 1, 1);
        await deliver(host, view);
        assert.strictEqual(status(host), undefined, 'text does not count');
        click(view, 4, 0);
        await deliver(host, view);
        assert.strictEqual(status(host), undefined, 'the append row does not count');
        click(view, 0, 0);
        await deliver(host, view);
        assert.strictEqual(status(host), 'Sum: 6  Average: 3  Count: 2');
        click(view, 0, 0);
        await deliver(host, view);
        assert.strictEqual(status(host), undefined, 'a numeric header selected on its own does not count');
      } finally { view.close(); host.dispose(); }
    });
  }

  it('ignores hidden rows and restores a numeric selection with headers and serial index off', async () => {
    const host = await createEditorHarness({ rows: [['100'], ['2'], ['4'], ['6']], header: false, serialIndex: false, hiddenRows: 1,
      filters: [{ column: 0, operator: 'notEquals', value: '4', dataType: 'number' }] });
    const view = createWebviewDom(host.panel.webview.html, { anchorRow: 1, anchorCol: 0 });
    try {
      await deliver(host, view);
      assert.strictEqual(status(host), 'Sum: 2  Average: 2  Count: 1');
      click(view, 3, 0, { shiftKey: true });
      await deliver(host, view);
      assert.strictEqual(status(host), 'Sum: 8  Average: 4  Count: 2');
      view.key('a', { ctrlKey: true });
      await deliver(host, view);
      assert.strictEqual(status(host), 'Sum: 8  Average: 4  Count: 2');
    } finally { view.close(); host.dispose(); }
  });

  it('includes remote chunks in column/table totals without loading them into the webview', async () => {
    const host = await createEditorHarness({ rows: [['Value'], ...Array.from({ length: 1200 }, () => ['2'])] });
    const view = createWebviewDom(host.panel.webview.html);
    try {
      await deliver(host, view);
      assert.strictEqual(view.cell(1200, 0), null);
      click(view, 0, 0);
      await deliver(host, view);
      assert.strictEqual(status(host), 'Sum: 2400  Average: 2  Count: 1200');
      view.key('a', { ctrlKey: true });
      await deliver(host, view);
      assert.strictEqual(status(host), 'Sum: 2400  Average: 2  Count: 1200');
      assert.strictEqual(view.cell(1200, 0), null);
      view.window.__csvLoadNextChunk();
      await deliver(host, view);
      const chunk = host.messages.find(message => message.type === 'chunkData');
      assert.ok(chunk);
      view.window.dispatchEvent(new view.window.MessageEvent('message', { data: chunk }));
      assert.ok(view.cell(1200, 0).classList.contains('selected'), 'later chunks inherit the selection represented by the totals');
      await deliver(host, view);
      assert.strictEqual(status(host), 'Sum: 2400  Average: 2  Count: 1200');
    } finally { view.close(); host.dispose(); }
  });

  it('updates committed edits and hides while editing, inactive, or disposed', async () => {
    const host = await createEditorHarness({ rows: [['Value'], ['2'], ['4']], untitled: true });
    const view = createWebviewDom(host.panel.webview.html);
    try {
      await deliver(host, view);
      click(view, 0, 0);
      await deliver(host, view);
      assert.strictEqual(status(host), 'Sum: 6  Average: 3  Count: 2');
      await host.receive({ type: 'editCell', row: 1, col: 0, value: '10' });
      assert.strictEqual(status(host), 'Sum: 14  Average: 7  Count: 2');
      await host.view(false, true);
      assert.strictEqual(status(host), undefined);
      await host.view(true, true);
      assert.strictEqual(status(host), 'Sum: 14  Average: 7  Count: 2');
      view.start(view.cell(1, 0));
      await deliver(host, view);
      assert.strictEqual(status(host), undefined, 'uncommitted cell drafts are not selection totals');
      view.cell(1, 0).textContent = '8';
      view.key('Tab', { shiftKey: true });
      await deliver(host, view);
      click(view, 0, 0);
      await deliver(host, view);
      assert.strictEqual(status(host), 'Sum: 12  Average: 6  Count: 2');
      host.dispose();
      assert.strictEqual(status(host), undefined);
      assert.ok(host.statusBarItems.every(item => item.disposed));
    } finally { view.close(); if (!host.panel.disposed) { host.dispose(); } }
  });

  it('rejects stale messages after filter changes and full refreshes', async () => {
    const host = await createEditorHarness({ rows: [['Value'], ['2'], ['4']] });
    const view = createWebviewDom(host.panel.webview.html);
    try {
      await deliver(host, view);
      click(view, 0, 0);
      await paint(view);
      const selected = view.messages.find(message => message.type === 'selectionChanged');
      assert.ok(selected);
      await deliver(host, view);
      await host.receive({ type: 'updateColumnFilters', session: selected.session, revision: 1,
        filters: [{ column: 0, operator: 'equals', value: '2' }] });
      assert.strictEqual(status(host), undefined);
      await host.receive(selected);
      assert.strictEqual(status(host), undefined, 'the old filter epoch cannot restore stale totals');
      await host.receive({ ...selected, filterEpoch: 1 });
      assert.strictEqual(status(host), 'Sum: 2  Average: 2  Count: 1');
      await host.view(false, false);
      await host.view(true, true);
      assert.strictEqual(status(host), undefined);
      await host.receive({ ...selected, filterEpoch: 1 });
      assert.strictEqual(status(host), undefined, 'the old webview session cannot restore stale totals');
    } finally { view.close(); host.dispose(); }
  });

  it('keeps status values owned by the active editor when a background editor reports a selection', async () => {
    const first = await createEditorHarness({ rows: [['Value'], ['2']], fileName: '/test/first.csv' });
    const firstView = createWebviewDom(first.panel.webview.html);
    let second: Host | undefined;
    let secondView: View | undefined;
    try {
      await deliver(first, firstView);
      click(firstView, 1, 0);
      await deliver(first, firstView);
      assert.strictEqual(status(first), 'Sum: 2  Average: 2  Count: 1');
      await first.view(false, true);
      second = await createEditorHarness({ rows: [['Value'], ['10']], fileName: '/test/second.csv' });
      secondView = createWebviewDom(second.panel.webview.html);
      await deliver(second, secondView);
      click(secondView, 1, 0);
      await deliver(second, secondView);
      assert.strictEqual(status(first), undefined);
      assert.strictEqual(status(second), 'Sum: 10  Average: 10  Count: 1');
      click(firstView, 0, 0);
      await deliver(first, firstView);
      assert.strictEqual(status(first), undefined);
      assert.strictEqual(status(second), 'Sum: 10  Average: 10  Count: 1');
      await second.view(false, true);
      await first.view(true, true);
      assert.strictEqual(status(first), 'Sum: 2  Average: 2  Count: 1');
      assert.strictEqual(status(second), undefined);
    } finally { firstView.close(); first.dispose(); secondView?.close(); second?.dispose(); }
  });
});
