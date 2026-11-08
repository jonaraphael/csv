import assert from 'assert';
import { describe, it } from 'node:test';
import Module from 'module';
import fs from 'fs';
import path from 'path';

// Stub the 'vscode' module so the provider can be imported in plain Node.
const originalRequire = Module.prototype.require;
Module.prototype.require = function (id: string) {
  if (id === 'vscode') {
    return {
      window: { activeColorTheme: { kind: 1 } },
      ColorThemeKind: { Light: 2, Dark: 1, HighContrast: 3, HighContrastLight: 4 },
      Uri: { file: (p: string) => ({ fsPath: p, toString: () => `file://${p}` }) }
    } as any;
  }
  return originalRequire.apply(this, arguments as any);
};

import { CsvEditorProvider } from '../CsvEditorProvider';

const t = CsvEditorProvider.__test;

// Settings an untrusted workspace's .vscode/settings.json could supply.
const hostileFont = 'x; } </style><img src="https://evil.example/leak"><style> body {';
const hostilePadding = '0px; } </style><img src="https://evil.example/leak"><style> td {';

function render(fontFamily: unknown, cellPadding: unknown, fontSize: unknown = 14): string {
  return t.wrapHtml({
    webview: { cspSource: 'vscode-resource:', asWebviewUri: (u: any) => u },
    nonce: 'n0nce',
    fontFamily,
    fontSize,
    cellPadding,
    separator: ',',
    tableHtml: '<table></table>',
    chunksJson: '[]',
    extraColumnColorCss: '',
    nextChunkStart: -1,
    hasRemoteChunks: false,
    mouseWheelZoomEnabled: true,
    mouseWheelZoomInvert: false,
    headerEnabled: true,
    columnSizes: {},
    frozenPanes: { rows: 0, columns: 0 },
    firstVisibleRow: 0,
    realRowCount: 0,
    visibleRowIds: [],
    filterMetadata: { filters: [] }
  });
}

describe('Workspace Trust (Restricted Mode)', () => {
  it('declares support for untrusted workspaces in package.json', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
    assert.strictEqual(pkg.capabilities?.untrustedWorkspaces?.supported, true);
  });

  it('sanitizeFontFamily keeps ordinary font lists', () => {
    assert.strictEqual(t.sanitizeFontFamily('"Fira Code", Menlo, monospace'), '"Fira Code", Menlo, monospace');
    assert.strictEqual(t.sanitizeFontFamily("'Noto Sans JP', sans-serif"), "'Noto Sans JP', sans-serif");
  });

  it('sanitizeFontFamily strips characters that can escape the declaration', () => {
    const out = t.sanitizeFontFamily(hostileFont);
    for (const ch of [';', '{', '}', '<', '>', '/', '(', ')']) {
      assert.ok(!out.includes(ch), `found ${ch} in ${out}`);
    }
    assert.ok(!t.sanitizeFontFamily('x, url(https://evil.example)').includes('('));
    assert.ok(!t.sanitizeFontFamily('x\n@import "https://evil.example"').includes('@'));
  });

  it('sanitizeFontFamily falls back for non-strings and empty results', () => {
    assert.strictEqual(t.sanitizeFontFamily(undefined), 'monospace');
    assert.strictEqual(t.sanitizeFontFamily(42), 'monospace');
    assert.strictEqual(t.sanitizeFontFamily(';{}'), 'monospace');
  });

  it('normalizeCellPadding accepts only finite, non-negative numbers', () => {
    assert.strictEqual(t.normalizeCellPadding(6), 6);
    assert.strictEqual(t.normalizeCellPadding('8'), 8);
    assert.strictEqual(t.normalizeCellPadding(1e9), 100);
    for (const bad of [hostilePadding, '', -1, NaN, Infinity, null, undefined, true, {}]) {
      assert.strictEqual(t.normalizeCellPadding(bad), 4, `for ${String(bad)}`);
    }
  });

  it('wrapHtml cannot be broken out of by hostile settings', () => {
    const html = render(hostileFont, hostilePadding, '14px; } </style><img src=x>');
    assert.ok(!html.includes('https://evil.example'), 'injected URL reached the page');
    assert.ok(!html.includes('<img'), 'injected element reached the page');
    assert.strictEqual(html.match(/<\/style>/g)?.length, html.match(/<style/g)?.length);
    assert.ok(html.includes('padding: 4px 8px'));
    assert.ok(html.includes('font-size: 14px'));
  });

  it('wrapHtml keeps legitimate settings', () => {
    const html = render('"Fira Code", monospace', 6, 16);
    assert.ok(html.includes('font-family: "Fira Code", monospace;'));
    assert.ok(html.includes('padding: 6px 8px'));
    assert.ok(html.includes('font-size: 16px'));
  });
});
