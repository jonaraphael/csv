import assert from 'assert';
import { describe, it } from 'node:test';
import fs from 'fs';
import path from 'path';

describe('Webview reorder and resize interactions', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'media', 'main.js'), 'utf8');

  it('starts reorder only from preselected header or row-index cells', () => {
    assert.ok(source.includes('startReorderDrag'));
    assert.ok(source.includes('target.classList.contains(\'selected\')'));
    assert.ok(source.includes('!e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && startReorderDrag(target, e)'));
  });

  it('posts reorder messages for columns and rows', () => {
    assert.ok(source.includes("type: 'reorderColumns'"));
    assert.ok(source.includes("type: 'reorderRows'"));
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
