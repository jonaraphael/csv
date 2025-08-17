import * as vscode from 'vscode';
import { CsvEditorProvider } from './CsvEditorProvider';
import { registerCsvCommands } from './commands';

export function activate(context: vscode.ExtensionContext) {
  console.log('CSV: Extension activated');

  // Commands (toggle features, change separator/font)
  registerCsvCommands(context);

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
