import { TestExtensionUri } from './test-extension-uri';
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import Module from 'module';
import Papa from 'papaparse';
import { describe, it } from 'node:test';
const { JSDOM } = require('jsdom');

const theme = { kind: 1 };
const kinds = { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 };
const themeClasses = ['vscode-light', 'vscode-dark', 'vscode-high-contrast', 'vscode-high-contrast-light'];
const settings: Record<string, unknown> = {};
const originalRequire = Module.prototype.require;
Module.prototype.require = function (id: string) {
  if (id === 'vscode') {
    return {
      ColorThemeKind: kinds,
      commands: { executeCommand: async () => {} },
      window: { activeColorTheme: theme },
      Uri: { file: (filePath: string) => ({ fsPath: filePath, toString: () => `test-resource:${filePath}` }) },
      workspace: {
        getConfiguration: () => ({ get: (key: string, fallback: unknown) => key === 'maxFileSizeMB' ? 0 : (settings[key] ?? fallback) }),
        onDidChangeTextDocument: () => ({ dispose() {} }),
        onWillSaveTextDocument: () => ({ dispose() {} })
      }
    };
  }
  return originalRequire.apply(this, arguments as any);
};
import { CsvEditorProvider } from '../CsvEditorProvider';
Module.prototype.require = originalRequire;

const accessibilityCss = fs.readFileSync(path.join(process.cwd(), 'media', 'high-contrast.css'), 'utf8');
const palettes = ['default', 'cool', 'warm'] as const;
const modes = ['type', 'theme'] as const;
const rows = [
  ['Boolean', 'Date', 'Float', 'Integer', 'String', 'Empty'],
  ['true', '2026-03-04', '2.5', '12', 'alpha', ''],
  ['false', '2026-04-05', '3.5', '24', 'beta', '']
];

async function render(options: {
  rows?: string[][]; kind?: number; palette?: typeof palettes[number]; mode?: typeof modes[number];
  separator?: string; header?: boolean; hiddenRows?: number;
} = {}) {
  theme.kind = options.kind ?? kinds.Light;
  settings.columnColorMode = options.mode ?? 'type';
  settings.columnColorPalette = options.palette ?? 'default';
  const separator = options.separator ?? ',';
  const uri = { fsPath: `/fixture.${separator === '\t' ? 'tsv' : 'csv'}`, toString: () => `vscode-remote://fixture/table.${separator === '\t' ? 'tsv' : 'csv'}` };
  const values: Record<string, unknown> = {};
  const context = {
    extensionPath: process.cwd(), extensionUri: new TestExtensionUri(),
    workspaceState: {
      get: (key: string, fallback: unknown) => values[key] ?? fallback,
      update: async (key: string, value: unknown) => { values[key] = value; }
    }
  };
  await CsvEditorProvider.setHeaderForUri(context as any, uri as any, options.header ?? true);
  await CsvEditorProvider.setHiddenRowsForUri(context as any, uri as any, options.hiddenRows ?? 0);
  let receive: (message: unknown) => Promise<void> = async () => {};
  const messages: any[] = [];
  const webview = {
    html: '', options: {}, cspSource: 'test-resource:',
    asWebviewUri: (resource: any) => resource.toString(),
    postMessage(message: unknown) { messages.push(message); return Promise.resolve(true); },
    onDidReceiveMessage(listener: typeof receive) { receive = listener; }
  };
  const panel = { title: 'fixture', active: false, webview, onDidChangeViewState() {}, onDidDispose() {} };
  const text = Papa.unparse(options.rows ?? rows, { delimiter: separator });
  await new CsvEditorProvider(context as any).resolveCustomTextEditor({ uri, version: 1, getText: () => text } as any, panel as any, {} as any);
  const dom = new JSDOM(webview.html);
  const style = dom.window.document.createElement('style');
  style.textContent = accessibilityCss;
  dom.window.document.head.append(style);
  dom.window.document.body.className = themeClasses[theme.kind - 1];
  dom.window.document.body.style.setProperty('--vscode-editor-foreground', '#13579b');
  dom.window.document.body.style.setProperty('--vscode-editor-background', '#102030');
  return { dom, html: webview.html, messages, receive: (message: unknown) => receive(message) };
}

// jsdom does not resolve custom properties. Resolve the browser's declared
// cascade here, then compare visible values rather than implementation var names.
function declared(element: any, property: string): string {
  let result = '';
  let important = false;
  for (const sheet of Array.from(element.ownerDocument.styleSheets) as any[]) {
    for (const rule of Array.from(sheet.cssRules) as any[]) {
      if (!rule.selectorText || !element.matches(rule.selectorText)) { continue; }
      const source = property === 'background-color' && !rule.style.getPropertyValue(property) ? 'background' : property;
      const value = rule.style.getPropertyValue(source);
      const priority = rule.style.getPropertyPriority(source) === 'important';
      if (value && (!important || priority)) { result = value; important = priority; }
    }
  }
  const inline = element.style.getPropertyValue(property);
  if (inline && (!important || element.style.getPropertyPriority(property) === 'important')) { result = inline; }
  return result;
}

function resolved(element: any, value: string): string {
  let output = value;
  for (let pass = 0; pass < 12 && output.includes('var('); pass++) {
    const next = output.replace(/var\((--[\w-]+)(?:,\s*([^()]*))?\)/g, (_match: string, name: string, fallback = '') => {
      let ancestor = element;
      while (ancestor) {
        const variable = declared(ancestor, name);
        if (variable) { return variable; }
        ancestor = ancestor.parentElement;
      }
      return fallback;
    });
    if (next === output) { break; }
    output = next;
  }
  assert.ok(!output.includes('var('), `unresolved value: ${output}`);
  return output.trim().toLowerCase();
}

function color(cell: any): string { return resolved(cell, declared(cell, 'color')); }
function dataCells(document: any): any[] { return Array.from(document.querySelectorAll('[data-col]:not([data-col="-1"])')); }

function assertCellColors(document: any, expected: string[], mode: typeof modes[number]) {
  for (const cell of dataCells(document)) {
    const col = Number(cell.dataset.col);
    assert.strictEqual(color(cell), mode === 'theme' ? '#13579b' : expected[col], `${cell.tagName} source row ${cell.dataset.row}, column ${col}`);
  }
}

describe('High-contrast rendering', () => {
  it('preserves all selected palettes and both color modes across header, body and append cells in CSV and TSV', async () => {
    const firstPaletteColors = new Map<string, string[]>();
    for (const separator of [',', '\t']) {
      for (const palette of palettes) {
        for (const mode of modes) {
          for (const [ordinary, contrast] of [[kinds.Light, kinds.HighContrastLight], [kinds.Dark, kinds.HighContrast]]) {
            const base = await render({ kind: ordinary, palette, mode, separator });
            const expected = Array.from(base.dom.window.document.querySelectorAll('thead [data-col]') as any[]).map(color);
            const hc = await render({ kind: contrast, palette, mode, separator });
            assertCellColors(base.dom.window.document, expected, mode);
            assertCellColors(hc.dom.window.document, expected, mode);
            assert.strictEqual(dataCells(hc.dom.window.document).length, rows[0].length * (rows.length + 1));
            if (mode === 'type') {
              assert.ok(expected.every(value => /^#[0-9a-f]{3,6}$/.test(value)), 'type mode retains literal palette colors');
              firstPaletteColors.set(`${ordinary}:${palette}`, expected);
            }
            base.dom.window.close();
            hc.dom.window.close();
          }
        }
      }
    }
    for (const kind of [kinds.Light, kinds.Dark]) {
      assert.notDeepStrictEqual(firstPaletteColors.get(`${kind}:default`), firstPaletteColors.get(`${kind}:cool`));
      assert.notDeepStrictEqual(firstPaletteColors.get(`${kind}:cool`), firstPaletteColors.get(`${kind}:warm`));
    }
    assert.notDeepStrictEqual(firstPaletteColors.get(`${kinds.Light}:default`), firstPaletteColors.get(`${kinds.Dark}:default`));
  });

  it('keeps the chosen palette or theme mode in serialized and remote chunks, including their final append row', async () => {
    const longRows = [['Name', 'Count'], ...Array.from({ length: 1001 }, (_, index) => ['hello', String(index + 10)])];
    for (const kind of [kinds.HighContrast, kinds.HighContrastLight]) {
      for (const palette of palettes) {
        for (const mode of modes) {
          const view = await render({ rows: longRows, kind, palette, mode, separator: '\t' });
          const document = view.dom.window.document;
          const expected = Array.from(document.querySelectorAll('thead [data-col]') as any[]).map(color);
          const serialized = CsvEditorProvider.__test.generateTableAndChunksRaw(longRows, true, true, 0, true, mode, palette);
          assert.ok(serialized.chunks.length > 0);
          const serializedBody = document.createElement('tbody');
          serializedBody.innerHTML = serialized.chunks.join('');
          document.querySelector('table').append(serializedBody);
          assertCellColors(document, expected, mode);
          serializedBody.remove();
          const filterSession = JSON.parse(document.getElementById('__csvFilters').textContent).session;
          await view.receive({ type: 'requestChunk', start: 1000, requestId: 'palette', filterEpoch: 0, session: filterSession });
          const chunk = view.messages.find(message => message.type === 'chunkData');
          assert.ok(chunk?.html, 'remote URI provider returns requested rows');
          document.querySelector('tbody').insertAdjacentHTML('beforeend', chunk.html);
          if (!chunk.done) {
            await view.receive({ type: 'requestChunk', start: chunk.nextStart, requestId: 'append', filterEpoch: 0, session: filterSession });
            const append = view.messages.find(message => message.requestId === 'append');
            assert.ok(append?.done);
            document.querySelector('tbody').insertAdjacentHTML('beforeend', append.html);
          }
          assert.ok(document.querySelector('[data-row="1002"][data-col="0"]'), 'final virtual row is mounted');
          assertCellColors(document, expected, mode);
          view.dom.window.close();
        }
      }
    }
  });

  it('preserves header-off and metadata-offset data colors rather than reclassifying the visible rows', async () => {
    for (const header of [true, false]) {
      const view = await render({ rows: [['metadata'], ...rows], kind: kinds.HighContrastLight, palette: 'warm', header, hiddenRows: 1 });
      const document = view.dom.window.document;
      assert.strictEqual(!!document.querySelector('thead'), header);
      assert.ok(!document.querySelector('[data-row="0"]'));
      const first = document.querySelector('[data-row="1"][data-col="0"]');
      const expected = dataCells(document).filter(cell => Number(cell.dataset.row) === 1).map(color);
      assert.ok(first);
      assertCellColors(document, expected, 'type');
      view.dom.window.close();
    }
  });

  it('loads the packaged accessibility stylesheet after generated table styles', async () => {
    const view = await render();
    const link = `<link rel="stylesheet" href="${new TestExtensionUri().with({ path: path.posix.join(process.cwd(), 'media', 'high-contrast.css') })}">`;
    assert.ok(view.html.includes(link));
    assert.ok(view.html.indexOf(link) > view.html.indexOf('</style>'));
    assert.ok(fs.existsSync(path.join(process.cwd(), 'media', 'high-contrast.css')));
    const extensionSource = fs.readFileSync(path.join(process.cwd(), 'src', 'extension.ts'), 'utf8');
    assert.ok(!extensionSource.includes('onDidChangeActiveColorTheme'), 'theme changes must not force-reload an active draft');
    view.dom.window.close();
  });

  it('leaves ordinary parent112 chrome colors unchanged and scopes accessibility overrides to HC', async () => {
    const view = await render();
    const document = view.dom.window.document;
    const th = document.querySelector('th[data-col="0"]');
    const cell = document.querySelector('td[data-col="0"]');
    const menu = document.querySelector('#contextMenu');
    const link = document.createElement('a');
    link.className = 'csv-link';
    cell.append(link);
    const cases = [
      { name: 'vscode-light', header: '#ffffff', border: '#ccc', selected: '#cce0ff', highlight: '#fefefe', active: '#ffffcc', link: '#0066cc', menu: '#ffffff' },
      { name: 'vscode-dark', header: '#1e1e1e', border: '#555', selected: '#333333', highlight: '#2a2a2a', active: '#444444', link: '#6cb6ff', menu: '#2d2d2d' }
    ];
    const externalRules = Array.from(document.styleSheets[document.styleSheets.length - 1].cssRules) as any[];
    const elements = [document.body, th, cell, link, menu, ...Array.from(document.querySelectorAll('#findReplaceWidget, #findReplaceWidget *'))];
    for (const expected of cases) {
      document.body.className = expected.name;
      for (const state of ['', 'selected', 'highlight', 'active-match']) {
        cell.className = state;
        for (const element of elements) {
          assert.ok(!externalRules.some(rule => element.matches(rule.selectorText)), `${expected.name} ${element.tagName}.${state} must not match accessibility CSS`);
        }
      }
      cell.className = '';
      assert.strictEqual(resolved(th, declared(th, 'background-color')), expected.header);
      assert.ok(resolved(cell, declared(cell, 'border')).endsWith(expected.border));
      assert.strictEqual(color(link), expected.link);
      assert.strictEqual(resolved(menu, declared(menu, 'background')), expected.menu);
      for (const [state, background] of [['selected', expected.selected], ['highlight', expected.highlight], ['active-match', expected.active]]) {
        cell.className = state;
        assert.strictEqual(resolved(cell, declared(cell, 'background-color')), background);
      }
      assert.strictEqual(declared(document.querySelector('#findReplaceWidget'), 'background'), '#171717');
      assert.strictEqual(declared(document.querySelector('.fr-input'), 'background'), '#1c1c1c');
    }
    for (const kind of ['vscode-high-contrast', 'vscode-high-contrast-light']) {
      document.body.className = kind;
      for (const target of [th, cell]) {
        for (const state of ['', 'selected', 'highlight', 'active-match']) {
          target.className = state;
          const matching = externalRules.filter(rule => target.matches(rule.selectorText));
          assert.ok(matching.length > 0);
          assert.ok(matching.every(rule => !rule.style.getPropertyValue('color')), `${kind} ${target.tagName}.${state} retains its configured foreground`);
          if (state) {
            assert.ok(matching.some(rule => rule.style.getPropertyValue('outline')), `${state} remains visibly distinguishable`);
            assert.strictEqual(resolved(target, declared(target, 'background-color')), '#102030');
          }
        }
      }
    }
    view.dom.window.close();
  });
});
