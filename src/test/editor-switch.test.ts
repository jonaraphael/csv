import assert from 'assert';
import fs from 'fs';
import Module from 'module';
import path from 'path';
import { beforeEach, describe, it } from 'node:test';
import type { EditorSwitchRouting } from '../editor-associations';

class Uri {
  constructor(public scheme: string, public authority: string, public path: string) {}
  toString() { return `${this.scheme}://${this.authority}${this.path}`; }
}
class TabInputText { constructor(public uri: Uri) {} }
class TabInputCustom { constructor(public uri: Uri, public viewType: string) {} }
class TabInputTextDiff { constructor(public original: Uri, public modified: Uri) {} }
const state = {
  group: { viewColumn: 2, tabs: [] as any[], activeTab: undefined as any },
  otherGroups: [] as any[],
  activeTextEditor: undefined as any,
  visibleTextEditors: undefined as any[] | undefined,
  enabled: true, version: '1.142.0', available: true,
  events: [] as any[][], errors: [] as string[], information: [] as string[],
  registered: new Map<string, (...args: any[]) => any>(),
  prepareRouting: undefined as ((uri: Uri, target: string) => Promise<EditorSwitchRouting>) | undefined,
  unqualifiedTable: false,
  tabListeners: new Set<() => void>(),
  commit: async (): Promise<boolean> => true,
  replace: async (_viewType: string): Promise<void> => {},
  reveal: async (_uri: Uri, _viewType: string): Promise<void> => {}
};
const vscode = {
  Uri, TabInputText, TabInputCustom,
  get version() { return state.version; },
  window: {
    get activeTextEditor() {
      return state.activeTextEditor ?? (state.group.activeTab?.input instanceof TabInputText
        ? { document: { uri: state.group.activeTab.input.uri }, viewColumn: state.group.viewColumn } : undefined);
    },
    get visibleTextEditors() {
      return state.visibleTextEditors ?? [state.group, ...state.otherGroups].flatMap(group =>
        group.activeTab?.input instanceof TabInputText
          ? [{ document: { uri: group.activeTab.input.uri }, viewColumn: group.viewColumn }] : []
      );
    },
    tabGroups: {
      onDidChangeTabs: (listener: () => void) => { state.tabListeners.add(listener); return { dispose: () => state.tabListeners.delete(listener) }; },
      get activeTabGroup() { return state.group; },
      get all() { return [state.group, ...state.otherGroups]; },
      close: () => { assert.fail('native replacement owns source removal; no separate close is safe'); }
    },
    showErrorMessage: (message: string) => { state.errors.push(message); },
    showInformationMessage: (message: string) => { state.information.push(message); }
  },
  workspace: { textDocuments: [] as any[], getConfiguration: () => ({ get: () => state.enabled }) },
  commands: {
    getCommands: async () => state.available ? ['reopenActiveEditorWith'] : [],
    executeCommand: async (command: string, ...args: any[]) => {
      state.events.push([command, ...args]);
      if (command === 'vscode.openWith') { await state.reveal(args[0], args[1]); }
      else if (command === 'vscode.open') { await state.reveal(args[0], state.unqualifiedTable ? 'csv.editor' : 'default'); }
      else if (command === 'workbench.action.keepEditor') { state.group.activeTab.isPreview = false; }
      else if (command === 'reopenActiveEditorWith') { await state.replace(args[0]); }
      else { assert.fail(`unexpected command: ${command}`); }
    },
    registerCommand: (name: string, callback: (...args: any[]) => any) => {
      state.registered.set(name, callback); return { dispose() {} };
    }
  }
};
const originalRequire = Module.prototype.require;
Module.prototype.require = function (id: string) {
  if (id === 'vscode') { return vscode; }
  if (id === 'font-list') { return { getFonts: async () => [] }; }
  return originalRequire.apply(this, arguments as any);
};
import { registerCsvCommands } from '../commands';
import { CsvEditorProvider } from '../CsvEditorProvider';
import { supportsEditorReplacement } from '../editor-switch';
Module.prototype.require = originalRequire;

function makeTab(uri: Uri, table: boolean, dirty = true) {
  return { input: table ? new TabInputCustom(uri, 'csv.editor') : new TabInputText(uri), isDirty: dirty };
}
function activateTab(tab: any) {
  state.group.tabs = [tab]; state.group.activeTab = tab;
  if (tab.input instanceof TabInputCustom && tab.input.viewType === 'csv.editor') {
    CsvEditorProvider.editors.push({
      getDocumentUri: () => tab.input.uri,
      getViewColumn: () => 2,
      commitPendingDraft: async () => { state.events.push(['commit']); return state.commit(); }
    } as any);
  }
}
async function toggle() { await state.registered.get('csv.toggleEditor')!(); }

beforeEach(() => {
  state.group = { viewColumn: 2, tabs: [], activeTab: undefined };
  state.otherGroups = [];
  state.activeTextEditor = undefined; state.visibleTextEditors = undefined;
  state.enabled = true; state.version = '1.142.0'; state.available = true;
  state.events = []; state.errors = []; state.information = [];
  state.registered.clear(); CsvEditorProvider.editors = []; vscode.workspace.textDocuments = [];
  state.prepareRouting = undefined; state.unqualifiedTable = false; state.tabListeners.clear();
  registerCsvCommands({ subscriptions: [] } as any, async () => {}, (uri, target) => state.prepareRouting?.(uri, target) ?? Promise.resolve({ supported: false, commit: async () => {}, rollback: async () => {} }));
  state.commit = async () => true;
  state.reveal = async (uri, viewType) => {
    const source = state.group.activeTab;
    const table = viewType === 'csv.editor';
    const target = state.group.tabs.find(tab => tab.input.uri?.toString() === uri.toString() &&
      (table ? tab.input instanceof TabInputCustom : tab.input instanceof TabInputText)) ?? makeTab(uri, table, source.isDirty);
    if (!state.group.tabs.includes(target)) { state.group.tabs.push(target); }
    state.group.activeTab = target;
    if (table && !CsvEditorProvider.editors.some(controller => controller.getDocumentUri().toString() === uri.toString())) {
      CsvEditorProvider.editors.push({ getDocumentUri: () => uri, getViewColumn: () => 2,
        commitPendingDraft: async () => { state.events.push(['commit']); return state.commit(); } } as any);
    }
  };
  state.replace = async viewType => {
    const original = state.group.activeTab;
    const table = viewType === 'csv.editor';
    const target = state.group.tabs.find(tab => tab !== original &&
      tab.input.uri?.toString() === original.input.uri.toString() &&
      (table ? tab.input instanceof TabInputCustom : tab.input instanceof TabInputText)
    ) ?? makeTab(original.input.uri, table, original.isDirty);
    state.group.tabs = state.group.tabs.filter(tab => tab !== original && tab !== target);
    state.group.tabs.push(target); state.group.activeTab = target;
    if (table) {
      CsvEditorProvider.editors.push({ getDocumentUri: () => target.input.uri, getViewColumn: () => 2,
        commitPendingDraft: async () => { state.events.push(['commit']); return state.commit(); } } as any);
    }
  };
});

describe('single-view CSV table/text switching', () => {
  for (const scheme of ['file', 'vscode-remote']) {
    for (const extension of ['csv', 'tsv', 'tab', 'psv', 'CSV']) {
      it(`replaces only the ${scheme} .${extension} source in its group`, async () => {
        const uri = new Uri(scheme, scheme === 'file' ? '' : 'wsl+Ubuntu', `/data/example.${extension}`);
        activateTab(makeTab(uri, false));
        const unrelated = makeTab(new Uri('file', '', '/other.csv'), false);
        state.group.tabs.push(unrelated);
        for (let round = 0; round < 4; round++) {
          await toggle();
          assert.strictEqual(state.group.tabs.filter(tab => tab.input.uri.toString() === uri.toString()).length, 1);
          assert.strictEqual(state.group.activeTab.input.uri, uri);
          assert.strictEqual(state.group.activeTab.isDirty, true);
          assert.ok(state.group.tabs.includes(unrelated));
        }
        assert.deepStrictEqual(state.events.slice(0, 4), [
          ['vscode.openWith', uri, 'csv.editor', { viewColumn: 2, preserveFocus: false, preview: false }],
          ['commit'],
          ['vscode.openWith', uri, 'default', { viewColumn: 2, preserveFocus: false, preview: false }],
          ['reopenActiveEditorWith', 'csv.editor']
        ]);
        assert.strictEqual(state.events.filter(event => event[0] === 'commit').length, 4);
        assert.strictEqual(state.errors.length, 0);
      });
    }
  }

  it('reuses a counterpart that is already open while removing only its source', async () => {
    const uri = new Uri('file', '', '/data.csv');
    const source = makeTab(uri, false); const target = makeTab(uri, true);
    activateTab(source); state.group.tabs.push(target);
    await toggle();
    assert.deepStrictEqual(state.group.tabs, [target]);
    assert.strictEqual(state.group.activeTab, target);
  });

  for (const extension of ['csv', 'tsv']) {
    it(`replaces a ${extension} table when its ready text target is visible but focus remains in another group`, async () => {
      const uri = new Uri('file', '', `/data.${extension}`);
      activateTab(makeTab(uri, true));
      const unrelated = makeTab(new Uri('file', '', '/other-group.csv'), false);
      const other = { viewColumn: 3, tabs: [unrelated], activeTab: unrelated };
      state.otherGroups = [other];
      state.activeTextEditor = { document: { uri: unrelated.input.uri }, viewColumn: 3 };
      await toggle();
      assert.deepStrictEqual(state.group.tabs.map(tab => tab.input.constructor), [TabInputText]);
      assert.strictEqual(state.group.activeTab.input.uri, uri);
      assert.strictEqual(state.group.activeTab.isDirty, true);
      assert.deepStrictEqual(state.events.at(-1), ['reopenActiveEditorWith', 'default']);
      assert.deepStrictEqual(other.tabs, [unrelated]);
      assert.strictEqual(other.activeTab, unrelated);
      assert.strictEqual(vscode.window.activeTextEditor.document.uri, unrelated.input.uri);
      assert.deepStrictEqual(state.errors, []);
    });

    it(`retains a ${extension} table if matching text is visible only in a different group`, async () => {
      const uri = new Uri('file', '', `/data.${extension}`);
      const source = makeTab(uri, true);
      activateTab(source);
      const otherText = makeTab(uri, false);
      const other = { viewColumn: 3, tabs: [otherText], activeTab: otherText };
      state.otherGroups = [other];
      state.activeTextEditor = { document: { uri }, viewColumn: 3 };
      state.visibleTextEditors = [state.activeTextEditor];
      await toggle();
      assert.ok(state.group.tabs.includes(source));
      assert.strictEqual(state.group.activeTab, source);
      assert.ok(!state.events.some(event => event[0] === 'reopenActiveEditorWith'));
      assert.deepStrictEqual(other.tabs, [otherText]);
      assert.strictEqual(other.activeTab, otherText);
    });
  }

  it('keeps the dirty source when native opening fails or is cancelled', async () => {
    const source = makeTab(new Uri('file', '', '/data.csv'), false);
    activateTab(source); state.reveal = async () => { throw new Error('open failed'); };
    await toggle();
    assert.deepStrictEqual(state.group.tabs, [source]); assert.strictEqual(source.isDirty, true);
    assert.strictEqual(state.errors.length, 1);
    state.reveal = async () => {};
    await toggle();
    assert.deepStrictEqual(state.group.tabs, [source]); assert.strictEqual(source.isDirty, true);
  });

  it('waits for a table draft, aborting if it cannot commit or the user changes tabs', async () => {
    const source = makeTab(new Uri('file', '', '/data.csv'), true);
    activateTab(source); state.commit = async () => false;
    await toggle(); assert.deepStrictEqual(state.events, [['commit']]);
    assert.deepStrictEqual(state.group.tabs, [source]);
    state.events = []; state.commit = async () => {
      state.group.activeTab = makeTab(new Uri('file', '', '/unrelated.csv'), false); return true;
    };
    await toggle(); assert.deepStrictEqual(state.events, [['commit']]);
  });

  it('does not steal focus back after the user changes tabs during target readiness', async () => {
    const uri = new Uri('file', '', '/data.csv');
    activateTab(makeTab(uri, false));
    state.commit = async () => {
      state.group.activeTab = makeTab(new Uri('file', '', '/another.csv'), false);
      return true;
    };
    await toggle();
    assert.deepStrictEqual(state.events.map(event => event[0]), ['vscode.openWith', 'commit']);
    assert.strictEqual(state.group.activeTab.input.uri.path, '/another.csv');
  });

  it('does not move a preexisting table from a different editor group', async () => {
    const uri = new Uri('file', '', '/data.csv');
    activateTab(makeTab(uri, false));
    const other = { viewColumn: 3, tabs: [makeTab(uri, true)] };
    state.otherGroups = [other];
    await toggle();
    assert.strictEqual(state.events.length, 0);
    assert.strictEqual(other.tabs.length, 1);
    assert.match(state.information[0], /another editor group/);
  });

  it('coalesces duplicate clicks during replacement', async () => {
    activateTab(makeTab(new Uri('file', '', '/data.csv'), false));
    let finish!: () => void; state.replace = () => new Promise(resolve => { finish = resolve; });
    const pending = toggle(); await new Promise(resolve => setImmediate(resolve));
    await toggle(); finish(); await pending;
    assert.strictEqual(state.events.filter(event => event[0] === 'reopenActiveEditorWith').length, 1);
  });

  it('respects disabled state while allowing a table to return to source', async () => {
    state.enabled = false; activateTab(makeTab(new Uri('file', '', '/data.tsv'), false));
    await toggle(); assert.strictEqual(state.events.length, 0); assert.strictEqual(state.information.length, 1);
    activateTab(makeTab(new Uri('file', '', '/data.tsv'), true));
    await toggle(); assert.strictEqual(state.events.at(-1)?.[1], 'default');
  });

  it('ignores other custom editors, native diffs, unsupported files, untitled URIs and empty groups', async () => {
    const uri = new Uri('file', '', '/data.csv');
    for (const input of [new TabInputCustom(uri, 'another.editor'), new TabInputTextDiff(uri, uri),
      new TabInputText(new Uri('file', '', '/notes.md')), new TabInputText(new Uri('untitled', '', '/data.csv'))]) {
      activateTab({ input }); await toggle();
    }
    state.group.activeTab = undefined; await toggle(); assert.strictEqual(state.events.length, 0);
  });

  it('guards old/forked hosts and rechecks dirty state after the draft commits', async () => {
    activateTab(makeTab(new Uri('file', '', '/data.csv'), false, false));
    state.version = '1.99.0'; await toggle(); assert.strictEqual(state.events.length, 0);
    state.version = '1.119.0'; await toggle(); assert.strictEqual(state.events.at(-1)?.[0], 'reopenActiveEditorWith');
    state.events = []; activateTab(makeTab(new Uri('file', '', '/data.csv'), true, false));
    state.commit = async () => { state.group.activeTab.isDirty = true; return true; };
    await toggle(); assert.deepStrictEqual(state.events, [['commit']]); assert.match(state.information.at(-1)!, /1\.120/);
    state.version = '1.120.0'; state.events = []; await toggle();
    assert.strictEqual(state.events.at(-1)?.[0], 'reopenActiveEditorWith');
    state.events = []; state.available = false; await toggle(); assert.strictEqual(state.events.length, 0);
  });

  it('tests the native command and dirty-working-copy compatibility boundaries', () => {
    for (const [version, dirty, expected] of [
      ['1.99.0', false, false], ['1.100.0', false, true], ['1.119.0', false, true],
      ['1.119.0', true, false], ['1.120.0', true, true], ['1.142.0', true, true],
      ['1.120.0-insider', true, true], ['2.0.0', true, true], ['unknown', false, false]
    ] as const) { assert.strictEqual(supportsEditorReplacement(version, dirty), expected); }
  });

  it('contributes the real native text-pane toolbar context and updated documentation', () => {
    const root = path.join(__dirname, '..', '..');
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const action = manifest.contributes.menus['editor/title'].find((entry: any) => entry.command === 'csv.toggleEditor');
    assert.ok(manifest.activationEvents.includes('onCommand:csv.toggleEditor'));
    assert.match(action.when, /activeEditor == workbench\.editors\.files\.textFileEditor/);
    assert.match(action.when, /activeCustomEditorId == csv\.editor/);
    assert.ok(action.when.includes('!isInDiffEditor'));
    assert.ok(action.when.includes('resourceScheme != untitled'));
    assert.ok(!action.when.includes('workbench.editors.textEditor'));
    const guide = fs.readFileSync(path.join(root, 'docs', 'user-guide.md'), 'utf8');
    assert.ok(!guide.includes('Both representations may remain open'));
    assert.ok(guide.includes('one representation remains'));
  });
});


describe('Text routing transaction around native replacement', () => {
  function transaction(): EditorSwitchRouting {
    return { supported: true, commit: async () => { state.events.push(['routing-commit']); }, rollback: async () => { state.events.push(['routing-rollback']); } };
  }
  it('proves native routing with an unqualified open and finalizes only after replacement', async () => {
    const uri = new Uri('file', '', '/data/check.csv'); activateTab(makeTab(uri, true));
    state.prepareRouting = async () => { state.events.push(['routing-prepare']); return transaction(); };
    await toggle();
    assert.ok(state.group.activeTab.input instanceof TabInputText);
    assert.ok(state.events.some(event => event[0] === 'vscode.open'));
    const replacement = state.events.findIndex(event => event[0] === 'reopenActiveEditorWith');
    assert.ok(state.events.findIndex(event => event[0] === 'routing-commit') > replacement);
    assert.ok(state.events.every(event => event[0] !== 'routing-rollback'));
  });
  it('rolls provisional Text routing back after a failed native replacement', async () => {
    activateTab(makeTab(new Uri('file', '', '/data/check.csv'), true));
    state.prepareRouting = async () => transaction(); state.replace = async () => { throw new Error('cancelled'); };
    await toggle();
    assert.ok(state.events.some(event => event[0] === 'routing-rollback'));
    assert.ok(state.events.every(event => event[0] !== 'routing-commit'));
    assert.ok(state.group.activeTab.input instanceof TabInputCustom);
  });
  it('does not close the source or finalize Text when a longer user association still chooses table', async () => {
    activateTab(makeTab(new Uri('file', '', '/data/check.csv'), true));
    state.prepareRouting = async () => transaction(); state.unqualifiedTable = true;
    await toggle();
    assert.ok(state.group.activeTab.input instanceof TabInputCustom);
    assert.ok(state.events.every(event => event[0] !== 'reopenActiveEditorWith'));
    assert.ok(state.events.some(event => event[0] === 'routing-rollback'));
    assert.ok(state.information.some(message => message.includes('editor associations still choose')));
  });
  it('retains the established remote switch with honest search guidance', async () => {
    activateTab(makeTab(new Uri('vscode-remote', 'wsl+Ubuntu', '/data/check.csv'), true));
    state.prepareRouting = async () => ({ ...transaction(), supported: false, limitation: 'Turn CSV off before Find in Files for this URI.' });
    await toggle();
    assert.ok(state.group.activeTab.input instanceof TabInputText);
    assert.ok(state.events.every(event => event[0] !== 'vscode.open'));
    assert.ok(state.information.some(message => message.includes('Turn CSV off')));
  });
  it('rolls back prepared routing if the user changes group before target opening', async () => {
    activateTab(makeTab(new Uri('file', '', '/data/check.csv'), true));
    const original = state.group;
    state.prepareRouting = async () => {
      state.otherGroups = [original]; state.group = { viewColumn: 3, tabs: [], activeTab: undefined };
      return transaction();
    };
    await toggle();
    assert.ok(state.events.some(event => event[0] === 'routing-rollback'));
    assert.ok(state.events.every(event => !['vscode.open', 'vscode.openWith', 'reopenActiveEditorWith'].includes(event[0])));
    assert.ok(original.activeTab.input instanceof TabInputCustom);
  });

  it('waits for delayed extension-host tab events before committing Table routing', async () => {
    activateTab(makeTab(new Uri('file', '', '/data/check.csv'), false));
    state.prepareRouting = async () => transaction();
    const replace = state.replace;
    state.replace = async viewType => {
      setImmediate(async () => { await replace(viewType); state.tabListeners.forEach(listener => listener()); });
    };
    await toggle();
    assert.ok(state.group.activeTab.input instanceof TabInputCustom);
    assert.ok(state.events.some(event => event[0] === 'routing-commit'));
    assert.ok(state.events.every(event => event[0] !== 'routing-rollback'));
    assert.strictEqual(state.tabListeners.size, 0);
  });

  it('starts its tab-event timeout after a slow native command completes', async () => {
    activateTab(makeTab(new Uri('file', '', '/data/check.csv'), false));
    state.prepareRouting = async () => transaction();
    const replace = state.replace;
    let release!: () => void;
    state.replace = async () => { await new Promise<void>(resolve => { release = resolve; }); };
    const originalTimer = global.setTimeout;
    const timers: Array<() => void> = [];
    global.setTimeout = ((callback: () => void, milliseconds: number, ...args: any[]) => {
      if (milliseconds === 5000) { timers.push(callback); return {} as any; }
      return originalTimer(callback, milliseconds, ...args);
    }) as typeof setTimeout;
    try {
      const changing = toggle();
      while (!release) { await new Promise(resolve => setImmediate(resolve)); }
      assert.strictEqual(timers.length, 0, 'a slow native command cannot consume the event-settlement timeout');
      release();
      while (!timers.length) { await new Promise(resolve => setImmediate(resolve)); }
      await replace('csv.editor'); state.tabListeners.forEach(listener => listener());
      await changing;
      assert.ok(state.events.some(event => event[0] === 'routing-commit'));
      assert.ok(state.events.every(event => event[0] !== 'routing-rollback'));
    } finally { global.setTimeout = originalTimer; }
  });

});
