import assert from 'assert';
import Module from 'module';
import { describe, it } from 'node:test';

class TabInputText { constructor(readonly uri: any) {} }
class Uri {
  readonly scheme = 'file';
  constructor(readonly fsPath: string) {}
  toString() { return `file://${this.fsPath}`; }
}
const clone = <T>(value: T): T => value === undefined ? value : JSON.parse(JSON.stringify(value));
function fixture(initial: { enabled?: boolean; workspaceEnabled?: boolean; associations?: Record<string, string> } = {}) {
  const data = { enabled: initial.enabled, workspaceEnabled: initial.workspaceEnabled, associations: clone(initial.associations), workspaceAssociations: undefined as Record<string, string> | undefined,
    failRouting: false, updates: [] as any[], opened: [] as any[], closed: [] as any[], errors: [] as string[], infos: [] as string[], beforeOpen: undefined as (() => Promise<void>) | undefined };
  const listeners: Array<(e: any) => Promise<void>> = [], events = new Set<Promise<void>>(), handlers = new Map<string, (...args: any[]) => any>();
  const emit = (key: string) => {
    for (const listener of listeners) {
      const next = Promise.resolve(listener({ affectsConfiguration: (candidate: string) => candidate === key }));
      events.add(next); void next.finally(() => events.delete(next));
    }
  };
  const store = () => {
    const values = new Map();
    return { keys: () => [...values.keys()].filter(key => values.get(key) !== undefined), get: (key: string) => clone(values.get(key)), update: async (key: string, value: unknown) => { values.set(key, clone(value)); } };
  };
  const group: any = { viewColumn: 1, tabs: [], activeTab: undefined };
  const groups = [group];
  let activeGroup = group;
  const api: any = {
    Uri, TabInputText, ConfigurationTarget: { Global: 1, Workspace: 2 },
    workspace: {
      workspaceFolders: [{}], workspaceFile: undefined, textDocuments: [],
      onDidOpenTextDocument: () => ({ dispose() {} }),
      onDidCloseTextDocument: () => ({ dispose() {} }),
      getConfiguration: (section: string) => ({
        get: (key: string, fallback: unknown) => section === 'csv' && key === 'enabled' ? (data.workspaceEnabled ?? data.enabled ?? fallback) : section === 'workbench' && key === 'editorAssociations' ? { ...data.associations, ...data.workspaceAssociations } : fallback,
        inspect: (key: string) => section === 'csv' && key === 'enabled' ? { defaultValue: true, globalValue: data.enabled, workspaceValue: data.workspaceEnabled } : section === 'workbench' && key === 'editorAssociations' ? { globalValue: clone(data.associations), workspaceValue: clone(data.workspaceAssociations) } : undefined,
        update: async (key: string, value: any, target: number) => {
          data.updates.push({ section, key, value: clone(value), target });
          if (section === 'csv') {
            if (target === 2) { data.workspaceEnabled = value; } else { data.enabled = value; }
          } else {
            if (data.failRouting) { throw new Error('read-only test settings'); }
            if (target === 2) { data.workspaceAssociations = clone(value); } else { data.associations = clone(value); }
          }
          emit(`${section}.${key}`);
        }
      }),
      onDidChangeConfiguration: (listener: (e: any) => Promise<void>) => { listeners.push(listener); return { dispose() {} }; }
    },
    window: {
      visibleTextEditors: [],
      onDidChangeActiveTextEditor: () => ({ dispose() {} }),
      tabGroups: { get all() { return groups; }, get activeTabGroup() { return activeGroup; }, close: async (tab: any) => { data.closed.push(tab); group.tabs = group.tabs.filter((candidate: any) => candidate !== tab); return true; } },
      showErrorMessage: (message: string) => { data.errors.push(message); },
      showInformationMessage: (message: string) => { data.infos.push(message); },
      registerCustomEditorProvider: () => ({ dispose() {} })
    },
    commands: {
      registerCommand: (id: string, handler: (...args: any[]) => any) => { handlers.set(id, handler); return { dispose() {} }; },
      executeCommand: async (...args: any[]) => {
        data.opened.push(args);
        await data.beforeOpen?.();
        if (args[0] === 'vscode.open' && args[1].fsPath !== '/keep-native.csv') {
          const table = { input: { uri: args[1], viewType: 'csv.editor' } };
          group.tabs.push(table); group.activeTab = table;
        }
      }
    }
  };
  class Provider {
    static viewType = 'csv.editor';
    static editors: any[] = [];
    constructor(_context: unknown) {}
  }
  const original = Module.prototype.require;
  Module.prototype.require = function (id: string) {
    if (id === 'vscode') { return api; }
    if (id === './CsvEditorProvider') { return { CsvEditorProvider: Provider }; }
    return original.apply(this, arguments as any);
  };
  let activate: (context: any) => Promise<void>;
  try {
    delete require.cache[require.resolve('../extension')];
    delete require.cache[require.resolve('../commands')];
    delete require.cache[require.resolve('../untitled-editors')];
    activate = require('../extension').activate;
  } finally { Module.prototype.require = original; }
  const context = { subscriptions: [], globalState: store(), workspaceState: store() };
  const idle = async () => {
    for (let n = 0; n < 100; n++) {
      if (!events.size) { return; }
      await Promise.all([...events]);
    }
    throw new Error('configuration events did not settle');
  };
  const addText = (path: string, dirty = false) => {
    group.tabs.forEach((tab: any) => { tab.isActive = false; });
    const tab = { input: new TabInputText(new Uri(path)), isActive: true, isPreview: false, isDirty: dirty };
    group.tabs.push(tab); group.activeTab = tab; return tab;
  };
  return { data, group, groups, setActiveGroup: (next: any) => { activeGroup = next; }, handlers, api, idle, addText, activate: () => activate(context), updateEnabled: (value: boolean) => api.workspace.getConfiguration('csv').update('enabled', value, 1) };
}

describe('CSV routing toggle and native resolver handoff', () => {
  it('serializes complete rapid toggles and restores the original association scope', async () => {
    const h = fixture(); await h.activate();
    const toggle = h.handlers.get('csv.toggleExtension')!;
    await Promise.all([toggle(), toggle()]); await h.idle();
    assert.strictEqual(h.data.enabled, true);
    assert.strictEqual(h.data.associations, undefined);
    assert.deepStrictEqual(h.data.updates.filter(update => update.key === 'enabled').map(update => update.value), [false, true]);
  });

  it('toggles an existing workspace override without changing global enablement or associations', async () => {
    const h = fixture({ enabled: true, workspaceEnabled: true, associations: { '*.md': 'default' } }); await h.activate();
    await h.handlers.get('csv.toggleExtension')!(); await h.idle();
    assert.strictEqual(h.data.workspaceEnabled, false); assert.strictEqual(h.data.enabled, true);
    assert.deepStrictEqual(h.data.associations, { '*.md': 'default' });
    assert.ok(h.data.updates.every(update => update.target === 2));
  });

  it('reports denied routing and rolls the toggle back without a disabled success notice', async () => {
    const h = fixture(); await h.activate(); h.data.failRouting = true;
    await h.handlers.get('csv.toggleExtension')!(); await h.idle();
    assert.strictEqual(h.data.enabled, undefined);
    assert.ok(h.data.errors.some(message => message.includes('read-only test settings')));
    assert.ok(h.data.infos.every(message => !message.includes('disabled')));
  });

  it('uses native resolution and preserves explicit native, external custom, and dirty source tabs', async () => {
    const h = fixture({ enabled: false, associations: { '**/keep-native.csv': 'default' } }); await h.activate();
    const native = h.addText('/keep-native.csv'), clean = h.addText('/normal.csv'), dirty = h.addText('/dirty.tsv', true);
    const external = { input: { uri: new Uri('/external.csv'), viewType: 'other.editor' } }; h.group.tabs.push(external);
    await h.updateEnabled(true); await h.idle();
    assert.ok(h.data.opened.every(args => args[0] === 'vscode.open'));
    assert.deepStrictEqual(h.data.closed, [], 'the active dirty owner stays open; inactive clean tabs are untouched');
    assert.ok(h.group.tabs.includes(clean));
    assert.deepStrictEqual(h.data.opened.map(args => args[1].fsPath), ['/dirty.tsv']);
    assert.ok(h.group.tabs.includes(native)); assert.ok(h.group.tabs.includes(dirty)); assert.ok(h.group.tabs.includes(external));
    assert.ok(h.data.opened.every(args => args[1].fsPath !== '/external.csv'));
  });

  it('does not close a captured source after Off supersedes an awaited On upgrade', async () => {
    const h = fixture({ enabled: false }); await h.activate(); const source = h.addText('/normal.csv');
    let release!: () => void;
    h.data.beforeOpen = () => new Promise<void>(resolve => { release = resolve; });
    await h.updateEnabled(true);
    while (!release) { await new Promise(resolve => setImmediate(resolve)); }
    await h.updateEnabled(false);
    release(); await h.idle();
    assert.strictEqual(h.data.enabled, false);
    assert.ok(h.group.tabs.includes(source)); assert.deepStrictEqual(h.data.closed, []);
  });
  it('keeps an explicit native source when an older counterpart table was already open', async () => {
    const h = fixture({ enabled: false, associations: { '**/keep-native.csv': 'default' } }); await h.activate();
    const source = h.addText('/keep-native.csv');
    const table = { input: { uri: source.input.uri, viewType: 'csv.editor' } }; h.group.tabs.push(table);
    await h.updateEnabled(true); await h.idle();
    assert.ok(h.group.tabs.includes(source)); assert.ok(h.group.tabs.includes(table));
    assert.deepStrictEqual(h.data.closed, []);
  });

  it('does not upgrade an inactive saved CSV over the invoking untitled owner', async () => {
    const h = fixture({ enabled: false }); await h.activate();
    const saved = h.addText('/old.csv');
    const owner = { input: new TabInputText({ scheme: 'untitled', fsPath: '/new.tsv', toString: () => 'untitled:/new.tsv' }), isActive: true, isDirty: true };
    saved.isActive = false; h.group.tabs.push(owner); h.group.activeTab = owner;
    await h.updateEnabled(true); await h.idle();
    assert.deepStrictEqual(h.data.opened, []);
    assert.deepStrictEqual(h.data.closed, []);
    assert.strictEqual(h.group.activeTab, owner);
  });
  it('upgrades only the active saved owner and leaves other groups intact', async () => {
    const h = fixture({ enabled: false }); await h.activate();
    const inactive = h.addText('/inactive.csv'), current = h.addText('/current.csv');
    const other = { viewColumn: 2, tabs: [{ input: new TabInputText(new Uri('/other.tsv')), isActive: true, isDirty: false }], activeTab: undefined as any };
    other.activeTab = other.tabs[0]; h.groups.push(other);
    await h.updateEnabled(true); await h.idle();
    assert.deepStrictEqual(h.data.opened.map(args => args[1].fsPath), ['/current.csv']);
    assert.deepStrictEqual(h.data.closed, [current]);
    assert.ok(h.group.tabs.includes(inactive)); assert.strictEqual(other.tabs.length, 1);
  });
  it('does not follow a captured saved owner after the user changes groups during routing', async () => {
    const h = fixture({ enabled: false }); await h.activate();
    const original = h.addText('/original.csv');
    const other = { viewColumn: 2, tabs: [] as any[], activeTab: undefined as any };
    h.groups.push(other);
    // The settings promise yields after the event starts but before routing completes.
    await h.updateEnabled(true); h.setActiveGroup(other);
    await h.idle();
    assert.deepStrictEqual(h.data.opened, []); assert.ok(h.group.tabs.includes(original));
  });

});
