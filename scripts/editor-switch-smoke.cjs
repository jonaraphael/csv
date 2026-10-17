// Run in an isolated VS Code development host using --extensionTestsPath.
const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');
const vscode = require('vscode');
const { CsvEditorProvider } = require('../out/CsvEditorProvider');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function tabsFor(uri, column) {
  return vscode.window.tabGroups.all.find(group => group.viewColumn === column).tabs.filter(tab => tab.input.uri?.toString() === uri.toString());
}
function snapshotOtherGroups(column) {
  return vscode.window.tabGroups.all.filter(group => group.viewColumn !== column).map(group => ({
    column: group.viewColumn,
    tabs: group.tabs.map(tab => ({ uri: tab.input.uri?.toString(), type: tab.input.viewType || 'text', dirty: tab.isDirty }))
  }));
}
exports.run = async function () {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-editor-switch-'));
  await vscode.extensions.getExtension('ReprEng.csv').activate();
  try {
    const unrelatedPath = path.join(directory, 'unrelated.csv');
    const otherPath = path.join(directory, 'other-group.csv');
    fs.writeFileSync(unrelatedPath, 'leave,this\nalone,1');
    fs.writeFileSync(otherPath, 'other,group\nkeep,2');
    const unrelated = vscode.Uri.file(unrelatedPath);
    await vscode.commands.executeCommand('vscode.openWith', unrelated, 'default', { preview: false });
    const sourceColumn = vscode.window.tabGroups.activeTabGroup.viewColumn;
    await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(otherPath), 'default', { viewColumn: vscode.ViewColumn.Beside, preview: false });
    const otherSnapshot = snapshotOtherGroups(sourceColumn);

    for (const [suffix, separator] of [['csv', ','], ['tsv', '\t'], ['tab', '\t'], ['psv', '|']]) {
      const filename = path.join(directory, `data.${suffix}`);
      const contents = `name${separator}value\nfirst${separator}1`;
      let expected = contents.replace('first', 'unsaved-first');
      fs.writeFileSync(filename, contents);
      const uri = vscode.Uri.file(filename);
      await vscode.commands.executeCommand('vscode.openWith', uri, 'default', { viewColumn: sourceColumn, preview: false });
      const edit = new vscode.WorkspaceEdit(); edit.insert(uri, new vscode.Position(1, 0), 'unsaved-');
      assert.equal(await vscode.workspace.applyEdit(edit), true);
      for (let round = 0; round < 2; round++) {
        for (const viewType of ['csv.editor', 'default']) {
          await vscode.commands.executeCommand('csv.toggleEditor');
          const group = vscode.window.tabGroups.activeTabGroup;
          const tabs = tabsFor(uri, sourceColumn);
          assert.equal(group.viewColumn, sourceColumn);
          assert.equal(tabs.length, 1, 'only one representation may remain after a switch');
          if (viewType === 'csv.editor') { assert.equal(group.activeTab.input.viewType, viewType); }
          else { assert.ok(group.activeTab.input instanceof vscode.TabInputText); }
          const live = vscode.workspace.textDocuments.find(document => document.uri.toString() === uri.toString());
          assert.ok(live); assert.equal(live.isDirty, true); assert.equal(live.getText(), expected);
          assert.equal(fs.readFileSync(filename, 'utf8'), contents, 'switching must not save');
          assert.deepEqual(snapshotOtherGroups(sourceColumn), otherSnapshot);
          const untouched = tabsFor(unrelated, sourceColumn);
          assert.equal(untouched.length, 1); assert.ok(untouched[0].input instanceof vscode.TabInputText, 'normalization must leave unrelated tabs alone');
          if (viewType === 'csv.editor' && round === 0) {
            const controller = CsvEditorProvider.getActiveProvider();
            void controller.enqueueOperation(() => controller.updateDocument(1, 1, '1\nqueued draft'));
            expected = `name${separator}value\nunsaved-first${separator}"1\nqueued draft"`;
          }
        }
      }
      if (suffix === 'csv') {
        // Recreate the previous draft's two-view state, then ensure replacement
        // reuses its existing counterpart and removes only the original source.
        await vscode.commands.executeCommand('vscode.openWith', uri, 'csv.editor', { viewColumn: sourceColumn, preview: false });
        await vscode.commands.executeCommand('vscode.openWith', uri, 'default', { viewColumn: sourceColumn, preview: false });
        assert.equal(tabsFor(uri, sourceColumn).length, 2);
        await vscode.commands.executeCommand('csv.toggleEditor');
        assert.equal(tabsFor(uri, sourceColumn).length, 1);
        assert.equal(vscode.workspace.textDocuments.find(document => document.uri.toString() === uri.toString()).getText(), expected);
        assert.equal(fs.readFileSync(filename, 'utf8'), contents);
        assert.deepEqual(snapshotOtherGroups(sourceColumn), otherSnapshot);
      }
    }

    const cancelPath = path.join(directory, 'cancel.csv');
    fs.writeFileSync(cancelPath, 'name,value\noriginal,1');
    const cancelUri = vscode.Uri.file(cancelPath);
    await vscode.commands.executeCommand('vscode.openWith', cancelUri, 'default', { viewColumn: sourceColumn, preview: false });
    const edit = new vscode.WorkspaceEdit(); edit.insert(cancelUri, new vscode.Position(1, 0), 'unsaved-');
    await vscode.workspace.applyEdit(edit);
    await vscode.workspace.getConfiguration('csv').update('maxFileSizeMB', 0.000001, vscode.ConfigurationTarget.Global);
    // Return the same result as pressing Cancel in the large-file prompt; the
    // extension-test host refuses modal dialogs instead of displaying them.
    const showWarning = vscode.window.showWarningMessage;
    vscode.window.showWarningMessage = async () => undefined;
    try { await vscode.commands.executeCommand('csv.toggleEditor'); }
    finally { vscode.window.showWarningMessage = showWarning; }
    await sleep(200);
    const live = vscode.workspace.textDocuments.find(document => document.uri.toString() === cancelUri.toString());
    assert.ok(live && live.isDirty, 'cancelled target initialization must retain the dirty owner');
    assert.equal(live.getText(), 'name,value\nunsaved-original,1');
    assert.equal(tabsFor(cancelUri, sourceColumn).length, 1);
    assert.ok(tabsFor(cancelUri, sourceColumn)[0].input instanceof vscode.TabInputText, 'cancellation keeps the source');
    assert.equal(fs.readFileSync(cancelPath, 'utf8'), 'name,value\noriginal,1');
    console.log('CSV_SWITCH_SMOKE_OK: dirty CSV/TSV/TAB/PSV, queued multiline edits, one representation, counterpart reuse, unrelated tabs unchanged, other groups unchanged, target cancellation retained');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
};
