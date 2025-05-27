import * as assert from 'assert';
import * as vscode from 'vscode';
import { CsvEditorProvider } from '../extension';

suite('CSV Extension', () => {
  test('activates the extension', async () => {
    const ext = vscode.extensions.getExtension('ReprEng.csv');
    assert.ok(ext, 'Extension not found');
    await ext!.activate();
    assert.strictEqual(ext!.isActive, true);
  });

  test('toggleHeader command flips configuration', async () => {
    const config = vscode.workspace.getConfiguration('csv');
    const original = config.get<boolean>('treatFirstRowAsHeader');
    await vscode.commands.executeCommand('csv.toggleHeader');
    const toggled = config.get<boolean>('treatFirstRowAsHeader');
    assert.strictEqual(toggled, !original);
    // revert to original
    await vscode.commands.executeCommand('csv.toggleHeader');
    const reverted = config.get<boolean>('treatFirstRowAsHeader');
    assert.strictEqual(reverted, original);
  });

  test('opens CSV file using custom editor', async () => {
    const doc = await vscode.workspace.openTextDocument({ language: 'csv', content: 'a,b\n1,2' });
    await vscode.commands.executeCommand('vscode.openWith', doc.uri, 'csv.editor');
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.ok(CsvEditorProvider.editors.length > 0, 'Custom editor did not open');
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.strictEqual(CsvEditorProvider.editors.length, 0);
  });
});
