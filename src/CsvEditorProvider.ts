import Papa from 'papaparse';
import * as vscode from 'vscode';
import * as path from 'path';

type SeparatorMode = 'extension' | 'auto' | 'default';
type SeparatorSettings = {
  mode: SeparatorMode;
  defaultSeparator: string;
  byExtension: Record<string, string>;
};
type CsvFieldSpan = {
  start: number;
  end: number;
  quoted: boolean;
};

// Per-document controller. Manages one webview + document.
class CsvEditorController {
  // Note: Global registry lives on CsvEditorProvider (wrapper)

  private static readonly BYTES_PER_MB = 1024 * 1024;
  private static readonly DEFAULT_MAX_FILE_SIZE_MB = 10;
  private static readonly LARGE_FILE_CONTINUE_THIS_TIME = 'Continue This Time';
  private static readonly LARGE_FILE_IGNORE_FOREVER = 'Ignore Forever';

  private isUpdatingDocument = false;
  private isSaving = false;
  private currentWebviewPanel: vscode.WebviewPanel | undefined;
  private document!: vscode.TextDocument;
  private separatorCache: { version: number; configKey: string; separator: string } | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {}

  // (no static helpers here; see wrapper CsvEditorProvider)

  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    this.document = document;

    const config = vscode.workspace.getConfiguration('csv', this.document.uri);
    if (!config.get<boolean>('enabled', true)) {
      // When disabled, immediately hand off to the default editor and close this tab
      await this.openWithDefaultEditorAndClose(webviewPanel, document.uri);
      return;
    }

    const proceed = await this.confirmLargeFileOpen(config, webviewPanel, _token);
    if (!proceed) {
      return;
    }

    this.currentWebviewPanel = webviewPanel;
    CsvEditorProvider.editors.push(this);

    webviewPanel.webview.options = {
      enableScripts: true,
      // Use file path for compatibility with older VS Code types (no Uri.joinPath)
      localResourceRoots: [vscode.Uri.file(path.join(this.context.extensionPath, 'media'))]
    };

    this.updateWebviewContent();

    if (webviewPanel.active) {
      CsvEditorProvider.currentActive = this;
    }

    webviewPanel.webview.postMessage({ type: 'focus' });
    webviewPanel.onDidChangeViewState(e => {
      if (e.webviewPanel.active) {
        e.webviewPanel.webview.postMessage({ type: 'focus' });
        CsvEditorProvider.currentActive = this;
      }
    });

    webviewPanel.webview.onDidReceiveMessage(async e => {
      switch (e.type) {
        case 'editCell':
          this.updateDocument(e.row, e.col, e.value);
          break;
        case 'replaceCells':
          await this.replaceCells(e.replacements);
          break;
        case 'findMatches':
          await this.findMatches(e.requestId, e.query, e.options);
          break;
        case 'save':
          await this.handleSave();
          break;
        case 'copyToClipboard':
          await vscode.env.clipboard.writeText(e.text);
          console.log('CSV: Copied to clipboard');
          break;
        case 'insertColumn':
          await this.insertColumn(e.index);
          break;
        case 'insertColumns':
          await this.insertColumns(e.index, e.count);
          break;
        case 'deleteColumn':
          await this.deleteColumn(e.index);
          break;
        case 'deleteColumns':
          await this.deleteColumns(e.indices);
          break;
        case 'insertRow':
          await this.insertRow(e.index);
          break;
        case 'insertRows':
          await this.insertRows(e.index, e.count);
          break;
        case 'deleteRow':
          await this.deleteRow(e.index);
          break;
        case 'deleteRows':
          await this.deleteRows(e.indices);
          break;
        case 'reorderColumns':
          await this.reorderColumns(e.indices, e.beforeIndex);
          break;
        case 'reorderRows':
          await this.reorderRows(e.indices, e.beforeIndex);
          break;
        case 'sortColumn':
          await this.sortColumn(e.index, e.ascending);
          break;
        case 'openLink':
          await this.openLinkExternally(e.url);
          break;
      }
    });

    const changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument(e => {
      if (
        e.document.uri.toString() === document.uri.toString() &&
        !this.isUpdatingDocument &&
        !this.isSaving
      ) {
        setTimeout(() => this.updateWebviewContent(), 250);
      }
    });

    webviewPanel.onDidDispose(() => {
      changeDocumentSubscription.dispose();
      CsvEditorProvider.editors = CsvEditorProvider.editors.filter(ed => ed !== this);
      this.currentWebviewPanel = undefined;
    });
  }

  private getMaxFileSizeLimitMb(config: vscode.WorkspaceConfiguration): number {
    const raw = Number(config.get<number>('maxFileSizeMB', CsvEditorController.DEFAULT_MAX_FILE_SIZE_MB));
    if (!Number.isFinite(raw) || raw <= 0) {
      return 0;
    }
    return raw;
  }

  private shouldPromptForLargeFile(fileSizeBytes: number, maxFileSizeMB: number): boolean {
    if (!Number.isFinite(fileSizeBytes) || fileSizeBytes < 0) {
      return false;
    }
    if (!Number.isFinite(maxFileSizeMB) || maxFileSizeMB <= 0) {
      return false;
    }
    const thresholdBytes = Math.floor(maxFileSizeMB * CsvEditorController.BYTES_PER_MB);
    return fileSizeBytes > thresholdBytes;
  }

  private formatSizeMb(fileSizeBytes: number): string {
    if (!Number.isFinite(fileSizeBytes) || fileSizeBytes <= 0) {
      return '0.0';
    }
    return (fileSizeBytes / CsvEditorController.BYTES_PER_MB).toFixed(1);
  }

  private async openWithDefaultEditorAndClose(webviewPanel: vscode.WebviewPanel, uri: vscode.Uri): Promise<void> {
    try {
      const opts: any = {
        viewColumn: webviewPanel.viewColumn,
        preserveFocus: !webviewPanel.active,
        preview: webviewPanel.active ? webviewPanel.active : false
      };
      await vscode.commands.executeCommand('vscode.openWith', uri, 'default', opts);
    } finally {
      try { webviewPanel.dispose(); } catch {}
    }
  }

  private async confirmLargeFileOpen(
    config: vscode.WorkspaceConfiguration,
    webviewPanel: vscode.WebviewPanel,
    token: vscode.CancellationToken
  ): Promise<boolean> {
    const maxFileSizeMB = this.getMaxFileSizeLimitMb(config);
    if (maxFileSizeMB <= 0) {
      return true;
    }

    let sizeBytes = 0;
    try {
      const stat = await vscode.workspace.fs.stat(this.document.uri);
      sizeBytes = Number(stat.size);
    } catch (err) {
      console.warn(`CSV: unable to stat file size for ${this.document.uri.toString()}`, err);
      return true;
    }

    if (token.isCancellationRequested) {
      return false;
    }
    if (!this.shouldPromptForLargeFile(sizeBytes, maxFileSizeMB)) {
      return true;
    }

    const fileLabel = path.basename(this.document.uri.fsPath || this.document.uri.path || this.document.uri.toString());
    const selected = await vscode.window.showWarningMessage(
      `CSV: "${fileLabel}" is ${this.formatSizeMb(sizeBytes)} MB and exceeds the csv.maxFileSizeMB limit (${maxFileSizeMB} MB).`,
      {
        modal: true,
        detail: 'Opening large files in CSV view can be slow and block the editor.'
      },
      CsvEditorController.LARGE_FILE_CONTINUE_THIS_TIME,
      CsvEditorController.LARGE_FILE_IGNORE_FOREVER
    );

    if (selected === CsvEditorController.LARGE_FILE_CONTINUE_THIS_TIME) {
      return true;
    }
    if (selected === CsvEditorController.LARGE_FILE_IGNORE_FOREVER) {
      await vscode.workspace
        .getConfiguration('csv')
        .update('maxFileSizeMB', 0, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage('CSV: Large-file prompt disabled (csv.maxFileSizeMB = 0).');
      return true;
    }

    try { webviewPanel.dispose(); } catch {}
    return false;
  }

  public refresh() {
    const config = vscode.workspace.getConfiguration('csv', this.document.uri);
    if (!config.get<boolean>('enabled', true)) {
      this.currentWebviewPanel?.dispose();
      vscode.commands.executeCommand('vscode.openWith', this.document.uri, 'default');
    } else {
      if (this.currentWebviewPanel) {
        this.forceReload();
      }
    }
  }

  private forceReload() {
    if (!this.currentWebviewPanel) return;
    const panel = this.currentWebviewPanel;
    // First, blank the DOM to ensure a full script/style reinit on next set
    panel.webview.html = '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body></body></html>';
    setTimeout(() => {
      try {
        this.updateWebviewContent();
      } catch (err) {
        console.error('CSV: forceReload failed', err);
      }
    }, 0);
  }

  public isActive(): boolean {
    return !!this.currentWebviewPanel?.active;
  }

  public getDocumentUri(): vscode.Uri {
    return this.document.uri;
  }

  public getCurrentSeparator(): string {
    return this.getSeparator();
  }

  // ───────────── Document Editing Methods ─────────────

  private async updateDocument(row: number, col: number, value: string) {
    this.isUpdatingDocument = true;
    let structuralChange = false;
    let applied = false;
    try {
      const separator = this.getSeparator();
      const oldText = this.document.getText();
      const result = Papa.parse(oldText, { dynamicTyping: false, delimiter: separator });
      const data = result.data as string[][];
      const hadRows = data.length;
      const hadColsAtRow = (data[row] ? data[row].length : 0);
      const previousValue =
        row < hadRows && col < hadColsAtRow
          ? String(data[row][col] ?? '')
          : undefined;

      const { data: nextData, trimmed, createdRow, createdCol } = this.mutateDataForEdit(data, row, col, value);
      structuralChange = !!(trimmed || createdRow || createdCol || row >= hadRows || col >= hadColsAtRow);

      if (!structuralChange && previousValue === value) {
        return;
      }

      let newCsvText: string | undefined;
      if (!structuralChange) {
        newCsvText = CsvEditorProvider.applyFieldUpdatesPreservingFormat(
          oldText,
          separator,
          [{ row, col, value: String(value ?? '') }]
        );
      }
      if (newCsvText === undefined) {
        newCsvText = Papa.unparse(nextData, { delimiter: separator });
      }

      if (newCsvText === oldText) {
        return;
      }

      const fullRange = new vscode.Range(
        0, 0,
        this.document.lineCount,
        this.document.lineCount ? this.document.lineAt(this.document.lineCount - 1).text.length : 0
      );
      const edit = new vscode.WorkspaceEdit();
      edit.replace(this.document.uri, fullRange, newCsvText);
      await vscode.workspace.applyEdit(edit);
      applied = true;
    } finally {
      this.isUpdatingDocument = false;
    }

    if (!applied) {
      return;
    }

    console.log(`CSV: Updated row ${row + 1}, column ${col + 1} to "${value}"`);
    const config = vscode.workspace.getConfiguration('csv', this.document.uri);
    const clickableLinks = config.get<boolean>('clickableLinks', true);
    const rendered = this.formatCellContent(value ?? '', clickableLinks);
    this.currentWebviewPanel?.webview.postMessage({ type: 'updateCell', row, col, value, rendered });

    // Trigger a full re-render if structure may have changed (new row/col created)
    if (structuralChange) {
      try { this.updateWebviewContent(); } catch (e) { console.error('CSV: refresh failed after structural edit', e); }
    }
  }

  private async replaceCells(replacements: unknown): Promise<void> {
    if (!Array.isArray(replacements) || replacements.length === 0) {
      return;
    }
    this.isUpdatingDocument = true;
    try {
      const separator = this.getSeparator();
      const oldText = this.document.getText();
      const result = Papa.parse(oldText, { dynamicTyping: false, delimiter: separator });
      const data = result.data as string[][];
      const updates: Array<{ row: number; col: number; value: string }> = [];

      let changed = false;
      for (const replacement of replacements) {
        if (!replacement || typeof replacement !== 'object') {
          continue;
        }
        const row = Number((replacement as any).row);
        const col = Number((replacement as any).col);
        if (!Number.isInteger(row) || row < 0 || !Number.isInteger(col) || col < 0) {
          continue;
        }
        if (row >= data.length) {
          continue;
        }
        if (col >= (data[row]?.length ?? 0)) {
          continue;
        }
        const raw = (replacement as any).value;
        const nextValue = raw === undefined || raw === null ? '' : String(raw);
        if ((data[row][col] ?? '') === nextValue) {
          continue;
        }
        data[row][col] = nextValue;
        updates.push({ row, col, value: nextValue });
        changed = true;
      }
      if (!changed) {
        return;
      }

      let newCsvText = CsvEditorProvider.applyFieldUpdatesPreservingFormat(oldText, separator, updates);
      if (newCsvText === undefined) {
        newCsvText = Papa.unparse(data, { delimiter: separator });
      }
      if (newCsvText === oldText) {
        return;
      }

      const fullRange = new vscode.Range(
        0, 0,
        this.document.lineCount,
        this.document.lineCount ? this.document.lineAt(this.document.lineCount - 1).text.length : 0
      );
      const edit = new vscode.WorkspaceEdit();
      edit.replace(this.document.uri, fullRange, newCsvText);
      await vscode.workspace.applyEdit(edit);

      this.updateWebviewContent();
    } finally {
      this.isUpdatingDocument = false;
    }
  }

  private escapeFindRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private buildFindRegex(query: string, options: { regex: boolean; wholeWord: boolean; matchCase: boolean }): RegExp | undefined {
    if (!query) return undefined;
    const useRegex = !!options.regex;
    const wholeWord = !!options.wholeWord;
    const matchCase = !!options.matchCase;
    let source = useRegex ? query : this.escapeFindRegex(query);
    if (wholeWord) {
      source = `\\b(?:${source})\\b`;
    }
    const flags = matchCase ? 'g' : 'gi';
    try {
      return new RegExp(source, flags);
    } catch {
      return undefined;
    }
  }

  private async findMatches(requestId: unknown, query: unknown, options: unknown): Promise<void> {
    if (!this.currentWebviewPanel) {
      return;
    }

    const requestQuery = typeof query === 'string' ? query : '';
    const optsRaw = (options && typeof options === 'object') ? options as any : {};
    const opts = {
      regex: !!optsRaw.regex,
      wholeWord: !!optsRaw.wholeWord,
      matchCase: !!optsRaw.matchCase
    };

    const postResult = (payload: { matches: Array<{ row: number; col: number; value: string }>; invalidRegex: boolean }) => {
      this.currentWebviewPanel?.webview.postMessage({
        type: 'findMatchesResult',
        requestId,
        matches: payload.matches,
        invalidRegex: payload.invalidRegex
      });
    };

    if (!requestQuery) {
      postResult({ matches: [], invalidRegex: false });
      return;
    }

    const regex = this.buildFindRegex(requestQuery, opts);
    if (!regex) {
      postResult({ matches: [], invalidRegex: true });
      return;
    }

    const separator = this.getSeparator();
    const parsed = Papa.parse(this.document.getText(), { dynamicTyping: false, delimiter: separator });
    const data = this.trimTrailingEmptyRows((parsed.data || []) as string[][]);
    const hiddenRows = this.getHiddenRows();
    const offset = Math.min(Math.max(0, hiddenRows), data.length);
    const matches: Array<{ row: number; col: number; value: string }> = [];

    for (let row = offset; row < data.length; row++) {
      const current = data[row] || [];
      for (let col = 0; col < current.length; col++) {
        const value = String(current[col] ?? '');
        regex.lastIndex = 0;
        if (regex.test(value)) {
          matches.push({ row, col, value });
        }
      }
    }

    postResult({ matches, invalidRegex: false });
  }

  // Apply an edit to a 2D data array, enforcing virtual row/cell invariants.
  // - Empty edits on non-existent virtual row/col are ignored
  // - Non-empty edits expand rows/cols as needed
  // - When editing the last row, trailing empty rows are trimmed
  private mutateDataForEdit(data: string[][], row: number, col: number, value: string): { data: string[][]; trimmed: boolean; createdRow: boolean; createdCol: boolean } {
    // Work on the same array instance (callers pass freshly parsed data)
    const hadRows = data.length;
    const hadColsAtRow = (data[row] ? data[row].length : 0);
    const wasEditingLastRow = row >= (data.length - 1);

    const rowExists = row < data.length;
    const colExists = rowExists && col < (data[row]?.length ?? 0);

    if (value === '') {
      if (!rowExists) {
        return { data, trimmed: false, createdRow: false, createdCol: false };
      }
      if (!colExists) {
        return { data, trimmed: false, createdRow: false, createdCol: false };
      }
      data[row][col] = '';
    } else {
      while (data.length <= row) data.push([]);
      while (data[row].length <= col) data[row].push('');
      data[row][col] = value;
    }

    let trimmed = false;
    if (wasEditingLastRow) {
      const isRowEmpty = (arr: string[] | undefined) => {
        if (!arr || arr.length === 0) return true;
        for (let i = 0; i < arr.length; i++) {
          if ((arr[i] ?? '') !== '') return false;
        }
        return true;
      };
      while (data.length > 0 && isRowEmpty(data[data.length - 1])) {
        data.pop();
        trimmed = true;
      }
    }

    return {
      data,
      trimmed,
      createdRow: value !== '' && row >= hadRows,
      createdCol: value !== '' && col >= hadColsAtRow
    };
  }

  private async handleSave() {
    this.isSaving = true;
    try {
      const success = await this.document.save();
      console.log(success ? 'CSV: Document saved' : 'CSV: Failed to save document');
    } catch (error) {
      console.error('CSV: Error saving document', error);
    } finally {
      this.isSaving = false;
    }
  }

  private async insertColumn(index: number) {
    this.isUpdatingDocument = true;
    const separator = this.getSeparator();
    const text = this.document.getText();
    const result = Papa.parse(text, { dynamicTyping: false, delimiter: separator });
    const data = result.data as string[][];
    for (const row of data) {
      if (index > row.length) {
        while (row.length < index) row.push('');
      }
      row.splice(index, 0, '');
    }
    const newText = Papa.unparse(data, { delimiter: separator });
    const fullRange = new vscode.Range(
      0, 0,
      this.document.lineCount,
      this.document.lineCount ? this.document.lineAt(this.document.lineCount - 1).text.length : 0
    );
    const edit = new vscode.WorkspaceEdit();
    edit.replace(this.document.uri, fullRange, newText);
    await vscode.workspace.applyEdit(edit);
    this.isUpdatingDocument = false;
    this.updateWebviewContent();
  }

  private async insertColumns(index: number, count: number) {
    if (count <= 0) return;
    this.isUpdatingDocument = true;
    const separator = this.getSeparator();
    const text = this.document.getText();
    const result = Papa.parse(text, { dynamicTyping: false, delimiter: separator });
    const data = result.data as string[][];
    for (let k = 0; k < count; k++) {
      for (const row of data) {
        if (index > row.length) {
          while (row.length < index) row.push('');
        }
        row.splice(index, 0, '');
      }
    }
    const newText = Papa.unparse(data, { delimiter: separator });
    const fullRange = new vscode.Range(
      0, 0,
      this.document.lineCount,
      this.document.lineCount ? this.document.lineAt(this.document.lineCount - 1).text.length : 0
    );
    const edit = new vscode.WorkspaceEdit();
    edit.replace(this.document.uri, fullRange, newText);
    await vscode.workspace.applyEdit(edit);
    this.isUpdatingDocument = false;
    this.updateWebviewContent();
  }

  private async deleteColumn(index: number) {
    this.isUpdatingDocument = true;
    const separator = this.getSeparator();
    const text = this.document.getText();
    const result = Papa.parse(text, { dynamicTyping: false, delimiter: separator });
    const data = result.data as string[][];
    for (const row of data) {
      if (index < row.length) {
        row.splice(index, 1);
      }
    }
    const newText = Papa.unparse(data, { delimiter: separator });
    const fullRange = new vscode.Range(
      0, 0,
      this.document.lineCount,
      this.document.lineCount ? this.document.lineAt(this.document.lineCount - 1).text.length : 0
    );
    const edit = new vscode.WorkspaceEdit();
    edit.replace(this.document.uri, fullRange, newText);
    await vscode.workspace.applyEdit(edit);
    this.isUpdatingDocument = false;
    this.updateWebviewContent();
  }

  private async deleteColumns(indices: number[]) {
    if (!indices || !indices.length) return;
    this.isUpdatingDocument = true;
    const separator = this.getSeparator();
    const text = this.document.getText();
    const result = Papa.parse(text, { dynamicTyping: false, delimiter: separator });
    const data = result.data as string[][];
    const sorted = [...indices].sort((a,b)=>b-a);
    for (const idx of sorted) {
      for (const row of data) {
        if (idx < row.length) {
          row.splice(idx, 1);
        }
      }
    }
    const newText = Papa.unparse(data, { delimiter: separator });
    const fullRange = new vscode.Range(
      0, 0,
      this.document.lineCount,
      this.document.lineCount ? this.document.lineAt(this.document.lineCount - 1).text.length : 0
    );
    const edit = new vscode.WorkspaceEdit();
    edit.replace(this.document.uri, fullRange, newText);
    await vscode.workspace.applyEdit(edit);
    this.isUpdatingDocument = false;
    this.updateWebviewContent();
  }

  private async sortColumn(index: number, ascending: boolean) {
    this.isUpdatingDocument = true;

    const config       = vscode.workspace.getConfiguration('csv', this.document.uri);
    const separator    = this.getSeparator();
    const hidden       = this.getHiddenRows();

    const text   = this.document.getText();
    const result = Papa.parse(text, { dynamicTyping: false, delimiter: separator });
    // Exclude virtual/trailing empty rows from sort input
    const rows   = this.trimTrailingEmptyRows(result.data as string[][]);
    const treatHeader  = this.getEffectiveHeader(rows, this.getHiddenRows());

    const offset = Math.min(Math.max(0, hidden), rows.length);
    let header: string[] = [];
    let body:   string[][] = [];

    if (treatHeader && offset < rows.length) {
      header = rows[offset];
      body   = rows.slice(offset + 1);
    } else {
      body   = rows.slice(offset);
    }

    const cmp = (a: string, b: string) => {
      const sa = (a ?? '').trim();
      const sb = (b ?? '').trim();
      const aEmpty = sa === '';
      const bEmpty = sb === '';
      if (aEmpty && bEmpty) return 0;
      if (aEmpty) return 1; // empty sorts last
      if (bEmpty) return -1;

      // Dates take precedence over numeric compare (avoid parseFloat on ISO)
      const aIsDate = this.isDate(sa);
      const bIsDate = this.isDate(sb);
      if (aIsDate && bIsDate) {
        const da = Date.parse(sa);
        const db = Date.parse(sb);
        if (!isNaN(da) && !isNaN(db)) return da - db;
      }

      const na = parseFloat(sa), nb = parseFloat(sb);
      if (!isNaN(na) && !isNaN(nb)) return na - nb;
      return sa.localeCompare(sb, undefined, { sensitivity: 'base' });
    };

    body.sort((r1, r2) => {
      const diff = cmp(r1[index] ?? '', r2[index] ?? '');
      return ascending ? diff : -diff;
    });

    const prefix = rows.slice(0, offset);
    const combined = treatHeader ? [...prefix, header, ...body] : [...prefix, ...body];

    // Sanitize before unparse: ensure undefined/null/NaN become empty strings
    const sanitized: string[][] = combined.map(r => r.map((v: any) => {
      if (v === undefined || v === null) return '';
      const t = typeof v;
      if (t === 'number') {
        return Number.isNaN(v) ? '' : String(v);
      }
      const s = String(v);
      return s.toLowerCase() === 'nan' ? '' : s;
    }));

    const newCsv = Papa.unparse(sanitized, { delimiter: separator });

    const fullRange = new vscode.Range(
      0, 0,
      this.document.lineCount,
      this.document.lineCount ? this.document.lineAt(this.document.lineCount - 1).text.length : 0
    );

    const edit = new vscode.WorkspaceEdit();
    edit.replace(this.document.uri, fullRange, newCsv);
    await vscode.workspace.applyEdit(edit);

    this.isUpdatingDocument = false;
    this.updateWebviewContent();
    console.log(`CSV: Sorted column ${index + 1} (${ascending ? 'A-Z' : 'Z-A'})`);
  }

  private async insertRow(index: number) {
    this.isUpdatingDocument = true;
    const separator = this.getSeparator();
    const text = this.document.getText();
    const result = Papa.parse(text, { dynamicTyping: false, delimiter: separator });
    const data = result.data as string[][];
    const numColumns = data.reduce((max, r) => Math.max(max, r.length), 0);
    const newRow = Array(numColumns).fill('');
    if (index > data.length) {
      while (data.length < index) data.push(Array(numColumns).fill(''));
    }
    data.splice(index, 0, newRow);
    const newText = Papa.unparse(data, { delimiter: separator });
    const fullRange = new vscode.Range(
      0, 0,
      this.document.lineCount,
      this.document.lineCount ? this.document.lineAt(this.document.lineCount - 1).text.length : 0
    );
    const edit = new vscode.WorkspaceEdit();
    edit.replace(this.document.uri, fullRange, newText);
    await vscode.workspace.applyEdit(edit);
    this.isUpdatingDocument = false;
    this.updateWebviewContent();
  }

  private async insertRows(index: number, count: number) {
    if (count <= 0) return;
    this.isUpdatingDocument = true;
    const separator = this.getSeparator();
    const text = this.document.getText();
    const result = Papa.parse(text, { dynamicTyping: false, delimiter: separator });
    const data = result.data as string[][];
    const numColumns = data.reduce((max, r) => Math.max(max, r.length), 0);
    for (let k = 0; k < count; k++) {
      const newRow = Array(numColumns).fill('');
      if (index > data.length) {
        while (data.length < index) data.push(Array(numColumns).fill(''));
      }
      data.splice(index, 0, newRow);
    }
    const newText = Papa.unparse(data, { delimiter: separator });
    const fullRange = new vscode.Range(
      0, 0,
      this.document.lineCount,
      this.document.lineCount ? this.document.lineAt(this.document.lineCount - 1).text.length : 0
    );
    const edit = new vscode.WorkspaceEdit();
    edit.replace(this.document.uri, fullRange, newText);
    await vscode.workspace.applyEdit(edit);
    this.isUpdatingDocument = false;
    this.updateWebviewContent();
  }

  private async deleteRow(index: number) {
    this.isUpdatingDocument = true;
    const separator = this.getSeparator();
    const text = this.document.getText();
    const result = Papa.parse(text, { dynamicTyping: false, delimiter: separator });
    const data = result.data as string[][];
    if (index < data.length) {
      data.splice(index, 1);
    }
    const newText = Papa.unparse(data, { delimiter: separator });
    const fullRange = new vscode.Range(
      0, 0,
      this.document.lineCount,
      this.document.lineCount ? this.document.lineAt(this.document.lineCount - 1).text.length : 0
    );
    const edit = new vscode.WorkspaceEdit();
    edit.replace(this.document.uri, fullRange, newText);
    await vscode.workspace.applyEdit(edit);
    this.isUpdatingDocument = false;
    this.updateWebviewContent();
  }

  private async deleteRows(indices: number[]) {
    if (!indices || !indices.length) return;
    this.isUpdatingDocument = true;
    const separator = this.getSeparator();
    const text = this.document.getText();
    const result = Papa.parse(text, { dynamicTyping: false, delimiter: separator });
    const data = result.data as string[][];
    const sorted = [...indices].sort((a,b)=>b-a);
    for (const idx of sorted) {
      if (idx < data.length) {
        data.splice(idx, 1);
      }
    }
    const newText = Papa.unparse(data, { delimiter: separator });
    const fullRange = new vscode.Range(
      0, 0,
      this.document.lineCount,
      this.document.lineCount ? this.document.lineAt(this.document.lineCount - 1).text.length : 0
    );
    const edit = new vscode.WorkspaceEdit();
    edit.replace(this.document.uri, fullRange, newText);
    await vscode.workspace.applyEdit(edit);
    this.isUpdatingDocument = false;
    this.updateWebviewContent();
  }

  private normalizeIndices(indices: unknown, maxExclusive: number): number[] {
    if (!Array.isArray(indices) || maxExclusive <= 0) return [];
    const seen = new Set<number>();
    const out: number[] = [];
    for (const raw of indices) {
      const num = Number(raw);
      if (!Number.isFinite(num)) continue;
      const idx = Math.trunc(num);
      if (idx < 0 || idx >= maxExclusive || seen.has(idx)) continue;
      seen.add(idx);
      out.push(idx);
    }
    out.sort((a, b) => a - b);
    return out;
  }

  private reorderByIndices<T>(items: T[], indices: unknown, beforeIndex: unknown): { reordered: T[]; changed: boolean } {
    const selected = this.normalizeIndices(indices, items.length);
    if (!selected.length) {
      return { reordered: [...items], changed: false };
    }

    const before = Number(beforeIndex);
    const safeBefore = Number.isFinite(before) ? Math.trunc(before) : items.length;
    const clampedBefore = Math.min(Math.max(safeBefore, 0), items.length);

    const selectedSet = new Set(selected);
    const moving = selected.map(i => items[i]);
    const remaining = items.filter((_, i) => !selectedSet.has(i));
    const removedBefore = selected.filter(i => i < clampedBefore).length;
    const insertAt = Math.min(Math.max(clampedBefore - removedBefore, 0), remaining.length);
    const reordered = [...remaining.slice(0, insertAt), ...moving, ...remaining.slice(insertAt)];

    let changed = false;
    for (let i = 0; i < items.length; i++) {
      if (reordered[i] !== items[i]) {
        changed = true;
        break;
      }
    }
    return { reordered, changed };
  }

  private async reorderColumns(indices: unknown, beforeIndex: unknown) {
    this.isUpdatingDocument = true;
    try {
      const separator = this.getSeparator();
      const text = this.document.getText();
      const result = Papa.parse(text, { dynamicTyping: false, delimiter: separator });
      const data = result.data as string[][];
      const numColumns = data.reduce((max, row) => Math.max(max, row.length), 0);
      if (numColumns <= 0) return;

      const sourceOrder = Array.from({ length: numColumns }, (_, i) => i);
      const { reordered: columnOrder, changed } = this.reorderByIndices(sourceOrder, indices, beforeIndex);
      if (!changed) return;

      const reorderedData = data.map(row => {
        const normalized = Array.from({ length: numColumns }, (_, i) => row[i] ?? '');
        const next = columnOrder.map(colIdx => normalized[colIdx] ?? '');
        while (next.length > 0 && next[next.length - 1] === '') {
          next.pop();
        }
        return next;
      });

      const newText = Papa.unparse(reorderedData, { delimiter: separator });
      const fullRange = new vscode.Range(
        0, 0,
        this.document.lineCount,
        this.document.lineCount ? this.document.lineAt(this.document.lineCount - 1).text.length : 0
      );
      const edit = new vscode.WorkspaceEdit();
      edit.replace(this.document.uri, fullRange, newText);
      await vscode.workspace.applyEdit(edit);
      this.updateWebviewContent();
    } finally {
      this.isUpdatingDocument = false;
    }
  }

  private async reorderRows(indices: unknown, beforeIndex: unknown) {
    this.isUpdatingDocument = true;
    try {
      const separator = this.getSeparator();
      const text = this.document.getText();
      const result = Papa.parse(text, { dynamicTyping: false, delimiter: separator });
      const data = result.data as string[][];
      if (!data.length) return;

      const { reordered, changed } = this.reorderByIndices(data, indices, beforeIndex);
      if (!changed) return;

      const newText = Papa.unparse(reordered, { delimiter: separator });
      const fullRange = new vscode.Range(
        0, 0,
        this.document.lineCount,
        this.document.lineCount ? this.document.lineAt(this.document.lineCount - 1).text.length : 0
      );
      const edit = new vscode.WorkspaceEdit();
      edit.replace(this.document.uri, fullRange, newText);
      await vscode.workspace.applyEdit(edit);
      this.updateWebviewContent();
    } finally {
      this.isUpdatingDocument = false;
    }
  }

  // ───────────── Webview Rendering ─────────────

  private updateWebviewContent() {
    if (!this.currentWebviewPanel) return;

    const webview = this.currentWebviewPanel.webview;
    const config = vscode.workspace.getConfiguration('csv', this.document.uri);
    const addSerialIndex = CsvEditorProvider.getSerialIndexForUri(this.context, this.document.uri);
    const separator = this.getSeparator();
    const hiddenRows = this.getHiddenRows();

    let parsed;
    try {
      parsed = Papa.parse(this.document.getText(), { dynamicTyping: false, delimiter: separator });
      console.log(`CSV: Parsed CSV data with ${parsed.data.length} rows`);
    } catch (error) {
      console.error('CSV: Error parsing CSV content', error);
      parsed = { data: [] };
    }

    const fontFamily =
      config.get<string>('fontFamily') ||
      vscode.workspace.getConfiguration('editor').get<string>('fontFamily', 'Menlo');

    const cellPadding = config.get<number>('cellPadding', 4);
    const data = this.trimTrailingEmptyRows((parsed.data || []) as string[][]);
    const treatHeader = this.getEffectiveHeader(data, hiddenRows);
    const clickableLinks = config.get<boolean>('clickableLinks', true);
    const columnColorMode = config.get<string>('columnColorMode', 'type');
    const columnColorPalette = config.get<string>('columnColorPalette', 'default');

    const { tableHtml, chunksJson, colorCss } =
      this.generateTableAndChunks(
        data,
        treatHeader,
        addSerialIndex,
        hiddenRows,
        clickableLinks,
        columnColorMode,
        columnColorPalette
      );

    const nonce = this.getNonce();

    this.currentWebviewPanel.webview.html = this.wrapHtml({
      webview,
      nonce,
      fontFamily,
      cellPadding,
      separator,
      tableHtml,
      chunksJson,
      extraColumnColorCss: colorCss
    });
  }

  private generateTableAndChunks(
    data: string[][],
    treatHeader: boolean,
    addSerialIndex: boolean,
    hiddenRows: number,
    clickableLinks: boolean,
    columnColorMode: string,
    columnColorPalette: string
  ): { tableHtml: string; chunksJson: string; colorCss: string } {
    let headerFlag = treatHeader;
    const totalRows = data.length;
    const offset = Math.min(Math.max(0, hiddenRows), totalRows);

    const isDark = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark;
    let headerRow: string[] = [];
    let bodyData: string[][] = [];
    if (totalRows === 0 || offset >= totalRows) {
      headerFlag = false;
      bodyData = [];
    } else if (headerFlag) {
      headerRow = data[offset];
      bodyData = data.slice(offset + 1);
    } else {
      bodyData = data.slice(offset);
    }
    const visibleForWidth = headerFlag ? [headerRow, ...bodyData] : bodyData;
    let numColumns = visibleForWidth.reduce((max, row) => Math.max(max, row.length), 0);
    if (numColumns === 0) numColumns = 1; // ensure at least 1 column for the virtual row

    const columnData = Array.from({ length: numColumns }, (_, i) => bodyData.map(row => row[i] || ''));
    const columnTypes = columnData.map(col => this.estimateColumnDataType(col));
    const useThemeForeground = columnColorMode === 'theme';
    const palette = columnColorPalette === 'cool'
      ? 'cool'
      : (columnColorPalette === 'warm' ? 'warm' : 'default');
    const columnColors = useThemeForeground
      ? Array.from({ length: numColumns }, () => 'var(--vscode-editor-foreground)')
      : columnTypes.map((type, i) => this.getColumnColor(type, isDark, i, palette));
    const columnWidths = this.computeColumnWidths(visibleForWidth);

    const CHUNK_SIZE = 1000;
    const allRows = headerFlag ? bodyData : data.slice(offset);
    const allRowsCount = allRows.length; // preserve total before any truncation
    const serialIndexWidthCh = Math.max(4, String(Math.max(1, allRowsCount + 1)).length + 1);
    const chunks: string[] = [];
    const chunked = allRowsCount > CHUNK_SIZE;

    if (allRowsCount > CHUNK_SIZE) {
      for (let i = CHUNK_SIZE; i < allRowsCount; i += CHUNK_SIZE) {
        const htmlChunk = allRows.slice(i, i + CHUNK_SIZE).map((row, localR) => {
          const startAbs = headerFlag ? offset + 1 : offset;
          const absRow = startAbs + i + localR;
          const displayIdx = i + localR + 1; // numbering relative to first visible data row
          let cells = '';
          for (let cIdx = 0; cIdx < numColumns; cIdx++) {
            const safe = this.formatCellContent(row[cIdx] || '', clickableLinks);
            cells += `<td tabindex="0" style="min-width:${Math.min(columnWidths[cIdx]||0,100)}ch;max-width:100ch;border:1px solid ${isDark?'#555':'#ccc'};color:${columnColors[cIdx]};overflow:hidden;white-space: pre;text-overflow:ellipsis;" data-row="${absRow}" data-col="${cIdx}">${safe}</td>`;
          }

          return `<tr>${
            addSerialIndex ? `<td tabindex="0" style="min-width:${serialIndexWidthCh}ch;max-width:${serialIndexWidthCh}ch;border:1px solid ${isDark?'#555':'#ccc'};color:#888;" data-row="${absRow}" data-col="-1">${displayIdx}</td>` : ''
          }${cells}</tr>`;
        }).join('');

        chunks.push(htmlChunk);
      }

      // Only render the first chunk worth of rows in the initial table; the rest
      // are appended lazily from `chunks` via the webview script's loader.
      if (headerFlag) {
        bodyData.length = CHUNK_SIZE;
      } else {
        // For non-header mode, limit visible rows for the initial render as well.
        // The remainder will stream from `chunks`.
        // Note: we don't mutate the original data array; simply rely on the
        // limited `nonHeaderRows` below when rendering the table body.
      }
    }

    const colorCss = useThemeForeground
      ? ''
      : columnColors.map((hex, i) => `td[data-col="${i}"], th[data-col="${i}"] { color: ${hex}; }`).join('');

    let tableHtml = `<table>`;
    if (headerFlag) {
      tableHtml += `<thead><tr>${
        addSerialIndex
          ? `<th tabindex="0" style="min-width: ${serialIndexWidthCh}ch; max-width: ${serialIndexWidthCh}ch; border: 1px solid ${isDark ? '#555' : '#ccc'}; background-color: ${isDark ? '#1e1e1e' : '#ffffff'}; color: #888;"></th>`
          : ''
      }`;
      for (let i = 0; i < numColumns; i++) {
        const safe = this.formatCellContent(headerRow[i] || '', clickableLinks);
        tableHtml += `<th tabindex="0" style="min-width: ${Math.min(columnWidths[i] || 0, 100)}ch; max-width: 100ch; border: 1px solid ${isDark ? '#555' : '#ccc'}; background-color: ${isDark ? '#1e1e1e' : '#ffffff'}; color: ${columnColors[i]}; overflow: hidden; white-space: pre; text-overflow: ellipsis;" data-row="${offset}" data-col="${i}">${safe}</th>`;
      }
      tableHtml += `</tr></thead><tbody>`;
      bodyData.forEach((row, r) => {
        tableHtml += `<tr>${
          addSerialIndex
            ? `<td tabindex="0" style="min-width: ${serialIndexWidthCh}ch; max-width: ${serialIndexWidthCh}ch; border: 1px solid ${isDark ? '#555' : '#ccc'}; color: #888;" data-row="${offset + 1 + r}" data-col="-1">${r + 1}</td>`
            : ''
        }`;
        for (let i = 0; i < numColumns; i++) {
          const safe = this.formatCellContent(row[i] || '', clickableLinks);
          tableHtml += `<td tabindex="0" style="min-width: ${Math.min(columnWidths[i] || 0, 100)}ch; max-width: 100ch; border: 1px solid ${isDark ? '#555' : '#ccc'}; color: ${columnColors[i]}; overflow: hidden; white-space: pre; text-overflow: ellipsis;" data-row="${offset + 1 + r}" data-col="${i}">${safe}</td>`;
        }
        tableHtml += `</tr>`;
      });
      if (!chunked) {
        const virtualAbs = offset + 1 + bodyData.length;
        const idxCell = addSerialIndex ? `<td tabindex="0" style="min-width: ${serialIndexWidthCh}ch; max-width: ${serialIndexWidthCh}ch; border: 1px solid ${isDark ? '#555' : '#ccc'}; color: #888;" data-row="${virtualAbs}" data-col="-1">${bodyData.length + 1}</td>` : '';
        const dataCells = Array.from({ length: numColumns }, (_, i) => `<td tabindex="0" style="min-width: ${Math.min(columnWidths[i] || 0, 100)}ch; max-width: 100ch; border: 1px solid ${isDark ? '#555' : '#ccc'}; color: ${columnColors[i]}; overflow: hidden; white-space: pre; text-overflow: ellipsis;" data-row="${virtualAbs}" data-col="${i}"></td>`).join('');
        tableHtml += `<tr>${idxCell}${dataCells}</tr>`;
      }
      tableHtml += `</tbody>`;
    } else {
      tableHtml += `<tbody>`;
      const nonHeaderAll = data.slice(offset);
      const nonHeaderRows = chunked ? nonHeaderAll.slice(0, CHUNK_SIZE) : nonHeaderAll;
      nonHeaderRows.forEach((row, r) => {
        tableHtml += `<tr>${
          addSerialIndex
            ? `<td tabindex="0" style="min-width: ${serialIndexWidthCh}ch; max-width: ${serialIndexWidthCh}ch; border: 1px solid ${isDark ? '#555' : '#ccc'}; color: #888;" data-row="${offset + r}" data-col="-1">${r + 1}</td>`
            : ''
        }`;
        for (let i = 0; i < numColumns; i++) {
          const safe = this.formatCellContent(row[i] || '', clickableLinks);
          tableHtml += `<td tabindex="0" style="min-width: ${Math.min(columnWidths[i] || 0, 100)}ch; max-width: 100ch; border: 1px solid ${isDark ? '#555' : '#ccc'}; color: ${columnColors[i]}; overflow: hidden; white-space: pre; text-overflow: ellipsis;" data-row="${offset + r}" data-col="${i}">${safe}</td>`;
        }
        tableHtml += `</tr>`;
      });
      if (!chunked) {
        const virtualAbs = offset + nonHeaderRows.length;
        const displayIdx = nonHeaderRows.length + 1;
        const idxCell = addSerialIndex ? `<td tabindex="0" style="min-width: ${serialIndexWidthCh}ch; max-width: ${serialIndexWidthCh}ch; border: 1px solid ${isDark ? '#555' : '#ccc'}; color: #888;" data-row="${virtualAbs}" data-col="-1">${displayIdx}</td>` : '';
        const dataCells = Array.from({ length: numColumns }, (_, i) => `<td tabindex="0" style="min-width: ${Math.min(columnWidths[i] || 0, 100)}ch; max-width: 100ch; border: 1px solid ${isDark ? '#555' : '#ccc'}; color: ${columnColors[i]}; overflow: hidden; white-space: pre; text-overflow: ellipsis;" data-row="${virtualAbs}" data-col="${i}"></td>`).join('');
        tableHtml += `<tr>${idxCell}${dataCells}</tr>`;
      }
      tableHtml += `</tbody>`;
    }
    tableHtml += `</table>`;
    // If chunked, append a final chunk with the virtual row so it appears at the end
    if (chunked) {
      const startAbs = headerFlag ? offset + 1 : offset;
      const virtualAbs = startAbs + allRowsCount;
      const displayIdx = allRowsCount + 1;
      const idxCell = addSerialIndex ? `<td tabindex="0" style="min-width: ${serialIndexWidthCh}ch; max-width: ${serialIndexWidthCh}ch; border: 1px solid ${isDark ? '#555' : '#ccc'}; color: #888;" data-row="${virtualAbs}" data-col="-1">${displayIdx}</td>` : '';
      const dataCells = Array.from({ length: numColumns }, (_, i) => `<td tabindex="0" style="min-width: ${Math.min(columnWidths[i] || 0, 100)}ch; max-width: 100ch; border: 1px solid ${isDark ? '#555' : '#ccc'}; color: ${columnColors[i]}; overflow: hidden; white-space: pre; text-overflow: ellipsis;" data-row="${virtualAbs}" data-col="${i}"></td>`).join('');
      const vrow = `<tr>${idxCell}${dataCells}</tr>`;
      chunks.push(vrow);
    }

    return { tableHtml, chunksJson: JSON.stringify(chunks), colorCss };
  }

  // Heuristic: If there is no explicit override for this file, compute default header as
  // true when the first visible row's per-column types differ from the body columns' types.
  // If they match identically across all columns, assume the first row is data (not header).
  private getEffectiveHeader(data: string[][], hiddenRows: number): boolean {
    // If user overrode per-file setting, honor it
    if (CsvEditorProvider.hasHeaderOverride(this.context, this.document.uri)) {
      return CsvEditorProvider.getHeaderForUri(this.context, this.document.uri);
    }

    const total = data.length;
    const offset = Math.min(Math.max(0, hiddenRows), total);
    if (total === 0 || offset >= total) return false; // nothing visible

    const headerRow = data[offset] || [];
    const body = data.slice(offset + 1);
    if (body.length === 0) {
      return true; // with only one row visible, lean toward header
    }

    const numColumns = body.reduce((max, r) => Math.max(max, r.length), Math.max(headerRow.length, 0));
    const bodyColData = Array.from({ length: numColumns }, (_, i) => body.map(r => r[i] || ''));
    const bodyTypes = bodyColData.map(col => this.estimateColumnDataType(col));
    const headerTypes = Array.from({ length: numColumns }, (_, i) => this.estimateColumnDataType([headerRow[i] || '']));

    const matches = headerTypes.every((t, i) => t === bodyTypes[i]);
    return !matches;
  }

  private wrapHtml(args: {
    webview: vscode.Webview;
    nonce: string;
    fontFamily: string;
    cellPadding: number;
    separator: string;
    tableHtml: string;
    chunksJson: string;
    extraColumnColorCss: string;
  }): string {
    const { webview, nonce, fontFamily, cellPadding, separator, tableHtml, chunksJson, extraColumnColorCss } = args;
    const isDark = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark;
    // Build script URI using file path for compatibility (older APIs may lack Uri.joinPath)
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(this.context.extensionPath, 'media', 'main.js'))
    );

    // Safe separator transport (assumes single character; see assumptions)
    const sepCode = (separator && separator.length > 0) ? separator.codePointAt(0)! : ','.codePointAt(0)!;

    return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none'; img-src ${webview.cspSource} https:; style-src 'unsafe-inline' ${webview.cspSource}; script-src 'nonce-${nonce}' ${webview.cspSource};">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>CSV</title>
    <style nonce="${nonce}">
      body { font-family: ${this.escapeCss(fontFamily)}; margin: 0; padding: 0; user-select: none; }
      .table-container { overflow: auto; height: 100vh; }
      table { border-collapse: collapse; width: max-content; }
      th, td { padding: ${cellPadding}px 8px; border: 1px solid ${isDark ? '#555' : '#ccc'}; overflow: hidden; white-space: pre; text-overflow: ellipsis; }
      th { position: sticky; top: 0; background-color: ${isDark ? '#1e1e1e' : '#ffffff'}; }
      td.selected, th.selected { background-color: ${isDark ? '#333333' : '#cce0ff'} !important; }
      td.editing, th.editing { overflow: visible !important; white-space: normal !important; max-width: none !important; }
      .highlight { background-color: ${isDark ? '#2a2a2a' : '#fefefe'} !important; }
      .active-match { background-color: ${isDark ? '#444444' : '#ffffcc'} !important; }
      .csv-link { color: ${isDark ? '#6cb6ff' : '#0066cc'}; text-decoration: underline; cursor: pointer; }
      .csv-link:hover { color: ${isDark ? '#8ecfff' : '#0044aa'}; }
      #findReplaceWidget {
        position: fixed;
        top: 12px;
        right: 20px;
        width: 592px;
        min-width: 592px;
        max-width: 592px;
        background: #171717;
        border: 1px solid #2a2a2a;
        border-radius: 8px;
        padding: 10px;
        box-shadow: 0 6px 18px rgba(0,0,0,0.45);
        z-index: 1200;
        display: none;
        align-items: stretch;
        color: #d4d4d4;
        font-family: ${this.escapeCss(fontFamily)};
      }
      #findReplaceWidget.open { display: flex; }
      #findReplaceWidget .fr-gutter {
        width: 24px;
        min-width: 24px;
        border-radius: 6px;
        background: #2a2b2b;
        border-right: 1px solid #1f1f1f;
        margin-right: 10px;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      #findReplaceWidget .fr-content {
        flex: 1 1 auto;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      #findReplaceWidget.replace-collapsed .fr-row-replace { display: none; }
      #findReplaceWidget .fr-row {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      #findReplaceWidget .fr-row-find .fr-input-wrap {
        flex: 0 0 calc(25ch + 118px);
        width: calc(25ch + 118px);
      }
      #findReplaceWidget .fr-row-replace .fr-input-wrap {
        flex: 0 0 calc(25ch + 54px);
        width: calc(25ch + 54px);
      }
      #findReplaceWidget .fr-input-wrap {
        position: relative;
        flex: 1 1 auto;
        min-width: 0;
      }
      #findReplaceWidget .fr-input {
        width: 100%;
        height: 36px;
        box-sizing: border-box;
        border: 1px solid #2a2a2a;
        border-radius: 6px;
        background: #1c1c1c;
        color: #d4d4d4;
        padding-left: 10px;
        font-size: 14px;
        outline: none;
      }
      #findReplaceWidget .fr-input::placeholder { color: #6a6a6a; }
      #findReplaceWidget .fr-input:focus {
        border-color: #3a3a3a;
        box-shadow: 0 0 0 2px rgba(255,255,255,0.06);
      }
      #findInput { padding-right: 118px; }
      #replaceInput { padding-right: 54px; }
      #findReplaceWidget .fr-inline-toggles {
        position: absolute;
        right: 6px;
        top: 50%;
        transform: translateY(-50%);
        display: flex;
        align-items: center;
        gap: 4px;
        padding-left: 6px;
        border-left: 1px solid rgba(42,42,42,0.75);
      }
      #findReplaceWidget .fr-toggle-btn {
        min-width: 24px;
        height: 24px;
        border: 0;
        border-radius: 4px;
        background: transparent;
        color: rgba(189,189,189,0.8);
        font-size: 12px;
        cursor: pointer;
        padding: 0 4px;
      }
      #findReplaceWidget .fr-toggle-btn:hover { background: rgba(255,255,255,0.04); color: #e6e6e6; }
      #findReplaceWidget .fr-toggle-btn[aria-pressed="true"] {
        color: #e6e6e6;
        box-shadow: inset 0 -2px 0 #e6e6e6;
      }
      #findReplaceWidget .fr-status {
        min-width: 84px;
        text-align: right;
        color: #d0d0d0;
        font-size: 14px;
      }
      #findReplaceWidget .fr-divider {
        width: 1px;
        height: 22px;
        background: #2a2a2a;
      }
      #findReplaceWidget .fr-icon-btn,
      #findReplaceWidget .fr-action-btn,
      #findReplaceWidget .fr-caret-btn {
        width: 28px;
        height: 28px;
        border: 1px solid transparent;
        border-radius: 4px;
        background: transparent;
        color: #bdbdbd;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 0;
      }
      #findReplaceWidget .fr-icon-btn:hover,
      #findReplaceWidget .fr-action-btn:hover,
      #findReplaceWidget .fr-caret-btn:hover {
        background: rgba(255,255,255,0.05);
        color: #e6e6e6;
      }
      #findReplaceWidget .fr-icon-btn[disabled],
      #findReplaceWidget .fr-action-btn[disabled] {
        color: #6a6a6a;
        cursor: default;
        pointer-events: none;
      }
      #findReplaceWidget .fr-close-btn:hover { background: rgba(255,255,255,0.08); color: #ffffff; }
      #findReplaceWidget .fr-actions {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      #findReplaceWidget .fr-overflow-menu {
        position: absolute;
        top: 48px;
        right: 44px;
        min-width: 200px;
        background: #202020;
        border: 1px solid #2f2f2f;
        border-radius: 6px;
        box-shadow: 0 10px 24px rgba(0,0,0,0.45);
        padding: 4px;
        display: none;
      }
      #findReplaceWidget .fr-overflow-menu.open { display: block; }
      #findReplaceWidget .fr-overflow-item {
        width: 100%;
        border: 0;
        background: transparent;
        color: #d4d4d4;
        border-radius: 4px;
        text-align: left;
        padding: 6px 8px;
        cursor: pointer;
        font-size: 13px;
      }
      #findReplaceWidget .fr-overflow-item:hover { background: rgba(255,255,255,0.05); }
      #contextMenu { position: absolute; display: none; background: ${isDark ? '#2d2d2d' : '#ffffff'}; border: 1px solid ${isDark ? '#555' : '#ccc'}; z-index: 10000; font-family: ${this.escapeCss(fontFamily)}; }
      #contextMenu div { padding: 4px 12px; cursor: pointer; }
      #contextMenu div:hover { background: ${isDark ? '#3d3d3d' : '#eeeeee'}; }

      /* Per-column computed colors */
      ${extraColumnColorCss}
    </style>
  </head>
  <body>
    <div id="csv-root" class="table-container" data-sepcode="${sepCode}">
      ${tableHtml}
    </div>

    <script id="__csvChunks" type="application/json" nonce="${nonce}">${chunksJson}</script>

    <div id="findReplaceWidget" class="replace-collapsed" role="group" aria-label="Find and Replace">
      <div id="replaceToggleGutter" class="fr-gutter">
        <button id="replaceToggle" class="fr-caret-btn" type="button" aria-label="Toggle Replace" aria-expanded="false">›</button>
      </div>
      <div class="fr-content">
        <div class="fr-row fr-row-find">
          <div class="fr-input-wrap">
            <input id="findInput" class="fr-input" type="text" placeholder="Find" aria-label="Find">
            <div class="fr-inline-toggles">
              <button id="findCaseToggle" class="fr-toggle-btn" type="button" aria-label="Match Case" aria-pressed="false" title="Match Case">Aa</button>
              <button id="findWordToggle" class="fr-toggle-btn" type="button" aria-label="Match Whole Word" aria-pressed="false" title="Match Whole Word">ab</button>
              <button id="findRegexToggle" class="fr-toggle-btn" type="button" aria-label="Use Regular Expression" aria-pressed="false" title="Use Regular Expression">.*</button>
            </div>
          </div>
          <div id="findStatus" class="fr-status">No results</div>
          <div class="fr-divider" aria-hidden="true"></div>
          <button id="findPrev" class="fr-icon-btn" type="button" aria-label="Previous Match" title="Previous Match" disabled>↑</button>
          <button id="findNext" class="fr-icon-btn" type="button" aria-label="Next Match" title="Next Match" disabled>↓</button>
          <button id="findMenuButton" class="fr-icon-btn" type="button" aria-label="More Find Options" title="More Find Options">☰</button>
          <button id="findClose" class="fr-icon-btn fr-close-btn" type="button" aria-label="Close Find and Replace" title="Close">✕</button>
        </div>
        <div class="fr-row fr-row-replace">
          <div class="fr-input-wrap">
            <input id="replaceInput" class="fr-input" type="text" placeholder="Replace" aria-label="Replace">
            <div class="fr-inline-toggles">
              <button id="replaceCaseToggle" class="fr-toggle-btn" type="button" aria-label="Preserve Case" aria-pressed="false" title="Preserve Case">AB</button>
            </div>
          </div>
          <div class="fr-actions">
            <button id="replaceOne" class="fr-action-btn" type="button" aria-label="Replace" title="Replace" disabled>↵</button>
            <button id="replaceAll" class="fr-action-btn" type="button" aria-label="Replace All" title="Replace All" disabled>⇅</button>
          </div>
        </div>
        <div id="findOverflowMenu" class="fr-overflow-menu" role="menu" aria-label="Find Options">
          <button id="findOverflowSelection" class="fr-overflow-item" type="button" role="menuitem">Find in selection</button>
          <button id="findOverflowDiacritics" class="fr-overflow-item" type="button" role="menuitem">Match diacritics</button>
          <button id="findOverflowPreserveCase" class="fr-overflow-item" type="button" role="menuitem">Toggle preserve case</button>
        </div>
      </div>
    </div>
    <div id="contextMenu"></div>

    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
  }

  // ───────────── Utilities ─────────────

  private computeColumnWidths(data: string[][]): number[] {
    const numColumns = data.reduce((max, row) => Math.max(max, row.length), 0);
    const widths = Array(numColumns).fill(0);
    for (const row of data) {
      for (let i = 0; i < numColumns; i++){
        widths[i] = Math.max(widths[i], (row[i] || '').length);
      }
    }
    console.log(`CSV: Column widths: ${widths}`);
    return widths;
  }

  private getSeparator(): string {
    const stored = CsvEditorProvider.getSeparatorForUri(this.context, this.document.uri);
    if (stored && stored.length) return stored;

    const settings = CsvEditorProvider.getSeparatorSettings(this.document.uri);
    const configKey = CsvEditorProvider.serializeSeparatorSettings(settings);
    const version = this.document.version;
    if (
      this.separatorCache &&
      this.separatorCache.version === version &&
      this.separatorCache.configKey === configKey
    ) {
      return this.separatorCache.separator;
    }

    const filePath = this.document?.uri.fsPath || this.document?.uri.path || '';
    const text = this.document.getText();
    const separator = CsvEditorProvider.resolveInheritedSeparator(filePath, text, settings);
    this.separatorCache = { version, configKey, separator };
    return separator;
  }

  private getHiddenRows(): number {
    return CsvEditorProvider.getHiddenRowsForUri(this.context, this.document.uri);
  }

  private escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, m => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    })[m] as string);
  }

  private isAllowedExternalScheme(scheme: string): boolean {
    const normalized = scheme.toLowerCase();
    return normalized === 'http' || normalized === 'https' || normalized === 'ftp' || normalized === 'mailto';
  }

  private isAllowedExternalUrl(rawUrl: unknown): rawUrl is string {
    if (typeof rawUrl !== 'string') return false;
    const value = rawUrl.trim();
    if (!value) return false;
    try {
      const parsed = new URL(value);
      const scheme = parsed.protocol.replace(/:$/, '').toLowerCase();
      return this.isAllowedExternalScheme(scheme);
    } catch {
      return false;
    }
  }

  private async openLinkExternally(rawUrl: unknown): Promise<void> {
    if (!this.isAllowedExternalUrl(rawUrl)) {
      return;
    }
    const value = rawUrl.trim();
    try {
      await vscode.env.openExternal(vscode.Uri.parse(value));
    } catch (err) {
      console.warn(`CSV: Failed to open external link: ${value}`, err);
    }
  }

  private linkifyUrls(escapedText: string): string {
    // Match URLs in already-escaped text (handles &amp; in query strings).
    // Supports http, https, ftp, mailto, and www.*.* (Google Sheets-like behavior).
    const urlPattern = /\b(?:(?:https?:\/\/|ftp:\/\/|mailto:)[^\s<>&"']+(?:&amp;[^\s<>&"']+)*|www\.[^\s<>&"']+\.[^\s<>&"']+)/gi;
    return escapedText.replace(urlPattern, (rawMatch) => {
      let matched = rawMatch;
      let trailing = '';
      const trailingMatch = matched.match(/[.,!?;:)\]]+$/);
      if (trailingMatch) {
        trailing = trailingMatch[0];
        matched = matched.slice(0, -trailing.length);
      }
      if (!matched) {
        return rawMatch;
      }

      // Decode &amp; back to & for URL parsing and opening.
      let href = matched.replace(/&amp;/g, '&');
      if (/^www\./i.test(href)) {
        href = `https://${href}`;
      }
      if (!this.isAllowedExternalUrl(href)) {
        return rawMatch;
      }

      return `<span class="csv-link" data-href="${this.escapeHtml(href)}" title="Ctrl/Cmd+click to open">${matched}</span>${trailing}`;
    });
  }

  private formatCellContent(text: string, linkify: boolean): string {
    const escaped = this.escapeHtml(text);
    return linkify ? this.linkifyUrls(escaped) : escaped;
  }

  private escapeCss(text: string): string {
    // conservative; ok for font-family lists
    return text.replace(/[\\"]/g, m => (m === '\\' ? '\\\\' : '\\"'));
  }

  private isDate(value: string): boolean {
    if (!value) return false;
    const v = value.trim();
    // Strictly match ISO-like date formats to avoid misclassifying plain numbers as dates.
    const isoDate = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
    const isoSlash = /^\d{4}\/\d{2}\/\d{2}$/;
    if (!(isoDate.test(v) || isoSlash.test(v))) return false;
    return !isNaN(Date.parse(v));
  }

  private isBooleanish(value: string): boolean {
    const v = (value ?? '').trim().toLowerCase();
    if (!v) return false;
    if (v === 'true' || v === 'false') return true;
    if (v === 't' || v === 'f') return true;
    if (v === 'yes' || v === 'no') return true;
    if (v === 'y' || v === 'n') return true;
    if (v === 'on' || v === 'off') return true;
    if (v === '1' || v === '0') return true;
    return false;
  }

  private estimateColumnDataType(column: string[]): string {
    let allBoolean = true, allDate = true, allInteger = true, allFloat = true, allEmpty = true;
    for (const cell of column) {
      const items = cell.split(',').map(item => item.trim());
      for (const item of items){
        if (item === '') continue;
        allEmpty = false;
        if (!this.isBooleanish(item)) allBoolean = false;
        if (!this.isDate(item)) allDate = false;
        const num = Number(item);
        if (!Number.isInteger(num)) allInteger = false;
        if (isNaN(num)) allFloat = false;
      }
    }
    if (allEmpty) return "empty";
    if (allBoolean) return "boolean";
    if (allDate) return "date";
    if (allInteger) return "integer";
    if (allFloat) return "float";
    return "string";
  }

  private getColumnColor(type: string, isDark: boolean, columnIndex: number, palette: 'default' | 'cool' | 'warm' = 'default'): string {
    let hueRange = 0, isDefault = false;
    if (palette === 'cool') {
      switch (type){
        case "boolean": hueRange = 160; break;
        case "date": hueRange = 210; break;
        case "float": hueRange = isDark ? 195 : 205; break;
        case "integer": hueRange = 130; break;
        case "string": hueRange = 190; break;
        case "empty": isDefault = true; break;
      }
    } else if (palette === 'warm') {
      switch (type){
        case "boolean": hueRange = 55; break;
        case "date": hueRange = 28; break;
        case "float": hueRange = isDark ? 18 : 24; break;
        case "integer": hueRange = 42; break;
        case "string": hueRange = 8; break;
        case "empty": isDefault = true; break;
      }
    } else {
      switch (type){
        case "boolean": hueRange = 30; break;
        case "date": hueRange = 210; break;
        case "float": hueRange = isDark ? 60 : 270; break;
        case "integer": hueRange = 120; break;
        case "string": hueRange = 0; break;
        case "empty": isDefault = true; break;
      }
    }
    if (isDefault) return isDark ? "#BBB" : "#444";
    const saturationOffset = ((columnIndex * 7) % 31) - 15;
    const saturation = saturationOffset + (isDark ? 60 : 80);
    const lightnessOffset = ((columnIndex * 13) % 31) - 15;
    const lightness = lightnessOffset + (isDark ? 70 : 30);
    const hueOffset = ((columnIndex * 17) % 31) - 15;
    const finalHue = (hueRange + hueOffset + 360) % 360;
    return this.hslToHex(finalHue, saturation, lightness);
  }

  private hslToHex(h: number, s: number, l: number): string {
    s /= 100; l /= 100;
    const k = (n: number) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
    const r = Math.round(255 * f(0));
    const g = Math.round(255 * f(8));
    const b = Math.round(255 * f(4));
    return "#" + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
  }

  private getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++){
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }

  private trimTrailingEmptyRows(rows: string[][]): string[][] {
    const isEmpty = (r: string[] | undefined) => {
      if (!r || r.length === 0) return true;
      for (let i = 0; i < r.length; i++) {
        if ((r[i] ?? '') !== '') return false;
      }
      return true;
    };
    let end = rows.length;
    while (end > 0 && isEmpty(rows[end - 1])) {
      end--;
    }
    return rows.slice(0, end);
  }
}

// Wrapper provider: one instance registered with VS Code.
export class CsvEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = 'csv.editor';
  public static editors: CsvEditorController[] = [];
  public static currentActive: CsvEditorController | undefined;
  public static readonly hiddenRowsKey = 'csv.hiddenRows';
  public static readonly headerKey     = 'csv.headerByUri';
  public static readonly serialKey     = 'csv.serialIndexByUri';
  public static readonly sepKey        = 'csv.separatorByUri';
  private static readonly DEFAULT_SEPARATOR = ',';
  private static readonly DEFAULT_SEPARATOR_MODE: SeparatorMode = 'extension';
  private static readonly BUILTIN_SEPARATORS_BY_EXTENSION: Record<string, string> = {
    '.csv': ',',
    '.tsv': '\t',
    '.tab': '\t',
    '.psv': '|'
  };
  private static readonly AUTO_SEPARATOR_CANDIDATES = [',', ';', '\t', '|'];

  private static normalizeExtension(rawExt: string): string {
    const trimmed = (rawExt ?? '').trim().toLowerCase();
    if (!trimmed) return '';
    return trimmed.startsWith('.') ? trimmed : `.${trimmed}`;
  }

  private static normalizeSeparator(rawSep: unknown): string | undefined {
    if (typeof rawSep !== 'string') return undefined;
    if (rawSep.length === 0) return undefined;
    if (rawSep === '\\t') return '\t';
    return rawSep;
  }

  public static getSeparatorSettings(uri: vscode.Uri): SeparatorSettings {
    const fallback: SeparatorSettings = {
      mode: CsvEditorProvider.DEFAULT_SEPARATOR_MODE,
      defaultSeparator: CsvEditorProvider.DEFAULT_SEPARATOR,
      byExtension: { ...CsvEditorProvider.BUILTIN_SEPARATORS_BY_EXTENSION }
    };

    const workspaceAny = (vscode as any).workspace;
    if (!workspaceAny || typeof workspaceAny.getConfiguration !== 'function') {
      return fallback;
    }

    const cfg = workspaceAny.getConfiguration('csv', uri) as vscode.WorkspaceConfiguration;
    const rawMode = cfg.get<string>('separatorMode', CsvEditorProvider.DEFAULT_SEPARATOR_MODE);
    const mode: SeparatorMode =
      rawMode === 'auto' || rawMode === 'default' || rawMode === 'extension'
        ? rawMode
        : CsvEditorProvider.DEFAULT_SEPARATOR_MODE;

    const defaultSeparator =
      CsvEditorProvider.normalizeSeparator(cfg.get<string>('defaultSeparator', CsvEditorProvider.DEFAULT_SEPARATOR)) ??
      CsvEditorProvider.DEFAULT_SEPARATOR;

    const byExtension: Record<string, string> = {
      ...CsvEditorProvider.BUILTIN_SEPARATORS_BY_EXTENSION
    };
    const rawMap = cfg.get<Record<string, unknown>>('separatorByExtension', {});
    if (rawMap && typeof rawMap === 'object') {
      for (const [rawExt, rawSep] of Object.entries(rawMap)) {
        const ext = CsvEditorProvider.normalizeExtension(rawExt);
        const sep = CsvEditorProvider.normalizeSeparator(rawSep);
        if (!ext || !sep) continue;
        byExtension[ext] = sep;
      }
    }

    return { mode, defaultSeparator, byExtension };
  }

  public static serializeSeparatorSettings(settings: SeparatorSettings): string {
    const sortedMapEntries = Object.entries(settings.byExtension)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([ext, sep]) => `${ext}:${sep}`)
      .join('|');
    return `${settings.mode}::${settings.defaultSeparator}::${sortedMapEntries}`;
  }

  private static resolveSeparatorFromExtension(filePath: string, settings: SeparatorSettings): string {
    const ext = CsvEditorProvider.normalizeExtension(path.extname((filePath ?? '').toLowerCase()));
    if (!ext) return settings.defaultSeparator;
    return settings.byExtension[ext] ?? settings.defaultSeparator;
  }

  private static countDelimiterOutsideQuotes(line: string, delimiter: string): number {
    if (!delimiter) return 0;
    let inQuotes = false;
    let count = 0;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          i++;
          continue;
        }
        inQuotes = !inQuotes;
        continue;
      }
      if (!inQuotes && line.startsWith(delimiter, i)) {
        count++;
        i += delimiter.length - 1;
      }
    }
    return count;
  }

  private static detectSeparatorFromText(text: string, candidates: string[]): string | undefined {
    if (!text) return undefined;
    const sampleText = text.length > 300000 ? text.slice(0, 300000) : text;
    const allLines = sampleText.split(/\r\n|\n|\r/);
    const lines: string[] = [];
    for (const line of allLines) {
      if (line.trim().length === 0) continue;
      lines.push(line);
      if (lines.length >= 200) break;
    }
    if (lines.length === 0) return undefined;

    const minRowsWithDelimiter = lines.length === 1 ? 1 : 2;
    let best:
      | {
          separator: string;
          rowsWithDelimiter: number;
          consistency: number;
          avgDelimiterCount: number;
          score: number;
        }
      | undefined;

    for (const separator of candidates) {
      if (!separator) continue;
      const counts = lines.map(line => CsvEditorProvider.countDelimiterOutsideQuotes(line, separator));
      const withDelimiter = counts.filter(count => count > 0);
      if (withDelimiter.length < minRowsWithDelimiter) continue;

      const frequencies = new Map<number, number>();
      for (const count of withDelimiter) {
        frequencies.set(count, (frequencies.get(count) ?? 0) + 1);
      }
      let modeRowCount = 0;
      for (const freq of frequencies.values()) {
        if (freq > modeRowCount) modeRowCount = freq;
      }

      const consistency = withDelimiter.length > 0 ? modeRowCount / withDelimiter.length : 0;
      const avgDelimiterCount = withDelimiter.reduce((sum, count) => sum + count, 0) / withDelimiter.length;
      const firstLineBonus = (counts[0] ?? 0) > 0 ? 25 : -25;
      const score = withDelimiter.length * 10 + consistency * 100 + avgDelimiterCount + firstLineBonus;
      const candidate = { separator, rowsWithDelimiter: withDelimiter.length, consistency, avgDelimiterCount, score };

      if (!best) {
        best = candidate;
        continue;
      }
      if (candidate.score > best.score) {
        best = candidate;
        continue;
      }
      if (candidate.score === best.score && candidate.rowsWithDelimiter > best.rowsWithDelimiter) {
        best = candidate;
      }
    }

    return best?.separator;
  }

  public static resolveInheritedSeparator(filePath: string, text: string, settings: SeparatorSettings): string {
    const extensionSeparator = CsvEditorProvider.resolveSeparatorFromExtension(filePath, settings);
    if (settings.mode === 'default') {
      return settings.defaultSeparator;
    }
    if (settings.mode === 'auto') {
      const candidates: string[] = [];
      const seen = new Set<string>();
      const push = (value: string | undefined) => {
        if (!value || seen.has(value)) return;
        seen.add(value);
        candidates.push(value);
      };
      push(extensionSeparator);
      push(settings.defaultSeparator);
      CsvEditorProvider.AUTO_SEPARATOR_CANDIDATES.forEach(push);
      Object.values(settings.byExtension).forEach(push);
      return CsvEditorProvider.detectSeparatorFromText(text, candidates) ?? extensionSeparator;
    }
    return extensionSeparator;
  }

  private static parseCsvFieldSpans(text: string, delimiter: string): CsvFieldSpan[][] {
    const sep = delimiter && delimiter.length ? delimiter : CsvEditorProvider.DEFAULT_SEPARATOR;
    const rows: CsvFieldSpan[][] = [];
    let row: CsvFieldSpan[] = [];
    let fieldStart = 0;
    let i = 0;
    let inQuotes = false;
    let quoted = false;

    const pushField = (end: number) => {
      row.push({ start: fieldStart, end, quoted });
      quoted = false;
    };
    const pushRow = () => {
      rows.push(row);
      row = [];
    };

    while (i < text.length) {
      if (!inQuotes) {
        if (text.startsWith(sep, i)) {
          pushField(i);
          i += sep.length;
          fieldStart = i;
          continue;
        }
        const ch = text[i];
        if (ch === '"' && i === fieldStart) {
          inQuotes = true;
          quoted = true;
          i++;
          continue;
        }
        if (ch === '\r' || ch === '\n') {
          pushField(i);
          pushRow();
          if (ch === '\r' && i + 1 < text.length && text[i + 1] === '\n') {
            i += 2;
          } else {
            i++;
          }
          fieldStart = i;
          continue;
        }
        i++;
        continue;
      }

      if (text[i] === '"') {
        if (i + 1 < text.length && text[i + 1] === '"') {
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      i++;
    }

    pushField(text.length);
    pushRow();
    return rows;
  }

  private static encodeCsvField(value: string, delimiter: string, preferQuoted: boolean): string {
    const mustQuote =
      preferQuoted ||
      value.includes('"') ||
      value.includes('\n') ||
      value.includes('\r') ||
      (!!delimiter && value.includes(delimiter));
    if (!mustQuote) {
      return value;
    }
    const escaped = value.replace(/"/g, '""');
    return `"${escaped}"`;
  }

  public static applyFieldUpdatesPreservingFormat(
    text: string,
    delimiter: string,
    updates: Array<{ row: number; col: number; value: string }>
  ): string | undefined {
    if (!Array.isArray(updates) || updates.length === 0) {
      return text;
    }

    const deduped = new Map<string, { row: number; col: number; value: string }>();
    for (const update of updates) {
      if (!Number.isInteger(update.row) || update.row < 0 || !Number.isInteger(update.col) || update.col < 0) {
        continue;
      }
      deduped.set(`${update.row}:${update.col}`, update);
    }
    if (deduped.size === 0) {
      return text;
    }

    const spans = CsvEditorProvider.parseCsvFieldSpans(text, delimiter);
    const edits: Array<{ start: number; end: number; replacement: string }> = [];

    for (const update of deduped.values()) {
      const span = spans[update.row]?.[update.col];
      if (!span) {
        return undefined;
      }
      const replacement = CsvEditorProvider.encodeCsvField(update.value, delimiter, span.quoted);
      if (text.slice(span.start, span.end) !== replacement) {
        edits.push({ start: span.start, end: span.end, replacement });
      }
    }

    if (edits.length === 0) {
      return text;
    }

    edits.sort((a, b) => b.start - a.start);
    let output = text;
    for (const edit of edits) {
      output = output.slice(0, edit.start) + edit.replacement + output.slice(edit.end);
    }
    return output;
  }

  constructor(private readonly context: vscode.ExtensionContext) {}

  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    console.log(`CSV(reg): creating controller for ${document.uri.toString()}`);
    const controller = new CsvEditorController(this.context);
    // Track active controller
    webviewPanel.onDidChangeViewState(e => {
      if (e.webviewPanel.active) {
        CsvEditorProvider.currentActive = controller;
      }
    });
    await controller.resolveCustomTextEditor(document, webviewPanel, _token);
  }

  public static getActiveProvider(): CsvEditorController | undefined {
    return CsvEditorProvider.currentActive || CsvEditorProvider.editors.find(ed => ed.isActive());
  }

  public static getHiddenRowsForUri(context: vscode.ExtensionContext, uri: vscode.Uri): number {
    const map = context.workspaceState.get<Record<string, number>>(CsvEditorProvider.hiddenRowsKey, {});
    const n = map[uri.toString()] ?? 0;
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }

  public static async setHiddenRowsForUri(context: vscode.ExtensionContext, uri: vscode.Uri, n: number): Promise<void> {
    const map = { ...(context.workspaceState.get<Record<string, number>>(CsvEditorProvider.hiddenRowsKey, {})) };
    if (!Number.isFinite(n) || n <= 0) {
      delete map[uri.toString()];
    } else {
      map[uri.toString()] = Math.floor(n);
    }
    await context.workspaceState.update(CsvEditorProvider.hiddenRowsKey, map);
  }

  public static getHeaderForUri(context: vscode.ExtensionContext, uri: vscode.Uri): boolean {
    const map = context.workspaceState.get<Record<string, boolean>>(CsvEditorProvider.headerKey, {});
    return map[uri.toString()] ?? true; // fallback default true
  }

  public static hasHeaderOverride(context: vscode.ExtensionContext, uri: vscode.Uri): boolean {
    const map = context.workspaceState.get<Record<string, boolean>>(CsvEditorProvider.headerKey, {});
    return Object.prototype.hasOwnProperty.call(map, uri.toString());
  }

  public static async setHeaderForUri(context: vscode.ExtensionContext, uri: vscode.Uri, val: boolean): Promise<void> {
    const map = { ...(context.workspaceState.get<Record<string, boolean>>(CsvEditorProvider.headerKey, {})) };
    map[uri.toString()] = !!val; // always persist explicit override
    await context.workspaceState.update(CsvEditorProvider.headerKey, map);
  }

  public static getSerialIndexForUri(context: vscode.ExtensionContext, uri: vscode.Uri): boolean {
    const map = context.workspaceState.get<Record<string, boolean>>(CsvEditorProvider.serialKey, {});
    return map[uri.toString()] ?? true; // default true
  }

  public static async setSerialIndexForUri(context: vscode.ExtensionContext, uri: vscode.Uri, val: boolean): Promise<void> {
    const map = { ...(context.workspaceState.get<Record<string, boolean>>(CsvEditorProvider.serialKey, {})) };
    map[uri.toString()] = !!val; // always persist explicit override
    await context.workspaceState.update(CsvEditorProvider.serialKey, map);
  }

  public static getSeparatorForUri(context: vscode.ExtensionContext, uri: vscode.Uri): string | undefined {
    const map = context.workspaceState.get<Record<string, string>>(CsvEditorProvider.sepKey, {});
    return map[uri.toString()];
  }

  public static async setSeparatorForUri(context: vscode.ExtensionContext, uri: vscode.Uri, sep: string | undefined): Promise<void> {
    const map = { ...(context.workspaceState.get<Record<string, string>>(CsvEditorProvider.sepKey, {})) };
    if (!sep || sep.length === 0) { delete map[uri.toString()]; } else { map[uri.toString()] = sep; }
    await context.workspaceState.update(CsvEditorProvider.sepKey, map);
  }

  // Test helpers to access internal utilities without VS Code runtime
  public static __test = {
    // Pure helper mirroring sort behavior; returns combined rows after sort.
    sortByColumn(rows: string[][], index: number, ascending: boolean, treatHeader: boolean, hiddenRows: number): string[][] {
      // Trim trailing empty rows like runtime before sorting
      const isEmpty = (r: string[] | undefined) => {
        if (!r || r.length === 0) return true;
        for (let i = 0; i < r.length; i++) { if ((r[i] ?? '') !== '') return false; }
        return true;
      };
      let end = rows.length;
      while (end > 0 && isEmpty(rows[end - 1])) { end--; }
      const trimmed = rows.slice(0, end);

      const offset = Math.min(Math.max(0, hiddenRows), trimmed.length);
      let header: string[] = [];
      let body:   string[][] = [];
      if (treatHeader && offset < trimmed.length) {
        header = trimmed[offset];
        body   = trimmed.slice(offset + 1);
      } else {
        body   = trimmed.slice(offset);
      }
      const isDateStr = (v: string) => {
        const s = (v ?? '').trim();
        if (!s) return false;
        const isoDate = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
        const isoSlash = /^\d{4}\/\d{2}\/\d{2}$/;
        return isoDate.test(s) || isoSlash.test(s);
      };
      const cmp = (a: string, b: string) => {
        const sa = (a ?? '').trim();
        const sb = (b ?? '').trim();
        const aEmpty = sa === '';
        const bEmpty = sb === '';
        if (aEmpty && bEmpty) return 0;
        if (aEmpty) return 1; // empty sorts last
        if (bEmpty) return -1;
        if (isDateStr(sa) && isDateStr(sb)) {
          const da = Date.parse(sa);
          const db = Date.parse(sb);
          if (!isNaN(da) && !isNaN(db)) return da - db;
        }
        const na = parseFloat(sa), nb = parseFloat(sb);
        if (!isNaN(na) && !isNaN(nb)) return na - nb;
        return sa.localeCompare(sb, undefined, { sensitivity: 'base' });
      };
      body.sort((r1, r2) => {
        const diff = cmp(r1[index] ?? '', r2[index] ?? '');
        return ascending ? diff : -diff;
      });
      const prefix = trimmed.slice(0, offset);

      // Apply same sanitation used before unparse in runtime path
      const combined = (treatHeader ? [...prefix, header, ...body] : [...prefix, ...body]).map(r => r.map((v: any) => {
        if (v === undefined || v === null) return '';
        const t = typeof v;
        if (t === 'number') return Number.isNaN(v) ? '' : String(v);
        const s = String(v);
        return s.toLowerCase() === 'nan' ? '' : s;
      }));
      return combined;
    },
    computeColumnWidths(data: string[][]): number[] {
      const c: any = new (CsvEditorController as any)({} as any);
      return c.computeColumnWidths(data);
    },
    reorderIndexOrder(length: number, indices: number[], beforeIndex: number): number[] {
      const c: any = new (CsvEditorController as any)({} as any);
      const n = Number.isFinite(length) ? Math.max(0, Math.trunc(length)) : 0;
      const base = Array.from({ length: n }, (_, i) => i);
      const result = c.reorderByIndices(base, indices, beforeIndex);
      return result.reordered;
    },
    reorderRows(rows: string[][], indices: number[], beforeIndex: number): string[][] {
      const c: any = new (CsvEditorController as any)({} as any);
      const result = c.reorderByIndices(rows, indices, beforeIndex);
      return result.reordered;
    },
    reorderColumns(rows: string[][], indices: number[], beforeIndex: number): string[][] {
      const c: any = new (CsvEditorController as any)({} as any);
      const numColumns = rows.reduce((max, row) => Math.max(max, row.length), 0);
      const sourceOrder = Array.from({ length: numColumns }, (_, i) => i);
      const orderResult = c.reorderByIndices(sourceOrder, indices, beforeIndex);
      return rows.map((row: string[]) => {
        const normalized = Array.from({ length: numColumns }, (_, i) => row[i] ?? '');
        const next = orderResult.reordered.map((colIdx: number) => normalized[colIdx] ?? '');
        while (next.length > 0 && next[next.length - 1] === '') {
          next.pop();
        }
        return next;
      });
    },
    mutateDataForEdit(data: string[][], row: number, col: number, value: string): { data: string[][]; trimmed: boolean; createdRow: boolean; createdCol: boolean } {
      const c: any = new (CsvEditorController as any)({} as any);
      return c.mutateDataForEdit(data, row, col, value);
    },
    isDate(v: string): boolean {
      const c: any = new (CsvEditorController as any)({} as any);
      return c.isDate(v);
    },
    estimateColumnDataType(col: string[]): string {
      const c: any = new (CsvEditorController as any)({} as any);
      return c.estimateColumnDataType(col);
    },
    getColumnColor(t: string, dark: boolean, i: number, palette: 'default' | 'cool' | 'warm' = 'default'): string {
      const c: any = new (CsvEditorController as any)({} as any);
      return c.getColumnColor(t, dark, i, palette);
    },
    hslToHex(h: number, s: number, l: number): string {
      const c: any = new (CsvEditorController as any)({} as any);
      return c.hslToHex(h, s, l);
    },
    formatCellContent(text: string, linkify: boolean): string {
      const c: any = new (CsvEditorController as any)({} as any);
      return c.formatCellContent(text, linkify);
    },
    isAllowedExternalUrl(url: unknown): boolean {
      const c: any = new (CsvEditorController as any)({} as any);
      return c.isAllowedExternalUrl(url);
    },
    shouldPromptForLargeFile(fileSizeBytes: number, maxFileSizeMB: number): boolean {
      const c: any = new (CsvEditorController as any)({} as any);
      return c.shouldPromptForLargeFile(fileSizeBytes, maxFileSizeMB);
    },
    // Expose header heuristic for tests. Allows specifying hiddenRows and
    // optionally an override value through a mock workspaceState.
    getEffectiveHeader(data: string[][], hiddenRows: number, override: undefined | boolean = undefined): boolean {
      const c: any = new (CsvEditorController as any)({} as any);
      // Minimal fake URI and context to satisfy header-override checks
      const fakeUri = { toString: () => 'vscode-test://csv/fixture', fsPath: '/csv/fixture.csv' } as any;
      const state: Record<string, any> = {};
      if (override !== undefined) {
        state[CsvEditorProvider.headerKey] = { [fakeUri.toString()]: override };
      }
      c.context = {
        workspaceState: {
          get: (key: string, def: any) => (key in state ? state[key] : def),
          update: async (key: string, val: any) => { state[key] = val; }
        }
      } as any;
      c.document = { uri: fakeUri } as any;
      return c.getEffectiveHeader(data, hiddenRows);
    },
    // Compute the effective separator used for a given file path with optional override.
    getEffectiveSeparator(
      filePath: string,
      override: string | undefined,
      options?: {
        mode?: SeparatorMode;
        defaultSeparator?: string;
        byExtension?: Record<string, string>;
        text?: string;
      }
    ): string {
      if (override && override.length) {
        return override;
      }
      const mode = options?.mode ?? 'extension';
      const defaultSeparator =
        CsvEditorProvider.normalizeSeparator(options?.defaultSeparator) ?? CsvEditorProvider.DEFAULT_SEPARATOR;
      const byExtension: Record<string, string> = { ...CsvEditorProvider.BUILTIN_SEPARATORS_BY_EXTENSION };
      if (options?.byExtension) {
        for (const [rawExt, rawSep] of Object.entries(options.byExtension)) {
          const ext = CsvEditorProvider.normalizeExtension(rawExt);
          const sep = CsvEditorProvider.normalizeSeparator(rawSep);
          if (!ext || !sep) continue;
          byExtension[ext] = sep;
        }
      }
      const text = options?.text ?? '';
      return CsvEditorProvider.resolveInheritedSeparator(filePath, text, {
        mode,
        defaultSeparator,
        byExtension
      });
    },
    applyFieldUpdatesPreservingFormat(
      text: string,
      delimiter: string,
      updates: Array<{ row: number; col: number; value: string }>
    ): string | undefined {
      return CsvEditorProvider.applyFieldUpdatesPreservingFormat(text, delimiter, updates);
    },
    // Expose chunking/table generation for large-data tests. Returns parsed chunk count.
    generateTableChunksMeta(
      data: string[][],
      treatHeader: boolean,
      addSerialIndex: boolean,
      hiddenRows: number,
      clickableLinks: boolean = true,
      columnColorMode: 'type' | 'theme' = 'type',
      columnColorPalette: 'default' | 'cool' | 'warm' = 'default'
    ): { chunkCount: number; hasTable: boolean } {
      const c: any = new (CsvEditorController as any)({} as any);
      const result = c.generateTableAndChunks(data, treatHeader, addSerialIndex, hiddenRows, clickableLinks, columnColorMode, columnColorPalette);
      try {
        const chunks = JSON.parse(result.chunksJson);
        return { chunkCount: Array.isArray(chunks) ? chunks.length : 0, hasTable: typeof result.tableHtml === 'string' && result.tableHtml.includes('<table') };
      } catch {
        return { chunkCount: 0, hasTable: false };
      }
    },
    generateTableAndChunksRaw(
      data: string[][],
      treatHeader: boolean,
      addSerialIndex: boolean,
      hiddenRows: number,
      clickableLinks: boolean = true,
      columnColorMode: 'type' | 'theme' = 'type',
      columnColorPalette: 'default' | 'cool' | 'warm' = 'default'
    ): { tableHtml: string; chunks: string[] } {
      const c: any = new (CsvEditorController as any)({} as any);
      const result = c.generateTableAndChunks(data, treatHeader, addSerialIndex, hiddenRows, clickableLinks, columnColorMode, columnColorPalette);
      let chunks: string[] = [];
      try { chunks = JSON.parse(result.chunksJson); } catch {}
      return { tableHtml: result.tableHtml, chunks };
    }
  };
}
