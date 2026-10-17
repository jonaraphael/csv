import assert from 'assert';
import fs from 'fs';
import path from 'path';
import Module from 'module';
import { describe, it } from 'node:test';

const theme = { kind: 1 };
const kinds = { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 };
const originalRequire = Module.prototype.require;
Module.prototype.require = function (id: string) {
  if (id === 'vscode') {
    return {
      ColorThemeKind: kinds,
      window: { activeColorTheme: theme },
      Uri: { file: (filePath: string) => ({ fsPath: filePath, toString: () => `test-resource:${filePath}` }) },
      workspace: {
        getConfiguration: () => ({ get: (key: string, fallback: any) => key === 'maxFileSizeMB' ? 0 : fallback }),
        onDidChangeTextDocument: () => ({ dispose() {} }),
        onWillSaveTextDocument: () => ({ dispose() {} })
      }
    };
  }
  return originalRequire.apply(this, arguments as any);
};
import { CsvEditorProvider } from '../CsvEditorProvider';
Module.prototype.require = originalRequire;

describe('High-contrast rendering', () => {
  it('uses theme foreground for header, body and virtual cells in both high-contrast variants', () => {
    for (const kind of [kinds.HighContrast, kinds.HighContrastLight]) {
      theme.kind = kind;
      const { tableHtml } = CsvEditorProvider.__test.generateTableAndChunksRaw([
        ['Name', 'Value'], ['hello', '123']
      ], true, true, 0);
      const dataCells = tableHtml.match(/<(?:td|th)\b[^>]*data-col="[0-9]+"[^>]*>/g) || [];
      assert.strictEqual(dataCells.length, 6);
      for (const cell of dataCells) { assert.ok(cell.includes('color: var(--vscode-editor-foreground)')); }
    }
  });

  it('applies high-contrast foreground to serialized and on-demand chunks', () => {
    for (const kind of [kinds.HighContrast, kinds.HighContrastLight]) {
      theme.kind = kind;
      const rows = [['Header'], ...Array.from({ length: 1100 }, (_, index) => [String(index)])];
      const serialized = CsvEditorProvider.__test.generateTableAndChunksRaw(rows, true, false, 0);
      assert.ok(serialized.chunks.length > 0);
      assert.ok(serialized.chunks[0].includes('color:var(--vscode-editor-foreground)'));
      const remote = CsvEditorProvider.__test.generateRuntimeChunkTransport(rows, true, false, 0, 1000);
      assert.ok(remote.response?.html.includes('color:var(--vscode-editor-foreground)'));
    }
  });

  it('retains type colors in ordinary light and dark themes', () => {
    for (const kind of [kinds.Light, kinds.Dark]) {
      theme.kind = kind;
      const { tableHtml } = CsvEditorProvider.__test.generateTableAndChunksRaw([['Name'], ['hello']], true, false, 0);
      assert.ok(!tableHtml.includes('var(--vscode-editor-foreground)'));
      assert.ok(tableHtml.includes('color: #'));
    }
  });

  it('loads the packaged high-contrast stylesheet after generated table styles', async () => {
    const webview = {
      html: '', options: {}, cspSource: 'test-resource:',
      asWebviewUri: (uri: any) => uri.toString(), postMessage() {}, onDidReceiveMessage() {}
    };
    const panel = { title: 'fixture', active: false, webview, onDidChangeViewState() {}, onDidDispose() {} };
    const context = { extensionPath: process.cwd(), workspaceState: { get: (_key: string, fallback: any) => fallback } };
    const uri = { fsPath: '/fixture.csv', toString: () => 'file:///fixture.csv' };
    await new CsvEditorProvider(context as any).resolveCustomTextEditor({ uri, version: 1, getText: () => 'Name\nhello' } as any, panel as any, {} as any);
    const link = `<link rel="stylesheet" href="test-resource:${path.join(process.cwd(), 'media', 'high-contrast.css')}">`;
    assert.ok(webview.html.includes(link));
    assert.ok(webview.html.indexOf(link) > webview.html.indexOf('</style>'));
    assert.ok(fs.existsSync(path.join(process.cwd(), 'media', 'high-contrast.css')));
  });

  it('scopes accessibility styles to high-contrast themes and covers interactive states with theme tokens', () => {
    const css = fs.readFileSync(path.join(process.cwd(), 'media', 'high-contrast.css'), 'utf8');
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, '').split('}').filter(rule => rule.trim()).map(rule => {
      const [selector, declarations] = rule.split('{');
      return { selector: selector.trim(), declarations: declarations.trim() };
    });
    for (const rule of rules) {
      assert.ok(rule.selector.startsWith('body:is(.vscode-high-contrast, .vscode-high-contrast-light)'));
      assert.ok(!/#[0-9a-f]{3,8}\b/i.test(rule.declarations), 'high-contrast colors must come from the active theme');
    }
    const expectedStates = new Map([
      ['.selected', ['selectionForeground', 'selectionBackground', 'outline']],
      ['.active-match', ['findMatchForeground', 'findMatchBackground', 'outline']],
      ['.fr-input {', ['input-foreground', 'input-background']],
      ['#contextMenu {', ['menu-foreground', 'menu-background']],
      [':focus-visible', ['focusBorder', 'outline']]
    ]);
    for (const [state, tokens] of expectedStates) {
      const rule = rules.find(item => `${item.selector} {`.includes(state));
      assert.ok(rule, state);
      for (const token of tokens) { assert.ok(rule!.declarations.includes(token), `${state}: ${token}`); }
    }
  });
});
