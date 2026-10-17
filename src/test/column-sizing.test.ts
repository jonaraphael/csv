import assert from 'assert';
import Module from 'module';
import vm from 'vm';
import { describe, it } from 'node:test';
import { createWebview } from '../test-support/sizing-webview-harness';

const originalRequire = Module.prototype.require;
Module.prototype.require = function (id: string) {
  if (id === 'vscode') { return { window: { activeColorTheme: { kind: 1 } }, ColorThemeKind: { Dark: 1 } }; }
  return originalRequire.apply(this, arguments as any);
};
import { CsvEditorProvider } from '../CsvEditorProvider';
Module.prototype.require = originalRequire;

describe('Column sizing behavior', () => {
  it('measures longest physical line across LF, CRLF and CR without counting separators', () => {
    assert.deepStrictEqual(CsvEditorProvider.__test.computeColumnWidths([
      ['short\nlongest', 'a\r\nb\r\nc', '123\r45', ''],
      ['x\nx\nx\nx\nx\nx\nx\nx', 'header', '1', 'tiny']
    ]), [7, 6, 3, 4]);
  });

  it('stores validated manual widths per URI and removes only the reset file', async () => {
    const store: Record<string, any> = {};
    const context = { workspaceState: {
      get: (key: string, fallback: any) => store[key] ?? fallback,
      update: async (key: string, value: any) => { store[key] = value; }
    }} as any;
    const first = { toString: () => 'file:///one.csv' } as any;
    const second = { toString: () => 'file:///two.tsv' } as any;
    await CsvEditorProvider.setColumnSizesForUri(context, first, { '0': 180.3, '-1': 100, invalid: 200, '1': 39, '2': Infinity });
    await CsvEditorProvider.setColumnSizesForUri(context, second, { '1': 220 });
    assert.deepStrictEqual(CsvEditorProvider.getColumnSizesForUri(context, first), { '0': 180 });
    assert.deepStrictEqual(CsvEditorProvider.getColumnSizesForUri(context, second), { '1': 220 });
    await CsvEditorProvider.setColumnSizesForUri(context, first, {});
    assert.deepStrictEqual(CsvEditorProvider.getColumnSizesForUri(context, first), {});
    assert.deepStrictEqual(CsvEditorProvider.getColumnSizesForUri(context, second), { '1': 220 });
  });

  it('restores durable widths when a fresh webview opens, including newly mounted chunks', () => {
    const view = createWebview({ persistedColumns: { '0': 210 } });
    const cell = view.cell(1, 0, 'initial');
    vm.runInContext('applySizeStateToRenderedCells();', view.context);
    assert.strictEqual(cell.style.width, '210px');
    assert.strictEqual(cell.style.boxSizing, 'border-box');
    const chunkCell = view.cell(1001, 0, 'later chunk');
    vm.runInContext('applySizeStateToRenderedCells();', view.context);
    assert.strictEqual(chunkCell.style.minWidth, '210px');
    assert.strictEqual(chunkCell.style.boxSizing, 'border-box');
    vm.runInContext('resetColumnWidth(0);', view.context);
    assert.strictEqual(cell.style.boxSizing, '');
    assert.strictEqual(chunkCell.style.boxSizing, '');
  });

  it('honors an explicit webview reset over durable values and restores automatic CSS', () => {
    const reset = createWebview({ state: { columnSizes: {} }, persistedColumns: { '0': 210 } });
    const untouched = reset.cell(1, 0, 'initial');
    vm.runInContext('applySizeStateToRenderedCells();', reset.context);
    assert.strictEqual(untouched.style.minWidth, '8ch');
    const view = createWebview({ persistedColumns: { '0': 210 } });
    const cell = view.cell(1, 0, 'initial');
    vm.runInContext('applySizeStateToRenderedCells(); resetColumnWidth(0); persistColumnSizes();', view.context);
    assert.strictEqual(cell.style.width, '');
    assert.strictEqual(cell.style.minWidth, '8ch');
    assert.strictEqual(cell.style.maxWidth, '100ch');
    assert.deepStrictEqual(view.messages, [{ type: 'columnSizesChanged', columnSizes: {} }]);
  });

  it("restores each cell's original box sizing after repeated resizes", () => {
    const view = createWebview();
    const header = view.cell(0, 0, 'header', true);
    const body = view.cell(1, 0, 'body');
    header.style.boxSizing = 'content-box';
    body.style.boxSizing = 'border-box';
    vm.runInContext('applyColumnWidth(0, 140); applyColumnWidth(0, 180);', view.context);
    assert.strictEqual(header.style.boxSizing, 'border-box');
    assert.strictEqual(body.style.boxSizing, 'border-box');
    vm.runInContext('resetColumnWidth(0);', view.context);
    assert.strictEqual(header.style.boxSizing, 'content-box');
    assert.strictEqual(body.style.boxSizing, 'border-box');
    assert.strictEqual(header.style.minWidth, '8ch');
    assert.strictEqual(body.style.maxWidth, '100ch');
  });

  it('starts and saves a resize from both sides of a boundary with headers on or off', () => {
    for (const header of [true, false]) {
      for (const side of ['left', 'right']) {
        const view = createWebview({ header });
        const first = view.cell(header ? 0 : 1, 0, 'one', header);
        const second = view.cell(header ? 0 : 1, 1, 'two', header);
        const target = side === 'left' ? first : second;
        const clientX = side === 'left' ? 97 : 103;
        const clientY = header ? 15 : 45;
        const event = view.dispatch(target, 'mousedown', { button: 0, clientX, clientY });
        assert.strictEqual(event.defaultPrevented, true);
        assert.strictEqual(view.table.style.cursor, 'col-resize');
        view.dispatch(target, 'mousemove', { clientX: clientX + 50, clientY });
        view.dispatch(target, 'mouseup');
        assert.strictEqual(first.style.width, '150px');
        assert.strictEqual(second.style.width, '');
        assert.deepStrictEqual(view.messages, [{ type: 'columnSizesChanged', columnSizes: { '0': 150 } }]);
      }
    }
  });

  it('double-click resets a resized column and persists the reset', () => {
    const view = createWebview();
    const header = view.cell(0, 0, 'one', true);
    vm.runInContext('applyColumnWidth(0, 230);', view.context);
    view.dispatch(header, 'dblclick', { clientX: 96, clientY: 15 });
    assert.strictEqual(header.style.minWidth, '8ch');
    assert.deepStrictEqual(view.messages, [{ type: 'columnSizesChanged', columnSizes: {} }]);
  });
});
