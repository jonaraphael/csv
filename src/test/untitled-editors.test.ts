import assert from 'assert';
import Module from 'module';
import { afterEach, beforeEach, describe, it } from 'node:test';

function event<T>() {
  const listeners = new Set<(value: T) => void>();
  return {
    listen: (callback: (value: T) => void) => {
      listeners.add(callback);
      return { dispose: () => listeners.delete(callback) };
    },
    fire: (value: T) => { listeners.forEach(callback => callback(value)); },
    clear: () => listeners.clear(),
    get size() { return listeners.size; }
  };
}
const activeEvent = event<any>();
const openEvent = event<any>();
const closeEvent = event<any>();
const configEvent = event<any>();
const state = {
  enabled: true,
  activeTextEditor: undefined as any,
  documents: [] as any[],
  panels: [] as any[],
  resolutions: [] as any[],
  subscriptions: [] as any[],
  tokens: [] as any[],
  failResolve: false,
  commitResult: true,
  commitWait: undefined as Promise<boolean> | undefined,
  commitRequests: 0,
  saveRequests: 0,
  commands: new Map<string, (...args: any[]) => any>(),
  information: [] as string[]
};
class TabInputText { constructor(public uri: any) {} }
class FakeProvider {
  static viewType = 'csv.editor';
  static editors: any[] = [];
  static currentActive: any;
  static getActiveProvider() { return FakeProvider.currentActive; }
  async resolveCustomTextEditor(document: any, panel: any, token: any) {
    state.resolutions.push({ document, panel, token });
    if (state.failResolve) { throw new Error('resolve failed'); }
    const controller = {
      document,
      getDocumentUri: () => controller.document.uri,
      isActive: () => panel.active,
      getViewColumn: () => panel.viewColumn,
      commitPendingDraft: () => { state.commitRequests++; return state.commitWait ?? Promise.resolve(state.commitResult); },
      saveUntitledAfterCommit: () => { state.saveRequests += 1; },
      updateDocumentReference: (replacement: any) => { controller.document = replacement; },
      revealSourceAfterCommit: async () => {
        await vscode.window.showTextDocument(controller.document, { viewColumn: panel.viewColumn });
        panel.dispose();
      }
    };
    FakeProvider.editors.push(controller);
    FakeProvider.currentActive = controller;
    panel.onDidDispose(() => {
      FakeProvider.editors = FakeProvider.editors.filter(candidate => candidate !== controller);
      if (FakeProvider.currentActive === controller) { FakeProvider.currentActive = undefined; }
    });
  }
}
function createPanel(viewType: string, title: string, viewColumn: number) {
  const disposeEvent = event<void>();
  state.panels.forEach(panel => { panel.active = false; });
  state.activeTextEditor = undefined;
  const panel = {
    viewType, title, viewColumn, active: true, disposed: false,
    onDidDispose: disposeEvent.listen,
    reveal: (column?: number) => {
      state.panels.forEach(other => { other.active = false; });
      panel.active = true;
      panel.viewColumn = column ?? panel.viewColumn;
      state.activeTextEditor = undefined;
    },
    dispose: () => {
      if (!panel.disposed) {
        panel.disposed = true;
        panel.active = false;
        disposeEvent.fire();
      }
    }
  };
  state.panels.push(panel);
  return panel;
}
const vscode = {
  Uri: class {},
  TabInputText,
  ViewColumn: { Active: -1 },
  CancellationTokenSource: class {
    token = { isCancellationRequested: false };
    disposed = false;
    constructor() { state.tokens.push(this); }
    cancel() { this.token.isCancellationRequested = true; }
    dispose() { this.disposed = true; }
  },
  window: {
    tabGroups: { get activeTabGroup() { return { viewColumn: state.activeTextEditor?.viewColumn ?? 2,
      activeTab: state.activeTextEditor ? { input: new TabInputText(state.activeTextEditor.document.uri) } : undefined }; } },
    get activeTextEditor() { return state.activeTextEditor; },
    onDidChangeActiveTextEditor: activeEvent.listen,
    createWebviewPanel: createPanel,
    showTextDocument: async (document: any, options: any) => {
      state.panels.forEach(panel => { panel.active = false; });
      state.activeTextEditor = { document, viewColumn: options.viewColumn };
      activeEvent.fire(state.activeTextEditor);
      return state.activeTextEditor;
    },
    showErrorMessage() {},
    showInformationMessage(message: string) { state.information.push(message); }
  },
  commands: {
    registerCommand: (name: string, callback: (...args: any[]) => any) => {
      state.commands.set(name, callback);
      return { dispose() {} };
    }
  },
  workspace: {
    get textDocuments() { return state.documents; },
    getConfiguration: () => ({ get: () => state.enabled }),
    onDidOpenTextDocument: openEvent.listen,
    onDidCloseTextDocument: closeEvent.listen,
    onDidChangeConfiguration: configEvent.listen
  }
};
const originalRequire = Module.prototype.require;
Module.prototype.require = function (id: string) {
  if (id === 'vscode') { return vscode; }
  if (id === 'font-list') { return { getFonts: async () => [] }; }
  if (id === './CsvEditorProvider') { return { CsvEditorProvider: FakeProvider }; }
  return originalRequire.apply(this, arguments as any);
};
import { getActiveUntitledCsvEditor, isUntitledCsv, openUntitledCsvEditor, registerUntitledCsvEditors } from '../untitled-editors';
import { toggleCsvEditor } from '../editor-switch';
import { registerCsvCommands } from '../commands';
Module.prototype.require = originalRequire;

function document(languageId = 'csv', scheme = 'untitled', name = 'Untitled-1'): any {
  return {
    uri: { scheme, path: name, toString: () => `${scheme}:${name}` },
    languageId,
    fileName: name,
    isClosed: false,
    isDirty: true,
    getText: () => 'name,value\nalready typed,42'
  };
}
function activate(document: any) {
  state.documents = [document];
  state.activeTextEditor = { document, viewColumn: 2 };
  activeEvent.fire(state.activeTextEditor);
}
const settle = () => new Promise(resolve => setTimeout(resolve, 5));

beforeEach(() => {
  state.enabled = true;
  state.activeTextEditor = undefined;
  state.documents = [];
  state.panels = [];
  state.resolutions = [];
  state.subscriptions = [];
  state.tokens = [];
  state.failResolve = false;
  state.commitResult = true;
  state.commitWait = undefined;
  state.commitRequests = 0;
  state.saveRequests = 0;
  state.commands.clear();
  state.information = [];
  FakeProvider.editors = [];
  FakeProvider.currentActive = undefined;
  registerUntitledCsvEditors({ subscriptions: state.subscriptions } as any);
});
afterEach(() => { state.subscriptions.forEach(subscription => subscription.dispose()); });

describe('untitled CSV document ownership and routing', () => {
  for (const language of ['csv', 'tsv']) {
    it(`opens a standalone ${language.toUpperCase()} table against the already typed original document`, async () => {
      const original = document(language);
      activate(original);
      await settle();
      assert.strictEqual(state.panels.length, 1);
      assert.strictEqual(state.panels[0].viewType, 'csv.untitledEditor');
      assert.strictEqual(state.panels[0].viewColumn, 2);
      assert.strictEqual(state.resolutions[0].document, original);
      assert.strictEqual(original.getText(), 'name,value\nalready typed,42');
      assert.strictEqual(original.isDirty, true);
      assert.strictEqual(getActiveUntitledCsvEditor()?.document, original);
    });
  }

  it('does not open tables for unshown buffers, saved files, or unrelated languages', async () => {
    openEvent.fire(document());
    activate(document('plaintext'));
    activate(document('csv', 'file'));
    await settle();
    assert.strictEqual(state.panels.length, 0);
    assert.strictEqual(isUntitledCsv(document('json')), false);
  });

  it('recognizes changing language on an existing active untitled buffer', async () => {
    const original = document('plaintext');
    activate(original);
    original.languageId = 'csv';
    openEvent.fire(original);
    await settle();
    assert.strictEqual(state.resolutions[0].document, original);
  });

  it('commits before replacing the untitled table with its native owner and recreates on return', async () => {
    const original = document();
    activate(original);
    await settle();
    const panel = state.panels[0];
    let finish!: (success: boolean) => void;
    state.commitWait = new Promise(resolve => { finish = resolve; });
    const switching = toggleCsvEditor();
    await settle();
    assert.strictEqual(panel.disposed, false);
    assert.strictEqual(panel.active, true);
    assert.strictEqual(state.activeTextEditor, undefined);
    assert.strictEqual(state.commitRequests, 1);
    finish(true);
    await switching;
    assert.strictEqual((state.activeTextEditor as any).document, original);
    await settle();
    assert.strictEqual(panel.disposed, true);
    assert.strictEqual(original.isClosed, false);
    assert.strictEqual(original.isDirty, true);
    assert.strictEqual(state.saveRequests, 0);
    await toggleCsvEditor();
    assert.strictEqual(state.panels[1].active, true);
    assert.strictEqual(state.panels.length, 2);
    assert.strictEqual(state.resolutions.length, 2);
    assert.strictEqual(state.resolutions[1].document, original);
  });

  it('keeps the standalone panel and native owner intact when the draft cannot commit', async () => {
    const original = document();
    activate(original);
    await settle();
    state.commitResult = false;
    await toggleCsvEditor();
    assert.strictEqual(state.panels[0].disposed, false);
    assert.strictEqual(state.panels[0].active, true);
    assert.strictEqual(state.activeTextEditor, undefined);
    assert.strictEqual(original.isClosed, false);
    assert.strictEqual(original.getText(), 'name,value\nalready typed,42');
    assert.strictEqual(state.saveRequests, 0);
  });

  it('ignores a completed commit after its standalone panel is disposed', async () => {
    const original = document();
    activate(original);
    await settle();
    let finish!: (success: boolean) => void;
    state.commitWait = new Promise(resolve => { finish = resolve; });
    const switching = toggleCsvEditor();
    state.panels[0].dispose();
    finish(true);
    await switching;
    assert.strictEqual(state.activeTextEditor, undefined);
    assert.strictEqual(original.isClosed, false);
  });

  it('respects disabled state and opens the current buffer when explicitly re-enabled', async () => {
    state.enabled = false;
    activate(document());
    await settle();
    assert.strictEqual(state.panels.length, 0);
    state.enabled = true;
    configEvent.fire({ affectsConfiguration: () => true });
    await settle();
    assert.strictEqual(state.panels.length, 1);
  });

  it('returns to the unchanged native source when disabled from settings', async () => {
    const original = document();
    activate(original);
    await settle();
    state.enabled = false;
    configEvent.fire({ affectsConfiguration: () => true });
    await settle();
    assert.strictEqual(state.panels[0].disposed, true);
    assert.strictEqual(state.activeTextEditor.document, original);
    assert.strictEqual(original.getText(), 'name,value\nalready typed,42');
    assert.strictEqual(FakeProvider.currentActive, undefined);
  });

  it('keeps an intentionally closed table closed until explicitly requested', async () => {
    const original = document();
    activate(original);
    await settle();
    state.panels[0].dispose();
    activate(original);
    await settle();
    assert.strictEqual(state.panels.length, 1);
    await openUntitledCsvEditor(original, 2);
    assert.strictEqual(state.panels.length, 2);
    assert.strictEqual(state.tokens[0].token.isCancellationRequested, true);
    assert.strictEqual(state.tokens[0].disposed, true);
  });

  it('rebinds a language-change replacement at the same URI without losing the table', async () => {
    const original = document();
    activate(original);
    await settle();
    const replacement = document('tsv');
    original.isClosed = true;
    state.documents = [replacement];
    closeEvent.fire(original);
    openEvent.fire(replacement);
    await settle();
    assert.strictEqual(state.panels[0].disposed, false);
    assert.strictEqual(getActiveUntitledCsvEditor()?.document, replacement);
    assert.strictEqual(FakeProvider.editors[0].document, replacement);
  });

  it('closes the temporary grid when Save As closes its original owner without guessing a saved URI', async () => {
    const original = document();
    activate(original);
    await settle();
    original.isClosed = true;
    state.documents = [document('csv', 'file', '/saved.csv')];
    closeEvent.fire(original);
    await settle();
    assert.strictEqual(state.panels[0].disposed, true);
    assert.strictEqual(FakeProvider.currentActive, undefined);
    assert.strictEqual(getActiveUntitledCsvEditor(), undefined);
  });

  it('routes the registered untitled Save As action to the active owner controller', async () => {
    activate(document());
    await settle();
    registerCsvCommands({ subscriptions: [] } as any);
    await state.commands.get('csv.saveUntitled')!();
    assert.strictEqual(state.saveRequests, 1);
    await toggleCsvEditor();
    await state.commands.get('csv.saveUntitled')!();
    assert.strictEqual(state.saveRequests, 1, 'source/native save owns text editor focus');
  });

  it('requires saving before encoding commands can close or reopen an untitled owner', async () => {
    activate(document());
    await settle();
    registerCsvCommands({ subscriptions: [] } as any);
    await state.commands.get('csv.changeEncoding')!();
    assert.strictEqual(state.panels[0].disposed, false);
    assert.strictEqual(state.information.length, 1);
    assert.match(state.information[0], /Save this document/);
  });

  it('cleans up a rejected initialization and allows a subsequent explicit retry', async () => {
    state.failResolve = true;
    const original = document();
    await assert.rejects(openUntitledCsvEditor(original, 2), /resolve failed/);
    assert.strictEqual(state.panels[0].disposed, true);
    assert.strictEqual(state.tokens[0].disposed, true);
    state.failResolve = false;
    await openUntitledCsvEditor(original, 2);
    assert.strictEqual(state.panels[1].active, true);
  });

  it('disposes event subscriptions and panels with the extension context', async () => {
    activate(document());
    await settle();
    state.subscriptions.forEach(subscription => subscription.dispose());
    assert.strictEqual(state.panels[0].disposed, true);
    assert.strictEqual(activeEvent.size + openEvent.size + closeEvent.size + configEvent.size, 0);
    assert.strictEqual(FakeProvider.currentActive, undefined);
  });
});
