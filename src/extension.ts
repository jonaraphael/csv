import * as vscode from 'vscode';
import { CsvEditorProvider } from './CsvEditorProvider';
import { registerCsvCommands } from './commands';

export function activate(context: vscode.ExtensionContext) {
  console.log('CSV: Extension activated');

  // Commands (toggle features, change separator/font)
  registerCsvCommands(context);

  // Auto-refresh all open CSV editors when relevant CSV settings change
  const cfgListener = vscode.workspace.onDidChangeConfiguration(e => {
    // If the user turned the extension on, immediately upgrade open CSV/TSV tabs
    if (e.affectsConfiguration('csv.enabled')) {
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
            if (viewType === CsvEditorProvider.viewType) return; // already our editor
            if (!uri) return;
            const fsPath = uri.fsPath?.toLowerCase?.() || '';
            const isCsvLike = fsPath.endsWith('.csv') || fsPath.endsWith('.tsv') || fsPath.endsWith('.tab') || fsPath.endsWith('.psv');
            console.log(`[CSV(enable)]: -> eligible=${isCsvLike}`);
            if (!isCsvLike) return;
            candidates.push({ group, groupIndex: gi, tab, tabIndex: ti, uri, wasActive: tab.isActive, wasPreview: tab.isPreview, viewColumn: group.viewColumn });
          });
        });

        console.log(`[CSV(enable)]: candidates=${candidates.length}`);
        (async () => {
          const processed = new Set<string>();
          for (const c of candidates) {
            try {
              console.log(`[CSV(enable)]: closing group[${c.groupIndex}] tab[${c.tabIndex}] uri=${c.uri.fsPath}`);
              await vscode.window.tabGroups.close(c.tab);
            } catch (err) {
              console.error(`[CSV(enable)]: close failed for ${c.uri.fsPath}`, err);
            }
            try {
              const openOpts: any = { viewColumn: c.viewColumn, preserveFocus: !c.wasActive, preview: c.wasPreview };
              console.log(`[CSV(enable)]: opening custom editor for ${c.uri.fsPath} in column=${c.viewColumn}`);
              await vscode.commands.executeCommand('vscode.openWith', c.uri, CsvEditorProvider.viewType, openOpts);
              processed.add(c.uri.toString());
            } catch (err) {
              console.error(`[CSV(enable)]: openWith failed for ${c.uri.fsPath}`, err);
            }
          }

          // Final sweep: ensure no stale non-custom tabs remain for processed URIs across all groups
          try {
            const stale: vscode.Tab[] = [];
            vscode.window.tabGroups.all.forEach((g, gi) => {
              g.tabs.forEach((t, ti) => {
                const inp: any = (t as any).input;
                const vt = inp?.viewType;
                const u: vscode.Uri | undefined = inp?.uri instanceof vscode.Uri ? (inp.uri as vscode.Uri) : undefined;
                const key = u?.toString();
                if (key && processed.has(key) && vt !== CsvEditorProvider.viewType) {
                  console.log(`[CSV(enable)]: final-sweep closing group[${gi}] tab[${ti}] uri=${u?.fsPath} vt=${vt}`);
                  stale.push(t);
                }
              });
            });
            if (stale.length) {
              await vscode.window.tabGroups.close(stale);
            }
          } catch (err) {
            console.error('[CSV(enable)]: final-sweep error', err);
          }

          console.log(`[CSV(enable)]: done processing ${candidates.length} candidate(s)`);
        })();
      }
    }

    const keys = [
      'csv.fontFamily',
      'csv.cellPadding',
      'csv.columnColorMode',
      'csv.columnColorPalette',
      'csv.clickableLinks',
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
