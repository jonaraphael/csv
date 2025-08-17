import * as vscode from 'vscode';
import { CsvEditorProvider } from './CsvEditorProvider';
import { registerCsvCommands } from './commands';

export function activate(context: vscode.ExtensionContext) {
  console.log('CSV: Extension activated');

  // Commands (toggle features, change separator/font)
  registerCsvCommands(context);

  // Auto-refresh all open CSV editors when relevant CSV settings change
  const cfgListener = vscode.workspace.onDidChangeConfiguration(e => {
    const keys = [
      'csv.treatFirstRowAsHeader',
      'csv.addSerialIndex',
      'csv.separator',
      'csv.fontFamily',
      'csv.cellPadding',
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
