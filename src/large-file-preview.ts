import * as vscode from 'vscode';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { CsvEditorProvider } from './CsvEditorProvider';
import { CsvPreviewPage, PreviewHistory, readCsvPreviewPage } from './bounded-csv-reader';

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char] as string));

export function renderPreviewRows(rows: string[][], firstRecord: number): string {
  if (rows.length === 0) {
    return '<p>No records in this file.</p>';
  }
  const width = Math.max(...rows.map(row => row.length));
  const headings = Array.from({ length: width }, (_, index) => `<th scope="col">Column ${index + 1}</th>`).join('');
  const body = rows.map((row, index) => `<tr><th scope="row">${firstRecord + index + 1}</th>${row.map(value => `<td>${escapeHtml(value)}</td>`).join('')}</tr>`).join('');
  return `<table><thead><tr><th scope="col">Record</th>${headings}</tr></thead><tbody>${body}</tbody></table>`;
}

class PreviewDocument implements vscode.CustomDocument {
  disposed = false;
  constructor(readonly uri: vscode.Uri) {}
  dispose(): void { this.disposed = true; }
}

export class LargeFilePreviewProvider implements vscode.CustomReadonlyEditorProvider<PreviewDocument> {
  static readonly viewType = 'csv.largeFilePreview';
  constructor(private readonly context: vscode.ExtensionContext) {}

  async openCustomDocument(uri: vscode.Uri): Promise<PreviewDocument> {
    if (uri.scheme !== 'file') {
      throw new Error('Large File Preview currently supports host-local file URIs only. Use the normal CSV editor for this location.');
    }
    return new PreviewDocument(uri);
  }

  async resolveCustomEditor(document: PreviewDocument, panel: vscode.WebviewPanel, token: vscode.CancellationToken): Promise<void> {
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(path.join(this.context.extensionPath, 'media'))]
    };
    panel.webview.html = this.html(panel.webview);
    const history = new PreviewHistory();
    let page: CsvPreviewPage | undefined;
    let fileVersion: string | undefined;
    let selectedDelimiter: string | undefined;
    let lastError = '';
    let disposed = false;
    let pending = Promise.resolve();
    const cancelled = () => disposed || document.disposed || token.isCancellationRequested;
    const send = (error?: string) => {
      if (cancelled()) {
        return;
      }
      const first = history.current.record;
      void panel.webview.postMessage({
        type: 'page',
        html: page ? renderPreviewRows(page.rows, first) : '',
        status: page?.rows.length ? `Saved file · Records ${first + 1}–${first + page.rows.length} · Read-only` : 'Saved file · Read-only',
        canBack: history.canGoBack,
        canNext: !!page && !page.done && !error,
        error: error ?? ''
      });
    };
    const read = async (reset: boolean) => {
      const config = vscode.workspace.getConfiguration('csv', document.uri);
      if (!config.get<boolean>('enabled', true)) {
        throw new Error('CSV is disabled. Enable it before opening Large File Preview.');
      }
      const settings = CsvEditorProvider.getSeparatorSettings(document.uri);
      const delimiter = CsvEditorProvider.getSeparatorForUri(this.context, document.uri)
        ?? CsvEditorProvider.resolveInheritedSeparator(document.uri.fsPath, '', settings);
      if (!reset && selectedDelimiter !== delimiter) {
        throw new Error('The separator changed. Choose Back to Start to reload the preview.');
      }
      selectedDelimiter = delimiter;
      page = await readCsvPreviewPage(document.uri.fsPath, {
        delimiter,
        offset: history.current.offset,
        maxRows: config.get<number>('largeFilePreviewRows', 1000),
        expectedVersion: reset ? undefined : fileVersion,
        cancelled
      });
      fileVersion = page.version;
      lastError = '';
      send();
    };
    panel.webview.onDidReceiveMessage(message => {
      pending = pending.then(async () => {
        if (cancelled()) {
          return;
        }
        if (message.type === 'ready') {
          if (page) {
            send();
          } else if (lastError) {
            send(lastError);
          } else {
            await read(true);
          }
        } else if (message.type === 'start') {
          history.reset();
          page = undefined;
          fileVersion = undefined;
          lastError = '';
          await read(true);
        } else if (message.type === 'next' && page && !page.done) {
          history.next({ offset: page.nextOffset, record: history.current.record + page.rows.length });
          await read(false);
        } else if (message.type === 'previous' && history.canGoBack) {
          history.previous();
          await read(false);
        }
      }).catch(error => {
        // Discard stale rows if navigation or source validation fails. The error
        // remains visible; Back to Start can always retry a changed file.
        page = undefined;
        lastError = error instanceof Error ? error.message : 'Unable to read this preview page.';
        send(lastError);
      });
      return pending;
    });
    panel.onDidDispose(() => { disposed = true; });
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('hex');
    const script = webview.asWebviewUri(vscode.Uri.file(path.join(this.context.extensionPath, 'media', 'large-preview.js')));
    return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">
body { font-family: var(--vscode-font-family); color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); margin: 12px; }
nav { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
button { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 1px solid var(--vscode-contrastBorder, transparent); padding: 5px 10px; }
button:disabled { opacity: .5; } #error { color: var(--vscode-errorForeground); white-space: pre-wrap; }
#records { overflow: auto; max-height: calc(100vh - 125px); } table { border-collapse: collapse; }
th, td { padding: 4px 8px; border: 1px solid var(--vscode-panel-border, #888); white-space: pre-wrap; overflow-wrap: anywhere; max-width: 60ch; }
thead th { position: sticky; top: 0; background: var(--vscode-editor-background); } th { text-align: left; }
</style></head><body>
<nav aria-label="Preview pages"><button id="start">Back to Start</button><button id="previous" disabled>Previous</button><button id="next" disabled>Next</button><span id="status" role="status">Loading saved file…</span></nav>
<p>Large File Preview · UTF-8 · Read-only. Each page replaces the previous page. The first record is shown as data.</p>
<p id="error" role="alert"></p><div id="records" tabindex="0" aria-label="CSV records"></div>
<script nonce="${nonce}" src="${script}"></script></body></html>`;
  }
}

export async function openLargeFilePreview(uri?: vscode.Uri): Promise<void> {
  if (!vscode.workspace.getConfiguration('csv').get<boolean>('enabled', true)) {
    void vscode.window.showInformationMessage('Enable CSV before opening Large File Preview.');
    return;
  }
  const target = uri instanceof vscode.Uri ? uri : (await vscode.window.showOpenDialog({
    canSelectMany: false,
    openLabel: 'Open Read-only Preview',
    filters: { 'CSV/TSV/PSV': ['csv', 'tsv', 'tab', 'psv'] }
  }))?.[0];
  if (!target) {
    return;
  }
  if (target.scheme !== 'file') {
    void vscode.window.showErrorMessage('Large File Preview currently supports host-local files only. Use the normal CSV editor for this location.');
    return;
  }
  await vscode.commands.executeCommand('vscode.openWith', target, LargeFilePreviewProvider.viewType, { preview: false });
}
