import * as path from 'path';
import * as vscode from 'vscode';
import { CsvEditorProvider } from './CsvEditorProvider';
import { getActiveUntitledCsvEditor, isUntitledCsv, openUntitledCsvEditor } from './untitled-editors';

const switchingTabs = new Set<string>();
const supportedExtensions = new Set(['.csv', '.tsv', '.tab', '.psv']);

function getInputUri(input: unknown, viewType: string): vscode.Uri | undefined {
  if (viewType === 'default') {
    return input instanceof vscode.TabInputText ? input.uri : undefined;
  }
  return input instanceof vscode.TabInputCustom && input.viewType === viewType ? input.uri : undefined;
}

export async function toggleCsvEditor(): Promise<void> {
  const untitled = getActiveUntitledCsvEditor();
  if (untitled) {
    await vscode.window.showTextDocument(untitled.document, { viewColumn: untitled.panel.viewColumn, preview: false });
    return;
  }
  const activeDocument = vscode.window.activeTextEditor?.document;
  if (activeDocument && isUntitledCsv(activeDocument)) {
    await openUntitledCsvEditor(activeDocument, vscode.window.activeTextEditor?.viewColumn);
    return;
  }
  const group = vscode.window.tabGroups.activeTabGroup;
  const tab = group.activeTab;
  if (!tab) {
    return;
  }
  const tableUri = getInputUri(tab.input, CsvEditorProvider.viewType);
  const uri = tableUri ?? getInputUri(tab.input, 'default');
  if (!uri || !supportedExtensions.has(path.posix.extname(uri.path).toLowerCase())) {
    return;
  }
  const source = tableUri ? CsvEditorProvider.viewType : 'default';
  const target = tableUri ? 'default' : CsvEditorProvider.viewType;
  const switchKey = `${group.viewColumn}:${source}:${uri.toString()}`;
  if (switchingTabs.has(switchKey)) {
    return;
  }
  if (target === CsvEditorProvider.viewType && !vscode.workspace.getConfiguration('csv', uri).get<boolean>('enabled', true)) {
    vscode.window.showInformationMessage('Enable the CSV extension to switch to the table view.');
    return;
  }

  switchingTabs.add(switchKey);
  try {
    if (tab.isPreview) {
      // Keep an active table draft alive when opening its counterpart; a second
      // preview could otherwise replace this tab before the draft is committed.
      await vscode.commands.executeCommand('workbench.action.keepEditor');
      const current = vscode.window.tabGroups.activeTabGroup;
      if (current.viewColumn !== group.viewColumn ||
        getInputUri(current.activeTab?.input, source)?.toString() !== uri.toString()) {
        return;
      }
    }
    // Reuse/open the other representation without closing either view. Closing
    // even a shared dirty editor can prompt to save/discard its document, and a
    // table may still have an active draft that has not reached the document yet.
    await vscode.commands.executeCommand('vscode.openWith', uri, target, {
      viewColumn: group.viewColumn,
      preserveFocus: false,
      preview: false
    });
  } catch (error) {
    console.error('CSV: could not switch editor', error);
    vscode.window.showErrorMessage('CSV: Could not switch between the table and text editor.');
  } finally {
    switchingTabs.delete(switchKey);
  }
}
