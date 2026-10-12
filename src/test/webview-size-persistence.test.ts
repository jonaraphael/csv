import assert from 'assert';
import { describe, it } from 'node:test';
import fs from 'fs';
import path from 'path';
import vm from 'vm';

describe('Webview size persistence', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'media', 'main.js'), 'utf8');

  it('persists column and row sizes in webview state', () => {
    assert.ok(source.includes('columnSizes: { ...columnSizeState }'));
    assert.ok(source.includes('rowSizes: { ...rowSizeState }'));
    assert.ok(source.includes('zoomScale'));
  });

  it('restores and reapplies size state after render/chunk loads', () => {
    assert.ok(source.includes("columnSizeState = normalizeSizeState(st.columnSizes ?? JSON.parse(root?.dataset?.columnsizes || '{}'), 40);"));
    assert.ok(source.includes('rowSizeState = normalizeSizeState(st.rowSizes, getMinRowHeight());'));
    assert.ok(source.includes('setZoomScale(restoredZoom ?? 1, false);'));
    assert.ok(source.includes('applySizeStateToRenderedCells();'));
  });

  it('updates in-memory size maps when resizing', () => {
    assert.ok(source.includes('columnSizeState[String(col)] = width;'));
    assert.ok(source.includes('rowSizeState[String(row)] = height;'));
    assert.ok(source.includes('Math.max(getMinRowHeight(), Math.round(heightPx))'));
  });

  it('derives a dynamic minimum row height from configured font size', () => {
    assert.ok(source.includes('const BASE_FONT_SIZE_PX ='));
    assert.ok(source.includes('const ZOOM_MIN = 0.5;'));
    assert.ok(source.includes('const ZOOM_MAX = 3.0;'));
    assert.ok(source.includes('const getMinRowHeight = () => Math.max(22, Math.round(BASE_FONT_SIZE_PX * zoomScale * 1.6));'));
  });

  it('removes size overrides from state when reset to defaults', () => {
    assert.ok(source.includes('delete columnSizeState[String(col)];'));
    assert.ok(source.includes('delete rowSizeState[String(row)];'));
  });
});


describe('Durable webview column widths', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'media', 'main.js'), 'utf8');
  const section = (start: string, end: string) => source.slice(source.indexOf(start), source.indexOf(end));
  const script = [
    'let columnSizeState = {}, rowSizeState = {};',
    section('const normalizeSizeState =', 'const getFirstDataRow ='),
    section('const persistColumnWidths =', '/* ──────────── VIRTUAL-SCROLL LOADER'),
    section('const applyColumnWidth =', 'const applyRowHeight ='),
    section('const onGlobalDragEnd =', "document.addEventListener('mousemove'")
  ].join('\n');

  it('restores saved widths without webview state and reapplies them to new chunks', () => {
    const cells = [{ style: {} as Record<string, string> }];
    const messages: any[] = [];
    let state: any = undefined;
    const context = vm.createContext({
      root: { dataset: { columnsizes: '{"0":175}' } },
      table: { style: {}, querySelectorAll: () => cells },
      vscode: { getState: () => state, postMessage: (msg: any) => messages.push(msg) },
      parsePositiveNumber: () => undefined, setZoomScale: () => {},
      getMinRowHeight: () => 22, persistState: () => {},
      resizeState: { axis: 'column' }, reorderState: null
    });
    vm.runInContext(script + '\nrestoreState();', context);
    assert.strictEqual(cells[0].style.width, '175px');
    cells.push({ style: {} });
    vm.runInContext('applySizeStateToRenderedCells();', context);
    assert.strictEqual(cells[1].style.width, '175px');
    vm.runInContext('applyColumnWidth(0, 220); onGlobalDragEnd();', context);
    assert.strictEqual(messages.length, 1);
    assert.strictEqual(messages[0].type, 'saveColumnWidths');
    assert.strictEqual(messages[0].columnSizes[0], 220);
    vm.runInContext('resetColumnWidth(0); persistColumnWidths();', context);
    assert.strictEqual(Object.keys(messages[1].columnSizes).length, 0);
    state = { columnSizes: {} };
    vm.runInContext('restoreState();', context);
    assert.strictEqual(cells[0].style.width, '');
    context.resizeState = { axis: 'row' };
    vm.runInContext('onGlobalDragEnd();', context);
    assert.strictEqual(messages.length, 2, 'row resize must not write column storage');
  });
});
