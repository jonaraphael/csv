import assert from 'assert';
import { describe, it } from 'node:test';
import fs from 'fs';
import path from 'path';

describe('Webview reorder and resize interactions', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'media', 'main.js'), 'utf8');
  const providerSource = fs.readFileSync(path.join(process.cwd(), 'src', 'CsvEditorProvider.ts'), 'utf8');

  it('starts column reorder directly from any column header', () => {
    assert.ok(source.includes('startReorderDrag'));
    assert.ok(source.includes('if (isColumnHeaderCell(target))'));
    assert.ok(source.includes('selectFullColumnRange(col, col)'));
    assert.ok(source.includes('!e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && startReorderDrag(target, e)'));
  });

  it('posts reorder messages for columns and rows', () => {
    assert.ok(source.includes("type: 'reorderColumns'"));
    assert.ok(source.includes("type: 'reorderRows'"));
  });

  it('shows a vertical insertion guideline while dragging a column', () => {
    assert.ok(source.includes('showColumnDropIndicator(target.indicatorX)'));
    assert.ok(source.includes("dragIndicator.style.width = '2px'"));
    assert.ok(source.includes("dragIndicator.style.display = 'block'"));
  });

  it('cycles header clicks through no sort, ascending, and descending', () => {
    assert.ok(source.includes('scheduleHeaderSort(sourceIndex)'));
    assert.ok(source.includes('cycleColumnSortState(col)'));
    assert.ok(source.includes('sorts.push({ index: col, ascending: true })'));
    assert.ok(source.includes('existing.ascending = false'));
    assert.ok(source.includes('sorts.splice(sorts.indexOf(existing), 1)'));
    assert.ok(source.includes("header.setAttribute('aria-sort', sort.ascending ? 'ascending' : 'descending')"));
  });

  it('renders copy-safe arrows with their chained sort priorities', () => {
    assert.ok(source.includes("table.querySelectorAll('.sort-indicator').forEach(indicator => indicator.remove())"));
    assert.ok(source.includes("header.setAttribute('data-sort-priority', String(priority + 1))"));
    assert.ok(providerSource.includes('th[aria-sort="ascending"]::after { content: " ↑" attr(data-sort-priority)'));
    assert.ok(providerSource.includes('th[aria-sort="descending"]::after { content: " ↓" attr(data-sort-priority)'));
    assert.ok(source.includes("vscode.postMessage({ type: 'sortColumns', sorts })"));
  });

  it('reapplies every sort from a baseline and restores it when the chain is empty', () => {
    assert.ok(providerSource.includes('this.sortBaselineText = this.document.getText()'));
    assert.ok(providerSource.includes('const result = Papa.parse(this.sortBaselineText'));
    assert.ok(providerSource.includes('edit.replace(this.document.uri, fullRange, originalText)'));
  });

  it('keeps double-click available for header editing', () => {
    assert.ok(source.includes("table.addEventListener('dblclick', e => {\n  cancelPendingHeaderSort(true)"));
    assert.ok(!source.includes("indicator.textContent = st.sortAscending"));
  });

  it('retains rapid clicks on different headers in the same chain', () => {
    assert.ok(source.includes('pendingHeaderSortColumn === col'));
    assert.ok(source.includes('pendingHeaderSortInitial = getColumnSorts()'));
    assert.ok(source.includes("vscode.postMessage({ type: 'sortColumns', sorts })"));
  });

  it('supports drag-resize for columns and rows', () => {
    assert.ok(source.includes('startResizeDrag'));
    assert.ok(source.includes('col-resize'));
    assert.ok(source.includes('row-resize'));
  });

  it('resets resized column/row on edge double-click', () => {
    assert.ok(source.includes('getResizeEdgeInfo'));
    assert.ok(source.includes('table.addEventListener(\'dblclick\''));
    assert.ok(source.includes('resetColumnWidth(edge.index)'));
    assert.ok(source.includes('resetRowHeight(edge.index)'));
  });
});
