import { TestExtensionUri } from './test-extension-uri';
import { createTestMemento } from './test-memento';
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
  TabInputText: class { constructor(readonly uri: TestUri) {} },
  ConfigurationTarget: { Global: 1, Workspace: 2 },
  ViewColumn: { Active: -1 },
  Range: class {},
  WorkspaceEdit: class {
    text = '';
    replace(_uri: unknown, _range: unknown, text: string) { this.text = text; }
  },
  ColorThemeKind: { Dark: 1 },
  window: {
    activeColorTheme: { kind: 1 },
    onDidChangeActiveTextEditor: () => ({ dispose() {} }),
    showTextDocument: async (document: any) => {
      activeHarness.sourceReveals.push(document.getText());
      return { document };
    },
    showWarningMessage: async (message: string) => {
      activeHarness.warnings.push(message);
      return activeHarness.warningChoice;
    },
    showQuickPick: async (items: any[], options: any) => {
      activeHarness.quickPickCalls.push({ items, options });
      return typeof activeHarness.filterChoice === 'function' ? activeHarness.filterChoice(items, options) : activeHarness.filterChoice;
    },
    showInputBox: async (options: any) => {
      activeHarness.inputBoxCalls.push(options);
      return activeHarness.filterInput;
    },
    showInformationMessage: (text: string) => activeHarness.notifications.push(text),
    showErrorMessage: async (text: string) => { activeHarness.notifications.push(text); activeHarness.errors.push(text); },
    showOpenDialog: async () => activeHarness.dialogResults.shift(),
    get visibleTextEditors() { return activeHarness.visibleTextEditors; },
    get activeTextEditor() { return activeHarness.activeTextDocument ? { document: activeHarness.activeTextDocument } : undefined; },
    createWebviewPanel: (...args: unknown[]) => activeHarness.createPanel(...args),
    tabGroups: {
      get activeTabGroup() { return this.all[0]; },
      get all() { return activeHarness.tabGroups ?? [{ tabs: [{ input: { uri: activeHarness.document.uri, viewType: 'csv.editor' } }] }]; },
      close: async () => activeHarness.closeResult
    },
    registerCustomEditorProvider: (viewType: string) => {
      activeHarness.providers.push(viewType);
      return { dispose() {} };
    }
  },
  commands: {
    registerCommand: (name: string, command: (...args: any[]) => unknown) => {
      activeHarness.commands.set(name, command);
      return { dispose() {} };
    },
    executeCommand: async (name: string, ...args: unknown[]) => {
      if (name === 'setContext') {
        activeHarness.contextUpdates.push(args);
        return;
      }
      activeHarness.executedCommands.push({ name, args });
      activeHarness.recordedCommands.push([name, ...args]);
      if (activeHarness.commandError) {
        throw activeHarness.commandError;
      }
      if (name === 'workbench.action.editor.changeEncoding') {
        await activeHarness.commandWait;
      }
      if (name === 'workbench.action.files.save') {
        activeHarness.nativeSaveCommands.push(name);
        return activeHarness.document.save();
      }
    }
  },
  env: { clipboard: { writeText: async (text: string) => { activeHarness.clipboardText = text; }, readText: async () => activeHarness.clipboardText } },
  workspace: {
    onDidOpenTextDocument: () => ({ dispose() {} }),
    onDidCloseTextDocument: () => ({ dispose() {} }),
    getConfiguration: (section: string, resource?: TestUri) => {
      if (activeHarness) { activeHarness.configurationRequests.push(resource); }
      return { inspect: (key: string) => section === 'csv' && key === 'enabled' ? { defaultValue: true, globalValue: activeHarness.configuration.enabled ?? activeHarness.enabled } : undefined,
        get: (key: string, fallback: unknown) => {
        if (key in activeHarness.configuration) { return activeHarness.configuration[key]; }
        if (key === 'enabled') { return activeHarness?.enabled ?? true; }
        if (key === 'maxFileSizeMB') { return 0; }
        if (key === 'defaultIgnoreRows') { return activeHarness.resourceDefaults[resource?.toString() ?? ''] ?? activeHarness.defaultIgnoreRows; }
        return fallback;
      } };
    },
    fs: {
      stat: async (uri: TestUri) => {
        if (activeHarness.statError) { throw activeHarness.statError; }
        return { size: activeHarness.statSize ?? Buffer.byteLength(activeHarness.sourceDocuments.get(uri.toString())?.getText() ?? '') };
      }
    },
    get textDocuments() { return activeHarness.existingDocuments; },
    openTextDocument: async (uri: TestUri) => {
      activeHarness.openedDocuments.push(uri.toString());
      const document = activeHarness.sourceDocuments.get(uri.toString());
      if (!document) { throw new Error('Unknown test document'); }
      return document;
    },
    applyEdit: (edit: { text: string }) => activeHarness.applyEdit(edit.text),
    onDidChangeTextDocument: (listener: (event: unknown) => void) => {
      activeHarness.changeListeners.push(listener);
      return { dispose() {} };
    },
    onDidChangeConfiguration: (listener: (event: any) => void) => {
      activeHarness.configurationListeners.push(listener);
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
  text?: string;
  warningChoice?: string | Promise<string | undefined>;
  rows?: string[][];
  separator?: string;
  header?: boolean;
  serialIndex?: boolean;
  remote?: boolean;
  frozenRows?: number;
  frozenColumns?: number;
  hiddenRows?: number;
  defaultIgnoreRows?: number;
  filters?: unknown;
  untitled?: boolean;
  fileName?: string;
  separatorOverride?: string;
  cancelInitialization?: boolean;
  closeDuringInitialization?: boolean;
} = {}) {
  const separator = options.separator ?? ',';
  let text = options.text ?? Papa.unparse(options.rows ?? [['name', 'value'], ['one', 'two']], { delimiter: separator });
  let diskText = text;
  let messageListener: (message: any) => Promise<void>;
  const changeListeners: Array<(event: unknown) => void> = [];
  const viewListeners: Array<(event: unknown) => void> = [];
  const saveListeners: Array<(event: unknown) => void> = [];
  const disposeListeners: Array<() => void> = [];
  let controller: any;
  const messages: any[] = [];
  const delayedEdits: Array<() => void> = [];
  let deferEdits = false;
  let editFailure: 'false' | 'throw' | undefined;
  const uri = new TestUri(options.fileName ?? `/test/data.${separator === '\t' ? 'tsv' : 'csv'}`, options.untitled ? 'untitled' : options.remote ? 'vscode-remote' : 'file');
  const document = {
    uri,
    isClosed: false,
    languageId: separator === '\t' ? 'tsv' : 'csv',
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
    subscriptions: [] as unknown[],
    extensionPath: process.cwd(), extensionUri: new TestExtensionUri(),
    globalState: createTestMemento(),
    workspaceState: {
      keys() { return Object.keys(this.values).filter(key => this.values[key] !== undefined); },
      values: {} as Record<string, unknown>,
      get(key: string, fallback: unknown) { return this.values[key] ?? fallback; },
      async update(key: string, value: unknown) { this.values[key] = value; }
    }
  };
  await CsvEditorProvider.setHeaderForUri(context as any, uri as any, options.header ?? true);
  await CsvEditorProvider.setSerialIndexForUri(context as any, uri as any, options.serialIndex ?? true);
  if (options.separatorOverride) {
    await CsvEditorProvider.setSeparatorForUri(context as any, uri as any, options.separatorOverride);
  }
  await CsvEditorProvider.setColumnFiltersForUri(context as any, uri as any, options.filters);
  if (options.hiddenRows !== undefined) {
    await CsvEditorProvider.setHiddenRowsForUri(context as any, uri as any, options.hiddenRows);
  }
  await CsvEditorProvider.setFrozenPanesForUri(context as any, uri as any, { rows: options.frozenRows, columns: options.frozenColumns });
  const panel = {
    active: true,
    viewColumn: 2,
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
    disposed: false,
    onDidDispose(listener: () => void) { disposeListeners.push(listener); },
    dispose() {
      panel.disposed = true;
      panel.active = false;
      panel.visible = false;
      disposeListeners.forEach(listener => listener());
    }
  };
  const harness = {
    document, panel, messages, changeListeners, saveListeners,
    configuration: {} as Record<string, unknown>,
    configurationListeners: [] as Array<(event: any) => void>,
    providers: [] as string[],
    tabGroups: undefined as any[] | undefined,
    errors: [] as string[],
    dialogResults: [] as Array<unknown>,
    activeTextDocument: undefined as any,
    visibleTextEditors: [] as any[],
    createPanel: undefined as any,
    openedDocuments: [] as string[],
    sourceDocuments: new Map<string, any>(),
    existingDocuments: [] as any[],
    statError: undefined as Error | undefined,
    statSize: undefined as number | undefined,
    warnings: [] as string[],
    warningChoice: options.warningChoice,
    commandError: undefined as Error | undefined,
    commandWait: undefined as Promise<void> | undefined,
    dispose() { panel.dispose(); },
    closeResult: true,
    commands: new Map<string, (...args: any[]) => unknown>(),
    executedCommands: [] as Array<{ name: string; args: unknown[] }>,
    contextUpdates: [] as unknown[][],
    registerCommands() {
      const { registerCsvCommands } = require('../commands') as typeof import('../commands');
      registerCsvCommands(context as any);
    },
    context,
    defaultIgnoreRows: options.defaultIgnoreRows ?? 0,
    clipboardText: '',
    filterChoice: undefined as any,
    filterInput: undefined as string | undefined,
    quickPickCalls: [] as Array<{ items: any[]; options: any }>,
    inputBoxCalls: [] as any[],
    notifications: [] as string[],
    resourceDefaults: {} as Record<string, number>,
    configurationRequests: [] as Array<TestUri | undefined>,
    enabled: true,
    recordedCommands: [] as unknown[][],
    refresh() { CsvEditorProvider.editors.find(controller => controller.getDocumentUri() === uri as any)!.refresh(); },
    get isOpen() { return CsvEditorProvider.editors.some(controller => controller.getDocumentUri() === uri as any); },
    async setSeparator(separator: string) { await CsvEditorProvider.setSeparatorForUri(context as any, uri as any, separator); },
    sourceReveals: [] as string[],
    nativeSaveCommands: [] as string[],
    get controllerCount() { return CsvEditorProvider.editors.length; },
    get activeController() { return CsvEditorProvider.currentActive; },
    saveUntitledAfterCommit() { controller.saveUntitledAfterCommit(); },
    requestViewCommit() { controller.requestViewCommit(); },
    commitPendingDraft() { return controller.commitPendingDraft() as Promise<boolean>; },
    revealSourceAfterCommit() { harness.enabled = false; controller.revealSourceAfterCommit(); },
    setEnabled(enabled: boolean) { harness.enabled = enabled; controller.refresh(); },
    getCurrentSeparator() { return controller.getCurrentSeparator() as string; },
    rebindDocument(languageId: string) {
      const replacement = {
        ...document, languageId,
        get version() { return document.version; },
        getText: () => text,
        get lineCount() { return text.split(/\r\n|\n|\r/).length; }
      };
      controller.updateDocumentReference(replacement);
      return replacement;
    },
    get diskText() { return diskText; },
    get pendingEdits() { return delayedEdits.length; },
    get pendingDraftRequestId(): number | undefined { return controller?.viewCommitRequested ? controller.viewCommitSequence : undefined; },
    deferEdits() { deferEdits = true; },
    resumeEdits() { deferEdits = false; },
    failEdits(mode: 'false' | 'throw' | undefined) { editFailure = mode; },
    releaseEdit() { delayedEdits.shift()?.(); },
    async applyEdit(nextText: string): Promise<boolean> {
      if (editFailure === 'false') { return false; }
      if (editFailure === 'throw') { throw new Error('applyEdit rejected'); }
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
  const token = { isCancellationRequested: false };
  const initializing = new CsvEditorProvider(context as any).resolveCustomTextEditor(document as any, panel as any, token as any);
  if (options.cancelInitialization || options.closeDuringInitialization) {
    token.isCancellationRequested = !!options.cancelInitialization;
    document.isClosed = !!options.closeDuringInitialization;
    panel.dispose();
  }
  await initializing;
  controller = CsvEditorProvider.currentActive;
  return harness;
}

export function createWebviewDom(html: string, initialState: unknown = {}) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const messages: any[] = [];
  let state: unknown = initialState;
  window.acquireVsCodeApi = () => ({
    postMessage: (message: unknown) => messages.push(message),
    getState: () => state,
    setState: (nextState: unknown) => { state = nextState; }
  });
  window.HTMLElement.prototype.scrollIntoView = () => {};
  // JSDOM has no paint hit testing. Interaction tests may supply cell geometry;
  // use those rectangles unless a scenario installs its own occlusion model.
  window.document.elementFromPoint = (x: number, y: number) =>
    Array.from(window.document.querySelectorAll('td, th')).reverse().find((cell: any) => {
      const rect = cell.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    }) ?? null;
  window.IntersectionObserver = class { observe() {} disconnect() {} };
  const source = fs.readFileSync(path.join(process.cwd(), 'media', 'main.js'), 'utf8');
  const freezeSource = fs.readFileSync(path.join(process.cwd(), 'media', 'frozen-panes.js'), 'utf8');
  window.eval(freezeSource);
  window.eval(fs.readFileSync(path.join(process.cwd(), 'media', 'column-filters.js'), 'utf8'));
  window.eval(`${source}\nwindow.editingTestApi = { editCell, setSingleSelection, selectRange, selectFullRowRange };`);
  return {
    window, messages,
    state: () => state,
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

export async function flushViewCommits(host: Awaited<ReturnType<typeof createEditorHarness>>, view: ReturnType<typeof createWebviewDom>): Promise<void> {
  for (let round = 0; round < 10; round++) {
    const requestId = host.pendingDraftRequestId;
    if (requestId === undefined) { return; }
    const request = host.messages.find(message => message.type === 'prepareViewRefresh' && message.requestId === requestId);
    if (!request) { throw new Error('Missing prepare message'); }
    const cursor = view.messages.length;
    view.window.dispatchEvent(new view.window.MessageEvent('message', { data: request }));
    await Promise.all(view.messages.slice(cursor).map(message => host.receive(message)));
  }
  throw new Error('View commit did not settle');
}
