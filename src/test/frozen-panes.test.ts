import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { describe, it } from 'node:test';
import { createEditorHarness, createWebviewDom } from './edit-integrity-harness';
const { CsvEditorProvider } = require('../CsvEditorProvider') as typeof import('../CsvEditorProvider');

function measure(view: ReturnType<typeof createWebviewDom>, heights = [25, 60, 35, 30]) {
  for (const row of Array.from(view.window.document.querySelectorAll('tr')) as any[]) {
    const index = Number(row.querySelector('[data-row]')?.getAttribute('data-row'));
    const height = () => (heights[index] ?? 30) * (parseFloat(view.window.document.body.style.fontSize) / 14 || 1);
    row.getBoundingClientRect = () => ({ height: height() });
    for (const cell of Array.from(row.cells) as any[]) {
      const col = cell.getAttribute('data-col') === null ? -1 : Number(cell.getAttribute('data-col'));
      const width = () => parseFloat(cell.style.width) || (col === -1 ? 30 : (col === 0 ? 90 : 140));
      cell.getBoundingClientRect = () => ({ left: col === -1 ? 0 : 30 + col * 90, right: col === -1 ? 30 : 30 + col * 90 + width(), width: width(), height: height() });
    }
  }
}

async function fixture(options: Parameters<typeof createEditorHarness>[0] = {}) {
  const host = await createEditorHarness({ rows: [['Name', 'Value'], ['one\nsecond line', 'a'], ['two', 'b'], ['three', 'c']], ...options });
  const view = createWebviewDom(host.panel.webview.html);
  measure(view);
  return { host, view };
}

describe('Frozen panes', () => {
  it('keeps measured multiline leading rows and data columns with proper corner stacking', async () => {
    const { view } = await fixture({ frozenRows: 3, frozenColumns: 1 });
    try {
      view.window.csvFrozenPanes.layout();
      assert.strictEqual(view.cell(0, 0).style.top, '-0.5px');
      assert.strictEqual(view.cell(1, 0).style.top, '24.5px');
      assert.strictEqual(view.cell(2, 0).style.top, '84.5px');
      assert.strictEqual(view.cell(1, -1).style.left, '0px');
      assert.strictEqual(view.cell(1, 0).style.left, '30px');
      assert.strictEqual(view.cell(1, 0).style.zIndex, '4');
      assert.strictEqual(view.cell(1, 1).style.zIndex, '3');
      assert.strictEqual(view.cell(3, 0).style.zIndex, '2');
      assert.ok(!view.cell(3, 1).classList.contains('csv-frozen-row'));
      assert.ok(!view.cell(4, 0).classList.contains('csv-frozen-row'), 'append row remains virtual');
    } finally { view.close(); }
  });

  it('covers the collapsed top border once without rounding fractional row spacing', async () => {
    const { view } = await fixture({ frozenRows: 3, frozenColumns: 1 });
    try {
      const table = view.window.document.querySelector('table');
      measure(view, [25.5, 60.25, 35.75, 30]);
      for (const [collapse, border, firstTop] of [
        ['collapse', 1, -0.5],
        ['collapse', 2, -1],
        ['collapse', 0, 0],
        ['separate', 1, 0]
      ] as const) {
        table.style.borderCollapse = collapse;
        for (const cell of Array.from(table.querySelectorAll('th, td')) as any[]) {
          cell.style.borderTopWidth = `${border}px`;
        }
        view.window.csvFrozenPanes.layout();
        assert.strictEqual(view.cell(0, 0).style.top, `${firstTop}px`);
        assert.strictEqual(view.cell(1, 0).style.top, `${firstTop + 25.5}px`);
        assert.strictEqual(view.cell(2, 0).style.top, `${firstTop + 85.75}px`);
        assert.strictEqual(table.rows[0].cells[0].style.top, `${firstTop}px`, 'serial corner shares the frozen row origin');
        assert.strictEqual(view.cell(0, 0).style.left, '30px', 'horizontal offsets remain measured independently');
      }
    } finally { view.close(); }
  });

  it('recomputes measured offsets after zoom and column resizing', async () => {
    const { view } = await fixture({ frozenRows: 3, frozenColumns: 2 });
    try {
      view.window.csvFrozenPanes.layout();
      view.cell(1, 0).focus();
      view.key('+', { ctrlKey: true });
      view.window.csvFrozenPanes.layout();
      assert.strictEqual(view.cell(2, 0).style.top, '93px');
      view.cell(0, 0).style.width = '200px';
      view.window.csvFrozenPanes.layout();
      assert.strictEqual(view.cell(1, 1).style.left, '230px');
    } finally { view.close(); }
  });

  it('supports headers off and hidden metadata without freezing the append row', async () => {
    const { view } = await fixture({ header: false, frozenRows: 100, hiddenRows: 1 });
    try {
      view.window.csvFrozenPanes.layout();
      assert.strictEqual(view.cell(1, 0).style.top, '-0.5px');
      assert.strictEqual(view.cell(2, 0).style.top, '59.5px');
      assert.ok(!view.cell(4, 0).classList.contains('csv-frozen-row'));
    } finally { view.close(); }
  });

  it('preserves the existing default header freeze and allows explicit zero to unfreeze it', async () => {
    const { host, view } = await fixture();
    try {
      view.window.csvFrozenPanes.layout();
      assert.ok(view.cell(0, 0).classList.contains('csv-frozen-row'));
      await host.receive({ type: 'freezePanesChanged', rows: 0, columns: 0 });
      const update = host.messages.slice().reverse().find((message: any) => message.type === 'frozenPanes');
      view.window.dispatchEvent(new view.window.MessageEvent('message', { data: update }));
      view.window.csvFrozenPanes.layout();
      assert.ok(!view.cell(0, 0).classList.contains('csv-frozen-row'));
      assert.strictEqual(view.cell(0, 0).style.top, '', 'unfreezing clears the collapsed-border correction');
      assert.strictEqual(view.cell(1, 0).style.top, '');
      assert.deepStrictEqual(CsvEditorProvider.getFrozenPanesForUri(host.context as any, host.document.uri as any, true), { rows: 0, columns: 0 });
    } finally { view.close(); }
  });

  it('persists each axis by URI and retains defaults for untouched files/header modes', async () => {
    const { host, view } = await fixture();
    try {
      const uri = host.document.uri as any;
      await CsvEditorProvider.setFrozenPanesForUri(host.context as any, uri, { rows: 3 });
      await CsvEditorProvider.setFrozenPanesForUri(host.context as any, uri, { columns: 2 });
      assert.deepStrictEqual(CsvEditorProvider.getFrozenPanesForUri(host.context as any, uri, true), { rows: 3, columns: 2 });
      await CsvEditorProvider.setFrozenPanesForUri(host.context as any, uri, { rows: -1, columns: Infinity });
      assert.deepStrictEqual(CsvEditorProvider.getFrozenPanesForUri(host.context as any, uri, true), { rows: 3, columns: 2 });
      const other = { toString: () => 'file:///other.tsv' } as any;
      assert.deepStrictEqual(CsvEditorProvider.getFrozenPanesForUri(host.context as any, other, true), { rows: 1, columns: 0 });
      assert.deepStrictEqual(CsvEditorProvider.getFrozenPanesForUri(host.context as any, other, false), { rows: 0, columns: 0 });
    } finally { view.close(); }
  });

  it('updates freeze state without replacing an active multiline draft, caret or selection', async () => {
    const { host, view } = await fixture();
    try {
      const cell = view.cell(1, 0);
      view.start(cell);
      cell.textContent = 'unsaved\nmultiline draft';
      view.caret(cell.firstChild, 8);
      const html = host.panel.webview.html;
      await host.receive({ type: 'freezePanesChanged', rows: 3, columns: 1 });
      const update = host.messages.slice().reverse().find((message: any) => message.type === 'frozenPanes');
      view.window.dispatchEvent(new view.window.MessageEvent('message', { data: update }));
      view.window.csvFrozenPanes.layout();
      assert.strictEqual(host.panel.webview.html, html);
      assert.strictEqual(view.cell(1, 0), cell);
      assert.strictEqual(cell.textContent, 'unsaved\nmultiline draft');
      assert.strictEqual(view.window.document.activeElement, cell);
      assert.strictEqual(view.window.getSelection().anchorOffset, 8);
    } finally { view.close(); }
  });

  it('requests and freezes leading rows extending beyond the initial remote chunk', async () => {
    const rows = Array.from({ length: 1100 }, (_, row) => [`row${row}`, 'value']);
    const { host, view } = await fixture({ rows, frozenRows: 1002, frozenColumns: 1 });
    try {
      view.window.csvFrozenPanes.layout();
      const request = view.messages.find((message: any) => message.type === 'requestChunk');
      assert.ok(request);
      await host.receive(request);
      const response = host.messages.slice().reverse().find((message: any) => message.type === 'chunkData');
      view.window.dispatchEvent(new view.window.MessageEvent('message', { data: response }));
      view.window.csvFrozenPanes.layout();
      view.window.csvFrozenPanes.layout();
      assert.ok(view.cell(1001, 0).classList.contains('csv-frozen-row'));
      assert.ok(view.cell(1002, 0).classList.contains('csv-frozen-column'));
      const appendRequest = view.messages.slice().reverse().find((message: any) => message.type === 'requestChunk');
      await host.receive(appendRequest);
      const appendResponse = host.messages.slice().reverse().find((message: any) => message.type === 'chunkData');
      view.window.dispatchEvent(new view.window.MessageEvent('message', { data: appendResponse }));
      view.window.__csvLoadNextChunk();
      view.window.csvFrozenPanes.layout();
      assert.ok(!view.cell(1100, 0).classList.contains('csv-frozen-row'));
    } finally { view.close(); }
  });

  it('freezes through a context-menu target using visible row counts and can unfreeze', async () => {
    const { view } = await fixture({ hiddenRows: 1, header: false });
    try {
      const target = view.cell(2, 1);
      const openMenu = () => {
        target.dispatchEvent(new view.window.MouseEvent('mousedown', { button: 2, bubbles: true, cancelable: true }));
        target.dispatchEvent(new view.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      };
      const choose = (label: string) => {
        const item = Array.from(view.window.document.querySelectorAll('#contextMenu div')).find((element: any) => element.textContent === label) as any;
        assert.ok(item, label);
        item.click();
      };
      openMenu();
      choose('Freeze rows through this row');
      openMenu();
      choose('Freeze columns through this column');
      view.window.csvFrozenPanes.layout();
      assert.strictEqual(view.cell(2, 1).style.zIndex, '4');
      assert.deepStrictEqual(JSON.parse(JSON.stringify(view.messages.filter((message: any) => message.type === 'freezePanesChanged'))), [
        { type: 'freezePanesChanged', rows: 2, columns: 0 }, { type: 'freezePanesChanged', rows: 2, columns: 2 }
      ]);
      openMenu();
      choose('Unfreeze rows');
      view.window.csvFrozenPanes.layout();
      assert.ok(!view.cell(2, 1).classList.contains('csv-frozen-row'));
      assert.ok(view.cell(2, 1).classList.contains('csv-frozen-column'));
    } finally { view.close(); }
  });

  it('observes row-height changes and recalculates sticky offsets on the next frame', async () => {
    const { view } = await fixture({ frozenRows: 3 });
    try {
      view.window.csvFrozenPanes.dispose();
      let resized = () => {};
      let observed = 0;
      let disconnected = false;
      view.window.ResizeObserver = class {
        constructor(callback: () => void) { resized = callback; }
        observe() { observed++; }
        disconnect() { disconnected = true; }
      };
      const heights = [25, 60, 35, 30];
      measure(view, heights);
      const manager = view.window.createFrozenPaneManager({ table: view.window.document.querySelector('table'), firstRow: 0, realRowCount: 4 });
      manager.update(3, 0);
      await new Promise(resolve => view.window.requestAnimationFrame(resolve));
      assert.ok(observed > 0);
      assert.strictEqual(view.cell(2, 0).style.top, '84.5px');
      heights[1] = 100;
      resized();
      await new Promise(resolve => view.window.requestAnimationFrame(resolve));
      assert.strictEqual(view.cell(2, 0).style.top, '124.5px');
      manager.dispose();
      assert.strictEqual(disconnected, true);
    } finally { view.close(); }
  });

  it('adds documented command contributions and opaque sticky theme surfaces', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
    const readme = fs.readFileSync(path.join(process.cwd(), 'README.md'), 'utf8');
    for (const command of ['csv.changeFrozenRows', 'csv.changeFrozenColumns']) {
      assert.ok(manifest.contributes.commands.some((item: any) => item.command === command));
      assert.ok(manifest.activationEvents.includes(`onCommand:${command}`));
      assert.ok(readme.includes(command));
    }
    const provider = fs.readFileSync(path.join(process.cwd(), 'src', 'CsvEditorProvider.ts'), 'utf8');
    assert.ok(provider.includes('background-color: var(--vscode-editor-background,'));
    assert.ok(provider.includes('background-image: linear-gradient(var(--vscode-editor-selectionBackground,'));
  });
});
