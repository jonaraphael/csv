import * as vscode from 'vscode';
import { CsvEditorProvider } from './CsvEditorProvider';
import { registerCsvCommands } from './commands';
import { CsvEditorAssociationRouting } from './editor-associations';

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
    const affectsRouting = e.affectsConfiguration('csv.enabled') || e.affectsConfiguration('workbench.editorAssociations');
    if (affectsRouting) { ++routingGeneration; }
    if (affectsRouting) {
      try { await synchronizeRouting(); } catch (error) { console.error('CSV: editor routing update failed', error); return; }
    }
    // If the user turned the extension on, immediately upgrade open CSV/TSV tabs
    if (e.affectsConfiguration('csv.enabled')) {
      const generation = routingGeneration;
      const enabled = vscode.workspace.getConfiguration('csv').get<boolean>('enabled', true);
      console.log(`[CSV(enable)]: configuration changed -> enabled=${enabled}`);
      if (enabled) {
        // Snapshot candidates first to avoid mutating collections during iteration
        type Candidate = { group: vscode.TabGroup; groupIndex: number; tab: vscode.Tab; tabIndex: number; uri: vscode.Uri; wasActive: boolean; wasPreview: boolean; viewColumn: vscode.ViewColumn | undefined };
        const candidates: Candidate[] = [];
        const groups = vscode.window.tabGroups.all;
        console.log(`[CSV(enable)]: scanning ${groups.length} tab group(s)`);
        groups.forEach((group, gi) => {
          console.log(`[CSV(enable)]: group[${gi}] has ${group.tabs.length} tab(s)`);
          group.tabs.forEach((tab, ti) => {
            const input: any = (tab as any).input;
            const viewType = input?.viewType;
            const uri: vscode.Uri | undefined = input?.uri instanceof vscode.Uri ? (input.uri as vscode.Uri) : undefined;
            const path = uri?.fsPath || '(no-uri)';
            console.log(`[CSV(enable)]: group[${gi}] tab[${ti}] vt=${viewType ?? '(text?)'} uri=${path} active=${tab.isActive} preview=${tab.isPreview}`);
            if (!input) return;
            if (viewType) return; // Never replace another custom editor (or ours).
            if (!uri || uri.scheme === 'untitled') return;
            const fsPath = uri.fsPath?.toLowerCase?.() || '';
            const isCsvLike = fsPath.endsWith('.csv') || fsPath.endsWith('.tsv') || fsPath.endsWith('.tab') || fsPath.endsWith('.psv');
            console.log(`[CSV(enable)]: -> eligible=${isCsvLike}`);
            if (!isCsvLike) return;
            candidates.push({ group, groupIndex: gi, tab, tabIndex: ti, uri, wasActive: tab.isActive, wasPreview: tab.isPreview, viewColumn: group.viewColumn });
          });
        });

        console.log(`[CSV(enable)]: candidates=${candidates.length}`);
        await (async () => {
          const stillEnabled = () => generation === routingGeneration && vscode.workspace.getConfiguration('csv').get<boolean>('enabled', true);
          for (const c of candidates) {
            if (!stillEnabled()) { return; }
            if (!vscode.window.tabGroups.all.some(group => group === c.group && group.tabs.includes(c.tab))) { continue; }
            try {
              const hadTable = c.group.tabs.some(tab => {
                const input: any = tab.input;
                return input?.viewType === CsvEditorProvider.viewType && input?.uri?.toString() === c.uri.toString();
              });
              // Let the resolver honor restored native/other-editor choices.
              await vscode.commands.executeCommand('vscode.open', c.uri, { viewColumn: c.viewColumn, preserveFocus: !c.wasActive, preview: c.wasPreview });
              if (!stillEnabled()) { return; }
              const group = vscode.window.tabGroups.all.find(group => group === c.group);
              const hasTable = group?.tabs.some(tab => {
                const input: any = tab.input;
                return input?.viewType === CsvEditorProvider.viewType && input?.uri?.toString() === c.uri.toString();
              });
              // Keep dirty source owners and cancelled/failed resolutions intact.
              if (!hadTable && hasTable && group?.tabs.includes(c.tab) && !c.tab.isDirty && stillEnabled()) {
                await vscode.window.tabGroups.close(c.tab, true);
              }
            } catch (error) { console.error('[CSV(enable)]: editor upgrade failed', error); }
          }

          console.log(`[CSV(enable)]: done processing ${candidates.length} candidate(s)`);
        })();
      } else {
        CsvEditorProvider.editors.slice().forEach(ed => ed.refresh());
      }
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
    vscode.window.registerCustomEditorProvider(
      CsvEditorProvider.viewType,
      new CsvEditorProvider(context),
      { supportsMultipleEditorsPerDocument: false }
    )
  );
}

export function deactivate() {
  console.log('CSV: Extension deactivated');
}
