import assert from 'assert';
import fs from 'fs';
import path from 'path';
import Module from 'module';
import { it } from 'node:test';
const { JSDOM } = require('jsdom');

const kinds = { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 };
const theme = { kind: kinds.HighContrast };
const settings: Record<string, unknown> = {};
const originalRequire = Module.prototype.require;
Module.prototype.require = function (id: string) {
  if (id === 'vscode') {
    return {
      ColorThemeKind: kinds, window: { activeColorTheme: theme },
      Uri: { file: (filePath: string) => ({ fsPath: filePath, toString: () => `test:${filePath}` }) },
      workspace: {
        getConfiguration: () => ({ get: (key: string, fallback: unknown) => key === 'maxFileSizeMB' ? 0 : (settings[key] ?? fallback) }),
        onDidChangeTextDocument: () => ({ dispose() {} }), onWillSaveTextDocument: () => ({ dispose() {} })
      }
    };
  }
  return originalRequire.apply(this, arguments as any);
};
import { CsvEditorProvider } from '../CsvEditorProvider';
Module.prototype.require = originalRequire;

async function createLiveView(mode: string, palette: string) {
  settings.columnColorMode = mode;
  settings.columnColorPalette = palette;
  const uri = { fsPath: '/draft.csv', toString: () => 'file:///draft.csv' };
  const values: Record<string, unknown> = {};
  const context = {
    extensionPath: process.cwd(), workspaceState: {
      get: (key: string, fallback: unknown) => values[key] ?? fallback,
      update: async (key: string, value: unknown) => { values[key] = value; }
    }
  };
  await CsvEditorProvider.setHeaderForUri(context as any, uri as any, true);
  const webview = { html: '', options: {}, cspSource: 'test:', asWebviewUri: (resource: any) => resource.toString(), postMessage() {}, onDidReceiveMessage() {} };
  const panel = { title: 'draft.csv', active: true, webview, onDidChangeViewState() {}, onDidDispose() {} };
  const text = 'Name,Count\nalpha,12\nbeta,24';
  const document = { uri, version: 1, getText: () => text };
  await new CsvEditorProvider(context as any).resolveCustomTextEditor(document as any, panel as any, {} as any);
  const dom = new JSDOM(webview.html, { runScripts: 'outside-only', pretendToBeVisual: true });
  const style = dom.window.document.createElement('style');
  style.textContent = fs.readFileSync(path.join(process.cwd(), 'media', 'high-contrast.css'), 'utf8');
  dom.window.document.head.append(style);
  const messages: any[] = [];
  let state = {};
  dom.window.acquireVsCodeApi = () => ({ postMessage: (message: unknown) => messages.push(message), getState: () => state, setState: (value: object) => { state = value; } });
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  dom.window.IntersectionObserver = class { observe() {} };
  dom.window.eval(`${fs.readFileSync(path.join(process.cwd(), 'media', 'main.js'), 'utf8')}\nwindow.themeTestApi = { editCell, setSingleSelection };`);
  return { dom, messages, document };
}

// Resolve only inherited custom-property values: jsdom leaves CSS var() colors
// unevaluated, while the declarations and real browser DOM remain executable.
function cellColor(cell: any): string {
  const document = cell.ownerDocument;
  const variables = new Map<string, string>([['--vscode-editor-foreground', '#13579b']]);
  for (const sheet of Array.from(document.styleSheets) as any[]) {
    for (const rule of Array.from(sheet.cssRules) as any[]) {
      if (rule.selectorText && document.body.matches(rule.selectorText)) {
        for (let index = 0; index < rule.style.length; index++) {
          const property = rule.style[index];
          if (property.startsWith('--')) { variables.set(property, rule.style.getPropertyValue(property)); }
        }
      }
    }
  }
  return cell.style.color.replace(/var\((--[\w-]+)(?:,\s*([^()]*))?\)/g, (_: string, name: string, fallback = '') => variables.get(name) ?? fallback).trim().toLowerCase();
}

it('changes all four theme classes without replacing, committing or recoloring an active multiline draft outside the chosen mode', async () => {
  for (const palette of ['default', 'cool', 'warm']) {
    for (const mode of ['type', 'theme']) {
      const { dom, messages, document: owner } = await createLiveView(mode, palette);
      const { document } = dom.window;
      const cell = document.querySelector('[data-row="1"][data-col="0"]');
      const header = document.querySelector('th[data-col="0"]');
      const append = document.querySelector('[data-row="3"][data-col="0"]');
      dom.window.themeTestApi.setSingleSelection(cell);
      dom.window.themeTestApi.editCell(cell);
      cell.textContent = 'unsaved first line\nsecond line';
      const selection = dom.window.getSelection();
      const range = document.createRange();
      range.setStart(cell.firstChild, 8);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      assert.strictEqual(document.activeElement, cell);
      const colors = new Map<string, string>();
      messages.length = 0;
      for (const themeClass of ['vscode-high-contrast', 'vscode-light', 'vscode-high-contrast-light', 'vscode-dark', 'vscode-light']) {
        document.body.className = themeClass;
        const visibleColor = cellColor(cell);
        colors.set(themeClass, visibleColor);
        assert.strictEqual(cellColor(header), visibleColor);
        assert.strictEqual(cellColor(append), visibleColor);
        assert.strictEqual(document.querySelector('[data-row="1"][data-col="0"]'), cell);
        assert.strictEqual(cell.textContent, 'unsaved first line\nsecond line');
        assert.strictEqual(cell.getAttribute('contenteditable'), 'true');
        assert.strictEqual(document.activeElement, cell);
        assert.strictEqual(selection.anchorNode, cell.firstChild);
        assert.strictEqual(selection.anchorOffset, 8);
        assert.ok(cell.classList.contains('editing'));
        assert.ok(!messages.some(message => ['editCell', 'save', 'saveAs'].includes(message.type)), 'class changes do not commit or save a draft');
        assert.strictEqual(owner.getText(), 'Name,Count\nalpha,12\nbeta,24');
        assert.strictEqual(owner.version, 1);
      }
      assert.strictEqual(colors.get('vscode-high-contrast'), colors.get('vscode-dark'));
      assert.strictEqual(colors.get('vscode-high-contrast-light'), colors.get('vscode-light'));
      if (mode === 'type') {
        assert.notStrictEqual(colors.get('vscode-light'), colors.get('vscode-dark'));
        assert.ok(Array.from(colors.values()).every(value => /^#[0-9a-f]{6}$/.test(value)));
      } else {
        assert.ok(Array.from(colors.values()).every(value => value === '#13579b'));
      }
      dom.window.close();
    }
  }
});
