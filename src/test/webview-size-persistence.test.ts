import assert from 'assert';
import { describe, it } from 'node:test';
import fs from 'fs';
import path from 'path';

describe('Webview size persistence', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'media', 'main.js'), 'utf8');

  it('persists column and row sizes in webview state', () => {
    assert.ok(source.includes('columnSizes: { ...columnSizeState }'));
    assert.ok(source.includes('rowSizes: { ...rowSizeState }'));
  });

  it('restores and reapplies size state after render/chunk loads', () => {
    assert.ok(source.includes('columnSizeState = normalizeSizeState(st.columnSizes, 40);'));
    assert.ok(source.includes('rowSizeState = normalizeSizeState(st.rowSizes, MIN_ROW_HEIGHT);'));
    assert.ok(source.includes('applySizeStateToRenderedCells();'));
  });

  it('updates in-memory size maps when resizing', () => {
    assert.ok(source.includes('columnSizeState[String(col)] = width;'));
    assert.ok(source.includes('rowSizeState[String(row)] = height;'));
    assert.ok(source.includes('Math.max(MIN_ROW_HEIGHT, Math.round(heightPx))'));
  });

  it('derives a dynamic minimum row height from configured font size', () => {
    assert.ok(source.includes('const BASE_FONT_SIZE_PX ='));
    assert.ok(source.includes('const MIN_ROW_HEIGHT = Math.max(22, Math.round(BASE_FONT_SIZE_PX * 1.6));'));
  });

  it('removes size overrides from state when reset to defaults', () => {
    assert.ok(source.includes('delete columnSizeState[String(col)];'));
    assert.ok(source.includes('delete rowSizeState[String(row)];'));
  });
});
