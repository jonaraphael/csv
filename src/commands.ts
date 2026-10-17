import { getFonts } from 'font-list';
import * as vscode from 'vscode';
import { CsvEditorProvider } from './CsvEditorProvider';
import { openLargeFilePreview } from './large-file-preview';
import { toggleCsvEditor } from './editor-switch';
import { compareFilesAsTable } from './table-comparison';
import { saveActiveUntitledCsvEditor } from './untitled-editors';

function displaySeparator(separator: string): string {
  return separator === '\t' ? '\\t' : separator;
}

function parseSeparatorInput(raw: string): string {
  return raw === '\\t' ? '\t' : raw;
}

async function toggleBooleanConfig(key: string, defaultVal: boolean, messagePrefix: string) {
  const config = vscode.workspace.getConfiguration('csv');
  const currentVal = config.get<boolean>(key, defaultVal);
  const newVal = !currentVal;
  await config.update(key, newVal, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(`${messagePrefix} ${newVal ? 'enabled' : 'disabled'}.`);
  CsvEditorProvider.editors.forEach(ed => ed.refresh());
}

async function changeFrozenPaneCount(axis: 'rows' | 'columns') {
  const active = CsvEditorProvider.getActiveProvider();
  if (!active) {
    vscode.window.showInformationMessage('Open a CSV/TSV/PSV file in the CSV editor.');
    return;
  }
  const current = active.getCurrentFrozenPanes()[axis];
  const input = await vscode.window.showInputBox({
    prompt: `Number of leading visible ${axis} to freeze (0 unfreezes)`,
    value: String(current),
    validateInput: value => /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? undefined : 'Enter a non-negative whole number.'
  });
  if (input !== undefined && /^\d+$/.test(input) && Number.isSafeInteger(Number(input))) {
    await active.setFrozenPanes({ [axis]: Number(input) });
  }
}

async function toggleCsvEnabled(synchronizeRouting: () => Promise<void>): Promise<void> {
  const config = vscode.workspace.getConfiguration('csv');
  const inspected = config.inspect<boolean>('enabled');
  const target = inspected?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  const previous = target === vscode.ConfigurationTarget.Workspace ? inspected?.workspaceValue : inspected?.globalValue;
  const next = !config.get<boolean>('enabled', true);
  await config.update('enabled', next, target);
  try {
    await synchronizeRouting();
  } catch (error) {
    // Do not report Off while VS Code still routes searches into the custom view.
    const current = config.inspect<boolean>('enabled');
    const value = target === vscode.ConfigurationTarget.Workspace ? current?.workspaceValue : current?.globalValue;
    if (value === next) {
      await config.update('enabled', previous, target);
      try { await synchronizeRouting(); } catch (restoreError) { console.error('CSV: routing rollback failed', restoreError); }
    }
    console.error('CSV: extension toggle was not applied', error);
    return;
  }
  vscode.window.showInformationMessage(`CSV extension ${next ? 'enabled' : 'disabled'}.`);
  CsvEditorProvider.editors.slice().forEach(ed => ed.refresh());
}

export function registerCsvCommands(context: vscode.ExtensionContext, synchronizeRouting: () => Promise<void> = async () => {}) {
  let pendingToggle: Promise<void> = Promise.resolve();
  context.subscriptions.push(
    vscode.commands.registerCommand('csv.changeFrozenRows', () => changeFrozenPaneCount('rows')),
    vscode.commands.registerCommand('csv.changeFrozenColumns', () => changeFrozenPaneCount('columns')),
    vscode.commands.registerCommand('csv.openLargeFilePreview', openLargeFilePreview),
    vscode.commands.registerCommand('csv.toggleEditor', toggleCsvEditor),
    vscode.commands.registerCommand('csv.compareFilesAsTable', (resource?: vscode.Uri, selected?: vscode.Uri[]) => compareFilesAsTable(context, resource, selected)),
    vscode.commands.registerCommand('csv.saveUntitled', saveActiveUntitledCsvEditor),
    vscode.commands.registerCommand('csv.toggleExtension', () => {
      const next = pendingToggle.catch(() => {}).then(() => toggleCsvEnabled(synchronizeRouting));
      pendingToggle = next;
      return next;
    }),
    vscode.commands.registerCommand('csv.toggleClickableLinks', () =>
      toggleBooleanConfig('clickableLinks', true, 'CSV clickable links')
    ),
    vscode.commands.registerCommand('csv.toggleHeader', async () => {
      const active = CsvEditorProvider.getActiveProvider();
      if (!active) { vscode.window.showInformationMessage('Open a CSV/TSV/PSV file in the CSV editor.'); return; }
      const uri = active.getDocumentUri();
      const cur = CsvEditorProvider.getHeaderForUri(context, uri);
      await CsvEditorProvider.setHeaderForUri(context, uri, !cur);
      CsvEditorProvider.editors.filter(ed => ed.getDocumentUri().toString() === uri.toString()).forEach(ed => ed.refresh());
      vscode.window.showInformationMessage(`CSV: First row as header ${!cur ? 'enabled' : 'disabled'} for this file.`);
    }),
    vscode.commands.registerCommand('csv.toggleSerialIndex', async () => {
      const active = CsvEditorProvider.getActiveProvider();
      if (!active) { vscode.window.showInformationMessage('Open a CSV/TSV/PSV file in the CSV editor.'); return; }
      const uri = active.getDocumentUri();
      const cur = CsvEditorProvider.getSerialIndexForUri(context, uri);
      await CsvEditorProvider.setSerialIndexForUri(context, uri, !cur);
      CsvEditorProvider.editors.filter(ed => ed.getDocumentUri().toString() === uri.toString()).forEach(ed => ed.refresh());
      vscode.window.showInformationMessage(`CSV: Serial index ${!cur ? 'enabled' : 'disabled'} for this file.`);
    }),
    vscode.commands.registerCommand('csv.changeSeparator', async () => {
      const active = CsvEditorProvider.getActiveProvider();
      if (!active) { vscode.window.showInformationMessage('Open a CSV/TSV/PSV file in the CSV editor.'); return; }
      const uri = active.getDocumentUri();
      const currentOverride = CsvEditorProvider.getSeparatorForUri(context, uri);
      const currentSep = currentOverride ?? active.getCurrentSeparator();
      const input = await vscode.window.showInputBox({
        prompt: 'Enter new CSV separator for this file (empty to inherit configured rules; use \\t for tab)',
        value: displaySeparator(currentSep)
      });
      if (input !== undefined) {
        const sep = input.length ? parseSeparatorInput(input) : undefined;
        await CsvEditorProvider.setSeparatorForUri(context, uri, sep);
        vscode.window.showInformationMessage(
          sep && sep.length
            ? `CSV separator set to "${displaySeparator(sep)}" for this file.`
            : 'CSV separator now inherits from configured separator settings.'
        );
        CsvEditorProvider.editors.filter(ed => ed.getDocumentUri().toString() === uri.toString()).forEach(ed => ed.refresh());
      }
    }),
    vscode.commands.registerCommand('csv.resetSeparator', async () => {
      const active = CsvEditorProvider.getActiveProvider();
      if (!active) { vscode.window.showInformationMessage('Open a CSV/TSV/PSV file in the CSV editor.'); return; }
      const uri = active.getDocumentUri();
      await CsvEditorProvider.setSeparatorForUri(context, uri, undefined);
      vscode.window.showInformationMessage('CSV separator override cleared for this file.');
      CsvEditorProvider.editors
        .filter(ed => ed.getDocumentUri().toString() === uri.toString())
        .forEach(ed => ed.refresh());
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
        vscode.window.showInformationMessage('Open a CSV/TSV/PSV file with the CSV editor to change hidden rows.');
        return;
      }
      const uri = active.getDocumentUri();
      const current = CsvEditorProvider.getHiddenRowsForUri(context, uri);
      const input = await vscode.window.showInputBox({
        prompt: 'Hide first N rows for this file (blank inherits csv.defaultIgnoreRows)',
        value: String(current),
        validateInput: (val: string) => (val.trim() === '' || (/^\d+$/.test(val) && Number.isSafeInteger(Number(val))) ? undefined : 'Enter a non-negative integer or leave blank to inherit')
      });
      if (input === undefined) { return; }
      if (input.trim() !== '' && (!/^\d+$/.test(input) || !Number.isSafeInteger(Number(input)))) { return; }
      const n = input.trim() === '' ? undefined : Number(input);
      await CsvEditorProvider.setHiddenRowsForUri(context, uri, n);
      // Refresh only editors showing this URI
      CsvEditorProvider.editors
        .filter(ed => ed.getDocumentUri().toString() === uri.toString())
        .forEach(ed => ed.refreshViewSafely());
      vscode.window.showInformationMessage(n === undefined ? 'CSV: Hidden rows now inherit csv.defaultIgnoreRows for this file.' : `CSV: Hiding first ${n} row(s) for this file.`);
    }),
    vscode.commands.registerCommand('csv.changeEncoding', async (requestedUri?: vscode.Uri) => {
      const active = CsvEditorProvider.getActiveProvider();
      const uri = requestedUri instanceof vscode.Uri ? requestedUri : active?.getDocumentUri();
      if (!uri) { vscode.window.showInformationMessage('Open a CSV/TSV/PSV file in the CSV editor.'); return; }
      if (uri.scheme === 'untitled') {
        vscode.window.showInformationMessage('Save this document before changing its file encoding.');
        return;
      }


      // Close any existing tabs for this URI so we can reuse the slot cleanly
      try {
        const toClose: vscode.Tab[] = [];
        vscode.window.tabGroups.all.forEach(g => {
          g.tabs.forEach(t => {
            const inp: any = (t as any).input;
            const u: vscode.Uri | undefined = inp?.uri instanceof vscode.Uri ? (inp.uri as vscode.Uri) : undefined;
            if (u && u.toString() === uri.toString()) toClose.push(t);
          });
        });
        if (toClose.length) {
          console.log(`[CSV(encoding)]: closing ${toClose.length} tab(s) for ${uri.fsPath}`);
          const closed = await vscode.window.tabGroups.close(toClose);
          if (!closed) {
            return;
          }
        }
      } catch (e) {
        console.warn('[CSV(encoding)]: failed to close existing tabs', e);
        return;
      }

      // Open the default text editor in-place and invoke the built-in encoding picker
      try {
        console.log(`[CSV(encoding)]: opening default text editor for ${uri.fsPath}`);
        await vscode.commands.executeCommand('vscode.openWith', uri, 'default', { preview: true, preserveFocus: false });

        console.log('[CSV(encoding)]: invoking workbench.action.editor.changeEncoding');
        await vscode.commands.executeCommand('workbench.action.editor.changeEncoding');

        // Switch back to our custom editor
        console.log(`[CSV(encoding)]: reopening with custom editor for ${uri.fsPath}`);
        await vscode.commands.executeCommand('vscode.openWith', uri, CsvEditorProvider.viewType, { preview: false, preserveFocus: false });

        // Best-effort: ensure no duplicate default tab remains
        try {
          const stale: vscode.Tab[] = [];
          vscode.window.tabGroups.all.forEach(g => g.tabs.forEach(t => {
            const inp: any = (t as any).input;
            const vt = inp?.viewType;
            const u: vscode.Uri | undefined = inp?.uri instanceof vscode.Uri ? (inp.uri as vscode.Uri) : undefined;
            if (u && u.toString() === uri.toString() && vt !== CsvEditorProvider.viewType) stale.push(t);
          }));
          if (stale.length) {
            console.log(`[CSV(encoding)]: closing ${stale.length} stale text tab(s)`);
            await vscode.window.tabGroups.close(stale);
          }
        } catch {}
      } catch (e) {
        console.error('CSV: encoding change flow failed', e);
        vscode.window.showWarningMessage('CSV: Could not invoke the built-in encoding picker. Please use File → Reopen with Encoding, then re-open the CSV view.');
      }
    })
  );
}
