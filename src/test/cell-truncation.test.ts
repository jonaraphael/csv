import assert from 'assert';
import { describe, it } from 'node:test';
import fs from 'fs';
import path from 'path';

describe('Cell truncation and full content modal', () => {
  const providerSource = fs.readFileSync(path.join(process.cwd(), 'src', 'CsvEditorProvider.ts'), 'utf8');
  const webviewSource = fs.readFileSync(path.join(process.cwd(), 'media', 'main.js'), 'utf8');
  const packageSource = fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8');

  it('declares csv.maxCellHeightLines setting in package.json', () => {
    assert.ok(packageSource.includes('"csv.maxCellHeightLines"'));
    assert.ok(packageSource.includes('"default": 3'));
  });

  it('includes cell-content wrapper and dynamic line clamping CSS in provider', () => {
    assert.ok(providerSource.includes("config.get<number>('maxCellHeightLines', 3)"));
    assert.ok(providerSource.includes('.cell-content {'));
    assert.ok(providerSource.includes('-webkit-line-clamp:'));
    assert.ok(providerSource.includes('<div class="cell-content">'));
    assert.ok(providerSource.includes('td.editing .cell-content {'));
    assert.ok(providerSource.includes('data-maxcelllines='));
  });

  it('supports DOM cell text truncation (>1000 chars) and getCellContent IPC handler', () => {
    assert.ok(providerSource.includes('MAX_DOM_CELL_CHARS = 1000'));
    assert.ok(providerSource.includes('data-domtruncated="1"'));
    assert.ok(providerSource.includes("case 'getCellContent':"));
    assert.ok(providerSource.includes('handleGetCellContent'));
    assert.ok(webviewSource.includes("getAttribute('data-domtruncated') === '1'"));
    assert.ok(webviewSource.includes("type: 'getCellContent'"));
    assert.ok(webviewSource.includes("message.type === 'fullCellContent'"));
  });

  it('provides an editable modal textarea with header Save support', () => {
    assert.ok(!providerSource.includes('<textarea id="cellModalTextArea" readonly>'));
    assert.ok(providerSource.includes('id="cellModalTextArea"'));
    assert.ok(providerSource.includes('id="cellModalSaveBtn"'));
    assert.ok(webviewSource.includes('closeCellModal(true)'));
    assert.ok(webviewSource.includes('closeCellModal(false)'));
    assert.ok(webviewSource.includes("type: 'editCell'"));
  });

  it('redirects ultra-long DOM-truncated cell edits and double-clicks to the editable modal viewer', () => {
    assert.ok(webviewSource.includes("cell.getAttribute('data-domtruncated') === '1'"));
    assert.ok(webviewSource.includes("target.getAttribute('data-domtruncated') === '1'"));
  });

  it('renders cell modal overlay, Save/Copy/Close buttons and expand button elements in webview template', () => {
    assert.ok(providerSource.includes('id="cellExpandBtn"'));
    assert.ok(providerSource.includes('id="cellModalOverlay"'));
    assert.ok(providerSource.includes('id="cellModal"'));
    assert.ok(providerSource.includes('id="cellModalHeaderTitle"'));
    assert.ok(providerSource.includes('id="cellModalTextArea"'));
    assert.ok(providerSource.includes('id="cellModalSaveBtn"'));
    assert.ok(providerSource.includes('id="cellModalCopyBtn"'));
    assert.ok(providerSource.includes('id="cellModalCloseBtn"'));
  });

  it('implements cell truncation detection and expand/Save/Cancel button handlers in main.js', () => {
    assert.ok(webviewSource.includes('MAX_CELL_HEIGHT_LINES'));
    assert.ok(webviewSource.includes('const isCellTruncated = cell => {'));
    assert.ok(webviewSource.includes('const updateExpandBtnForCell = cell => {'));
    assert.ok(webviewSource.includes('const openCellModal = (row, col) => {'));
    assert.ok(webviewSource.includes('const closeCellModal = (shouldSave = false) => {'));
    assert.ok(webviewSource.includes('const copyCellModalContent = () => {'));
  });

  it('adds View Full Cell Content to the context menu in main.js', () => {
    assert.ok(webviewSource.includes("item('View Full Cell Content', () => {"));
  });

  it('handles Escape (Cancel) and Ctrl/Cmd+Enter (Save) keys for the cell modal in keydown handler', () => {
    assert.ok(webviewSource.includes("if (cellModalOverlay && cellModalOverlay.classList.contains('open')) {"));
    assert.ok(webviewSource.includes("if (e.key === 'Escape') {"));
    assert.ok(webviewSource.includes('closeCellModal(false);'));
    assert.ok(webviewSource.includes("else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {"));
    assert.ok(webviewSource.includes('closeCellModal(true);'));
  });

  it('suppresses full webview DOM re-renders for internal document edits via lastInternalEditTime', () => {
    assert.ok(providerSource.includes('private lastInternalEditTime = 0;'));
    assert.ok(providerSource.includes('this.lastInternalEditTime = Date.now();'));
    assert.ok(providerSource.includes('Date.now() - this.lastInternalEditTime > 1000'));
  });

  it('preserves cell-content wrapper element in updateCell message handler', () => {
    assert.ok(webviewSource.includes("let inner = cell.querySelector('.cell-content');"));
    assert.ok(webviewSource.includes("inner.className = 'cell-content';"));
  });
});
