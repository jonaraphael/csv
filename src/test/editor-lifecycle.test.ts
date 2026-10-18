import assert from 'assert';
import Module from 'module';
import { beforeEach, describe, it } from 'node:test';

class Uri {
  constructor(public scheme: string, public authority: string, public path: string) {}
  get fsPath() { return this.path; }
  toString() { return `${this.scheme}://${this.authority}${this.path}`; }
  with(changes: { path: string }) {
    return new Uri(this.scheme, this.authority, changes.path);
  }
}

const state = {
  enabled: true,
  activeGroup: undefined as any,
  groups: [] as any[],
  focusListeners: new Set<(...args: any[]) => void>(),
  shown: [] as any[],
  visibleTextEditors: [] as any[],
  commands: [] as any[][],
  stat: async (): Promise<{ size: number }> => ({ size: 12 }),
  executeCommand: async (..._args: any[]): Promise<void> => {},
  documentListeners: new Set<(...args: any[]) => void>()
};
const vscode = {
  Uri,
  ColorThemeKind: { Dark: 1 },
  window: {
    activeColorTheme: { kind: 1 },
    tabGroups: { get all() { return state.groups; }, get activeTabGroup() { return state.activeGroup; } },
    onDidChangeActiveTextEditor: (callback: (...args: any[]) => void) => {
      state.focusListeners.add(callback);
      return { dispose: () => state.focusListeners.delete(callback) };
    },
    showTextDocument: async (document: any, options: any) => {
      state.shown.push({ document, options });
      const editor = { document, viewColumn: options.viewColumn };
      state.visibleTextEditors = [editor];
      state.activeGroup = { viewColumn: options.viewColumn, activeTab: { input: { uri: document.uri } } };
      state.focusListeners.forEach(callback => callback(editor));
      return editor;
    },
    get visibleTextEditors() { return state.visibleTextEditors; }
  },
  workspace: {
    getConfiguration: () => ({
      get: (key: string, fallback: any) => key === 'enabled' ? state.enabled : fallback
    }),
    fs: { stat: () => state.stat() },
    onWillSaveTextDocument: () => ({ dispose() {} }),
    onDidChangeTextDocument: (callback: (...args: any[]) => void) => {
      state.documentListeners.add(callback);
      return { dispose: () => state.documentListeners.delete(callback) };
    }
  },
  commands: {
    executeCommand: async (...args: any[]) => {
      if (args[0] === 'setContext') { return; }
      state.commands.push(args);
      await state.executeCommand(...args);
    }
  }
};
const originalRequire = Module.prototype.require;
Module.prototype.require = function (id: string) {
  if (id === 'vscode') {
    return vscode;
  }
  return originalRequire.apply(this, arguments as any);
};
import { CsvEditorProvider } from '../CsvEditorProvider';
Module.prototype.require = originalRequire;

const context = {
  extensionUri: new Uri('vscode-remote', 'wsl+Ubuntu', '/home/user/.vscode-server/extensions/csv'),
  // A path alone cannot carry the remote authority of extensionUri.
  extensionPath: '/home/user/.vscode-server/extensions/csv',
  workspaceState: { get: (_key: string, fallback: any) => fallback }
};

function makePanel(viewColumn = 1) {
  const disposeListeners: Array<() => void> = [];
  const viewStateListeners: Array<(event: any) => void> = [];
  const messages: any[] = [];
  const resources: Uri[] = [];
  let html = '';
  let disposed = false;
  let receiveMessage: (message: any) => Promise<void> = async () => {};
  const panel = {
    active: true,
    visible: true,
    viewColumn,
    title: 'test.csv',
    get disposed() { return disposed; },
    webview: {
      options: {} as { localResourceRoots?: Uri[] },
      cspSource: 'vscode-webview:',
      get html() { return html; },
      set html(value: string) {
        assert.strictEqual(disposed, false, 'must not render into a disposed webview');
        html = value;
      },
      asWebviewUri: (uri: Uri) => { resources.push(uri); return uri; },
      postMessage: (message: any) => { messages.push(message); return Promise.resolve(true); },
      onDidReceiveMessage: (listener: typeof receiveMessage) => { receiveMessage = listener; return { dispose() {} }; }
    },
    onDidDispose: (callback: () => void) => {
      disposeListeners.push(callback);
      return { dispose() {} };
    },
    onDidChangeViewState: (callback: (event: any) => void) => {
      viewStateListeners.push(callback);
      return { dispose() {} };
    },
    dispose: () => {
      if (!disposed) {
        disposed = true;
        disposeListeners.forEach(callback => callback());
      }
    },
    receive: (message: any) => receiveMessage(message),
    setActive: (active: boolean) => {
      panel.active = active;
      viewStateListeners.forEach(callback => callback({ webviewPanel: panel }));
    }
  };
  return { panel, messages, resources };
}

function makeDocument(uri: Uri, text = 'name,value\nfirst,1') {
  return { uri, version: 1, getText: () => text };
}

async function resolve(document: ReturnType<typeof makeDocument>, panel: ReturnType<typeof makePanel>['panel'], token = { isCancellationRequested: false }) {
  const provider = new CsvEditorProvider(context as any);
  await provider.resolveCustomTextEditor(document as any, panel as any, token as any);
}

beforeEach(() => {
  state.enabled = true;
  state.activeGroup = undefined;
  state.groups = [];
  state.focusListeners.clear();
  state.shown = [];
  state.visibleTextEditors = [];
  state.commands = [];
  state.stat = async () => ({ size: 12 });
  state.executeCommand = async () => {};
  state.documentListeners.clear();
  CsvEditorProvider.editors = [];
  CsvEditorProvider.currentActive = undefined;
});

describe('CSV editor lifecycle and native text handoff', () => {
  for (const [extension, text, separatorCode] of [
    ['csv', 'name,value\nfirst,1', 44],
    ['tsv', 'name\tvalue\nfirst\t1', 9]
  ] as const) {
    for (const scheme of ['file', 'vscode-remote']) {
      it(`preserves the ${scheme} ${extension.toUpperCase()} controller and resources across tab changes`, async () => {
        const uri = new Uri(scheme, scheme === 'file' ? '' : 'wsl+Ubuntu', `/workspace/data.${extension}`);
        const document = makeDocument(uri, text);
        const { panel, messages, resources } = makePanel();
        await resolve(document, panel);
        assert.ok(panel.webview.html.includes(`data-sepcode="${separatorCode}"`));
        assert.strictEqual(CsvEditorProvider.editors.length, 1);
        assert.strictEqual(state.documentListeners.size, 1);
        const controller = CsvEditorProvider.getActiveProvider();
        assert.ok(controller);

        panel.setActive(false);
        assert.strictEqual(CsvEditorProvider.getActiveProvider(), undefined);
        panel.setActive(true);
        assert.strictEqual(CsvEditorProvider.getActiveProvider(), controller);
        assert.deepStrictEqual(messages[messages.length - 1], { type: 'focus' });
        assert.strictEqual(state.commands.length, 0, 'tab changes must not reopen or replace editors');
        assert.strictEqual(CsvEditorProvider.editors.length, 1);
        assert.strictEqual(resources[0].toString(), `${context.extensionUri}/media/main.js`);
        assert.deepStrictEqual(resources.map(resource => resource.path.split('/').pop()).sort(), ['column-filters.js', 'frozen-panes.js', 'high-contrast.css', 'main.js']);
        assert.ok(resources.every(resource => resource.scheme === context.extensionUri.scheme && resource.authority === context.extensionUri.authority));
        assert.strictEqual(panel.webview.options.localResourceRoots?.[0].toString(), `${context.extensionUri}/media`);
        panel.dispose();
        assert.strictEqual(CsvEditorProvider.getActiveProvider(), undefined);
        assert.strictEqual(state.documentListeners.size, 0);
      });
    }
  }

  it('does not register or render a preview closed during a slow remote file check', async () => {
    let finishStat!: (value: { size: number }) => void;
    state.stat = () => new Promise(resolveStat => { finishStat = resolveStat; });
    const { panel } = makePanel();
    const pending = resolve(makeDocument(new Uri('vscode-remote', 'wsl+Ubuntu', '/data.csv')), panel);
    panel.dispose();
    finishStat({ size: 12 });
    await pending;
    assert.strictEqual(panel.webview.html, '');
    assert.strictEqual(CsvEditorProvider.editors.length, 0);
    assert.strictEqual(state.documentListeners.size, 0);
    assert.strictEqual(CsvEditorProvider.getActiveProvider(), undefined);

    state.stat = async () => ({ size: 12 });
    const replacement = makePanel();
    await resolve(makeDocument(new Uri('vscode-remote', 'wsl+Ubuntu', '/data.csv')), replacement.panel);
    assert.ok(replacement.panel.webview.html.includes('<table>'));
    assert.strictEqual(CsvEditorProvider.editors.length, 1);
    assert.ok(CsvEditorProvider.getActiveProvider());
    replacement.panel.dispose();
  });

  it('honors cancellation during asynchronous initialization', async () => {
    let finishStat!: (value: { size: number }) => void;
    state.stat = () => new Promise(resolveStat => { finishStat = resolveStat; });
    const { panel } = makePanel();
    const token = { isCancellationRequested: false };
    const pending = resolve(makeDocument(new Uri('file', '', '/data.csv')), panel, token);
    token.isCancellationRequested = true;
    finishStat({ size: 12 });
    await pending;
    assert.strictEqual(panel.webview.html, '');
    assert.strictEqual(CsvEditorProvider.editors.length, 0);
    assert.strictEqual(state.documentListeners.size, 0);
  });

  for (const extension of ['csv', 'tsv']) {
    it(`keeps an already visible ${extension.toUpperCase()} search destination when disabled`, async () => {
      state.enabled = false;
      const document = makeDocument(new Uri('vscode-remote', 'wsl+Ubuntu', `/data.${extension}`));
      const selection = { start: { line: 87, character: 4 }, end: { line: 87, character: 10 } };
      const editor = { document, viewColumn: 2, selection };
      state.visibleTextEditors.push(editor);
      const { panel } = makePanel(2);
      await resolve(document, panel);
      assert.strictEqual(state.commands.length, 0, 'must not reopen a text editor already at the requested result');
      assert.strictEqual(editor.selection, selection);
      assert.strictEqual(panel.disposed, true);
      assert.strictEqual(CsvEditorProvider.getActiveProvider(), undefined);
    });
  }

  it('reopens the correct group once when disabling with no visible text editor', async () => {
    const document = makeDocument(new Uri('file', '', '/data.csv'));
    const { panel, messages } = makePanel(2);
    await resolve(document, panel);
    const controller = CsvEditorProvider.getActiveProvider()!;
    panel.setActive(false);
    let finishOpen!: () => void;
    state.executeCommand = () => new Promise(resolveOpen => { finishOpen = resolveOpen; });
    state.enabled = false;
    controller.refresh();
    controller.refresh();
    assert.strictEqual(state.commands.length, 0, 'disable waits for the current webview draft');
    const request = messages.filter(message => message.type === 'prepareViewRefresh').slice(-1)[0];
    const metadata = JSON.parse(/<script id="__csvFilters"[^>]*>(.*?)<\/script>/s.exec(panel.webview.html)![1]);
    const completing = panel.receive({ type: 'viewRefreshReady', session: metadata.session, requestId: request.requestId });
    await new Promise(resolveTurn => setImmediate(resolveTurn));
    assert.deepStrictEqual(state.commands, [[
      'vscode.openWith', document.uri, 'default', { viewColumn: 2, preserveFocus: true }
    ]]);
    finishOpen();
    await completing;
    controller.refresh();
    assert.strictEqual(state.commands.length, 1, 'a disposed controller cannot reopen the file later');
    assert.strictEqual(panel.disposed, true);
    assert.strictEqual(CsvEditorProvider.getActiveProvider(), undefined);
  });

  it('retains an initialized table when On overtakes an already-started native handoff', async () => {
    const document = makeDocument(new Uri('file', '', '/data.csv'));
    const { panel, messages } = makePanel(2);
    await resolve(document, panel);
    const controller = CsvEditorProvider.getActiveProvider()!;
    const html = panel.webview.html;
    let finishOpen!: () => void;
    state.executeCommand = () => new Promise(resolveOpen => { finishOpen = resolveOpen; });
    state.enabled = false;
    controller.refresh();
    const request = messages.filter(message => message.type === 'prepareViewRefresh').slice(-1)[0];
    const metadata = JSON.parse(/<script id="__csvFilters"[^>]*>(.*?)<\/script>/s.exec(html)![1]);
    const completing = panel.receive({ type: 'viewRefreshReady', session: metadata.session, requestId: request.requestId });
    await new Promise(resolveTurn => setImmediate(resolveTurn));
    state.enabled = true;
    controller.refresh();
    assert.strictEqual(panel.webview.html, html, 'On does not replace live DOM during a native handoff');
    finishOpen();
    await completing;
    assert.strictEqual(panel.disposed, false);
    assert.ok(CsvEditorProvider.editors.includes(controller));
    assert.strictEqual(state.focusListeners.size, 0);
    panel.dispose();
  });

  it('restores the current untitled owner after an inactive saved-file handoff takes its group', async () => {
    const document = makeDocument(new Uri('file', '', '/previous.csv'));
    const { panel, messages } = makePanel(2);
    await resolve(document, panel);
    const controller = CsvEditorProvider.getActiveProvider()!;
    panel.setActive(false);
    const owner = makeDocument(new Uri('untitled', '', '/new.tsv'), 'name\tvalue\nlatest\tdraft');
    state.visibleTextEditors = [{ document: owner, viewColumn: 2 }];
    const ownerTab = { input: { uri: owner.uri } };
    const group = { viewColumn: 2, activeTab: ownerTab, tabs: [ownerTab] };
    state.activeGroup = group; state.groups = [group];
    state.executeCommand = async () => {
      // Workbench publication can occur after the active owner was captured.
      const nativeTab = { input: { uri: document.uri } };
      group.tabs.push(nativeTab); group.activeTab = nativeTab;
      state.focusListeners.forEach(callback => callback({ document, viewColumn: 2 }));
    };
    state.enabled = false;
    controller.refresh();
    const request = messages.filter(message => message.type === 'prepareViewRefresh').slice(-1)[0];
    const metadata = JSON.parse(/<script id="__csvFilters"[^>]*>(.*?)<\/script>/s.exec(panel.webview.html)![1]);
    await panel.receive({ type: 'viewRefreshReady', session: metadata.session, requestId: request.requestId });
    assert.strictEqual(state.shown.length, 1);
    assert.strictEqual(state.shown[0].document, owner);
    assert.strictEqual(state.activeGroup.activeTab.input.uri, owner.uri);
    assert.strictEqual(panel.disposed, true);
    assert.strictEqual(state.focusListeners.size, 0);
  });

  it('restores the native untitled owner after its captured grid closes before another handoff settles', async () => {
    const saved = makeDocument(new Uri('file', '', '/previous.csv'));
    const previous = makePanel(2);
    await resolve(saved, previous.panel);
    const savedController = CsvEditorProvider.getActiveProvider()!;
    previous.panel.setActive(false);
    const document = { ...makeDocument(new Uri('untitled', '', '/new.tsv'), 'name\tvalue\nlatest\tdraft'), languageId: 'tsv' };
    const current = makePanel(2);
    await resolve(document, current.panel);
    const nativeTab = { input: { uri: document.uri } };
    const gridTab: any = { input: { viewType: 'mainThreadWebview-csv.untitledEditor' } };
    const group = { viewColumn: 2, tabs: [nativeTab, gridTab], activeTab: gridTab };
    state.activeGroup = group; state.groups = [group];
    state.visibleTextEditors = [];
    state.executeCommand = async () => {
      current.panel.dispose();
      const target = { input: { uri: saved.uri } };
      group.tabs = [nativeTab, target]; group.activeTab = target;
      state.focusListeners.forEach(callback => callback({ document: saved, viewColumn: 2 }));
    };
    state.enabled = false;
    savedController.refresh();
    const request = previous.messages.filter(message => message.type === 'prepareViewRefresh').slice(-1)[0];
    const metadata = JSON.parse(/<script id="__csvFilters"[^>]*>(.*?)<\/script>/s.exec(previous.panel.webview.html)![1]);
    await previous.panel.receive({ type: 'viewRefreshReady', session: metadata.session, requestId: request.requestId });
    assert.strictEqual(state.shown.length, 1);
    assert.strictEqual(state.shown[0].document, document);
    assert.strictEqual(document.getText(), 'name\tvalue\nlatest\tdraft');
    assert.strictEqual(previous.panel.disposed, true);
  });

  it('restores the current saved owner after its own native handoff settles before an older one', async () => {
    const previousDocument = makeDocument(new Uri('file', '', '/previous.csv'));
    const previous = makePanel(2);
    await resolve(previousDocument, previous.panel);
    const previousController = CsvEditorProvider.getActiveProvider()!;
    previous.panel.setActive(false);
    const owner = makeDocument(new Uri('file', '', '/current.tsv'), 'name\tvalue\ncurrent\tdraft');
    const current = makePanel(2);
    await resolve(owner, current.panel);
    const gridTab: any = { input: { uri: owner.uri, viewType: 'csv.editor' } };
    const group = { viewColumn: 2, tabs: [gridTab], activeTab: gridTab };
    state.activeGroup = group; state.groups = [group];
    state.executeCommand = async () => {
      current.panel.dispose();
      const nativeOwner = { input: { uri: owner.uri } };
      const previousTarget = { input: { uri: previousDocument.uri } };
      group.tabs = [nativeOwner, previousTarget]; group.activeTab = previousTarget;
      state.focusListeners.forEach(callback => callback({ document: previousDocument, viewColumn: 2 }));
    };
    state.enabled = false;
    previousController.refresh();
    const request = previous.messages.filter(message => message.type === 'prepareViewRefresh').slice(-1)[0];
    const metadata = JSON.parse(/<script id="__csvFilters"[^>]*>(.*?)<\/script>/s.exec(previous.panel.webview.html)![1]);
    await previous.panel.receive({ type: 'viewRefreshReady', session: metadata.session, requestId: request.requestId });
    assert.strictEqual(state.shown.length, 1);
    assert.strictEqual(state.shown[0].document, owner);
    assert.strictEqual(owner.getText(), 'name\tvalue\ncurrent\tdraft');
  });

  it('does not restore the old group after its captured live grid moves elsewhere', async () => {
    const previousDocument = makeDocument(new Uri('file', '', '/previous.csv'));
    const previous = makePanel(2);
    await resolve(previousDocument, previous.panel);
    const controller = CsvEditorProvider.getActiveProvider()!;
    previous.panel.setActive(false);
    const owner = makeDocument(new Uri('file', '', '/current.tsv'));
    const current = makePanel(2);
    await resolve(owner, current.panel);
    const nativeTab: any = { input: { uri: owner.uri } };
    const gridTab: any = { input: { uri: owner.uri, viewType: 'csv.editor' } };
    const group = { viewColumn: 2, tabs: [nativeTab, gridTab], activeTab: gridTab };
    state.activeGroup = group; state.groups = [group];
    state.executeCommand = async () => {
      current.panel.viewColumn = 3;
      current.panel.setActive(false);
      const target: any = { input: { uri: previousDocument.uri } };
      group.tabs = [nativeTab, target]; group.activeTab = target;
      state.groups.push({ viewColumn: 3, tabs: [gridTab], activeTab: gridTab });
      state.focusListeners.forEach(callback => callback({ document: previousDocument, viewColumn: 2 }));
    };
    state.enabled = false;
    controller.refresh();
    const request = previous.messages.filter(message => message.type === 'prepareViewRefresh').slice(-1)[0];
    const metadata = JSON.parse(/<script id="__csvFilters"[^>]*>(.*?)<\/script>/s.exec(previous.panel.webview.html)![1]);
    await previous.panel.receive({ type: 'viewRefreshReady', session: metadata.session, requestId: request.requestId });
    assert.strictEqual(state.shown.length, 0);
    assert.strictEqual(current.panel.viewColumn, 3);
    assert.strictEqual(current.panel.disposed, false);
    current.panel.dispose();
  });

  it('does not recreate a captured owner tab closed while native handoff is pending', async () => {
    const document = makeDocument(new Uri('file', '', '/previous.csv'));
    const { panel, messages } = makePanel(2);
    await resolve(document, panel);
    const controller = CsvEditorProvider.getActiveProvider()!;
    panel.setActive(false);
    const owner = makeDocument(new Uri('untitled', '', '/still-live-elsewhere.tsv'));
    const ownerTab = { input: { uri: owner.uri } };
    const group = { viewColumn: 2, activeTab: ownerTab, tabs: [ownerTab] };
    state.activeGroup = group; state.groups = [group];
    state.visibleTextEditors = [{ document: owner, viewColumn: 2 }];
    state.executeCommand = async () => {
      const target = { input: { uri: document.uri } };
      group.tabs = [target]; group.activeTab = target;
      state.focusListeners.forEach(callback => callback({ document, viewColumn: 2 }));
    };
    state.enabled = false;
    controller.refresh();
    const request = messages.filter(message => message.type === 'prepareViewRefresh').slice(-1)[0];
    const metadata = JSON.parse(/<script id="__csvFilters"[^>]*>(.*?)<\/script>/s.exec(panel.webview.html)![1]);
    await panel.receive({ type: 'viewRefreshReady', session: metadata.session, requestId: request.requestId });
    assert.strictEqual(state.shown.length, 0);
    assert.strictEqual(panel.disposed, true);
  });

  it('disposes an uninitialized disabled fallback even if On arrives during native open', async () => {
    state.enabled = false;
    let finishOpen!: () => void;
    state.executeCommand = () => new Promise(resolveOpen => { finishOpen = resolveOpen; });
    const { panel } = makePanel(2);
    const pending = resolve(makeDocument(new Uri('file', '', '/data.tsv')), panel);
    await new Promise(resolveTurn => setImmediate(resolveTurn));
    state.enabled = true;
    finishOpen();
    await pending;
    assert.strictEqual(panel.disposed, true);
    assert.strictEqual(CsvEditorProvider.editors.length, 0);
    assert.strictEqual(state.focusListeners.size, 0);
  });

  it('does not reuse a matching text editor from another group during fallback', async () => {
    state.enabled = false;
    const document = makeDocument(new Uri('file', '', '/data.tsv'));
    state.visibleTextEditors.push({ document, viewColumn: 1 });
    const { panel } = makePanel(2);
    await resolve(document, panel);
    assert.deepStrictEqual(state.commands, [[
      'vscode.openWith', document.uri, 'default', { viewColumn: 2, preserveFocus: false }
    ]]);
    assert.strictEqual(panel.disposed, true);
  });

  it('honors disabling while the remote size check is pending', async () => {
    let finishStat!: (value: { size: number }) => void;
    state.stat = () => new Promise(resolveStat => { finishStat = resolveStat; });
    const { panel } = makePanel();
    const document = makeDocument(new Uri('vscode-remote', 'wsl+Ubuntu', '/data.csv'));
    const pending = resolve(document, panel);
    state.enabled = false;
    finishStat({ size: 12 });
    await pending;
    assert.strictEqual(panel.webview.html, '');
    assert.strictEqual(state.commands.length, 1);
    assert.strictEqual(CsvEditorProvider.editors.length, 0);
    assert.strictEqual(panel.disposed, true);
  });

  it('cleans up a disabled panel even if the native fallback fails', async () => {
    state.enabled = false;
    state.executeCommand = async () => { throw new Error('editor unavailable'); };
    const { panel } = makePanel();
    await assert.rejects(resolve(makeDocument(new Uri('file', '', '/data.csv')), panel), /editor unavailable/);
    assert.strictEqual(panel.disposed, true);
    assert.strictEqual(CsvEditorProvider.editors.length, 0);
    assert.strictEqual(CsvEditorProvider.getActiveProvider(), undefined);
  });
});
