import * as vscode from 'vscode';
import { CsvEditorProvider } from './CsvEditorProvider';

export const untitledCsvViewType = 'csv.untitledEditor';

type UntitledEditor = {
  document: vscode.TextDocument;
  panel: vscode.WebviewPanel;
};
const editors = new Map<string, UntitledEditor>();
const opened = new Set<string>();
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
  const maybeOpen = (document: vscode.TextDocument | undefined) => {
    if (!document || !isUntitledCsv(document) || opened.has(document.uri.toString())) {
      return;
    }
    const active = vscode.window.activeTextEditor;
    if (!active || active.document.uri.toString() !== document.uri.toString()) {
      return;
    }
    void openUntitledCsvEditor(document, active.viewColumn).catch(error => {
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
          // A panel still initializing has no active draft or controller yet.
          if (!editor.document.isClosed) {
            void Promise.resolve(vscode.window.showTextDocument(editor.document, {
              viewColumn: editor.panel.viewColumn, preview: false, preserveFocus: !editor.panel.active
            })).catch(error => console.error('CSV: could not reveal the untitled source', error));
          }
          editor.panel.dispose();
        });
        return;
      }
      opened.clear();
      editors.forEach((_editor, key) => opened.add(key));
      maybeOpen(vscode.window.activeTextEditor?.document);
    }),
    { dispose: () => {
      editors.forEach(editor => editor.panel.dispose());
      editors.clear();
      opened.clear();
      extensionContext = undefined;
    } }
  );
  maybeOpen(vscode.window.activeTextEditor?.document);
}
