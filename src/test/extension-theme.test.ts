import assert from 'assert';
import Module from 'module';
import { it } from 'node:test';

let themeChanged: () => void = () => {};
const themeListener = { dispose() {} };
const originalRequire = Module.prototype.require;
Module.prototype.require = function (id: string) {
  if (id === 'vscode') {
    return {
      commands: { registerCommand: () => ({ dispose() {} }) },
      workspace: { onDidChangeConfiguration: () => ({ dispose() {} }) },
      window: {
        onDidChangeActiveColorTheme: (listener: () => void) => { themeChanged = listener; return themeListener; },
        registerCustomEditorProvider: () => ({ dispose() {} })
      }
    };
  }
  return originalRequire.apply(this, arguments as any);
};
import { activate } from '../extension';
import { CsvEditorProvider } from '../CsvEditorProvider';
Module.prototype.require = originalRequire;

it('refreshes every open editor when the color theme changes and disposes the listener', () => {
  const context = { subscriptions: [] as any[] };
  activate(context as any);
  let refreshed = 0;
  CsvEditorProvider.editors = [{ refresh: () => refreshed++ }, { refresh: () => refreshed++ }] as any;
  themeChanged();
  assert.strictEqual(refreshed, 2);
  assert.ok(context.subscriptions.includes(themeListener));
  CsvEditorProvider.editors = [];
});
