import assert from 'assert';
import fs from 'fs';
import Module from 'module';
import path from 'path';
import { beforeEach, describe, it } from 'node:test';

class Uri {
  constructor(public scheme: string, public authority: string, public path: string) {}
  toString() { return `${this.scheme}://${this.authority}${this.path}`; }
}
class TabInputText {
  constructor(public uri: Uri) {}
}
class TabInputCustom {
  constructor(public uri: Uri, public viewType: string) {}
}
class TabInputTextDiff {
  constructor(public original: Uri, public modified: Uri) {}
}
const state = {
  group: { viewColumn: 2, tabs: [] as any[], activeTab: undefined as any },
  enabled: true,
  events: [] as any[][],
  errors: [] as string[],
  information: [] as string[],
  registered: new Map<string, (...args: any[]) => any>(),
  open: async (_uri: Uri, _viewType: string): Promise<void> => {}
};
const vscode = {
  Uri, TabInputText, TabInputCustom,
  window: {
    tabGroups: {
      get activeTabGroup() { return state.group; },
      close: () => { assert.fail('switching must never close an editor or discard a pending draft'); }
    },
    showErrorMessage: (message: string) => { state.errors.push(message); },
    showInformationMessage: (message: string) => { state.information.push(message); }
  },
  workspace: {
    getConfiguration: () => ({ get: () => state.enabled })
  },
  commands: {
    executeCommand: async (command: string, uri?: Uri, viewType?: string, options?: any) => {
      if (command === 'workbench.action.keepEditor') {
        state.events.push([command]);
        state.group.activeTab.isPreview = false;
        return;
      }
      state.events.push([command, uri, viewType, options]);
      await state.open(uri!, viewType!);
    },
    registerCommand: (name: string, callback: (...args: any[]) => any) => {
      state.registered.set(name, callback);
      return { dispose() {} };
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
Module.prototype.require = originalRequire;

function makeTab(uri: Uri, table: boolean, preview = false) {
  return {
    input: table ? new TabInputCustom(uri, 'csv.editor') : new TabInputText(uri),
    isPreview: preview,
    isDirty: true
  };
}
function activateTab(tab: any) {
  state.group.tabs = [tab];
  state.group.activeTab = tab;
}
async function toggle() {
  await state.registered.get('csv.toggleEditor')!();
}

beforeEach(() => {
  state.group = { viewColumn: 2, tabs: [], activeTab: undefined };
  state.enabled = true;
  state.events = [];
  state.errors = [];
  state.information = [];
  state.registered.clear();
  registerCsvCommands({ subscriptions: [] } as any);
  state.open = async (uri, viewType) => {
    const table = viewType === 'csv.editor';
    let target = state.group.tabs.find(tab =>
      tab.input.uri.toString() === uri.toString() &&
      (table ? tab.input instanceof TabInputCustom : tab.input instanceof TabInputText)
    );
    if (!target) {
      target = makeTab(uri, table);
      state.group.tabs.push(target);
    }
    state.group.activeTab = target;
  };
});

describe('CSV table/text switch command', () => {
  for (const scheme of ['file', 'vscode-remote']) {
    for (const extension of ['csv', 'tsv', 'tab', 'psv', 'CSV']) {
      it(`reuses ${scheme} .${extension} views in both directions without closing either`, async () => {
        const uri = new Uri(scheme, scheme === 'file' ? '' : 'wsl+Ubuntu', `/data/example.${extension}`);
        const original = makeTab(uri, false);
        activateTab(original);
        const unrelated = makeTab(new Uri('file', '', '/other.csv'), false);
        state.group.tabs.push(unrelated);
        await toggle();
        assert.deepStrictEqual(state.events, [['vscode.openWith', uri, 'csv.editor', { viewColumn: 2, preserveFocus: false, preview: false }]]);
        assert.strictEqual(state.group.activeTab.input.uri, uri);
        assert.strictEqual(state.group.activeTab.isDirty, true);
        assert.strictEqual(state.group.viewColumn, 2);
        assert.ok(state.group.tabs.includes(unrelated));
        await toggle();
        assert.strictEqual(state.events[1][2], 'default');
        assert.strictEqual(state.group.activeTab.input.uri, uri);
        await toggle();
        await toggle();
        assert.strictEqual(state.group.tabs.filter(tab => tab.input.uri.toString() === uri.toString()).length, 2);
        assert.strictEqual(state.errors.length, 0);
      });
    }
  }

  it('pins a preview before opening the counterpart so an active grid draft is retained', async () => {
    const uri = new Uri('file', '', '/data.csv');
    const original = makeTab(uri, true, true);
    activateTab(original);
    await toggle();
    assert.deepStrictEqual(state.events[0], ['workbench.action.keepEditor']);
    assert.strictEqual(state.events[1][0], 'vscode.openWith');
    assert.strictEqual(state.events[1][3].preview, false);
    assert.ok(state.group.tabs.includes(original));
    assert.strictEqual(original.isPreview, false);
  });

  it('leaves the dirty source intact if opening the counterpart fails', async () => {
    const original = makeTab(new Uri('file', '', '/data.csv'), false);
    activateTab(original);
    state.open = async () => { throw new Error('open failed'); };
    await toggle();
    assert.deepStrictEqual(state.group.tabs, [original]);
    assert.strictEqual(original.isDirty, true);
    assert.strictEqual(state.errors.length, 1);
  });

  it('coalesces duplicate clicks while opening the same counterpart', async () => {
    activateTab(makeTab(new Uri('file', '', '/data.csv'), false));
    let finishOpen!: () => void;
    state.open = () => new Promise(resolve => { finishOpen = resolve; });
    const pending = toggle();
    await toggle();
    finishOpen();
    await pending;
    assert.strictEqual(state.events.length, 1);
  });

  it('respects disabled state when opening the table without changing configuration', async () => {
    state.enabled = false;
    activateTab(makeTab(new Uri('file', '', '/data.tsv'), false));
    await toggle();
    assert.strictEqual(state.events.length, 0);
    assert.strictEqual(state.enabled, false);
    assert.strictEqual(state.information.length, 1);
  });

  it('can leave the table for source text even if the extension has been disabled', async () => {
    state.enabled = false;
    activateTab(makeTab(new Uri('file', '', '/data.tsv'), true));
    await toggle();
    assert.strictEqual(state.events[0][2], 'default');
  });

  it('ignores unrelated custom editors, diff tabs, unsupported files, and empty groups', async () => {
    const uri = new Uri('file', '', '/data.csv');
    for (const input of [new TabInputCustom(uri, 'another.editor'), new TabInputTextDiff(uri, uri), new TabInputText(new Uri('file', '', '/notes.md'))]) {
      activateTab({ input });
      await toggle();
    }
    state.group.activeTab = undefined;
    await toggle();
    assert.strictEqual(state.events.length, 0);
  });

  it('contributes its command, activation, toolbar action, and documentation together', () => {
    const root = path.join(__dirname, '..', '..');
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const command = manifest.contributes.commands.find((entry: any) => entry.command === 'csv.toggleEditor');
    assert.strictEqual(command.title, 'CSV: Switch Between Table and Text');
    assert.ok(manifest.activationEvents.includes('onCommand:csv.toggleEditor'));
    const action = manifest.contributes.menus['editor/title'].find((entry: any) => entry.command === 'csv.toggleEditor');
    assert.strictEqual(action.group, 'navigation');
    assert.ok(action.when.includes('!isInDiffEditor'));
    assert.ok(fs.readFileSync(path.join(root, 'README.md'), 'utf8').includes('`csv.toggleEditor`'));
  });
});
