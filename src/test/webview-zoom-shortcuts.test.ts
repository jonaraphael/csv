import assert from 'assert';
import { describe, it } from 'node:test';
import fs from 'fs';
import path from 'path';

describe('Webview zoom interactions', () => {
  const providerSource = fs.readFileSync(path.join(process.cwd(), 'src', 'CsvEditorProvider.ts'), 'utf8');
  const webviewSource = fs.readFileSync(path.join(process.cwd(), 'media', 'main.js'), 'utf8');

  it('passes zoom settings from provider to webview root dataset', () => {
    assert.ok(providerSource.includes('data-wheelzoomenabled="${mouseWheelZoomEnabled ? \'1\' : \'0\'}"'));
    assert.ok(providerSource.includes('data-wheelzoominvert="${mouseWheelZoomInvert ? \'1\' : \'0\'}"'));
  });

  it('handles Ctrl/Cmd zoom keyboard shortcuts (+, -, 0)', () => {
    assert.ok(webviewSource.includes('const maybeHandleZoomShortcut = e => {'));
    assert.ok(webviewSource.includes("const isZoomInShortcut = e => e.code === 'NumpadAdd' || e.key === '+' || e.key === '=';"));
    assert.ok(webviewSource.includes("const isZoomOutShortcut = e => e.code === 'NumpadSubtract' || e.key === '-' || e.key === '_';"));
    assert.ok(webviewSource.includes("const isZoomResetShortcut = e => e.key === '0';"));
    assert.ok(webviewSource.includes('if (maybeHandleZoomShortcut(e)) {'));
  });

  it('handles Ctrl/Cmd mouse wheel zoom and supports invert direction', () => {
    assert.ok(webviewSource.includes('const MOUSE_WHEEL_ZOOM_ENABLED = root?.dataset?.wheelzoomenabled !== \'0\';'));
    assert.ok(webviewSource.includes('const MOUSE_WHEEL_ZOOM_INVERTED = root?.dataset?.wheelzoominvert === \'1\';'));
    assert.ok(webviewSource.includes('const handleZoomWheel = e => {'));
    assert.ok(webviewSource.includes('const direction = MOUSE_WHEEL_ZOOM_INVERTED ? -naturalDirection : naturalDirection;'));
    assert.ok(webviewSource.includes("window.addEventListener('wheel', handleZoomWheel, { passive: false });"));
  });
});
