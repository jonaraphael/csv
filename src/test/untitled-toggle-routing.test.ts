import assert from 'assert';
import Module from 'module';
import { describe, it } from 'node:test';

class Uri {
  constructor(public scheme: string, public path: string) {}
  toString() { return `${this.scheme}:${this.path}`; }
}
class TabInputText { constructor(public uri: Uri) {} }
class TabInputCustom { constructor(public uri: Uri, public viewType: string) {} }
const owner = { uri: new Uri('untitled', 'Untitled-1'), languageId: 'csv' };
const group = { viewColumn: 1, activeTab: undefined as any };
const opened: unknown[] = [];
const vscode = {
  TabInputText, TabInputCustom, version: '1.142.0',
  window: { activeTextEditor: { document: owner, viewColumn: 2 },
    tabGroups: { activeTabGroup: group }, showInformationMessage() {}, showErrorMessage() {} },
  workspace: { getConfiguration: () => ({ get: () => true }) },
  commands: { getCommands: async () => [] }
};
const originalRequire = Module.prototype.require;
Module.prototype.require = function (id: string) {
  if (id === 'vscode') { return vscode; }
  if (id === './CsvEditorProvider') { return { CsvEditorProvider: { viewType: 'csv.editor' } }; }
  if (id === './untitled-editors') {
    return { getActiveUntitledCsvEditor: () => undefined,
      isUntitledCsv: (document: typeof owner) => document.uri.scheme === 'untitled',
      openUntitledCsvEditor: async (document: unknown, column: number) => { opened.push({ document, column }); } };
  }
  return originalRequire.apply(this, arguments as any);
};
const { toggleCsvEditor } = require('../editor-switch') as typeof import('../editor-switch');
Module.prototype.require = originalRequire;

describe('untitled switch routing across editor groups', () => {
  it('ignores another group’s untitled text owner while switching a saved table', async () => {
    opened.length = 0;
    group.activeTab = { input: new TabInputCustom(new Uri('file', '/saved.csv'), 'csv.editor') };
    await toggleCsvEditor();
    assert.deepStrictEqual(opened, []);
  });
  it('ignores another group’s untitled text owner while switching saved text', async () => {
    opened.length = 0;
    group.activeTab = { input: new TabInputText(new Uri('file', '/saved.csv')) };
    await toggleCsvEditor();
    assert.deepStrictEqual(opened, []);
  });
  it('opens the untitled grid when its native owner is the active tab', async () => {
    opened.length = 0;
    group.activeTab = { input: new TabInputText(owner.uri) };
    await toggleCsvEditor();
    assert.deepStrictEqual(opened, [{ document: owner, column: 1 }]);
  });
});
