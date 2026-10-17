import * as vscode from 'vscode';
import { CsvEditorProvider } from './CsvEditorProvider';
import { registerCsvCommands } from './commands';
import { CsvEditorAssociationRouting } from './editor-associations';
import { LargeFilePreviewProvider } from './large-file-preview';
import { registerUntitledCsvEditors } from './untitled-editors';

export async function activate(context: vscode.ExtensionContext) {
  console.log('CSV: Extension activated');

  const routing = new CsvEditorAssociationRouting(context, vscode);
  context.subscriptions.push(routing);
  let lastRoutingError: string | undefined;
  const synchronizeRouting = async () => {
    try {
      await routing.synchronize();
      lastRoutingError = undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== lastRoutingError) { void vscode.window.showErrorMessage(message); }
      lastRoutingError = message;
      throw error;
    }
  };
  let routingGeneration = 0;
  // Auto-refresh all open CSV editors when relevant CSV settings change
  const cfgListener = vscode.workspace.onDidChangeConfiguration(async e => {
    const invokingGroup = vscode.window.tabGroups.activeTabGroup;
    const invokingTab = invokingGroup?.activeTab;
    const affectsRouting = e.affectsConfiguration('csv.enabled') || e.affectsConfiguration('workbench.editorAssociations');
    if (affectsRouting) { ++routingGeneration; }
    if (affectsRouting) {
      try { await synchronizeRouting(); } catch (error) { console.error('CSV: editor routing update failed', error); return; }
    }
    // Re-enable the invoking saved file; background tabs keep their current view.
    if (e.affectsConfiguration('csv.enabled')) {
      const generation = routingGeneration;
      const enabled = vscode.workspace.getConfiguration('csv').get<boolean>('enabled', true);
      console.log(`[CSV(enable)]: configuration changed -> enabled=${enabled}`);
      if (enabled) {
        const input: any = invokingTab?.input;
        const uri: vscode.Uri | undefined = input?.uri instanceof vscode.Uri ? input.uri : undefined;
        const eligible = !input?.viewType && uri?.scheme !== 'untitled' && /\.(csv|tsv|tab|psv)$/i.test(uri?.path || uri?.fsPath || '');
        const stillEnabled = () => generation === routingGeneration && vscode.workspace.getConfiguration('csv').get<boolean>('enabled', true);
        // An inactive tab cannot be opened in-place without activating it inside
        // its group. Upgrade only the owner that invoked this mode change.
        if (eligible && uri && invokingTab && invokingGroup && stillEnabled() &&
            vscode.window.tabGroups.activeTabGroup === invokingGroup && invokingGroup.activeTab === invokingTab) {
          try {
            const hadTable = invokingGroup.tabs.some(tab => {
              const candidate: any = tab.input;
              return candidate?.viewType === CsvEditorProvider.viewType && candidate?.uri?.toString() === uri.toString();
            });
            await vscode.commands.executeCommand('vscode.open', uri, {
              viewColumn: invokingGroup.viewColumn, preserveFocus: false, preview: invokingTab.isPreview
            });
            if (stillEnabled() && vscode.window.tabGroups.activeTabGroup === invokingGroup) {
              const active: any = invokingGroup.activeTab?.input;
              const choseTable = active?.viewType === CsvEditorProvider.viewType && active?.uri?.toString() === uri.toString();
              if (!hadTable && choseTable && invokingGroup.tabs.includes(invokingTab) && !invokingTab.isDirty) {
                await vscode.window.tabGroups.close(invokingTab, true);
              }
            }
          } catch (error) { console.error('[CSV(enable)]: editor upgrade failed', error); }
        }
      } else {
        CsvEditorProvider.editors.slice().forEach(ed => ed.refresh());
      }
    }

    if (e.affectsConfiguration('csv.defaultIgnoreRows')) {
      CsvEditorProvider.editors
        .filter(editor => !CsvEditorProvider.hasHiddenRowsOverride(context, editor.getDocumentUri()) && e.affectsConfiguration('csv.defaultIgnoreRows', editor.getDocumentUri()))
        .forEach(editor => editor.refreshViewSafely());
    }

    const keys = [
      'csv.fontFamily',
      'csv.cellPadding',
      'csv.columnColorMode',
      'csv.columnColorPalette',
      'csv.diffUseThemeForeground',
      'csv.clickableLinks',
      'csv.showTrailingEmptyRow',
      'csv.separatorMode',
      'csv.defaultSeparator',
      'csv.separatorByExtension'
    ];
    const changed = keys.filter(k => e.affectsConfiguration(k));
    if (changed.length) {
      CsvEditorProvider.editors.forEach(ed => ed.refresh());
    }
  });
  context.subscriptions.push(cfgListener);

  // Listen before the first await so settings changes during recovery are queued.
  // Persisted Off routing must be installed before commands/provider handoffs.
  try { await synchronizeRouting(); } catch (error) { console.error('CSV: editor routing initialization failed', error); }
  registerCsvCommands(context, synchronizeRouting, (uri, target) => routing.prepareEditorSwitch(uri, target));

  // Register the custom editor provider for CSV/TSV
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(LargeFilePreviewProvider.viewType, new LargeFilePreviewProvider(context)),
    vscode.window.registerCustomEditorProvider(
      CsvEditorProvider.viewType,
      new CsvEditorProvider(context),
      { supportsMultipleEditorsPerDocument: false }
    )
  );
  registerUntitledCsvEditors(context);
}

export function deactivate() {
  console.log('CSV: Extension deactivated');
}
