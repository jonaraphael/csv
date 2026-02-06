import assert from 'assert';
import { describe, it } from 'node:test';
import fs from 'fs';
import path from 'path';

describe('Webview edit shortcuts', () => {
  const webviewSource = fs.readFileSync(path.join(process.cwd(), 'media', 'main.js'), 'utf8');

  it('supports Shift+Enter to insert newline while editing', () => {
    assert.ok(webviewSource.includes('const insertNewlineAtCaret = cell => {'));
    assert.ok(webviewSource.includes("const NEWLINE_SENTINEL_ATTR = 'data-csv-newline-sentinel';"));
    assert.ok(webviewSource.includes("if (editingCell && e.key === 'Enter') {"));
    assert.ok(webviewSource.includes('if (e.shiftKey) {'));
    assert.ok(webviewSource.includes('insertNewlineAtCaret(editingCell)'));
    assert.ok(webviewSource.includes('appendVisibleNewlineAtEnd(editingCell)'));
  });

  it('supports Shift+Enter from selection on first press', () => {
    assert.ok(webviewSource.includes('if (!editingCell && anchorCell && currentSelection.length === 1) {'));
    assert.ok(webviewSource.includes('if (e.shiftKey) {'));
    assert.ok(webviewSource.includes('Shift+Enter from selection should open detail edit and insert'));
    assert.ok(webviewSource.includes('appendVisibleNewlineAtEnd(cell);'));
  });

  it('removes temporary newline sentinels before saving edited cell text', () => {
    assert.ok(webviewSource.includes('const removeNewlineSentinels = cell => {'));
    assert.ok(webviewSource.includes('removeNewlineSentinels(cell);'));
    assert.ok(webviewSource.includes("const value = cell.textContent;"));
  });

  it('keeps non-edit Tab navigation in sync with selection state', () => {
    assert.ok(webviewSource.includes("if (!editingCell && e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) {"));
    assert.ok(webviewSource.includes('const nextCell = ensureRenderedCellByCoords(targetRow, targetCol);'));
    assert.ok(webviewSource.includes('setSingleSelection(nextCell);'));
    assert.ok(webviewSource.includes('const setSingleSelection = cell => {'));
  });

  it('commits edit-mode Enter and moves selection down without auto-entering edit mode', () => {
    assert.ok(webviewSource.includes('Editing Enter commits and moves selection down (no auto-edit).'));
    assert.ok(webviewSource.includes('const nextCell = ensureRenderedCellByCoords(targetRow, col);'));
    assert.ok(webviewSource.includes('setSingleSelection(nextCell);'));
  });

  it('commits edit-mode Tab and moves selection without auto-entering edit mode', () => {
    assert.ok(webviewSource.includes("if (editingCell && e.key === 'Tab') {"));
    assert.ok(webviewSource.includes('Editing Tab commits and moves selection only (no auto-edit).'));
    assert.ok(webviewSource.includes('const nextCell = canMove ? ensureRenderedCellByCoords(targetRow, targetCol) : null;'));
    assert.ok(webviewSource.includes('setSingleSelection(nextCell);'));
  });
});
