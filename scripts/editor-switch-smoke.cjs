// Run in an isolated VS Code development host using --extensionTestsPath.
const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');
const vscode = require('vscode');

exports.run = async function () {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-editor-switch-'));
  const extension = vscode.extensions.getExtension('ReprEng.csv');
  assert.ok(extension, 'development extension must be loaded');
  await extension.activate();
  try {
    for (const [suffix, contents] of [['csv', 'name,value\nfirst,1'], ['tsv', 'name\tvalue\nfirst\t1']]) {
      const filename = path.join(directory, `data.${suffix}`);
      fs.writeFileSync(filename, contents);
      const uri = vscode.Uri.file(filename);
      await vscode.commands.executeCommand('vscode.openWith', uri, 'default', { preview: false });
      const edit = new vscode.WorkspaceEdit();
      edit.insert(uri, new vscode.Position(1, 0), 'unsaved-');
      assert.equal(await vscode.workspace.applyEdit(edit), true);
      for (let round = 0; round < 2; round++) {
        for (const viewType of ['csv.editor', 'default']) {
          await vscode.commands.executeCommand('csv.toggleEditor');
          const group = vscode.window.tabGroups.activeTabGroup;
          const tabs = group.tabs.filter(tab => tab.input.uri?.toString() === uri.toString());
          assert.equal(tabs.length, 2, 'repeated switches must reuse the two existing views');
          assert.equal(tabs.filter(tab => tab.input instanceof vscode.TabInputCustom).length, 1);
          assert.equal(tabs.filter(tab => tab.input instanceof vscode.TabInputText).length, 1);
          if (viewType === 'csv.editor') {
            assert.equal(group.activeTab.input.viewType, viewType);
          } else {
            assert.ok(group.activeTab.input instanceof vscode.TabInputText);
          }
          const live = vscode.workspace.textDocuments.find(document => document.uri.toString() === uri.toString());
          assert.ok(live, 'the live document must remain open');
          assert.equal(live.isDirty, true);
          assert.ok(live.getText().includes('unsaved-first'));
          assert.equal(fs.readFileSync(filename, 'utf8'), contents, 'switching must not save');
        }
      }
      await vscode.commands.executeCommand('workbench.action.files.revert');
      const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input.uri?.toString() === uri.toString());
      await vscode.window.tabGroups.close(tabs);
    }
    console.log('CSV_SWITCH_SMOKE_OK: dirty CSV+TSV preserved, disk unchanged, exactly one tab per view across repeated switches');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
};
