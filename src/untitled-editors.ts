import * as vscode from 'vscode';
import { CsvEditorProvider } from './CsvEditorProvider';

export const untitledCsvViewType = 'csv.untitledEditor';

type UntitledEditor = {
  document: vscode.TextDocument;
  panel: vscode.WebviewPanel;
};
const editors = new Map<string, UntitledEditor>();
const opened = new Set<string>();
const switchingToSource = new Set<string>();
let extensionContext: vscode.ExtensionContext | undefined;

export function isUntitledCsv(document: vscode.TextDocument): boolean {
  return document.uri.scheme === 'untitled' && (document.languageId === 'csv' || document.languageId === 'tsv');
}

export function getActiveUntitledCsvEditor(): UntitledEditor | undefined {
  return Array.from(editors.values()).find(editor => editor.panel.active && !editor.document.isClosed);
}

export function saveActiveUntitledCsvEditor(): void {
  const editor = getActiveUntitledCsvEditor();
  if (!editor) {
    return;
  }
  CsvEditorProvider.editors.find(controller => controller.getDocumentUri().toString() === editor.document.uri.toString())
    ?.saveUntitledAfterCommit();
}

export async function showActiveUntitledCsvSource(): Promise<void> {
  const editor = getActiveUntitledCsvEditor();
  if (!editor) {
    return;
  }
  const key = editor.document.uri.toString();
  if (switchingToSource.has(key)) {
    return;
  }
  const controller = CsvEditorProvider.editors.find(candidate => candidate.getDocumentUri().toString() === key);
  if (!controller) {
    return;
  }
  switchingToSource.add(key);
  try {
    if (!await controller.commitPendingDraft() || editors.get(key) !== editor || editor.document.isClosed) {
      return;
    }
    const source = await vscode.window.showTextDocument(editor.document, {
      viewColumn: controller.getViewColumn() ?? editor.panel.viewColumn, preview: false
    });
    if (source.document === editor.document && editors.get(key) === editor) {
      // The native owner remains open. Only its temporary standalone table closes.
      editor.panel.dispose();
    }
  } catch (error) {
    console.error('CSV: could not reveal the untitled source', error);
    void vscode.window.showErrorMessage('CSV: Could not switch the untitled table to text.');
  } finally {
    switchingToSource.delete(key);
  }
}

export async function openUntitledCsvEditor(document: vscode.TextDocument, viewColumn?: vscode.ViewColumn): Promise<void> {
  if (!extensionContext || document.isClosed || !isUntitledCsv(document) ||
    !vscode.workspace.getConfiguration('csv', document.uri).get<boolean>('enabled', true)) {
    return;
  }
  const key = document.uri.toString();
  const existing = editors.get(key);
  if (existing) {
    existing.panel.reveal(viewColumn);
    return;
  }
  opened.add(key);
  // A plain webview keeps the native untitled document as its owner. Asking
  // vscode.openWith for an untitled custom text editor can reset that document.
  const panel = vscode.window.createWebviewPanel(
    untitledCsvViewType,
    `${document.fileName.split(/[\\/]/).pop() || 'Untitled'} — CSV`,
    viewColumn ?? vscode.ViewColumn.Active,
    { enableScripts: true }
  );
  const tokenSource = new vscode.CancellationTokenSource();
  editors.set(key, { document, panel });
  panel.onDidDispose(() => {
    editors.delete(key);
    tokenSource.cancel();
    tokenSource.dispose();
    const active = CsvEditorProvider.currentActive;
    if (active?.getDocumentUri().toString() === key) {
      CsvEditorProvider.currentActive = undefined;
    }
  });
  try {
    await new CsvEditorProvider(extensionContext).resolveCustomTextEditor(document, panel, tokenSource.token);
  } catch (error) {
    opened.delete(key);
    panel.dispose();
    throw error;
  }
}

export function registerUntitledCsvEditors(context: vscode.ExtensionContext): void {
  extensionContext = context;
  const maybeOpen = (document?: vscode.TextDocument) => {
    const group = vscode.window.tabGroups.activeTabGroup;
    const input = group?.activeTab?.input;
    if (!(input instanceof vscode.TabInputText)) { return; }
    const active = vscode.window.visibleTextEditors.find(editor => editor.viewColumn === group.viewColumn &&
      editor.document.uri.toString() === input.uri.toString());
    const owner = active?.document;
    if (!owner || (document && owner.uri.toString() !== document.uri.toString()) ||
        !isUntitledCsv(owner) || opened.has(owner.uri.toString())) { return; }
    void openUntitledCsvEditor(owner, group.viewColumn).catch(error => {
      console.error('CSV: could not open the untitled table', error);
      vscode.window.showErrorMessage('CSV: Could not open the untitled document in the table view.');
    });
  };
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(editor => maybeOpen(editor?.document)),
    vscode.workspace.onDidOpenTextDocument(document => {
      if (document.uri.scheme !== 'untitled') {
        return;
      }
      if (!isUntitledCsv(document)) {
        opened.delete(document.uri.toString());
      }
      maybeOpen(document);
    }),
    vscode.workspace.onDidCloseTextDocument(document => {
      const key = document.uri.toString();
      if (!editors.has(key) && !opened.has(key)) {
        return;
      }
      // Changing language also closes/reopens a TextDocument at the same URI.
      setTimeout(() => {
        const replacement = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === key && !candidate.isClosed);
        const editor = editors.get(key);
        if (replacement) {
          if (editor) {
            editor.document = replacement;
            CsvEditorProvider.editors.filter(controller => controller.getDocumentUri().toString() === key)
              .forEach(controller => {
                controller.updateDocumentReference(replacement);
                if (!isUntitledCsv(replacement)) {
                  controller.revealSourceAfterCommit('language');
                }
              });
          }
          return;
        }
        editor?.panel.dispose();
        opened.delete(key);
      }, 0);
    }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (!event.affectsConfiguration('csv.enabled')) {
        return;
      }
      if (!vscode.workspace.getConfiguration('csv').get<boolean>('enabled', true)) {
        editors.forEach(editor => {
          const controller = CsvEditorProvider.editors.find(candidate => candidate.getDocumentUri().toString() === editor.document.uri.toString());
          if (controller) {
            controller.revealSourceAfterCommit();
            return;
          }
          // Its native owner was retained when the temporary grid opened.
          // No controller/draft exists yet, so cancel initialization without
          // racing committed handoffs with a second native open.
          editor.panel.dispose();
        });
        return;
      }
      opened.clear();
      editors.forEach((_editor, key) => opened.add(key));
      maybeOpen();
    }),
    { dispose: () => {
      editors.forEach(editor => editor.panel.dispose());
      editors.clear();
      opened.clear();
      switchingToSource.clear();
      extensionContext = undefined;
    } }
  );
  maybeOpen();
}
