import assert from 'assert';
import { describe, it } from 'node:test';
import fs from 'fs';
import path from 'path';

describe('Webview freeze columns', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'media', 'main.js'), 'utf8');

  it('includes freeze column context menu labels', () => {
    assert.ok(source.includes('Freeze COLUMN'));
    assert.ok(source.includes('Unfreeze COLUMN'));
    assert.ok(source.includes('Clear Frozen COLUMNS'));
  });

  it('includes frozen column state and apply function hooks', () => {
    assert.ok(source.includes('applyFrozenColumns'));
    assert.ok(source.includes('frozenColumns'));
  });

  it('reapplies frozen columns when csv chunks are loaded', () => {
    assert.ok(/window\.addEventListener\('csvChunkLoaded'[\s\S]*applyFrozenColumns\(\)/.test(source));
  });

  it('freezes selected column ranges instead of only the context column', () => {
    assert.ok(source.includes('const freezeTargetCols = (colCountSel > 1 && selectedColIds.includes(col)) ? selectedColIds : [col];'));
    assert.ok(source.includes('frozenColumns = normalizeFrozenColumns([...frozenColumns, ...freezeTargetCols]);'));
  });

  it('uses opaque background colors for frozen cells to avoid bleed-through', () => {
    assert.ok(source.includes('const getOpaqueBackgroundColor = (color, fallback) => {'));
    assert.ok(source.includes("document.documentElement"));
    assert.ok(source.includes("'--vscode-editor-background'"));
    assert.ok(source.includes('const headerBackground = getOpaqueBackgroundColor(rawHeaderBackground, fallbackBackground);'));
    assert.ok(source.includes("cell.style.backgroundColor = cell.tagName === 'TH' ? headerBackground : fallbackBackground;"));
  });

  it('does not freeze selection highlight colors into frozen cell backgrounds', () => {
    assert.ok(source.includes('const headerProbe = table.querySelector(\'thead th[data-col]:not(.selected):not(.highlight):not(.active-match)\');'));
    assert.ok(source.includes('const rawHeaderBackground = headerProbe ? window.getComputedStyle(headerProbe).backgroundColor : fallbackBackground;'));
  });
});
