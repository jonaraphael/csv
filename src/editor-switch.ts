import * as path from 'path';
import * as vscode from 'vscode';
import { CsvEditorProvider } from './CsvEditorProvider';
import { getActiveUntitledCsvEditor, isUntitledCsv, openUntitledCsvEditor, showActiveUntitledCsvSource } from './untitled-editors';

const switchingTabs = new Set<string>();
const supportedExtensions = new Set(['.csv', '.tsv', '.tab', '.psv']);

function getInputUri(input: unknown, viewType: string): vscode.Uri | undefined {
  if (viewType === 'default') {
    return input instanceof vscode.TabInputText ? input.uri : undefined;
  }
  return input instanceof vscode.TabInputCustom && input.viewType === viewType ? input.uri : undefined;
}

export function supportsEditorReplacement(version: string, dirty: boolean): boolean {
  const match = /^(\d+)\.(\d+)\./.exec(version);
  if (!match) {
    return false;
  }
  return Number(match[1]) > 1 || (Number(match[1]) === 1 && Number(match[2]) >= (dirty ? 120 : 100));
}

function showUpdateGuidance(dirty: boolean): void {
  void vscode.window.showInformationMessage(
    `CSV: Switching ${dirty ? 'an unsaved document' : 'between table and text'} requires VS Code ${dirty ? '1.120' : '1.100'} or newer. Update VS Code to use this action.`
  );
}

export async function toggleCsvEditor(): Promise<void> {
  const untitled = getActiveUntitledCsvEditor();
  if (untitled) {
    await showActiveUntitledCsvSource();
    return;
  }
  const activeDocument = vscode.window.activeTextEditor?.document;
  const activeInput = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (activeDocument && isUntitledCsv(activeDocument) && activeInput instanceof vscode.TabInputText &&
    activeInput.uri.toString() === activeDocument.uri.toString()) {
    await openUntitledCsvEditor(activeDocument, vscode.window.tabGroups.activeTabGroup.viewColumn);
    return;
  }
  const group = vscode.window.tabGroups.activeTabGroup;
  const tab = group.activeTab;
  if (!tab) {
    return;
  }
  const tableUri = getInputUri(tab.input, CsvEditorProvider.viewType);
  const uri = tableUri ?? getInputUri(tab.input, 'default');
  if (!uri || uri.scheme === 'untitled' || !supportedExtensions.has(path.posix.extname(uri.path).toLowerCase())) {
    return;
  }
  const source = tableUri ? CsvEditorProvider.viewType : 'default';
  const target = tableUri ? 'default' : CsvEditorProvider.viewType;
  const switchKey = `${group.viewColumn}:${uri.toString()}`;
  if (switchingTabs.has(switchKey)) {
    return;
  }
  if (target === CsvEditorProvider.viewType && !vscode.workspace.getConfiguration('csv', uri).get<boolean>('enabled', true)) {
    void vscode.window.showInformationMessage('Enable the CSV extension to switch to the table view.');
    return;
  }
  if (!supportsEditorReplacement(vscode.version, false)) {
    showUpdateGuidance(false);
    return;
  }

  switchingTabs.add(switchKey);
  try {
    if (!(await vscode.commands.getCommands(true)).includes('reopenActiveEditorWith')) {
      showUpdateGuidance(false);
      return;
    }
    if (tableUri) {
      const controller = CsvEditorProvider.editors.find(candidate =>
        candidate.getDocumentUri().toString() === uri.toString() && candidate.getViewColumn() === group.viewColumn
      );
      if (!controller || !(await controller.commitPendingDraft())) {
        void vscode.window.showErrorMessage('CSV: Could not commit the active cell. The current view has been kept open.');
        return;
      }
    }
    // The user may have changed tabs while the webview committed its draft.
    const current = vscode.window.tabGroups.activeTabGroup;
    if (current.viewColumn !== group.viewColumn || getInputUri(current.activeTab?.input, source)?.toString() !== uri.toString()) {
      return;
    }
    const dirty = current.activeTab!.isDirty || vscode.workspace.textDocuments.some(document =>
      document.uri.toString() === uri.toString() && document.isDirty
    );
    if (!supportsEditorReplacement(vscode.version, dirty)) {
      showUpdateGuidance(dirty);
      return;
    }
    const sameFileTableElsewhere = target === CsvEditorProvider.viewType && vscode.window.tabGroups.all.some(other =>
      other.viewColumn !== group.viewColumn && other.tabs.some(otherTab =>
        getInputUri(otherTab.input, target)?.toString() === uri.toString()
      )
    );
    if (sameFileTableElsewhere) {
      void vscode.window.showInformationMessage('CSV: This file already has a table in another editor group. Switch from that group to keep both groups intact.');
      return;
    }
    if (current.activeTab!.isPreview) {
      await vscode.commands.executeCommand('workbench.action.keepEditor');
      const pinned = vscode.window.tabGroups.activeTabGroup;
      if (pinned.viewColumn !== group.viewColumn || getInputUri(pinned.activeTab?.input, source)?.toString() !== uri.toString()) {
        return;
      }
    }
    // Resolve the target while the original is still pinned and owns its edits.
    // Provider cancellation or initialization failure must not remove the source.
    await vscode.commands.executeCommand('vscode.openWith', uri, target, {
      viewColumn: group.viewColumn, preserveFocus: false, preview: false
    });
    const targetGroup = vscode.window.tabGroups.activeTabGroup;
    let targetReady = targetGroup.viewColumn === group.viewColumn &&
      getInputUri(targetGroup.activeTab?.input, target)?.toString() === uri.toString();
    if (targetReady && target === CsvEditorProvider.viewType) {
      const controller = CsvEditorProvider.editors.find(candidate =>
        candidate.getDocumentUri().toString() === uri.toString() && candidate.getViewColumn() === group.viewColumn
      );
      targetReady = !!controller && await controller.commitPendingDraft();
    } else if (targetReady) {
      targetReady = vscode.window.activeTextEditor?.document.uri.toString() === uri.toString();
    }
    const afterReady = vscode.window.tabGroups.activeTabGroup;
    if (afterReady.viewColumn !== group.viewColumn ||
      (targetReady && getInputUri(afterReady.activeTab?.input, target)?.toString() !== uri.toString())) {
      return;
    }
    if (!targetReady) {
      const original = vscode.window.tabGroups.all.find(candidate => candidate.viewColumn === group.viewColumn);
      if (original?.tabs.some(candidate => getInputUri(candidate.input, source)?.toString() === uri.toString()) &&
        afterReady.viewColumn === group.viewColumn &&
        (!afterReady.activeTab || getInputUri(afterReady.activeTab.input, target)?.toString() === uri.toString())) {
        await vscode.commands.executeCommand('vscode.openWith', uri, source, {
          viewColumn: group.viewColumn, preserveFocus: false, preview: false
        });
      }
      return;
    }
    // Reopening acts on selected tabs. Revealing this exact source through the
    // ordinary open path narrows selection before replacing just this tab.
    await vscode.commands.executeCommand('vscode.openWith', uri, source, {
      viewColumn: group.viewColumn, preserveFocus: false, preview: false
    });
    const revealed = vscode.window.tabGroups.activeTabGroup;
    if (revealed.viewColumn !== group.viewColumn || getInputUri(revealed.activeTab?.input, source)?.toString() !== uri.toString()) {
      return;
    }
    const dirtyAfterOpen = revealed.activeTab!.isDirty || vscode.workspace.textDocuments.some(document =>
      document.uri.toString() === uri.toString() && document.isDirty
    );
    if (!supportsEditorReplacement(vscode.version, dirtyAfterOpen)) {
      showUpdateGuidance(dirtyAfterOpen);
      return;
    }
    // Native replacement opens the target before removing the source and retains
    // the shared dirty text working copy. A separate tab close can prompt/discard.
    await vscode.commands.executeCommand('reopenActiveEditorWith', target);
  } catch (error) {
    console.error('CSV: could not switch editor', error);
    void vscode.window.showErrorMessage('CSV: Could not switch between the table and text editor.');
  } finally {
    switchingTabs.delete(switchKey);
  }
}
