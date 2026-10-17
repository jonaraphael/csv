import Papa from 'papaparse';
import * as vscode from 'vscode';
import * as path from 'path';
import { parseClipboardMatrix, serializeClipboardMatrix } from './clipboard';
import { ColumnFilter, normalizeColumnFilters, rowMatchesFilters, visibleSourceRows, remapColumnFilters, MAX_FILTER_VALUE_LENGTH, MAX_COLUMN_FILTERS } from './column-filters';

type FrozenPanes = { rows: number; columns: number };

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
type PasteSelectionBounds = {
  minRow: number;
  maxRow: number;
  minCol: number;
  maxCol: number;
  rectangular: boolean;
};
type PastePlan = {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  fillSelection: boolean;
};
type PasteApplyResult = {
  changed: boolean;
  structuralChange: boolean;
  updates: Array<{ row: number; col: number; value: string }>;
  plan: PastePlan;
};
type ChunkRenderState = {
  rowIds: number[];
  bodyStart: number;
  virtualRow: number;
  allRows: string[][];
  allRowsCount: number;
  chunkRows: number;
  includeTrailingEmptyRow: boolean;
  addSerialIndex: boolean;
  numColumns: number;
  columnWidths: number[];
  columnColors: string[];
  clickableLinks: boolean;
  isDark: boolean;
  serialIndexWidthCh: number;
};
type ChunkResponse = {
  html: string;
  nextStart: number;
  done: boolean;
};

// Per-document controller. Manages one webview + document.
class CsvEditorController {
  // Note: Global registry lives on CsvEditorProvider (wrapper)

  private static readonly BYTES_PER_MB = 1024 * 1024;
  private static readonly DEFAULT_MAX_FILE_SIZE_MB = 10;
  private static readonly LARGE_FILE_CONTINUE_THIS_TIME = 'Continue This Time';
  private static readonly LARGE_FILE_IGNORE_FOREVER = 'Ignore Forever';
  private static readonly encodingWarnings = new WeakSet<vscode.TextDocument>();

  private isUpdatingDocument = false;
  private isSaving = false;
  private disposed = false;
  private pendingOperation: Promise<void> = Promise.resolve();
  private currentWebviewPanel: vscode.WebviewPanel | undefined;
  private document!: vscode.TextDocument;
  private separatorCache: { version: number; configKey: string; separator: string } | undefined;
  private isDiffContext = false;
  private currentHeader = false;
  private chunkRenderState: ChunkRenderState | undefined;

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

    this.refreshDiffContext(webviewPanel);
    this.updateWebviewContent();

    if (webviewPanel.active) {
      CsvEditorProvider.currentActive = this;
    }
    void this.warnAboutPossibleDecoding().catch(error => {
      console.warn('CSV: Encoding warning action failed', error);
    });

    webviewPanel.webview.postMessage({ type: 'focus' });
    let wasVisible = webviewPanel.visible;
    webviewPanel.onDidChangeViewState(e => {
      const becameVisible = e.webviewPanel.visible && !wasVisible;
      wasVisible = e.webviewPanel.visible;
      if (e.webviewPanel.active) {
        const diffChanged = this.refreshDiffContext(e.webviewPanel);
        if (diffChanged || becameVisible) {
          // A hidden webview can be recreated from its original HTML snapshot.
          // Rebuild from the current (possibly unsaved) document after pending edits.
          void this.enqueueOperation(() => this.updateWebviewContent());
        }
        e.webviewPanel.webview.postMessage({ type: 'focus' });
        CsvEditorProvider.currentActive = this;
      }
    });

    webviewPanel.webview.onDidReceiveMessage(e => this.enqueueOperation(async () => {
      switch (e.type) {
        case 'editCell':
          await this.updateDocument(e.row, e.col, e.value);
          break;
        case 'replaceCells':
          await this.replaceCells(e.replacements);
          break;
        case 'pasteCells':
          await this.pasteCells(e.text, e.anchorRow, e.anchorCol, e.selection);
          break;
        case 'requestChunk':
          await this.requestChunk(e.start, e.requestId);
          break;
        case 'findMatches':
          await this.findMatches(e.requestId, e.query, e.options);
          break;
        case 'save':
          await this.handleSave();
          break;
        case 'configureColumnFilter':
          await this.configureColumnFilter(e.column);
          break;
        case 'clearColumnFilter':
          await this.setColumnFilters(CsvEditorProvider.getColumnFiltersForUri(this.context, this.document.uri).filter(filter => filter.column !== Number(e.column)));
          break;
        case 'clearAllFilters':
          await this.setColumnFilters([]);
          break;
        case 'viewRefreshReady':
          this.updateWebviewContent();
          break;
        case 'freezePanesChanged':
          await this.setFrozenPanes({ rows: e.rows, columns: e.columns });
          break;
        case 'columnSizesChanged':
          await CsvEditorProvider.setColumnSizesForUri(this.context, this.document.uri, e.columnSizes);
          break;
        case 'copyCells':
          await this.copyCells(e.matrix, e.rowIds, e.startCol, e.cut === true);
          break;
        case 'pasteFromClipboard':
          await this.pasteCells(await vscode.env.clipboard.readText(), e.anchorRow, e.anchorCol, e.selection);
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
    }));

    const changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument(e => {
      if (
        e.document.uri.toString() === document.uri.toString() &&
        !this.isUpdatingDocument &&
        !this.isSaving
      ) {
        setTimeout(() => this.updateWebviewContent(), 250);
      }
    });

    const saveDocumentSubscription = vscode.workspace.onWillSaveTextDocument(e => {
      if (e.document.uri.toString() === document.uri.toString() && !this.isSaving) {
        // Native File > Save can run while the webview's blur edit is applying.
        // The custom save command is already in this queue and must not await itself.
        e.waitUntil(this.pendingOperation);
      }
    });

    webviewPanel.onDidDispose(() => {
      this.disposed = true;
      changeDocumentSubscription.dispose();
      saveDocumentSubscription.dispose();
      CsvEditorProvider.editors = CsvEditorProvider.editors.filter(ed => ed !== this);
      this.currentWebviewPanel = undefined;
    });
  }

  private enqueueOperation(operation: () => void | Promise<void>): Promise<void> {
    // Event listeners are not awaited by VS Code. Serialize mutations, reads and
    // saves so every command sees the result of the preceding document edit.
    this.pendingOperation = this.pendingOperation.then(operation).catch(error => {
      console.error('CSV: Editor operation failed', error);
    });
    return this.pendingOperation;
  }

  private async warnAboutPossibleDecoding(): Promise<void> {
    if (!this.document.getText().includes('\uFFFD') || CsvEditorController.encodingWarnings.has(this.document)) {
      return;
    }
    CsvEditorController.encodingWarnings.add(this.document);
    const action = 'Change File Encoding';
    const selected = await vscode.window.showWarningMessage(
      'CSV: This file contains replacement characters (�), which can indicate a decoding mismatch. Check the source encoding before saving.',
      action
    );
    if (selected === action && !this.disposed) {
      // Bind the action to this document even if another tab becomes active.
      await vscode.commands.executeCommand('csv.changeEncoding', this.document.uri);
    }
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

  private refreshDiffContext(webviewPanel: vscode.WebviewPanel): boolean {
    const next = this.isLikelyDiffContext(webviewPanel, this.document.uri);
    const changed = next !== this.isDiffContext;
    this.isDiffContext = next;
    return changed;
  }

  private isLikelyDiffContext(webviewPanel: vscode.WebviewPanel, uri: vscode.Uri): boolean {
    if (uri.scheme === 'git') {
      return true;
    }

    const title = webviewPanel.title || '';
    if (title.includes('↔')) {
      return true;
    }

    const key = uri.toString();
    const tabGroups = (vscode.window as any)?.tabGroups?.all;
    if (!Array.isArray(tabGroups)) {
      return false;
    }
    for (const group of tabGroups) {
      const activeTab: any = group?.activeTab;
      const input: any = activeTab?.input;
      const original: unknown = input?.original;
      const modified: unknown = input?.modified;
      if (original instanceof vscode.Uri && modified instanceof vscode.Uri) {
        if (original.toString() === key || modified.toString() === key) {
          return true;
        }
      }
    }
    return false;
  }

  private static resolveEffectiveColumnColorMode(
    baseMode: string,
    isDiffContext: boolean,
    useThemeForegroundInDiff: boolean
  ): 'type' | 'theme' {
    const normalizedBase: 'type' | 'theme' = baseMode === 'theme' ? 'theme' : 'type';
    if (isDiffContext && useThemeForegroundInDiff) {
      return 'theme';
    }
    return normalizedBase;
  }

  private static normalizeFontSize(value: unknown): number | undefined {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return undefined;
    }
    return Math.round(parsed * 100) / 100;
  }

  private static resolveEffectiveFontSize(csvFontSize: unknown, editorFontSize: unknown): number {
    return (
      CsvEditorController.normalizeFontSize(csvFontSize) ??
      CsvEditorController.normalizeFontSize(editorFontSize) ??
      14
    );
  }

  private async setColumnFilters(filters: ColumnFilter[]): Promise<void> {
    await CsvEditorProvider.setColumnFiltersForUri(this.context, this.document.uri, filters);
    this.refreshViewSafely();
  }

  private async configureColumnFilter(rawColumn: unknown): Promise<void> {
    const column = Number(rawColumn);
    const data = this.trimTrailingEmptyRows(Papa.parse<string[]>(this.document.getText(), { delimiter: this.getSeparator() }).data);
    const columnCount = data.reduce((max, row) => Math.max(max, row.length), 0);
    if (!Number.isInteger(column) || column < 0 || column >= columnCount) {
      return;
    }
    const filters = CsvEditorProvider.getColumnFiltersForUri(this.context, this.document.uri);
    const existing = filters.find(filter => filter.column === column);
    if (!existing && filters.length >= MAX_COLUMN_FILTERS) {
      void vscode.window.showInformationMessage(`CSV: Clear a column filter before adding another (maximum ${MAX_COLUMN_FILTERS}).`);
      return;
    }
    const choices: Array<vscode.QuickPickItem & { operator: ColumnFilter['operator'] }> = [
      { label: 'Contains', operator: 'contains' }, { label: 'Equals', operator: 'equals' },
      { label: 'Is empty', operator: 'empty' }, { label: 'Is not empty', operator: 'notEmpty' }
    ];
    const choice = await vscode.window.showQuickPick(choices, { placeHolder: `Filter column ${column + 1} (text matching ignores case)` });
    if (!choice) {
      return;
    }
    let value = '';
    if (choice.operator === 'contains' || choice.operator === 'equals') {
      const input = await vscode.window.showInputBox({
        prompt: `Column ${column + 1}: ${choice.label.toLowerCase()} (case-insensitive)`,
        value: existing?.value ?? '',
        validateInput: text => text.length > MAX_FILTER_VALUE_LENGTH ? `Use at most ${MAX_FILTER_VALUE_LENGTH} characters.` : undefined
      });
      if (input === undefined || input.length > MAX_FILTER_VALUE_LENGTH) {
        return;
      }
      value = input;
    }
    await this.setColumnFilters([...filters.filter(filter => filter.column !== column), { column, operator: choice.operator, value }]);
  }

  private async remapFilters(columnOrder: number[]): Promise<void> {
    await CsvEditorProvider.setColumnFiltersForUri(this.context, this.document.uri,
      remapColumnFilters(CsvEditorProvider.getColumnFiltersForUri(this.context, this.document.uri), columnOrder));
  }

  public refreshViewSafely(): void {
    if (this.currentWebviewPanel?.visible) {
      this.currentWebviewPanel.webview.postMessage({ type: 'prepareViewRefresh' });
    } else {
      this.refresh();
    }
  }

  public getCurrentFrozenPanes(): FrozenPanes {
    return CsvEditorProvider.getFrozenPanesForUri(this.context, this.document.uri, this.currentHeader);
  }

  public async setFrozenPanes(change: Partial<FrozenPanes>): Promise<void> {
    await CsvEditorProvider.setFrozenPanesForUri(this.context, this.document.uri, change);
    this.currentWebviewPanel?.webview.postMessage({ type: 'frozenPanes', ...this.getCurrentFrozenPanes() });
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
    let filterMembershipChanged = false;
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

      const filters = CsvEditorProvider.getColumnFiltersForUri(this.context, this.document.uri);
      const previouslyMatched = rowMatchesFilters(data[row] ?? [], filters);
      const { data: nextData, trimmed, createdRow, createdCol } = this.mutateDataForEdit(data, row, col, value);
      filterMembershipChanged = filters.length > 0 && previouslyMatched !== rowMatchesFilters(nextData[row] ?? [], filters);
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
      } else {
        newCsvText = CsvEditorProvider.applyStructuralUpdatesPreservingFormat(oldText, separator, nextData);
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
      applied = await vscode.workspace.applyEdit(edit);
    } finally {
      this.isUpdatingDocument = false;
    }

    if (!applied) {
      return;
    }

    console.log(`CSV: Updated row ${row + 1}, column ${col + 1}`);
    const config = vscode.workspace.getConfiguration('csv', this.document.uri);
    const clickableLinks = config.get<boolean>('clickableLinks', true);
    const rendered = this.formatCellContent(value ?? '', clickableLinks);
    this.currentWebviewPanel?.webview.postMessage({ type: 'updateCell', row, col, value, rendered });

    // Trigger a full re-render if structure may have changed (new row/col created)
    if (filterMembershipChanged) {
      this.refreshViewSafely();
    } else if (structuralChange) {
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

  private async copyCells(rawMatrix: unknown, rawRowIds: unknown, rawStartCol: unknown, cut: boolean): Promise<void> {
    if (!Array.isArray(rawMatrix) || rawMatrix.length === 0 || !rawMatrix.every(row =>
      Array.isArray(row) && row.length > 0 && row.every(value => typeof value === 'string')
    )) {
      return;
    }
    const matrix = rawMatrix as string[][];
    const rowIds = Array.isArray(rawRowIds) ? rawRowIds : [];
    const startCol = Number(rawStartCol);
    if (rowIds.length !== matrix.length || new Set(rowIds).size !== rowIds.length || !rowIds.every(row => Number.isInteger(row) && row >= 0) || !Number.isInteger(startCol) || startCol < 0) {
      return;
    }
    const documentVersion = this.document.version;
    try {
      await vscode.env.clipboard.writeText(serializeClipboardMatrix(matrix, this.getSeparator()));
    } catch {
      void vscode.window.showErrorMessage('CSV: Unable to write to the clipboard. The selected cells were kept.');
      return;
    }
    if (cut && this.document.version === documentVersion) {
      await this.replaceCells(matrix.flatMap((row, rowOffset) => row.map((_value, colOffset) => ({
        row: rowIds[rowOffset],
        col: startCol + colOffset,
        value: ''
      }))));
    }
  }

  private static parsePasteSelectionBounds(raw: unknown): PasteSelectionBounds | undefined {
    if (!raw || typeof raw !== 'object') {
      return undefined;
    }
    const minRow = Number((raw as any).minRow);
    const maxRow = Number((raw as any).maxRow);
    const minCol = Number((raw as any).minCol);
    const maxCol = Number((raw as any).maxCol);
    if (
      !Number.isInteger(minRow) || minRow < 0 ||
      !Number.isInteger(maxRow) || maxRow < minRow ||
      !Number.isInteger(minCol) || minCol < 0 ||
      !Number.isInteger(maxCol) || maxCol < minCol
    ) {
      return undefined;
    }
    return {
      minRow,
      maxRow,
      minCol,
      maxCol,
      rectangular: !!(raw as any).rectangular
    };
  }

  private static computePastePlan(
    matrix: string[][],
    anchorRow: number,
    anchorCol: number,
    selection: PasteSelectionBounds | undefined
  ): PastePlan | undefined {
    const height = matrix.length;
    const width = height > 0 ? Math.max(0, matrix[0].length) : 0;
    if (height <= 0 || width <= 0) {
      return undefined;
    }
    const canFillSelection = !!selection
      && selection.rectangular
      && (selection.maxRow > selection.minRow || selection.maxCol > selection.minCol)
      && height === 1
      && width === 1;
    if (canFillSelection) {
      return {
        startRow: selection.minRow,
        startCol: selection.minCol,
        endRow: selection.maxRow,
        endCol: selection.maxCol,
        fillSelection: true
      };
    }
    return {
      startRow: anchorRow,
      startCol: anchorCol,
      endRow: anchorRow + height - 1,
      endCol: anchorCol + width - 1,
      fillSelection: false
    };
  }

  private static applyPasteMatrixToData(
    data: string[][],
    matrix: string[][],
    anchorRow: number,
    anchorCol: number,
    selection: PasteSelectionBounds | undefined,
    targetRows?: number[]
  ): PasteApplyResult {
    const plan = CsvEditorController.computePastePlan(matrix, anchorRow, anchorCol, selection);
    if (!plan) {
      return {
        changed: false,
        structuralChange: false,
        updates: [],
        plan: {
          startRow: anchorRow,
          startCol: anchorCol,
          endRow: anchorRow,
          endCol: anchorCol,
          fillSelection: false
        }
      };
    }

    const rowsToWrite = targetRows ?? Array.from({ length: plan.endRow - plan.startRow + 1 }, (_, index) => plan.startRow + index);
    if (rowsToWrite.length) {
      plan.startRow = rowsToWrite[0];
      plan.endRow = rowsToWrite[rowsToWrite.length - 1];
    }
    const updates: Array<{ row: number; col: number; value: string }> = [];
    let changed = false;
    let structuralChange = false;

    const setCellValue = (row: number, col: number, nextValue: string) => {
      const hasRow = row >= 0 && row < data.length;
      const hasCol = hasRow && col >= 0 && col < data[row].length;
      const prevValue = hasCol ? String(data[row][col] ?? '') : '';
      if (prevValue === nextValue) {
        return;
      }
      if (!hasRow || !hasCol) {
        structuralChange = true;
      }
      while (data.length <= row) {
        data.push([]);
      }
      while (data[row].length <= col) {
        data[row].push('');
      }
      data[row][col] = nextValue;
      updates.push({ row, col, value: nextValue });
      changed = true;
    };

    if (plan.fillSelection) {
      const value = String(matrix[0][0] ?? '');
      for (const row of rowsToWrite) {
        for (let col = plan.startCol; col <= plan.endCol; col++) {
          setCellValue(row, col, value);
        }
      }
    } else {
      for (let r = 0; r < matrix.length; r++) {
        for (let c = 0; c < matrix[r].length; c++) {
          setCellValue(rowsToWrite[r], plan.startCol + c, String(matrix[r][c] ?? ''));
        }
      }
    }

    return { changed, structuralChange, updates, plan };
  }

  private async pasteCells(
    rawText: unknown,
    rawAnchorRow: unknown,
    rawAnchorCol: unknown,
    rawSelection: unknown
  ): Promise<void> {
    const text = typeof rawText === 'string' ? rawText : '';
    if (!text) {
      return;
    }
    const anchorRow = Number(rawAnchorRow);
    const anchorCol = Number(rawAnchorCol);
    if (!Number.isInteger(anchorRow) || anchorRow < 0 || !Number.isInteger(anchorCol) || anchorCol < 0) {
      return;
    }
    const matrix = parseClipboardMatrix(text, this.getSeparator());
    if (!matrix.length || !matrix[0].length) {
      return;
    }
    const selection = CsvEditorController.parsePasteSelectionBounds(rawSelection);

    this.isUpdatingDocument = true;
    try {
      const separator = this.getSeparator();
      const oldText = this.document.getText();
      const result = Papa.parse(oldText, { dynamicTyping: false, delimiter: separator });
      const data = this.trimTrailingEmptyRows(result.data as string[][]);

      const realData = this.trimTrailingEmptyRows(data);
      const filters = normalizeColumnFilters(CsvEditorProvider.getColumnFiltersForUri(this.context, this.document.uri), data.reduce((max, row) => Math.max(max, row.length), 0));
      const visibleRows = [...visibleSourceRows(realData, this.getHiddenRows(), this.getEffectiveHeader(realData, this.getHiddenRows()), filters), realData.length];
      const anchorIndex = visibleRows.indexOf(anchorRow);
      if (anchorIndex < 0) {
        void vscode.window.showInformationMessage('CSV: Select a visible cell and paste again.');
        return;
      }
      const plan = CsvEditorController.computePastePlan(matrix, anchorRow, anchorCol, selection);
      const targetRows = plan?.fillSelection
        ? visibleRows.filter(row => row >= plan.startRow && row <= plan.endRow)
        : matrix.map((_row, index) => visibleRows[anchorIndex + index] ?? realData.length + anchorIndex + index - visibleRows.length + 1);
      const pasteResult = CsvEditorController.applyPasteMatrixToData(data, matrix, anchorRow, anchorCol, selection, targetRows);
      if (!pasteResult.changed) {
        return;
      }

      let newCsvText: string | undefined;
      if (!pasteResult.structuralChange) {
        newCsvText = CsvEditorProvider.applyFieldUpdatesPreservingFormat(oldText, separator, pasteResult.updates);
      } else {
        newCsvText = CsvEditorProvider.applyStructuralUpdatesPreservingFormat(oldText, separator, this.trimTrailingEmptyRows(data));
      }
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
      this.currentWebviewPanel?.webview.postMessage({
        type: 'pasteApplied',
        startRow: pasteResult.plan.startRow,
        startCol: pasteResult.plan.startCol,
        endRow: pasteResult.plan.endRow,
        endCol: pasteResult.plan.endCol
      });
    } finally {
      this.isUpdatingDocument = false;
    }
  }

  private renderChunkFromState(state: ChunkRenderState, start: number): ChunkResponse {
    if (!Number.isInteger(start) || start < 0) {
      return { html: '', nextStart: -1, done: true };
    }

    if (start < state.allRowsCount) {
      const end = Math.min(start + state.chunkRows, state.allRowsCount);
      const html = state.allRows.slice(start, end).map((row, localR) => {
        const absRow = state.rowIds[start + localR];
        const displayIdx = absRow - state.bodyStart + 1;
        let cells = '';
        for (let cIdx = 0; cIdx < state.numColumns; cIdx++) {
          const rawValue = row[cIdx] || '';
          const safe = this.formatCellContent(rawValue, state.clickableLinks);
          const titleAttr = this.getMultilineCellTitleAttr(rawValue);
          cells += `<td tabindex="0" style="min-width:${Math.min(state.columnWidths[cIdx] || 0, 100)}ch;max-width:100ch;border:1px solid ${state.isDark ? '#555' : '#ccc'};color:${state.columnColors[cIdx]};overflow:visible;white-space: pre-wrap;overflow-wrap:anywhere;"${titleAttr} data-row="${absRow}" data-col="${cIdx}">${safe}</td>`;
        }
        const idxCell = state.addSerialIndex
          ? `<td tabindex="0" style="min-width:${state.serialIndexWidthCh}ch;max-width:${state.serialIndexWidthCh}ch;border:1px solid ${state.isDark ? '#555' : '#ccc'};color:#888;" data-row="${absRow}" data-col="-1">${displayIdx}</td>`
          : '';
        return `<tr>${idxCell}${cells}</tr>`;
      }).join('');

      if (end < state.allRowsCount) {
        return { html, nextStart: end, done: false };
      }
      if (state.includeTrailingEmptyRow) {
        return { html, nextStart: state.allRowsCount, done: false };
      }
      return { html, nextStart: -1, done: true };
    }

    if (start === state.allRowsCount && state.includeTrailingEmptyRow) {
      const virtualAbs = state.virtualRow;
      const displayIdx = virtualAbs - state.bodyStart + 1;
      const idxCell = state.addSerialIndex
        ? `<td tabindex="0" style="min-width:${state.serialIndexWidthCh}ch;max-width:${state.serialIndexWidthCh}ch;border:1px solid ${state.isDark ? '#555' : '#ccc'};color:#888;" data-row="${virtualAbs}" data-col="-1">${displayIdx}</td>`
        : '';
      const dataCells = Array.from({ length: state.numColumns }, (_, i) => `<td tabindex="0" style="min-width:${Math.min(state.columnWidths[i] || 0, 100)}ch;max-width:100ch;border:1px solid ${state.isDark ? '#555' : '#ccc'};color:${state.columnColors[i]};overflow:visible;white-space: pre-wrap;overflow-wrap:anywhere;" data-row="${virtualAbs}" data-col="${i}"></td>`).join('');
      return { html: `<tr>${idxCell}${dataCells}</tr>`, nextStart: -1, done: true };
    }

    return { html: '', nextStart: -1, done: true };
  }

  private async requestChunk(rawStart: unknown, requestId: unknown): Promise<void> {
    if (!this.currentWebviewPanel || !this.chunkRenderState) {
      return;
    }
    const start = Number(rawStart);
    if (!Number.isInteger(start) || start < 0) {
      this.currentWebviewPanel.webview.postMessage({
        type: 'chunkData',
        requestId,
        start: -1,
        html: '',
        nextStart: -1,
        done: true
      });
      return;
    }
    const response = this.renderChunkFromState(this.chunkRenderState, start);
    this.currentWebviewPanel.webview.postMessage({
      type: 'chunkData',
      requestId,
      start,
      html: response.html,
      nextStart: response.nextStart,
      done: response.done
    });
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

    const filters = normalizeColumnFilters(CsvEditorProvider.getColumnFiltersForUri(this.context, this.document.uri), data.reduce((max, row) => Math.max(max, row.length), 0));
    for (const row of visibleSourceRows(data, offset, this.getEffectiveHeader(data, hiddenRows), filters)) {
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
    const data = this.trimTrailingEmptyRows(result.data as string[][]);
    const order = Array.from({ length: data.reduce((max, row) => Math.max(max, row.length), 0) }, (_, column) => column);
    for (const row of data) {
      if (index > row.length) {
        while (row.length < index) row.push('');
      }
      row.splice(index, 0, '');
    }
    order.splice(index, 0, -1);
    const newText = CsvEditorProvider.applyStructuralUpdatesPreservingFormat(text, separator, data, undefined, order)
      ?? Papa.unparse(data, { delimiter: separator });
    const fullRange = new vscode.Range(
      0, 0,
      this.document.lineCount,
      this.document.lineCount ? this.document.lineAt(this.document.lineCount - 1).text.length : 0
    );
    const edit = new vscode.WorkspaceEdit();
    edit.replace(this.document.uri, fullRange, newText);
    await vscode.workspace.applyEdit(edit);
    this.isUpdatingDocument = false;
    await this.remapFilters(order);
    this.updateWebviewContent();
  }

  private async insertColumns(index: number, count: number) {
    if (count <= 0) return;
    this.isUpdatingDocument = true;
    const separator = this.getSeparator();
    const text = this.document.getText();
    const result = Papa.parse(text, { dynamicTyping: false, delimiter: separator });
    const data = this.trimTrailingEmptyRows(result.data as string[][]);
    const order = Array.from({ length: data.reduce((max, row) => Math.max(max, row.length), 0) }, (_, column) => column);
    for (let k = 0; k < count; k++) {
      for (const row of data) {
        if (index > row.length) {
          while (row.length < index) row.push('');
        }
        row.splice(index, 0, '');
      }
    }
    order.splice(index, 0, ...Array(count).fill(-1));
    const newText = CsvEditorProvider.applyStructuralUpdatesPreservingFormat(text, separator, data, undefined, order)
      ?? Papa.unparse(data, { delimiter: separator });
    const fullRange = new vscode.Range(
      0, 0,
      this.document.lineCount,
      this.document.lineCount ? this.document.lineAt(this.document.lineCount - 1).text.length : 0
    );
    const edit = new vscode.WorkspaceEdit();
    edit.replace(this.document.uri, fullRange, newText);
    await vscode.workspace.applyEdit(edit);
    this.isUpdatingDocument = false;
    await this.remapFilters(order);
    this.updateWebviewContent();
  }

  private async deleteColumn(index: number) {
    this.isUpdatingDocument = true;
    const separator = this.getSeparator();
    const text = this.document.getText();
    const result = Papa.parse(text, { dynamicTyping: false, delimiter: separator });
    const data = this.trimTrailingEmptyRows(result.data as string[][]);
    const order = Array.from({ length: data.reduce((max, row) => Math.max(max, row.length), 0) }, (_, column) => column);
    for (const row of data) {
      if (index < row.length) {
        row.splice(index, 1);
      }
    }
    order.splice(index, 1);
    const newText = CsvEditorProvider.applyStructuralUpdatesPreservingFormat(text, separator, data, undefined, order)
      ?? Papa.unparse(data, { delimiter: separator });
    const fullRange = new vscode.Range(
      0, 0,
      this.document.lineCount,
      this.document.lineCount ? this.document.lineAt(this.document.lineCount - 1).text.length : 0
    );
    const edit = new vscode.WorkspaceEdit();
    edit.replace(this.document.uri, fullRange, newText);
    await vscode.workspace.applyEdit(edit);
    this.isUpdatingDocument = false;
    await this.remapFilters(order);
    this.updateWebviewContent();
  }

  private async deleteColumns(indices: number[]) {
    if (!indices || !indices.length) return;
    this.isUpdatingDocument = true;
    const separator = this.getSeparator();
    const text = this.document.getText();
    const result = Papa.parse(text, { dynamicTyping: false, delimiter: separator });
    const data = this.trimTrailingEmptyRows(result.data as string[][]);
    const order = Array.from({ length: data.reduce((max, row) => Math.max(max, row.length), 0) }, (_, column) => column);
    const sorted = [...indices].sort((a,b)=>b-a);
    for (const idx of sorted) {
      for (const row of data) {
        if (idx < row.length) {
          row.splice(idx, 1);
        }
      }
    }
    for (const column of sorted) { order.splice(column, 1); }
    const newText = CsvEditorProvider.applyStructuralUpdatesPreservingFormat(text, separator, data, undefined, order)
      ?? Papa.unparse(data, { delimiter: separator });
    const fullRange = new vscode.Range(
      0, 0,
      this.document.lineCount,
      this.document.lineCount ? this.document.lineAt(this.document.lineCount - 1).text.length : 0
    );
    const edit = new vscode.WorkspaceEdit();
    edit.replace(this.document.uri, fullRange, newText);
    await vscode.workspace.applyEdit(edit);
    this.isUpdatingDocument = false;
    await this.remapFilters(order);
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

    const filters = normalizeColumnFilters(CsvEditorProvider.getColumnFiltersForUri(this.context, this.document.uri), rows.reduce((max, row) => Math.max(max, row.length), 0));
    const matchingSlots = body.map((_row, slot) => slot).filter(slot => rowMatchesFilters(body[slot], filters));
    const sortedMatches = matchingSlots.map(slot => body[slot]).sort((r1, r2) => {
      const diff = cmp(r1[index] ?? '', r2[index] ?? '');
      return ascending ? diff : -diff;
    });
    matchingSlots.forEach((slot, order) => { body[slot] = sortedMatches[order]; });

    const prefix = rows.slice(0, offset);
    const combined = treatHeader ? [...prefix, header, ...body] : [...prefix, ...body];

    const originalIndex = new Map(rows.map((row, position) => [row, position]));
    const rowOrder = combined.map(row => originalIndex.get(row)!);
    const newCsv = CsvEditorProvider.applyStructuralUpdatesPreservingFormat(text, separator, combined, rowOrder)
      ?? Papa.unparse(combined, { delimiter: separator });

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
    const data = this.trimTrailingEmptyRows(result.data as string[][]);
    const order = data.map((_row, position) => position);
    const numColumns = data.reduce((max, r) => Math.max(max, r.length), 0);
    const newRow = Array(numColumns).fill('');
    if (index > data.length) {
      while (data.length < index) data.push(Array(numColumns).fill(''));
    }
    data.splice(index, 0, newRow);
    order.splice(index, 0, -1);
    const newText = CsvEditorProvider.applyStructuralUpdatesPreservingFormat(text, separator, data, order)
      ?? Papa.unparse(data, { delimiter: separator });
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
    const data = this.trimTrailingEmptyRows(result.data as string[][]);
    const order = data.map((_row, position) => position);
    const numColumns = data.reduce((max, r) => Math.max(max, r.length), 0);
    for (let k = 0; k < count; k++) {
      const newRow = Array(numColumns).fill('');
      if (index > data.length) {
        while (data.length < index) data.push(Array(numColumns).fill(''));
      }
      data.splice(index, 0, newRow);
    }
    order.splice(index, 0, ...Array(count).fill(-1));
    const newText = CsvEditorProvider.applyStructuralUpdatesPreservingFormat(text, separator, data, order)
      ?? Papa.unparse(data, { delimiter: separator });
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
    const data = this.trimTrailingEmptyRows(result.data as string[][]);
    const order = data.map((_row, position) => position);
    if (index < data.length) {
      data.splice(index, 1);
    }
    order.splice(index, 1);
    const newText = CsvEditorProvider.applyStructuralUpdatesPreservingFormat(text, separator, data, order)
      ?? Papa.unparse(data, { delimiter: separator });
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
    const data = this.trimTrailingEmptyRows(result.data as string[][]);
    const order = data.map((_row, position) => position);
    const sorted = [...indices].sort((a,b)=>b-a);
    for (const idx of sorted) {
      if (idx < data.length) {
        data.splice(idx, 1);
      }
    }
    for (const row of sorted) { order.splice(row, 1); }
    const newText = CsvEditorProvider.applyStructuralUpdatesPreservingFormat(text, separator, data, order)
      ?? Papa.unparse(data, { delimiter: separator });
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
      const data = this.trimTrailingEmptyRows(result.data as string[][]);
      const numColumns = data.reduce((max, row) => Math.max(max, row.length), 0);
      if (numColumns <= 0) return;

      const sourceOrder = Array.from({ length: numColumns }, (_, i) => i);
      const { reordered: columnOrder, changed } = this.reorderByIndices(sourceOrder, indices, beforeIndex);
      if (!changed) return;

      const reorderedData = data.map(row => {
        const normalized = Array.from({ length: numColumns }, (_, i) => row[i] ?? '');
        const next = columnOrder.map(colIdx => normalized[colIdx] ?? '');
        // Keep explicit empty fields; omit only positions absent from the source row.
        const lastPresent = columnOrder.reduce((last, colIdx, index) => colIdx < row.length ? index : last, -1);
        return next.slice(0, lastPresent + 1);
      });

      const newText = CsvEditorProvider.applyStructuralUpdatesPreservingFormat(text, separator, reorderedData, undefined, columnOrder)
        ?? Papa.unparse(reorderedData, { delimiter: separator });
      const fullRange = new vscode.Range(
        0, 0,
        this.document.lineCount,
        this.document.lineCount ? this.document.lineAt(this.document.lineCount - 1).text.length : 0
      );
      const edit = new vscode.WorkspaceEdit();
      edit.replace(this.document.uri, fullRange, newText);
      await vscode.workspace.applyEdit(edit);
      await this.remapFilters(columnOrder);
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
      const data = this.trimTrailingEmptyRows(result.data as string[][]);
      if (!data.length) return;

      const { reordered: rowOrder, changed } = this.reorderByIndices(data.map((_, index) => index), indices, beforeIndex);
      if (!changed) return;

      const reordered = rowOrder.map(index => data[index]);
      const newText = CsvEditorProvider.applyStructuralUpdatesPreservingFormat(text, separator, reordered, rowOrder)
        ?? Papa.unparse(reordered, { delimiter: separator });
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
    const fontSize = CsvEditorController.resolveEffectiveFontSize(
      config.get<number>('fontSize', 0),
      vscode.workspace.getConfiguration('editor').get<number>('fontSize', 14)
    );

    const cellPadding = config.get<number>('cellPadding', 4);
    const data = this.trimTrailingEmptyRows((parsed.data || []) as string[][]);
    const filters = normalizeColumnFilters(CsvEditorProvider.getColumnFiltersForUri(this.context, this.document.uri), data.reduce((max, row) => Math.max(max, row.length), 0));
    const treatHeader = this.getEffectiveHeader(data, hiddenRows);
    this.currentHeader = treatHeader;
    const clickableLinks = config.get<boolean>('clickableLinks', true);
    const configuredColumnColorMode = config.get<string>('columnColorMode', 'type');
    const diffUseThemeForeground = config.get<boolean>('diffUseThemeForeground', true);
    const columnColorMode = CsvEditorController.resolveEffectiveColumnColorMode(
      configuredColumnColorMode,
      this.isDiffContext,
      diffUseThemeForeground
    );
    const columnColorPalette = config.get<string>('columnColorPalette', 'default');
    const showTrailingEmptyRow = config.get<boolean>('showTrailingEmptyRow', true);
    const mouseWheelZoomEnabled = config.get<boolean>('mouseWheelZoom', true);
    const mouseWheelZoomInvert = config.get<boolean>('mouseWheelZoomInvert', false);

    const { tableHtml, chunksJson, colorCss, nextChunkStart, hasRemoteChunks, chunkState } =
      this.generateTableAndChunks(
        data,
        treatHeader,
        addSerialIndex,
        hiddenRows,
        clickableLinks,
        columnColorMode,
        columnColorPalette,
        showTrailingEmptyRow,
        /* maxSerializedChunks */ 0,
      filters
      );
    this.chunkRenderState = chunkState;

    const nonce = this.getNonce();

    this.currentWebviewPanel.webview.html = this.wrapHtml({
      webview,
      nonce,
      fontFamily,
      fontSize,
      cellPadding,
      separator,
      tableHtml,
      chunksJson,
      extraColumnColorCss: colorCss,
      nextChunkStart,
      hasRemoteChunks,
      mouseWheelZoomEnabled,
      mouseWheelZoomInvert,
      columnSizes: CsvEditorProvider.getColumnSizesForUri(this.context, this.document.uri),
      frozenPanes: this.getCurrentFrozenPanes(),
      firstVisibleRow: hiddenRows,
      realRowCount: data.length,
      visibleRowIds: filters.length ? [...visibleSourceRows(data, hiddenRows, treatHeader, filters), data.length] : [],
      filters,
      matchedRows: visibleSourceRows(data, hiddenRows, false, filters).filter(row => !(treatHeader && row === hiddenRows)).length,
      totalFilterRows: Math.max(0, data.length - hiddenRows - (treatHeader ? 1 : 0)),
      filterHeader: treatHeader ? data[hiddenRows] : undefined
    });
  }

  private generateTableAndChunks(
    data: string[][],
    treatHeader: boolean,
    addSerialIndex: boolean,
    hiddenRows: number,
    clickableLinks: boolean,
    columnColorMode: string,
    columnColorPalette: string,
    showTrailingEmptyRow: boolean,
    maxSerializedChunks: number = Number.MAX_SAFE_INTEGER,
    filters: ColumnFilter[] = []
  ): {
    tableHtml: string;
    chunksJson: string;
    colorCss: string;
    nextChunkStart: number;
    hasRemoteChunks: boolean;
    chunkState: ChunkRenderState | undefined;
  } {
    let headerFlag = treatHeader;
    const totalRows = data.length;
    const offset = Math.min(Math.max(0, hiddenRows), totalRows);

    const themeKind = vscode.window.activeColorTheme.kind;
    const isDark = themeKind === vscode.ColorThemeKind.Dark || themeKind === vscode.ColorThemeKind.HighContrast;
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
    const bodyStart = headerFlag ? offset + 1 : offset;
    const rowIds = bodyData.map((_row, index) => bodyStart + index).filter(row => rowMatchesFilters(data[row], filters));
    bodyData = rowIds.map(row => data[row]);
    const visibleForWidth = headerFlag ? [headerRow, ...bodyData] : bodyData;
    let numColumns = data.reduce((max, row) => Math.max(max, row.length), 0);
    if (numColumns === 0) numColumns = 1; // ensure at least 1 column for the virtual row

    const columnData = Array.from({ length: numColumns }, (_, i) => bodyData.map(row => row[i] || ''));
    const columnTypes = columnData.map(col => this.estimateColumnDataType(col));
    const highContrast = themeKind === vscode.ColorThemeKind.HighContrast || themeKind === vscode.ColorThemeKind.HighContrastLight;
    const useThemeForeground = columnColorMode === 'theme' || highContrast;
    const palette = columnColorPalette === 'cool'
      ? 'cool'
      : (columnColorPalette === 'warm' ? 'warm' : 'default');
    const columnColors = useThemeForeground
      ? Array.from({ length: numColumns }, () => 'var(--vscode-editor-foreground)')
      : columnTypes.map((type, i) => this.getColumnColor(type, isDark, i, palette));
    const columnWidths = this.computeColumnWidths(visibleForWidth);

    const BASE_CHUNK_ROWS = 1000;
    const MAX_CELLS_PER_CHUNK = 20000;
    const MIN_CHUNK_ROWS = 10;
    const allRows = bodyData;
    const allRowsCount = allRows.length; // preserve total before any truncation
    const chunkRows = Math.max(
      MIN_CHUNK_ROWS,
      Math.min(BASE_CHUNK_ROWS, Math.floor(MAX_CELLS_PER_CHUNK / Math.max(1, numColumns)))
    );
    // Always keep one editable row for fully empty views; otherwise allow disabling the
    // trailing virtual row via settings.
    const includeTrailingEmptyRow = showTrailingEmptyRow || allRowsCount === 0;
    const serialIndexMaxDisplay = data.length - bodyStart + (includeTrailingEmptyRow ? 1 : 0);
    const serialIndexWidthCh = Math.max(4, String(Math.max(1, serialIndexMaxDisplay)).length + 1);
    const chunks: string[] = [];
    const chunked = allRowsCount > chunkRows;
    let nextChunkStart = -1;
    const safeMaxSerializedChunks = Number.isFinite(maxSerializedChunks)
      ? Math.max(0, Math.trunc(maxSerializedChunks))
      : 0;
    let serializedChunkCount = 0;

    if (chunked) {
      for (let i = chunkRows; i < allRowsCount; i += chunkRows) {
        if (serializedChunkCount >= safeMaxSerializedChunks) {
          nextChunkStart = i;
          break;
        }
        const htmlChunk = allRows.slice(i, i + chunkRows).map((row, localR) => {
          const absRow = rowIds[i + localR];
          const displayIdx = absRow - bodyStart + 1; // retain source numbering across filtered gaps
          let cells = '';
          for (let cIdx = 0; cIdx < numColumns; cIdx++) {
            const rawValue = row[cIdx] || '';
            const safe = this.formatCellContent(rawValue, clickableLinks);
            const titleAttr = this.getMultilineCellTitleAttr(rawValue);
            cells += `<td tabindex="0" style="min-width:${Math.min(columnWidths[cIdx]||0,100)}ch;max-width:100ch;border:1px solid ${isDark?'#555':'#ccc'};color:${columnColors[cIdx]};overflow:visible;white-space: pre-wrap;overflow-wrap:anywhere;"${titleAttr} data-row="${absRow}" data-col="${cIdx}">${safe}</td>`;
          }

          return `<tr>${
            addSerialIndex ? `<td tabindex="0" style="min-width:${serialIndexWidthCh}ch;max-width:${serialIndexWidthCh}ch;border:1px solid ${isDark?'#555':'#ccc'};color:#888;" data-row="${absRow}" data-col="-1">${displayIdx}</td>` : ''
          }${cells}</tr>`;
        }).join('');

        chunks.push(htmlChunk);
        serializedChunkCount++;
      }
    }

    // VS Code changes these classes in place. Keep both palettes available so
    // entering/leaving high contrast never needs to reload a live cell edit.
    const colorCss = columnColorMode === 'theme'
      ? ''
      : columnTypes.map((type, i) => {
        const light = this.getColumnColor(type, false, i, palette);
        const dark = this.getColumnColor(type, true, i, palette);
        return `body.vscode-light td[data-col="${i}"], body.vscode-light th[data-col="${i}"] { color: ${light} !important; }` +
          `body.vscode-dark td[data-col="${i}"], body.vscode-dark th[data-col="${i}"] { color: ${dark} !important; }`;
      }).join('');

    let tableHtml = `<table>`;
    if (headerFlag) {
      tableHtml += `<thead><tr>${
        addSerialIndex
          ? `<th tabindex="0" style="min-width: ${serialIndexWidthCh}ch; max-width: ${serialIndexWidthCh}ch; border: 1px solid ${isDark ? '#555' : '#ccc'}; background-color: ${isDark ? '#1e1e1e' : '#ffffff'}; color: #888;"></th>`
          : ''
      }`;
      for (let i = 0; i < numColumns; i++) {
        const safe = this.formatCellContent(headerRow[i] || '', clickableLinks);
        tableHtml += `<th tabindex="0" style="min-width: ${Math.min(columnWidths[i] || 0, 100)}ch; max-width: 100ch; border: 1px solid ${isDark ? '#555' : '#ccc'}; background-color: ${isDark ? '#1e1e1e' : '#ffffff'}; color: ${columnColors[i]}; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;" data-row="${offset}" data-col="${i}" data-filter-column="${filters.some(filter => filter.column === i) ? 'active' : 'none'}">${safe}</th>`;
      }
      tableHtml += `</tr></thead><tbody>`;
      const initialBodyRows = chunked ? allRows.slice(0, chunkRows) : allRows;
      initialBodyRows.forEach((row, r) => {
        tableHtml += `<tr>${
          addSerialIndex
            ? `<td tabindex="0" style="min-width: ${serialIndexWidthCh}ch; max-width: ${serialIndexWidthCh}ch; border: 1px solid ${isDark ? '#555' : '#ccc'}; color: #888;" data-row="${rowIds[r]}" data-col="-1">${rowIds[r] - bodyStart + 1}</td>`
            : ''
        }`;
        for (let i = 0; i < numColumns; i++) {
          const rawValue = row[i] || '';
          const safe = this.formatCellContent(rawValue, clickableLinks);
          const titleAttr = this.getMultilineCellTitleAttr(rawValue);
          tableHtml += `<td tabindex="0" style="min-width: ${Math.min(columnWidths[i] || 0, 100)}ch; max-width: 100ch; border: 1px solid ${isDark ? '#555' : '#ccc'}; color: ${columnColors[i]}; overflow: visible; white-space: pre-wrap; overflow-wrap: anywhere;"${titleAttr} data-row="${rowIds[r]}" data-col="${i}">${safe}</td>`;
        }
        tableHtml += `</tr>`;
      });
      if (!chunked && includeTrailingEmptyRow) {
        const virtualAbs = data.length;
        const idxCell = addSerialIndex ? `<td tabindex="0" style="min-width: ${serialIndexWidthCh}ch; max-width: ${serialIndexWidthCh}ch; border: 1px solid ${isDark ? '#555' : '#ccc'}; color: #888;" data-row="${virtualAbs}" data-col="-1">${virtualAbs - bodyStart + 1}</td>` : '';
        const dataCells = Array.from({ length: numColumns }, (_, i) => `<td tabindex="0" style="min-width: ${Math.min(columnWidths[i] || 0, 100)}ch; max-width: 100ch; border: 1px solid ${isDark ? '#555' : '#ccc'}; color: ${columnColors[i]}; overflow: visible; white-space: pre-wrap; overflow-wrap: anywhere;" data-row="${virtualAbs}" data-col="${i}"></td>`).join('');
        tableHtml += `<tr>${idxCell}${dataCells}</tr>`;
      }
      tableHtml += `</tbody>`;
    } else {
      tableHtml += `<tbody>`;
      const nonHeaderRows = chunked ? allRows.slice(0, chunkRows) : allRows;
      nonHeaderRows.forEach((row, r) => {
        tableHtml += `<tr>${
          addSerialIndex
            ? `<td tabindex="0" style="min-width: ${serialIndexWidthCh}ch; max-width: ${serialIndexWidthCh}ch; border: 1px solid ${isDark ? '#555' : '#ccc'}; color: #888;" data-row="${rowIds[r]}" data-col="-1">${rowIds[r] - bodyStart + 1}</td>`
            : ''
        }`;
        for (let i = 0; i < numColumns; i++) {
          const rawValue = row[i] || '';
          const safe = this.formatCellContent(rawValue, clickableLinks);
          const titleAttr = this.getMultilineCellTitleAttr(rawValue);
          tableHtml += `<td tabindex="0" style="min-width: ${Math.min(columnWidths[i] || 0, 100)}ch; max-width: 100ch; border: 1px solid ${isDark ? '#555' : '#ccc'}; color: ${columnColors[i]}; overflow: visible; white-space: pre-wrap; overflow-wrap: anywhere;"${titleAttr} data-row="${rowIds[r]}" data-col="${i}">${safe}</td>`;
        }
        tableHtml += `</tr>`;
      });
      if (!chunked && includeTrailingEmptyRow) {
        const virtualAbs = data.length;
        const displayIdx = virtualAbs - bodyStart + 1;
        const idxCell = addSerialIndex ? `<td tabindex="0" style="min-width: ${serialIndexWidthCh}ch; max-width: ${serialIndexWidthCh}ch; border: 1px solid ${isDark ? '#555' : '#ccc'}; color: #888;" data-row="${virtualAbs}" data-col="-1">${displayIdx}</td>` : '';
        const dataCells = Array.from({ length: numColumns }, (_, i) => `<td tabindex="0" style="min-width: ${Math.min(columnWidths[i] || 0, 100)}ch; max-width: 100ch; border: 1px solid ${isDark ? '#555' : '#ccc'}; color: ${columnColors[i]}; overflow: visible; white-space: pre-wrap; overflow-wrap: anywhere;" data-row="${virtualAbs}" data-col="${i}"></td>`).join('');
        tableHtml += `<tr>${idxCell}${dataCells}</tr>`;
      }
      tableHtml += `</tbody>`;
    }
    tableHtml += `</table>`;
    // If chunked, append a final chunk with the virtual row so it appears at the end.
    if (chunked && includeTrailingEmptyRow) {
      if (nextChunkStart === -1 && serializedChunkCount < safeMaxSerializedChunks) {
        const virtualAbs = data.length;
        const displayIdx = virtualAbs - bodyStart + 1;
        const idxCell = addSerialIndex ? `<td tabindex="0" style="min-width: ${serialIndexWidthCh}ch; max-width: ${serialIndexWidthCh}ch; border: 1px solid ${isDark ? '#555' : '#ccc'}; color: #888;" data-row="${virtualAbs}" data-col="-1">${displayIdx}</td>` : '';
        const dataCells = Array.from({ length: numColumns }, (_, i) => `<td tabindex="0" style="min-width: ${Math.min(columnWidths[i] || 0, 100)}ch; max-width: 100ch; border: 1px solid ${isDark ? '#555' : '#ccc'}; color: ${columnColors[i]}; overflow: visible; white-space: pre-wrap; overflow-wrap: anywhere;" data-row="${virtualAbs}" data-col="${i}"></td>`).join('');
        const vrow = `<tr>${idxCell}${dataCells}</tr>`;
        chunks.push(vrow);
      } else if (nextChunkStart === -1) {
        nextChunkStart = allRowsCount;
      }
    }

    const hasRemoteChunks = nextChunkStart >= 0;
    const chunkState: ChunkRenderState | undefined = chunked
      ? {
          rowIds,
          bodyStart,
          virtualRow: data.length,
          allRows,
          allRowsCount,
          chunkRows,
          includeTrailingEmptyRow,
          addSerialIndex,
          numColumns,
          columnWidths,
          columnColors,
          clickableLinks,
          isDark,
          serialIndexWidthCh
        }
      : undefined;

    return {
      tableHtml,
      chunksJson: JSON.stringify(chunks),
      colorCss,
      nextChunkStart,
      hasRemoteChunks,
      chunkState
    };
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
    fontSize: number;
    cellPadding: number;
    separator: string;
    tableHtml: string;
    chunksJson: string;
    extraColumnColorCss: string;
    nextChunkStart: number;
    hasRemoteChunks: boolean;
    mouseWheelZoomEnabled: boolean;
    mouseWheelZoomInvert: boolean;
    columnSizes: Record<string, number>;
    frozenPanes: FrozenPanes;
    firstVisibleRow: number;
    realRowCount: number;
    visibleRowIds: number[];
    filters: ColumnFilter[];
    matchedRows: number;
    totalFilterRows: number;
    filterHeader: string[] | undefined;
  }): string {
    const { webview, nonce, fontFamily, fontSize, cellPadding, separator, tableHtml, chunksJson, extraColumnColorCss, nextChunkStart, hasRemoteChunks, mouseWheelZoomEnabled, mouseWheelZoomInvert, columnSizes, frozenPanes, firstVisibleRow, realRowCount, visibleRowIds, filters, matchedRows, totalFilterRows, filterHeader } = args;
    const themeKind = vscode.window.activeColorTheme.kind;
    const isDark = themeKind === vscode.ColorThemeKind.Dark || themeKind === vscode.ColorThemeKind.HighContrast;
    // Build script URI using file path for compatibility (older APIs may lack Uri.joinPath)
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(this.context.extensionPath, 'media', 'main.js'))
    );

    const frozenPanesScriptUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(this.context.extensionPath, 'media', 'frozen-panes.js'))
    );
    const contrastStyleUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(this.context.extensionPath, 'media', 'high-contrast.css'))
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
      body { font-family: ${this.escapeCss(fontFamily)}; font-size: ${fontSize}px; margin: 0; padding: 0; user-select: none; }
      .table-container { overflow: auto; height: 100vh; }
      table { border-collapse: collapse; width: max-content; }
      th, td { padding: ${cellPadding}px 8px; border: 1px solid ${isDark ? '#555' : '#ccc'}; font-size: inherit; }
      th { position: static; background-color: ${isDark ? '#1e1e1e' : '#ffffff'}; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
      td { overflow: visible; white-space: pre-wrap; overflow-wrap: anywhere; }
      td.selected, th.selected { background-color: ${isDark ? '#333333' : '#cce0ff'} !important; }
      td.editing, th.editing { overflow: visible !important; white-space: pre-wrap !important; overflow-wrap: anywhere !important; max-width: none !important; }
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
        font-size: inherit;
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
        font-size: inherit;
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
        font-size: 0.86em;
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
        font-size: inherit;
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
        font-size: inherit;
      }
      #findReplaceWidget .fr-overflow-item:hover { background: rgba(255,255,255,0.05); }
      #contextMenu { position: absolute; display: none; background: ${isDark ? '#2d2d2d' : '#ffffff'}; border: 1px solid ${isDark ? '#555' : '#ccc'}; z-index: 10000; font-family: ${this.escapeCss(fontFamily)}; font-size: inherit; }
      #contextMenu div { padding: 4px 12px; cursor: pointer; }
      #contextMenu div:hover { background: ${isDark ? '#3d3d3d' : '#eeeeee'}; }

      #csv-root .csv-frozen-row, #csv-root .csv-frozen-column {
        position: sticky;
        background-color: var(--vscode-editor-background, ${isDark ? '#1e1e1e' : '#ffffff'}) !important;
      }
      #csv-root .csv-frozen-row.selected, #csv-root .csv-frozen-column.selected {
        background-image: linear-gradient(var(--vscode-editor-selectionBackground, ${isDark ? '#333333' : '#cce0ff'}), var(--vscode-editor-selectionBackground, ${isDark ? '#333333' : '#cce0ff'}));
      }
      #csv-root .csv-frozen-row.highlight, #csv-root .csv-frozen-column.highlight {
        background-image: linear-gradient(var(--vscode-editor-findMatchHighlightBackground, transparent), var(--vscode-editor-findMatchHighlightBackground, transparent));
      }
      #csv-root .csv-frozen-row.active-match, #csv-root .csv-frozen-column.active-match {
        background-image: linear-gradient(var(--vscode-editor-findMatchBackground, transparent), var(--vscode-editor-findMatchBackground, transparent));
      }
      #filterStatus { position: sticky; top: 0; left: 0; z-index: 6; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; max-height: 25vh; overflow: auto; padding: 6px; background: var(--vscode-editorWidget-background, ${isDark ? '#252526' : '#ffffff'}); color: var(--vscode-editorWidget-foreground, inherit); border-bottom: 1px solid var(--vscode-editorWidget-border, ${isDark ? '#555' : '#ccc'}); }
      #filterStatus button { color: inherit; background: transparent; border: 1px solid var(--vscode-button-border, currentColor); border-radius: 3px; cursor: pointer; }
      #filterStatus [data-clear-filter] { max-width: 32ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      th[data-filter-column="active"]::after { content: " ⏷"; }
      #filterStatus button:focus-visible { outline: 2px solid var(--vscode-focusBorder); }
      /* Per-column computed colors */
      ${extraColumnColorCss}
    </style>
    <link rel="stylesheet" href="${contrastStyleUri}">
  </head>
  <body>
    <div id="csv-root" data-roworder="${this.escapeHtml(JSON.stringify(visibleRowIds))}" data-filtered="${filters.length ? '1' : '0'}" data-frozenrows="${frozenPanes.rows}" data-frozencolumns="${frozenPanes.columns}" data-firstrow="${firstVisibleRow}" data-realrowcount="${realRowCount}" data-columnsizes="${this.escapeHtml(JSON.stringify(columnSizes))}" class="table-container" data-sepcode="${sepCode}" data-fontsize="${fontSize}" data-wheelzoomenabled="${mouseWheelZoomEnabled ? '1' : '0'}" data-wheelzoominvert="${mouseWheelZoomInvert ? '1' : '0'}" data-nextchunkstart="${nextChunkStart >= 0 ? nextChunkStart : ''}" data-hasmorechunks="${hasRemoteChunks ? '1' : '0'}">
      ${filters.length ? `<div id="filterStatus" role="status" title="Sort and Replace All affect matching rows; saving keeps every source row."><span>Filtered: ${matchedRows} of ${totalFilterRows} rows</span><button type="button" id="clearAllFilters">Clear all filters</button>${filters.map(filter => `<button type="button" data-clear-filter="${filter.column}" title="Remove this column filter">${this.escapeHtml(filterHeader?.[filter.column] || `Column ${filter.column + 1}`)}: ${this.escapeHtml(filter.operator === 'empty' ? 'is empty' : filter.operator === 'notEmpty' ? 'is not empty' : `${filter.operator} “${filter.value}”`)} ×</button>`).join('')}</div>` : ''}
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
            <button id="replaceAll" class="fr-action-btn" type="button" aria-label="Replace All" title="${filters.length ? 'Replace All in matching filtered rows' : 'Replace All'}" disabled>⇅</button>
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

    <script nonce="${nonce}" src="${frozenPanesScriptUri}"></script>
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
        for (const line of (row[i] || '').split(/\r\n|[\r\n]/)) {
          widths[i] = Math.max(widths[i], line.length);
        }
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

  private getMultilineCellTitleAttr(text: string): string {
    if (!text || (text.indexOf('\n') === -1 && text.indexOf('\r') === -1)) {
      return '';
    }
    return ` title="${this.escapeHtml(text)}"`;
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
  public static readonly columnSizesKey = 'csv.columnSizesByUri';
  public static readonly frozenPanesKey = 'csv.frozenPanesByUri';
  public static readonly columnFiltersKey = 'csv.columnFiltersByUri';
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
    let fieldStart = text.startsWith('\uFEFF') ? 1 : 0;
    let i = fieldStart;
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

  public static applyStructuralUpdatesPreservingFormat(
    text: string,
    delimiter: string,
    data: string[][],
    rowOrder?: number[],
    columnOrder?: number[]
  ): string | undefined {
    const parsed = Papa.parse<string[]>(text, { delimiter, dynamicTyping: false });
    if (parsed.errors.some(error => error.type === 'Quotes')) {
      return undefined;
    }
    const original = parsed.data;
    let contentRowCount = original.length;
    while (contentRowCount > 0 && original[contentRowCount - 1].every(value => value === '')) {
      contentRowCount--;
    }
    const spans = CsvEditorProvider.parseCsvFieldSpans(text, delimiter);
    // Pasting into the displayed append row can fill an existing empty source
    // record. Consume that record rather than retaining it again as a suffix.
    for (let row = 0; row < data.length; row++) {
      const sourceRow = rowOrder?.[row] ?? row;
      const sourceEnd = spans[sourceRow]?.slice(-1)[0]?.end;
      const sourceStart = spans[sourceRow]?.[0]?.start;
      if (sourceEnd !== undefined && (sourceEnd < text.length || (sourceStart ?? sourceEnd) < sourceEnd) && data[row].some(value => value !== '')) {
        contentRowCount = Math.max(contentRowCount, sourceRow + 1);
      }
    }
    const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
    const lastSpan = contentRowCount > 0 ? spans[contentRowCount - 1]?.slice(-1)[0] : undefined;
    const suffix = text.slice(lastSpan?.end ?? bom.length);
    const rowBreak = (row: number): string | undefined => {
      const end = spans[row]?.slice(-1)[0]?.end;
      if (end === undefined) {
        return undefined;
      }
      return /^(\r\n|\n|\r)/.exec(text.slice(end))?.[0];
    };
    const defaultBreak = parsed.meta.linebreak || '\n';
    const columnPrefersQuotes = (col: number): boolean => {
      // The body supplies the convention when a header uses a different style.
      const sample = spans.slice(contentRowCount > 1 ? 1 : 0, contentRowCount)
        .map(row => row[col]).filter((span): span is CsvFieldSpan => !!span);
      return sample.length > 0 && sample.every(span => span.quoted);
    };
    const quotedColumns = new Map<number, boolean>();
    let output = bom;
    for (let row = 0; row < data.length; row++) {
      const sourceRow = rowOrder?.[row] ?? row;
      const fields: string[] = [];
      for (let col = 0; col < data[row].length; col++) {
        const sourceCol = columnOrder?.[col] ?? col;
        const span = sourceRow < contentRowCount ? spans[sourceRow]?.[sourceCol] : undefined;
        const value = data[row][col] ?? '';
        if (span && original[sourceRow]?.[sourceCol] === value) {
          fields.push(text.slice(span.start, span.end));
        } else {
          if (!quotedColumns.has(sourceCol)) {
            quotedColumns.set(sourceCol, columnPrefersQuotes(sourceCol));
          }
          fields.push(CsvEditorProvider.encodeCsvField(value, delimiter, span?.quoted ?? quotedColumns.get(sourceCol) ?? false));
        }
      }
      output += fields.join(delimiter);
      if (row < data.length - 1) {
        output += rowBreak(sourceRow) ?? defaultBreak;
      }
    }
    output += suffix;
    // Papa Parse remains authoritative: never reuse source tokens if their
    // reconstruction would change the requested values or field boundaries.
    const actual = Papa.parse<string[]>(output, { delimiter, dynamicTyping: false });
    const trimEmpty = (rows: string[][]) => {
      const result = [...rows];
      while (result.length > 0 && result[result.length - 1].every(value => value === '')) {
        result.pop();
      }
      return result;
    };
    if (actual.errors.some(error => error.type === 'Quotes') || JSON.stringify(trimEmpty(actual.data)) !== JSON.stringify(trimEmpty(data))) {
      return undefined;
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

  public static hasHiddenRowsOverride(context: vscode.ExtensionContext, uri: vscode.Uri): boolean {
    const map = context.workspaceState.get<Record<string, number>>(CsvEditorProvider.hiddenRowsKey, {});
    const saved = map[uri.toString()];
    return Object.prototype.hasOwnProperty.call(map, uri.toString()) && typeof saved === 'number' && Number.isFinite(saved);
  }

  public static getHiddenRowsForUri(context: vscode.ExtensionContext, uri: vscode.Uri): number {
    const map = context.workspaceState.get<Record<string, number>>(CsvEditorProvider.hiddenRowsKey, {});
    const saved = map[uri.toString()];
    if (Object.prototype.hasOwnProperty.call(map, uri.toString()) && typeof saved === 'number' && Number.isFinite(saved)) {
      return Math.max(0, Math.floor(saved));
    }
    const configured = vscode.workspace.getConfiguration('csv', uri).get<number>('defaultIgnoreRows', 0);
    return typeof configured === 'number' && Number.isFinite(configured) ? Math.max(0, Math.floor(configured)) : 0;
  }

  public static async setHiddenRowsForUri(context: vscode.ExtensionContext, uri: vscode.Uri, n: number | undefined): Promise<void> {
    const map = { ...context.workspaceState.get<Record<string, number>>(CsvEditorProvider.hiddenRowsKey, {}) };
    if (n === undefined || !Number.isFinite(n)) {
      delete map[uri.toString()];
    } else {
      map[uri.toString()] = Math.max(0, Math.floor(n));
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

  public static getColumnFiltersForUri(context: vscode.ExtensionContext, uri: vscode.Uri): ColumnFilter[] {
    const map = context.workspaceState.get<Record<string, unknown>>(CsvEditorProvider.columnFiltersKey, {});
    return normalizeColumnFilters(map[uri.toString()]);
  }

  public static async setColumnFiltersForUri(context: vscode.ExtensionContext, uri: vscode.Uri, filters: unknown): Promise<void> {
    const map = { ...context.workspaceState.get<Record<string, unknown>>(CsvEditorProvider.columnFiltersKey, {}) };
    const normalized = normalizeColumnFilters(filters);
    if (normalized.length) {
      map[uri.toString()] = normalized;
    } else {
      delete map[uri.toString()];
    }
    await context.workspaceState.update(CsvEditorProvider.columnFiltersKey, map);
  }

  public static getFrozenPanesForUri(context: vscode.ExtensionContext, uri: vscode.Uri, header: boolean): FrozenPanes {
    const map = context.workspaceState.get<Record<string, Partial<FrozenPanes>>>(CsvEditorProvider.frozenPanesKey, {});
    const saved = map[uri.toString()] ?? {};
    const valid = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
    return { rows: valid(saved.rows) ? saved.rows : (header ? 1 : 0), columns: valid(saved.columns) ? saved.columns : 0 };
  }

  public static async setFrozenPanesForUri(context: vscode.ExtensionContext, uri: vscode.Uri, change: Partial<FrozenPanes>): Promise<void> {
    const map = { ...context.workspaceState.get<Record<string, Partial<FrozenPanes>>>(CsvEditorProvider.frozenPanesKey, {}) };
    const saved = { ...map[uri.toString()] };
    for (const axis of ['rows', 'columns'] as const) {
      const value = change[axis];
      if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
        saved[axis] = value;
      }
    }
    map[uri.toString()] = saved;
    await context.workspaceState.update(CsvEditorProvider.frozenPanesKey, map);
  }

  public static normalizeColumnSizes(raw: unknown): Record<string, number> {
    const sizes: Record<string, number> = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return sizes;
    }
    for (const [key, value] of Object.entries(raw)) {
      const col = Number(key);
      const width = Number(value);
      if (!Number.isInteger(col) || col < 0 || !Number.isFinite(width) || width < 40) {
        continue;
      }
      sizes[String(col)] = Math.round(width);
    }
    return sizes;
  }

  public static getColumnSizesForUri(context: vscode.ExtensionContext, uri: vscode.Uri): Record<string, number> {
    const map = context.workspaceState.get<Record<string, unknown>>(CsvEditorProvider.columnSizesKey, {});
    return CsvEditorProvider.normalizeColumnSizes(map[uri.toString()]);
  }

  public static async setColumnSizesForUri(context: vscode.ExtensionContext, uri: vscode.Uri, raw: unknown): Promise<void> {
    const map = { ...context.workspaceState.get<Record<string, unknown>>(CsvEditorProvider.columnSizesKey, {}) };
    const sizes = CsvEditorProvider.normalizeColumnSizes(raw);
    if (Object.keys(sizes).length) {
      map[uri.toString()] = sizes;
    } else {
      delete map[uri.toString()];
    }
    await context.workspaceState.update(CsvEditorProvider.columnSizesKey, map);
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
    resolveEffectiveColumnColorMode(baseMode: string, isDiffContext: boolean, diffUseThemeForeground: boolean): 'type' | 'theme' {
      return (CsvEditorController as any).resolveEffectiveColumnColorMode(baseMode, isDiffContext, diffUseThemeForeground);
    },
    resolveEffectiveFontSize(csvFontSize: unknown, editorFontSize: unknown): number {
      return (CsvEditorController as any).resolveEffectiveFontSize(csvFontSize, editorFontSize);
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
    computePastePlan(
      matrix: string[][],
      anchorRow: number,
      anchorCol: number,
      selection?: { minRow: number; maxRow: number; minCol: number; maxCol: number; rectangular: boolean }
    ): { startRow: number; startCol: number; endRow: number; endCol: number; fillSelection: boolean } | undefined {
      return (CsvEditorController as any).computePastePlan(matrix, anchorRow, anchorCol, selection);
    },
    applyPasteMatrixToData(
      data: string[][],
      matrix: string[][],
      anchorRow: number,
      anchorCol: number,
      selection?: { minRow: number; maxRow: number; minCol: number; maxCol: number; rectangular: boolean }
    ): {
      changed: boolean;
      structuralChange: boolean;
      updates: Array<{ row: number; col: number; value: string }>;
      plan: { startRow: number; startCol: number; endRow: number; endCol: number; fillSelection: boolean };
    } {
      return (CsvEditorController as any).applyPasteMatrixToData(data, matrix, anchorRow, anchorCol, selection);
    },
    // Expose chunking/table generation for large-data tests. Returns parsed chunk count.
    generateTableChunksMeta(
      data: string[][],
      treatHeader: boolean,
      addSerialIndex: boolean,
      hiddenRows: number,
      clickableLinks: boolean = true,
      columnColorMode: 'type' | 'theme' = 'type',
      columnColorPalette: 'default' | 'cool' | 'warm' = 'default',
      showTrailingEmptyRow: boolean = true
    ): { chunkCount: number; hasTable: boolean } {
      const c: any = new (CsvEditorController as any)({} as any);
      const result = c.generateTableAndChunks(
        data,
        treatHeader,
        addSerialIndex,
        hiddenRows,
        clickableLinks,
        columnColorMode,
        columnColorPalette,
        showTrailingEmptyRow
      );
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
      columnColorPalette: 'default' | 'cool' | 'warm' = 'default',
      showTrailingEmptyRow: boolean = true
    ): { tableHtml: string; chunks: string[] } {
      const c: any = new (CsvEditorController as any)({} as any);
      const result = c.generateTableAndChunks(
        data,
        treatHeader,
        addSerialIndex,
        hiddenRows,
        clickableLinks,
        columnColorMode,
        columnColorPalette,
        showTrailingEmptyRow
      );
      let chunks: string[] = [];
      try { chunks = JSON.parse(result.chunksJson); } catch {}
      return { tableHtml: result.tableHtml, chunks };
    },
    generateRuntimeChunkTransport(
      data: string[][],
      treatHeader: boolean,
      addSerialIndex: boolean,
      hiddenRows: number,
      start: number | undefined = undefined
    ): {
      serializedChunkCount: number;
      nextChunkStart: number;
      hasRemoteChunks: boolean;
      hasChunkState: boolean;
      response?: { html: string; nextStart: number; done: boolean };
    } {
      const c: any = new (CsvEditorController as any)({} as any);
      const result = c.generateTableAndChunks(
        data,
        treatHeader,
        addSerialIndex,
        hiddenRows,
        /* clickableLinks */ true,
        /* columnColorMode */ 'type',
        /* columnColorPalette */ 'default',
        /* showTrailingEmptyRow */ true,
        /* maxSerializedChunks */ 0
      );
      let chunks: string[] = [];
      try { chunks = JSON.parse(result.chunksJson); } catch {}
      const out: {
        serializedChunkCount: number;
        nextChunkStart: number;
        hasRemoteChunks: boolean;
        hasChunkState: boolean;
        response?: { html: string; nextStart: number; done: boolean };
      } = {
        serializedChunkCount: chunks.length,
        nextChunkStart: result.nextChunkStart,
        hasRemoteChunks: result.hasRemoteChunks,
        hasChunkState: !!result.chunkState
      };
      if (typeof start === 'number' && result.chunkState) {
        const response = c.renderChunkFromState(result.chunkState, start);
        out.response = {
          html: response.html,
          nextStart: response.nextStart,
          done: response.done
        };
      }
      return out;
    }
  };
}
