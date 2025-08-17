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
    vscode.commands.registerCommand('csv.toggleHeader', () =>
      toggleBooleanConfig('treatFirstRowAsHeader', true, 'CSV first row as header is now')
    ),
    vscode.commands.registerCommand('csv.toggleSerialIndex', () =>
      toggleBooleanConfig('addSerialIndex', false, 'CSV serial index is now')
    ),
    vscode.commands.registerCommand('csv.changeSeparator', async () => {
      const config = vscode.workspace.getConfiguration('csv');
      const currentSep = config.get<string>('separator', ',');
      const input = await vscode.window.showInputBox({ prompt: 'Enter new CSV separator', value: currentSep });
      if (input !== undefined) {
        await config.update('separator', input, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(`CSV separator changed to "${input}"`);
        CsvEditorProvider.editors.forEach(ed => ed.refresh());
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
    })
  );
}
