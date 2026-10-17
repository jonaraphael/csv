import * as vscode from 'vscode';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { CsvEditorProvider } from './CsvEditorProvider';
import { compareCsvRows, comparisonLimits, comparisonPages, CsvTableDiff, parseComparisonRows } from './csv-table-diff';

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] as string));

export function renderComparisonSide(diff: CsvTableDiff, side: 'original' | 'modified', start: number, end: number): string {
  const columns = Math.max(1, ...diff.originalRows.map(row => row.length), ...diff.modifiedRows.map(row => row.length));
  const headings = Array.from({ length: columns }, (_, col) => `<th scope="col">${col + 1}</th>`).join('');
  const rows = diff.records.slice(start, end).map((record, index) => {
    const source = record[side];
    const values = source === undefined ? undefined : (side === 'original' ? diff.originalRows : diff.modifiedRows)[source];
    const otherIndex = record[side === 'original' ? 'modified' : 'original'];
    const other = otherIndex === undefined ? undefined : (side === 'original' ? diff.modifiedRows : diff.originalRows)[otherIndex];
    const rowLabel = record.kind === 'added' ? 'Added' : record.kind === 'removed' ? 'Removed' : record.kind === 'changed' ? 'Changed' : 'Unchanged';
    const cells = values === undefined ? `<td class="gap" colspan="${columns}">No record</td>`
      : Array.from({ length: Math.max(values.length, other?.length ?? 0) }, (_, col) => {
        if (col >= values.length) { return '<td class="gap" title="No field">—</td>'; }
        const changed = record.changedColumns.includes(col);
        const kind = changed ? (side === 'original' ? 'removed' : 'added') : '';
        return `<td${kind ? ` class="${kind}" title="${rowLabel} cell"` : ''}>${escapeHtml(values[col])}</td>`;
      }).join('');
    return `<tr data-align="${start + index}" aria-label="${rowLabel} record"><th scope="row" title="${rowLabel}">${source === undefined ? '—' : source + 1}</th>${cells}</tr>`;
  }).join('');
  return `<table data-columns="${columns}"><colgroup><col width="60">${'<col width="180">'.repeat(columns)}</colgroup><thead><tr><th scope="col">Record</th>${headings}</tr></thead><tbody>${rows}</tbody></table>`;
}

export class TableComparison {
  private diff: CsvTableDiff | undefined;
  private pages = [{ start: 0, end: 0 }];
  private currentPage = 0;
  private focusedRecord: number | undefined;
  private error = '';
  private disposed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly changeSubscription: vscode.Disposable;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private original: vscode.TextDocument,
    private modified: vscode.TextDocument,
    private readonly panel: vscode.WebviewPanel
  ) {
    panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'media'))] };
    panel.webview.html = this.html();
    panel.webview.onDidReceiveMessage(message => {
      if (this.disposed) { return; }
      if (message.type === 'ready') { this.showPage(); }
      else if (message.type === 'page' && Number.isInteger(message.index)) {
        this.currentPage = Math.max(0, Math.min(this.pages.length - 1, message.index));
        this.focusedRecord = undefined;
        this.showPage();
      } else if (message.type === 'change' && (message.direction === 1 || message.direction === -1)) {
        const changes = this.diff?.records.map((record, index) => record.kind === 'equal' ? -1 : index).filter(index => index >= 0) ?? [];
        const boundary = this.focusedRecord ?? (this.pages[this.currentPage].start - (message.direction === 1 ? 1 : 0));
        const target = message.direction === 1 ? changes.find(index => index > boundary) : changes.reverse().find(index => index < boundary);
        if (target !== undefined) {
          this.focusedRecord = target;
          this.currentPage = this.pages.findIndex(page => target >= page.start && target < page.end);
        }
        this.showPage();
      }
    });
    this.changeSubscription = vscode.workspace.onDidChangeTextDocument(event => {
      if (event.document.uri.toString() !== original.uri.toString() && event.document.uri.toString() !== modified.uri.toString()) { return; }
      if (event.document.uri.toString() === original.uri.toString()) { this.original = event.document; }
      if (event.document.uri.toString() === modified.uri.toString()) { this.modified = event.document; }
      if (this.timer) { clearTimeout(this.timer); }
      this.timer = setTimeout(() => this.refresh(), 150);
    });
    panel.onDidDispose(() => this.dispose());
    this.refresh();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) { clearTimeout(this.timer); }
    this.changeSubscription.dispose();
  }

  refresh(): void {
    if (this.disposed) { return; }
    try {
      const rows = (document: vscode.TextDocument) => {
        const text = document.getText();
        const config = vscode.workspace.getConfiguration('csv', document.uri);
        if (!config.get<boolean>('enabled', true)) { throw new Error('CSV is disabled.'); }
        const limit = config.get<number>('maxFileSizeMB', 10);
        if (Number.isFinite(limit) && limit > 0 && Buffer.byteLength(text, 'utf8') > limit * 1024 * 1024) {
          throw new Error('An input exceeds csv.maxFileSizeMB. Use a text diff or adjust the existing file-size limit.');
        }
        const separator = CsvEditorProvider.getSeparatorForUri(this.context, document.uri)
          ?? CsvEditorProvider.resolveInheritedSeparator(document.uri.fsPath || document.uri.path, text, CsvEditorProvider.getSeparatorSettings(document.uri));
        return parseComparisonRows(text, separator);
      };
      this.diff = compareCsvRows(rows(this.original), rows(this.modified));
      this.pages = comparisonPages(this.diff);
      this.currentPage = Math.min(this.currentPage, this.pages.length - 1);
      this.focusedRecord = undefined;
      this.error = '';
    } catch (error) {
      this.diff = undefined;
      this.pages = [{ start: 0, end: 0 }];
      this.currentPage = 0;
      this.error = error instanceof Error ? error.message : 'Unable to compare these files.';
    }
    this.showPage();
  }

  private showPage(): void {
    if (this.disposed) { return; }
    const { start, end } = this.pages[this.currentPage];
    const changes = this.diff?.records.map((record, index) => record.kind === 'equal' ? -1 : index).filter(index => index >= 0) ?? [];
    const boundary = this.focusedRecord ?? start;
    void this.panel.webview.postMessage({
      type: 'comparison',
      originalHtml: this.diff ? renderComparisonSide(this.diff, 'original', start, end) : '',
      modifiedHtml: this.diff ? renderComparisonSide(this.diff, 'modified', start, end) : '',
      page: this.currentPage,
      pageCount: this.pages.length,
      canPreviousChange: changes.some(index => index < boundary),
      canNextChange: changes.some(index => index > (this.focusedRecord ?? start - 1)),
      focusRecord: this.focusedRecord,
      status: this.diff ? `Page ${this.currentPage + 1}/${this.pages.length} · Added ${this.diff.added} · Removed ${this.diff.removed} · Changed ${this.diff.changed} records` : '',
      notice: this.diff?.approximate ? 'Some large changed sections are aligned by position after the alignment work limit. Cell differences are exact for the displayed pairs.' : '',
      error: this.error
    });
  }

  private html(): string {
    const nonce = randomBytes(16).toString('hex');
    const script = this.panel.webview.asWebviewUri(vscode.Uri.file(path.join(this.context.extensionPath, 'media', 'table-comparison.js')));
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}';">
<style nonce="${nonce}">
body { font-family: var(--vscode-font-family, sans-serif); color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); margin: 10px; }
nav { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; } button { padding: 4px 8px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 1px solid var(--vscode-contrastBorder, #888); } button:disabled { opacity: .5; }
#error, #notice { white-space: pre-wrap; } #error { color: var(--vscode-errorForeground); }
.panes { display: grid; grid-template-columns: minmax(0,1fr) minmax(0,1fr); gap: 10px; } section { min-width: 0; } h2 { font-size: 1em; margin: 5px 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.viewport { overflow: auto; height: calc(100vh - 170px); min-height: 150px; border: 1px solid var(--vscode-panel-border, #888); }
table { border-collapse: collapse; table-layout: fixed; } th, td { box-sizing: border-box; border: 1px solid var(--vscode-panel-border, #888); padding: 4px 7px; white-space: pre-wrap; overflow-wrap: anywhere; vertical-align: top; }
thead th { position: sticky; top: 0; z-index: 1; background: var(--vscode-editor-background, white); } th { text-align: left; }
.added { background: var(--vscode-diffEditor-insertedTextBackground, rgba(40,180,80,.22)); box-shadow: inset 3px 0 var(--vscode-editorGutter-addedBackground, #259c45); }
.removed { background: var(--vscode-diffEditor-removedTextBackground, rgba(220,60,60,.22)); box-shadow: inset 3px 0 var(--vscode-editorGutter-deletedBackground, #d23b3b); }
.gap { opacity: .65; border-style: dashed; } tr.focused { outline: 2px solid var(--vscode-focusBorder, #007acc); outline-offset: -2px; }
</style></head><body>
<nav><button id="previousPage">Previous Page</button><button id="nextPage">Next Page</button><button id="previousChange">Previous Change</button><button id="nextChange">Next Change</button><span id="status" role="status"></span></nav>
<p>Read-only cell comparison · Red: original differences · Green: modified differences · Scrolling stays synchronized. Quoting and line-ending style are not compared.</p>
<div id="error" role="alert"></div><div id="notice" role="status"></div>
<div class="panes"><section><h2 title="${escapeHtml(path.basename(this.original.uri.path))}">Original: ${escapeHtml(path.basename(this.original.uri.path))}</h2><div id="original" class="viewport" tabindex="0" aria-label="Original CSV"></div></section>
<section><h2 title="${escapeHtml(path.basename(this.modified.uri.path))}">Modified: ${escapeHtml(path.basename(this.modified.uri.path))}</h2><div id="modified" class="viewport" tabindex="0" aria-label="Modified CSV"></div></section></div>
<script nonce="${nonce}" src="${script}"></script></body></html>`;
  }
}

export async function compareFilesAsTable(context: vscode.ExtensionContext, resource?: vscode.Uri, selected?: vscode.Uri[]): Promise<void> {
  if (!vscode.workspace.getConfiguration('csv').get<boolean>('enabled', true)) {
    void vscode.window.showInformationMessage('Enable CSV before comparing files as a table.'); return;
  }
  let original: vscode.Uri | undefined;
  let modified: vscode.Uri | undefined;
  if (Array.isArray(selected) && selected.length === 2 && selected.every(uri => uri instanceof vscode.Uri)) {
    [original, modified] = selected;
  } else {
    const active = CsvEditorProvider.getActiveProvider();
    original = resource instanceof vscode.Uri ? resource : vscode.window.activeTextEditor?.document.uri ?? (active?.isActive() ? active.getDocumentUri() : undefined);
    if (!original) {
      original = (await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Select Original CSV File' }))?.[0];
    }
    if (!original) { return; }
    modified = (await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Select Modified CSV File' }))?.[0];
  }
  if (!original || !modified) { return; }
  try {
    const documents: vscode.TextDocument[] = [];
    for (const uri of [original, modified]) {
      const limit = vscode.workspace.getConfiguration('csv', uri).get<number>('maxFileSizeMB', 10);
      const existing = vscode.workspace.textDocuments.find(document => !document.isClosed && document.uri.toString() === uri.toString());
      let size: number | undefined;
      try { size = (await vscode.workspace.fs.stat(uri)).size; } catch { /* Existing documents can still be compared within decoded-size limits. */ }
      if (size === undefined && !existing) {
        throw new Error('Cannot verify this source size. Open it in a normal editor first, then compare the already-open document.');
      }
      if (size !== undefined && size > comparisonLimits.sourceBytes) {
        throw new Error('Table comparison supports at most 10 MiB of saved bytes per input, regardless of csv.maxFileSizeMB. Use a text diff for larger files.');
      }
      if (size !== undefined && Number.isFinite(limit) && limit > 0 && size > limit * 1024 * 1024) {
        throw new Error('An input exceeds csv.maxFileSizeMB. Use a text diff or adjust the existing file-size limit.');
      }
      const document = existing ?? await vscode.workspace.openTextDocument(uri);
      if (Buffer.byteLength(document.getText(), 'utf8') > comparisonLimits.textBytes) {
        throw new Error('Table comparison supports at most 5 MiB of decoded text per input. Use a text diff for larger files.');
      }
      documents.push(document);
    }
    const [before, after] = documents;
    const panel = vscode.window.createWebviewPanel('csv.tableComparison', `CSV Compare: ${path.basename(original.path)} ↔ ${path.basename(modified.path)}`, vscode.ViewColumn.Active, {});
    new TableComparison(context, before, after, panel);
  } catch (error) {
    void vscode.window.showErrorMessage(error instanceof Error ? error.message : 'Unable to open the CSV comparison.');
  }
}
