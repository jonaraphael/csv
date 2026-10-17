import assert from 'assert';
import Module from 'module';
import { describe, it } from 'node:test';

class Uri {
  constructor(public fsPath: string, public scheme: string) {}
  toString() { return `${this.scheme}:${this.fsPath}`; }
}
const state = { listeners: [] as any[], tabs: [] as any[], calls: [] as any[][] };
const vscode = {
  Uri,
  workspace: {
    getConfiguration: () => ({ get: () => true }),
    onDidChangeConfiguration: (callback: any) => { state.listeners.push(callback); return { dispose() {} }; }
  },
  window: {
    tabGroups: {
      get all() { return [{ viewColumn: 1, tabs: state.tabs }]; },
      close: async (tabs: any) => { state.calls.push(['close', tabs]); return true; }
    },
    registerCustomEditorProvider: () => ({ dispose() {} })
  },
  commands: { executeCommand: async (...args: any[]) => { state.calls.push(args); } }
};
const originalRequire = Module.prototype.require;
Module.prototype.require = function (id: string) {
  if (id === 'vscode') { return vscode; }
  if (id === './CsvEditorProvider') { return { CsvEditorProvider: class { static viewType = 'csv.editor'; static editors = []; } }; }
  if (id === './commands') { return { registerCsvCommands() {} }; }
  if (id === './untitled-editors') { return { registerUntitledCsvEditors() {} }; }
  return originalRequire.apply(this, arguments as any);
};
import { activate } from '../extension';
Module.prototype.require = originalRequire;

describe('enabling the saved-file editor preserves untitled owners', () => {
  it('never closes or openWith-routes associated-path CSV/TSV untitled tabs', async () => {
    const csv = { input: { uri: new Uri('/workspace/data.csv', 'untitled') }, isActive: true };
    const tsv = { input: { uri: new Uri('/workspace/data.tsv', 'untitled') }, isActive: false };
    state.tabs = [csv, tsv];
    state.calls = [];
    state.listeners = [];
    activate({ subscriptions: [] } as any);
    state.listeners[0]({ affectsConfiguration: (key: string) => key === 'csv.enabled' });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepStrictEqual(state.calls, []);
    assert.deepStrictEqual(state.tabs, [csv, tsv]);
  });
});
