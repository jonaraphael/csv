import assert from 'assert';
import { createTestMemento } from './test-memento';
import Module from 'module';
import { describe, it } from 'node:test';

const commands = new Map<string, () => Promise<void>>();
let input: string | undefined;
let prompt: any;
const routingErrors: string[] = [];
const configurationListeners: Array<(event: any) => Promise<void>> = [];
let changedConfiguration: (event: any) => Promise<void[]>;
const originalRequire = Module.prototype.require;
Module.prototype.require = function (id: string) {
  if (id === 'vscode') {
    return {
      TabInputText: class {},
      ConfigurationTarget: { Global: 1, Workspace: 2 },
      commands: { registerCommand: (name: string, callback: () => Promise<void>) => { commands.set(name, callback); return { dispose() {} }; } },
      window: { tabGroups: { all: [], activeTabGroup: { viewColumn: 1, tabs: [], activeTab: undefined } }, visibleTextEditors: [], onDidChangeActiveTextEditor: () => ({ dispose() {} }), showInputBox: async (options: any) => { prompt = options; return input; }, showInformationMessage() {}, showErrorMessage: (message: string) => { routingErrors.push(message); }, registerCustomEditorProvider: () => ({ dispose() {} }) },
      workspace: { textDocuments: [], onDidOpenTextDocument: () => ({ dispose() {} }), onDidCloseTextDocument: () => ({ dispose() {} }), getConfiguration: (section: string) => ({ inspect: (key: string) => section === 'csv' && key === 'enabled' ? { defaultValue: true } : undefined, get: (key: string, fallback: any) => section === 'csv' && key === 'defaultIgnoreRows' ? 7 : fallback }), onDidChangeConfiguration: (listener: any) => { configurationListeners.push(listener); changedConfiguration = event => Promise.all(configurationListeners.map(callback => callback(event))); return { dispose() {} }; } }
    };
  }
  return originalRequire.apply(this, arguments as any);
};
import { activate } from '../extension';
import { CsvEditorProvider } from '../CsvEditorProvider';
Module.prototype.require = originalRequire;

describe('Hidden-row override controls', () => {
  it('uses zero as an explicit override and blank input to inherit again; cancellation keeps the override', async () => {
    const values: Record<string, any> = {};
    const context = { subscriptions: [], globalState: createTestMemento(), workspaceState: { keys: () => Object.keys(values).filter(key => values[key] !== undefined), get: (key: string, fallback: any) => values[key] ?? fallback, update: async (key: string, value: any) => { values[key] = value; } } } as any;
    await activate(context);
    assert.deepStrictEqual(routingErrors, [], 'routing initialization must finish without fixture errors');
    const uri = { toString: () => 'file:///sample.csv' } as any;
    let refreshed = 0;
    const active = { isActive: () => true, getDocumentUri: () => uri, refreshViewSafely: () => refreshed++ } as any;
    CsvEditorProvider.currentActive = active;
    CsvEditorProvider.editors = [active];
    input = '0';
    await commands.get('csv.changeIgnoreRows')!();
    assert.strictEqual(CsvEditorProvider.getHiddenRowsForUri(context, uri), 0);
    await changedConfiguration!({ affectsConfiguration: (key: string) => key === 'csv.defaultIgnoreRows' });
    assert.strictEqual(refreshed, 1, 'an explicit override must not interrupt editing when defaults change');
    assert.strictEqual(prompt.validateInput(''), undefined);
    assert.ok(prompt.validateInput('-1'));
    assert.ok(prompt.validateInput('1.5'));
    input = undefined;
    await commands.get('csv.changeIgnoreRows')!();
    assert.strictEqual(CsvEditorProvider.getHiddenRowsForUri(context, uri), 0);
    input = '';
    await commands.get('csv.changeIgnoreRows')!();
    assert.strictEqual(CsvEditorProvider.getHiddenRowsForUri(context, uri), 7);
    assert.strictEqual(refreshed, 2);
    await changedConfiguration!({ affectsConfiguration: (key: string) => key === 'csv.defaultIgnoreRows' });
    assert.strictEqual(refreshed, 3, 'default setting updates use the edit-safe refresh path');
    assert.deepStrictEqual(routingErrors, []);
    CsvEditorProvider.currentActive = undefined;
    CsvEditorProvider.editors = [];
  });
});
