import assert from 'assert';
import Module from 'module';
import { describe, it } from 'node:test';

const commands = new Map<string, () => Promise<void>>();
let input: string | undefined;
let prompt: any;
const configurationListeners: Array<(event: any) => void> = [];
let changedConfiguration: (event: any) => void;
const originalRequire = Module.prototype.require;
Module.prototype.require = function (id: string) {
  if (id === 'vscode') {
    return {
      commands: { registerCommand: (name: string, callback: () => Promise<void>) => { commands.set(name, callback); return { dispose() {} }; } },
      window: { onDidChangeActiveTextEditor: () => ({ dispose() {} }), showInputBox: async (options: any) => { prompt = options; return input; }, showInformationMessage() {}, registerCustomEditorProvider: () => ({ dispose() {} }) },
      workspace: { textDocuments: [], onDidOpenTextDocument: () => ({ dispose() {} }), onDidCloseTextDocument: () => ({ dispose() {} }), getConfiguration: () => ({ get: (key: string, fallback: any) => key === 'defaultIgnoreRows' ? 7 : fallback }), onDidChangeConfiguration: (listener: any) => { configurationListeners.push(listener); changedConfiguration = event => configurationListeners.forEach(callback => callback(event)); return { dispose() {} }; } }
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
    const context = { subscriptions: [], workspaceState: { get: (key: string, fallback: any) => values[key] ?? fallback, update: async (key: string, value: any) => { values[key] = value; } } } as any;
    activate(context);
    const uri = { toString: () => 'file:///sample.csv' } as any;
    let refreshed = 0;
    const active = { getDocumentUri: () => uri, refreshViewSafely: () => refreshed++ } as any;
    CsvEditorProvider.currentActive = active;
    CsvEditorProvider.editors = [active];
    input = '0';
    await commands.get('csv.changeIgnoreRows')!();
    assert.strictEqual(CsvEditorProvider.getHiddenRowsForUri(context, uri), 0);
    changedConfiguration!({ affectsConfiguration: (key: string) => key === 'csv.defaultIgnoreRows' });
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
    changedConfiguration!({ affectsConfiguration: (key: string) => key === 'csv.defaultIgnoreRows' });
    assert.strictEqual(refreshed, 3, 'default setting updates use the edit-safe refresh path');
    CsvEditorProvider.currentActive = undefined;
    CsvEditorProvider.editors = [];
  });
});
