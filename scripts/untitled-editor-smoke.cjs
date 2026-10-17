// Run in an isolated VS Code development host using --extensionTestsPath.
const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');
const vscode = require('vscode');
const { CsvEditorProvider } = require('../out/CsvEditorProvider');
const { getActiveUntitledCsvEditor } = require('../out/untitled-editors');

async function waitUntil(predicate, message) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) { throw new Error(message); }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
async function prepare(document, language, content) {
  await vscode.window.showTextDocument(document, { preview: false });
  const edit = new vscode.WorkspaceEdit();
  edit.insert(document.uri, new vscode.Position(0, 0), content);
  assert.equal(await vscode.workspace.applyEdit(edit), true);
  const live = await vscode.languages.setTextDocumentLanguage(document, language);
  await waitUntil(() => getActiveUntitledCsvEditor()?.document === live, 'language mode should open the untitled table');
  assert.equal(live.getText(), content);
  assert.ok(vscode.window.tabGroups.all.flatMap(group => group.tabs).some(tab => tab.input.uri?.toString() === live.uri.toString() && tab.isDirty), 'native source must retain its unsaved state');
  return live;
}

exports.run = async function () {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-untitled-'));
  await vscode.extensions.getExtension('ReprEng.csv').activate();
  try {
    for (const language of ['csv', 'tsv']) {
      const separator = language === 'tsv' ? '\t' : ',';
      const filename = path.join(directory, `saved.${language}`);
      const uri = vscode.Uri.file(filename).with({ scheme: 'untitled' });
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.languages.setTextDocumentLanguage(document, 'plaintext');
      const contents = `name${separator}value\nnew${separator}42`;
      let live = await prepare(document, language, contents);
      await new Promise(resolve => setTimeout(resolve, 200));
      await vscode.workspace.getConfiguration('csv').update('enabled', false, vscode.ConfigurationTarget.Global);
      await waitUntil(() => vscode.window.activeTextEditor?.document.uri.toString() === live.uri.toString() && !getActiveUntitledCsvEditor(), 'disabling should reveal the native untitled owner');
      assert.equal(live.getText(), contents);
      assert.equal(fs.existsSync(filename), false, 'disabling must not save');
      await vscode.workspace.getConfiguration('csv').update('enabled', true, vscode.ConfigurationTarget.Global);
      await waitUntil(() => getActiveUntitledCsvEditor()?.document === live, 'enabling should safely reopen associated-path untitled buffers');
      assert.equal(live.getText(), contents);
      let controller = CsvEditorProvider.getActiveProvider();
      assert.ok(controller);
      assert.equal(controller.getCurrentSeparator(), separator);
      const oppositeLanguage = language === 'csv' ? 'tsv' : 'csv';
      live = await vscode.languages.setTextDocumentLanguage(live, oppositeLanguage);
      await waitUntil(() => getActiveUntitledCsvEditor()?.document === live && controller.getCurrentSeparator() === (oppositeLanguage === 'tsv' ? '\t' : ','), 'native language rebind should use its logical extension');
      assert.equal(live.getText(), contents, 'language change must not convert source data');
      live = await vscode.languages.setTextDocumentLanguage(live, language);
      await waitUntil(() => getActiveUntitledCsvEditor()?.document === live && controller.getCurrentSeparator() === separator, 'native language roundtrip should restore its logical extension');
      assert.equal(live.getText(), contents);
      await controller.updateDocument(1, 1, '43');
      const expected = `name${separator}value\nnew${separator}43`;
      assert.equal(live.getText(), expected);
      const previousPanel = getActiveUntitledCsvEditor().panel;
      await vscode.commands.executeCommand('csv.toggleEditor');
      assert.equal(vscode.window.activeTextEditor.document.uri.toString(), live.uri.toString());
      assert.equal(vscode.window.activeTextEditor.document.getText(), expected);
      assert.equal(getActiveUntitledCsvEditor(), undefined, 'source switch closes only the standalone table');
      assert.equal(live.isClosed, false, 'native unsaved owner remains live');
      assert.equal(fs.existsSync(filename), false, 'source switching must not save');
      await new Promise(resolve => setTimeout(resolve, 50));
      assert.ok(vscode.window.activeTextEditor, 'explicit source switch must stay in source');
      await vscode.commands.executeCommand('csv.toggleEditor');
      await waitUntil(() => getActiveUntitledCsvEditor()?.document === live, 'switch should recreate the untitled grid against the same owner');
      assert.notEqual(getActiveUntitledCsvEditor().panel, previousPanel);
      controller = CsvEditorProvider.getActiveProvider();
      const savedExpected = `name${separator}value\nnew${separator}"43\nqueued"`;
      void controller.enqueueOperation(() => controller.updateDocument(1, 1, '43\nqueued'));
      await vscode.commands.executeCommand('csv.saveUntitled');
      await waitUntil(() => live.isClosed && fs.existsSync(filename) && fs.readFileSync(filename, 'utf8') === savedExpected && !CsvEditorProvider.editors.some(candidate => candidate.getDocumentUri().toString() === live.uri.toString()), 'registered native save should finish writing exact bytes and close the temporary grid');
      assert.equal(fs.readFileSync(filename, 'utf8'), savedExpected);
      await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(filename), 'csv.editor', { preview: false });
      assert.equal(CsvEditorProvider.getActiveProvider().getCurrentSeparator(), separator);
    }

    const document = await vscode.workspace.openTextDocument({ language: 'plaintext' });
    const live = await prepare(document, 'csv', 'name,value\ncancel,42');
    const panel = getActiveUntitledCsvEditor().panel;
    const controller = CsvEditorProvider.getActiveProvider();
    await vscode.commands.executeCommand('csv.saveUntitled');
    await waitUntil(() => vscode.window.activeTextEditor?.document.uri.toString() === live.uri.toString() && !panel.active, 'registered Save As command should reveal the native owner and finish its view-state transition');
    await controller.enqueueOperation(() => {});
    // VS Code's isolated extension-test host cancels the native Save As picker.
    assert.equal(live.isClosed, false);
    assert.ok(vscode.window.tabGroups.all.flatMap(group => group.tabs).some(tab => tab.input.uri?.toString() === live.uri.toString() && tab.isDirty), 'cancel must retain the dirty native source');
    assert.equal(live.getText(), 'name,value\ncancel,42');
    await vscode.commands.executeCommand('csv.toggleEditor');
    await waitUntil(() => getActiveUntitledCsvEditor()?.panel === panel, 'cancelled Save As must retain and reuse the grid');
    panel.dispose();
    assert.equal(live.getText(), 'name,value\ncancel,42');
    assert.equal(CsvEditorProvider.currentActive, undefined);
    console.log('CSV_UNTITLED_SMOKE_OK: pretyped CSV+TSV, language roundtrips, shared edits, source switching, disable/re-enable, registered Save As exact native saves, cancelled Save As retained');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
};
