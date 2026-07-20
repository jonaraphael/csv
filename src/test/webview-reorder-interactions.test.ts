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
    assert.ok(source.includes('requestColumnSort(col, true)'));
    assert.ok(source.includes('requestColumnSort(col, false)'));
    assert.ok(source.includes('clearColumnSortIndicator()'));
    assert.ok(source.includes("header.setAttribute('aria-sort', st.sortAscending ? 'ascending' : 'descending')"));
  });

  it('renders one copy-safe arrow and keeps double-click available for header editing', () => {
    assert.ok(source.includes("table.querySelectorAll('.sort-indicator').forEach(indicator => indicator.remove())"));
    assert.ok(providerSource.includes('th[aria-sort="ascending"]::after { content: " ↑"'));
    assert.ok(providerSource.includes('th[aria-sort="descending"]::after { content: " ↓"'));
    assert.ok(source.includes("table.addEventListener('dblclick', e => {\n  cancelPendingHeaderSort()"));
    assert.ok(!source.includes("indicator.textContent = st.sortAscending"));
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
