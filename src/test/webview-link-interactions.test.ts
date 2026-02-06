import assert from 'assert';
import { describe, it } from 'node:test';
import fs from 'fs';
import path from 'path';

describe('Webview link interactions', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'media', 'main.js'), 'utf8');

  it('opens links only on Ctrl/Cmd+click', () => {
    assert.ok(source.includes("closest('.csv-link[data-href]')"));
    assert.ok(source.includes("link.getAttribute('data-href')"));
    assert.ok(source.includes('if (!(e.ctrlKey || e.metaKey)) {'));
    assert.ok(source.includes('if (e.detail === 1) {'));
    assert.ok(source.includes('postOpenLink(link);'));
  });

  it('treats right-click on link text as cell context menu', () => {
    assert.ok(source.includes("table.addEventListener('contextmenu', e => {"));
    assert.ok(source.includes('const target = getCellTarget(e.target);'));
  });

  it('keeps regular click selection behavior on URL cells', () => {
    assert.ok(source.includes('if (link && (e.ctrlKey || e.metaKey)) {'));
    assert.ok(source.includes('const target = getCellTarget(e.target);'));
  });
});
