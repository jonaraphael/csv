import { getFonts } from 'font-list';
import * as vscode from 'vscode';
import { CsvEditorProvider } from './CsvEditorProvider';

async function toggleBooleanConfig(key: string, defaultVal: boolean, messagePrefix: string) {
  const config = vscode.workspace.getConfiguration('csv');
  const currentVal = config.get<boolean>(key, defaultVal);
  const newVal = !currentVal;
  await config.update(key, newVal, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(`${messagePrefix} ${newVal ? 'enabled' : 'disabled'}.`);
  CsvEditorProvider.editors.forEach(ed => ed.refresh());
}

export function registerCsvCommands(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('csv.toggleExtension', () =>
      toggleBooleanConfig('enabled', true, 'CSV extension')
    ),
    vscode.commands.registerCommand('csv.toggleHeader', async () => {
      const active = CsvEditorProvider.getActiveProvider();
      if (!active) { vscode.window.showInformationMessage('Open a CSV/TSV file in the CSV editor.'); return; }
      const uri = active.getDocumentUri();
      const cur = CsvEditorProvider.getHeaderForUri(context, uri);
      await CsvEditorProvider.setHeaderForUri(context, uri, !cur);
      CsvEditorProvider.editors.filter(ed => ed.getDocumentUri().toString() === uri.toString()).forEach(ed => ed.refresh());
      vscode.window.showInformationMessage(`CSV: First row as header ${!cur ? 'enabled' : 'disabled'} for this file.`);
    }),
    vscode.commands.registerCommand('csv.toggleSerialIndex', async () => {
      const active = CsvEditorProvider.getActiveProvider();
      if (!active) { vscode.window.showInformationMessage('Open a CSV/TSV file in the CSV editor.'); return; }
      const uri = active.getDocumentUri();
      const cur = CsvEditorProvider.getSerialIndexForUri(context, uri);
      await CsvEditorProvider.setSerialIndexForUri(context, uri, !cur);
      CsvEditorProvider.editors.filter(ed => ed.getDocumentUri().toString() === uri.toString()).forEach(ed => ed.refresh());
      vscode.window.showInformationMessage(`CSV: Serial index ${!cur ? 'enabled' : 'disabled'} for this file.`);
    }),
    vscode.commands.registerCommand('csv.changeSeparator', async () => {
      const active = CsvEditorProvider.getActiveProvider();
      if (!active) { vscode.window.showInformationMessage('Open a CSV/TSV file in the CSV editor.'); return; }
      const uri = active.getDocumentUri();
      const currentSep = CsvEditorProvider.getSeparatorForUri(context, uri) ?? (uri.fsPath.toLowerCase().endsWith('.tsv') ? '\\t' : ',');
      const input = await vscode.window.showInputBox({ prompt: 'Enter new CSV separator (empty to inherit from file)', value: currentSep });
      if (input !== undefined) {
        const sep = input;
        await CsvEditorProvider.setSeparatorForUri(context, uri, sep.length ? sep : undefined);
        vscode.window.showInformationMessage(`CSV separator ${sep.length ? `set to "${sep}"` : 'now inherits from file type'}`);
        CsvEditorProvider.editors.filter(ed => ed.getDocumentUri().toString() === uri.toString()).forEach(ed => ed.refresh());
      }
    }),
    vscode.commands.registerCommand('csv.changeFontFamily', async () => {
      const csvCfg     = vscode.workspace.getConfiguration('csv');
      const editorCfg  = vscode.workspace.getConfiguration('editor');

      const currentCsvFont   = csvCfg.get<string>('fontFamily', '');
      const inheritedFont    = editorCfg.get<string>('fontFamily', 'Menlo');
      const currentEffective = currentCsvFont || inheritedFont;

      let fonts: string[] = [];
      try {
        fonts = (await getFonts()).map((f: string) => f.replace(/^"(.*)"$/, '$1')).sort();
      } catch (e) {
        console.error('CSV: unable to enumerate system fonts', e);
      }
      const picks = ['(inherit editor setting)', ...fonts];

      const choice = await vscode.window.showQuickPick(picks, {
        placeHolder: `Current: ${currentEffective}`
      });
      if (choice === undefined) { return; }

      const newVal = choice === '(inherit editor setting)' ? '' : choice;
      await csvCfg.update('fontFamily', newVal, vscode.ConfigurationTarget.Global);

      vscode.window.showInformationMessage(
        newVal ? `CSV font set to “${newVal}”.` : 'CSV font now inherits editor.fontFamily.'
      );
      CsvEditorProvider.editors.forEach(ed => ed.refresh());
    }),
    vscode.commands.registerCommand('csv.changeIgnoreRows', async () => {
      const active = CsvEditorProvider.getActiveProvider();
      if (!active) {
        vscode.window.showInformationMessage('Open a CSV/TSV file with the CSV editor to change hidden rows.');
        return;
      }
      const uri = active.getDocumentUri();
      const current = CsvEditorProvider.getHiddenRowsForUri(context, uri);
      const input = await vscode.window.showInputBox({
        prompt: 'Hide first N rows (per file)',
        value: String(current),
        validateInput: (val: string) => (/^\d+$/.test(val) ? undefined : 'Enter a non-negative integer')
      });
      if (input === undefined) { return; }
      const n = parseInt(input, 10);
      await CsvEditorProvider.setHiddenRowsForUri(context, uri, n);
      // Refresh only editors showing this URI
      CsvEditorProvider.editors
        .filter(ed => ed.getDocumentUri().toString() === uri.toString())
        .forEach(ed => ed.refresh());
      vscode.window.showInformationMessage(`CSV: Hiding first ${n} row(s) for this file.`);
    })
  );
}
