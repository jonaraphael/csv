import fs from 'fs';
import path from 'path';
import Module from 'module';
import Papa from 'papaparse';

class TestUri {
  constructor(public readonly path: string, public readonly scheme = 'file') {}
  get fsPath() { return this.path; }
  toString() { return `${this.scheme}://${this.path}`; }
  static file(filePath: string) { return new TestUri(filePath); }
}

let activeHarness: any;
const vscodeStub = {
  Uri: TestUri,
  Range: class {},
  WorkspaceEdit: class {
    text = '';
    replace(_uri: unknown, _range: unknown, text: string) { this.text = text; }
  },
  ColorThemeKind: { Dark: 1 },
  window: { activeColorTheme: { kind: 1 } },
  workspace: {
    getConfiguration: () => ({ get: (key: string, fallback: unknown) => key === 'maxFileSizeMB' ? 0 : fallback }),
    applyEdit: (edit: { text: string }) => activeHarness.applyEdit(edit.text),
    onDidChangeTextDocument: (listener: (event: unknown) => void) => {
      activeHarness.changeListeners.push(listener);
      return { dispose() {} };
    },
    onWillSaveTextDocument: (listener: (event: unknown) => void) => {
      activeHarness.saveListeners.push(listener);
      return { dispose() {} };
    }
  }
};
const originalRequire = Module.prototype.require;
Module.prototype.require = function (id: string) {
  if (id === 'vscode') {
    return vscodeStub;
  }
  return originalRequire.apply(this, arguments as any);
};
// Load the provider only after installing the VS Code API stub.
const { CsvEditorProvider } = require('../CsvEditorProvider') as typeof import('../CsvEditorProvider');
const { JSDOM } = require('jsdom');

export async function createEditorHarness(options: {
  rows?: string[][];
  separator?: string;
  header?: boolean;
  serialIndex?: boolean;
  remote?: boolean;
} = {}) {
  const separator = options.separator ?? ',';
  let text = Papa.unparse(options.rows ?? [['name', 'value'], ['one', 'two']], { delimiter: separator });
  let diskText = text;
  let messageListener: (message: any) => Promise<void>;
  const changeListeners: Array<(event: unknown) => void> = [];
  const viewListeners: Array<(event: unknown) => void> = [];
  const saveListeners: Array<(event: unknown) => void> = [];
  const messages: any[] = [];
  const delayedEdits: Array<() => void> = [];
  let deferEdits = false;
  const uri = new TestUri(`/test/data.${separator === '\t' ? 'tsv' : 'csv'}`, options.remote ? 'vscode-remote' : 'file');
  const document = {
    uri,
    version: 1,
    getText: () => text,
    get lineCount() { return text.split(/\r\n|\n|\r/).length; },
    lineAt: (index: number) => ({ text: text.split(/\r\n|\n|\r/)[index] ?? '' }),
    save: async () => {
      const pending: Promise<unknown>[] = [];
      saveListeners.forEach(listener => listener({ document, waitUntil: (promise: Promise<unknown>) => pending.push(promise) }));
      await Promise.all(pending);
      diskText = text;
      return true;
    }
  };
  const context = {
    extensionPath: process.cwd(),
    workspaceState: {
      values: {} as Record<string, unknown>,
      get(key: string, fallback: unknown) { return this.values[key] ?? fallback; },
      async update(key: string, value: unknown) { this.values[key] = value; }
    }
  };
  await CsvEditorProvider.setHeaderForUri(context as any, uri as any, options.header ?? true);
  await CsvEditorProvider.setSerialIndexForUri(context as any, uri as any, options.serialIndex ?? true);
  const panel = {
    active: true,
    visible: true,
    title: 'data.csv',
    webview: {
      html: '',
      options: {},
      cspSource: 'test:',
      asWebviewUri: (resource: TestUri) => resource.toString(),
      postMessage: (message: unknown) => { messages.push(message); return Promise.resolve(true); },
      onDidReceiveMessage: (listener: typeof messageListener) => { messageListener = listener; }
    },
    onDidChangeViewState: (listener: (event: unknown) => void) => { viewListeners.push(listener); },
    onDidDispose() {}
  };
  const harness = {
    context, document, panel, messages, changeListeners, saveListeners,
    get diskText() { return diskText; },
    get pendingEdits() { return delayedEdits.length; },
    deferEdits() { deferEdits = true; },
    releaseEdit() { delayedEdits.shift()?.(); },
    async applyEdit(nextText: string): Promise<boolean> {
      return new Promise(resolve => {
        const apply = () => {
          text = nextText;
          document.version += 1;
          changeListeners.forEach(listener => listener({ document }));
          resolve(true);
        };
        if (deferEdits) {
          delayedEdits.push(apply);
        } else {
          apply();
        }
      });
    },
    receive(message: unknown) { return messageListener(message); },
    async view(active: boolean, visible: boolean) {
      panel.active = active;
      panel.visible = visible;
      viewListeners.forEach(listener => listener({ webviewPanel: panel }));
      await messageListener({ type: 'test-drain' });
    },
    rows() { return Papa.parse<string[]>(text, { delimiter: separator }).data; }
  };
  activeHarness = harness;
  await new CsvEditorProvider(context as any).resolveCustomTextEditor(document as any, panel as any, { isCancellationRequested: false } as any);
  return harness;
}

export function createWebviewDom(html: string) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const messages: any[] = [];
  let state: unknown = {};
  window.acquireVsCodeApi = () => ({
    postMessage: (message: unknown) => messages.push(message),
    getState: () => state,
    setState: (nextState: unknown) => { state = nextState; }
  });
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.IntersectionObserver = class { observe() {} };
  const source = fs.readFileSync(path.join(process.cwd(), 'media', 'main.js'), 'utf8');
  window.eval(`${source}\nwindow.editingTestApi = { editCell, setSingleSelection };`);
  return {
    window, messages,
    close() { window.close(); },
    cell(row = 1, col = 0) {
      return window.document.querySelector(`[data-row="${row}"][data-col="${col}"]`);
    },
    start(cell: any) { window.editingTestApi.setSingleSelection(cell); window.editingTestApi.editCell(cell); },
    key(key: string, options: Record<string, unknown> = {}) {
      window.document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options }));
    },
    type(value: string) {
      const selection = window.getSelection();
      const range = selection.getRangeAt(0);
      range.deleteContents();
      const node = window.document.createTextNode(value);
      range.insertNode(node);
      range.setStartAfter(node);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
    },
    caret(node: any, offset: number) {
      const range = window.document.createRange();
      range.setStart(node, offset);
      range.collapse(true);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
  };
}
