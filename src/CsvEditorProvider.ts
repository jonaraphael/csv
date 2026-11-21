import Papa from 'papaparse';
import * as vscode from 'vscode';
import * as path from 'path';
import { parseClipboardMatrix, serializeClipboardMatrix } from './clipboard';
import { ColumnFilter, normalizeColumnFilters, compileColumnFilters, visibleSourceRows, remapColumnFilters, getFilterOperatorChoices, validateColumnFilterInput, MAX_COLUMN_FILTERS, MAX_FILTER_VALUE_LENGTH } from './column-filters';
import { FilterDataType, parseFilterDate } from './filter-values';
import { NumericSelection, computeSelectionStatistics, formatSelectionStatistics, parseNumericSelection } from './selection-statistics';

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
type FilterColumn = { column: number; label: string; dataType: FilterDataType; operators: ReturnType<typeof getFilterOperatorChoices> };
type FilterDraft = {
  session: string;
  filterColumnsRevision: number;
  rows: Array<{ column: number; operator: ColumnFilter['operator']; value: string; composing?: boolean }>;
  columns: Array<{ column: number; label: string }>;
  focus?: {
    row: number;
    field: 'column' | 'operator' | 'value' | 'remove';
    selectionStart?: number;
    selectionEnd?: number;
    selectionDirection?: 'forward' | 'backward' | 'none';
  };
};
type FilterRender = {
  tableHtml: string; chunksJson: string; colorCss: string; nextChunkStart: number; hasRemoteChunks: boolean;
  visibleRowIds: number[]; matchedRows: number; totalRows: number; filters: ColumnFilter[]; columns: FilterColumn[];
  firstVisibleRow: number; realRowCount: number; headerEnabled: boolean; chunkState: ChunkRenderState | undefined;
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
  private static readonly DRAFT_COMMIT_TIMEOUT_MS = 5000;
  private static nativeHandoffQueue: Promise<void> = Promise.resolve();

  private isUpdatingDocument = false;
  private isSaving = false;
  private disposed = false;
  private defaultEditorHandoff: Promise<void> | undefined;
  private pendingViewAction: (() => Promise<void>) | undefined;
  private pendingDocumentReference: { document: vscode.TextDocument; separator: string } | undefined;
  private renderedSeparator: string | undefined;
  private viewCommitRequested = false;
  private viewCommitSequence = 0;
  private viewCommitNeedsFreshAck = false;
  private draftActivityRevision = 0;
  private pendingClose = false;
  private pendingOperation: Promise<void> = Promise.resolve();
  private readonly failedCellEdits = new Map<string, { row: number; col: number }>();
  private refreshAfterDraftCommit = false;
  private readonly draftCommitWaiters = new Set<{ resolve: (success: boolean) => void; timer: ReturnType<typeof setTimeout> }>();
  private currentWebviewPanel: vscode.WebviewPanel | undefined;
  private document!: vscode.TextDocument;
  private separatorCache: { version: number; configKey: string; separator: string } | undefined;
  private isDiffContext = false;
  private currentHeader = false;
  private wordWrapEnabled = false;
  private chunkRenderState: ChunkRenderState | undefined;
  private currentFilterView: FilterRender | undefined;
  private latestFilterRevision = 0;
  private filterEpoch = 0;
  private filterSession = '';
  private filterSessionUri = '';
  private filterColumnsRevision = 0;
  private pendingFilterDraft: { uri: string; draft: FilterDraft } | undefined;
  private numericSelection: NumericSelection | undefined;
  private selectionStatusBar: vscode.StatusBarItem | undefined;
  private selectionStatusText: string | undefined;
  private selectionStatisticsVersion = -1;
  private selectionData: { version: number; data: string[][] } | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {}

  // (no static helpers here; see wrapper CsvEditorProvider)

  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    this.document = document;
    this.currentWebviewPanel = webviewPanel;
    let changeDocumentSubscription: vscode.Disposable | undefined;
    let saveDocumentSubscription: vscode.Disposable | undefined;
    // Register before remote stat/prompt awaits: a closed panel stays closed.
    webviewPanel.onDidDispose(() => {
      this.disposed = true;
      this.selectionStatusBar?.dispose();
      this.selectionStatusBar = undefined;
      this.selectionData = undefined;
      changeDocumentSubscription?.dispose();
      saveDocumentSubscription?.dispose();
      CsvEditorProvider.editors = CsvEditorProvider.editors.filter(ed => ed !== this);
      this.currentWebviewPanel = undefined;
      this.pendingFilterDraft = undefined;
      this.pendingViewAction = undefined;
      this.pendingDocumentReference = undefined;
      this.viewCommitRequested = false;
      this.resolveDraftCommitWaiters(false);
      if (CsvEditorProvider.currentActive === this) {
        CsvEditorProvider.currentActive = undefined;
        void vscode.commands.executeCommand('setContext', 'csv.wordWrapEnabled', false);
      }
    });
    if (_token.isCancellationRequested) { return; }

    const config = vscode.workspace.getConfiguration('csv', this.document.uri);
    if (!config.get<boolean>('enabled', true)) {
      // When disabled, immediately hand off to the default editor and close this tab
      await this.openWithDefaultEditorAndClose(webviewPanel, document.uri);
      return;
    }

    const proceed = await this.confirmLargeFileOpen(config, webviewPanel, _token);
    if (!proceed || this.disposed || _token.isCancellationRequested || document.isClosed) {
      return;
    }

    if (!vscode.workspace.getConfiguration('csv', document.uri).get<boolean>('enabled', true)) {
      await this.openWithDefaultEditorAndClose(webviewPanel, document.uri);
      return;
    }
    CsvEditorProvider.editors.push(this);

    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.getMediaUri()]
    };

    this.refreshDiffContext(webviewPanel);
    this.updateWebviewContent();

    if (webviewPanel.active) {
      CsvEditorProvider.currentActive = this;
      this.updateWordWrapContext();
      this.updateSelectionStatusBar();
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
        this.updateWordWrapContext();
        this.updateSelectionStatusBar();
      } else if (CsvEditorProvider.currentActive === this) {
        CsvEditorProvider.currentActive = undefined;
        void vscode.commands.executeCommand('setContext', 'csv.wordWrapEnabled', false);
      }
      if (!e.webviewPanel.active) { this.selectionStatusBar?.hide(); }
    });

    webviewPanel.webview.onDidReceiveMessage(e => {
      if (e.type === 'wordWrapChanged') {
        if (typeof e.enabled === 'boolean') {
          this.wordWrapEnabled = e.enabled;
          this.updateWordWrapContext();
        }
        return;
      }
      if (e.type === 'filterDraftChanged') {
        if (e.session === this.filterSession) { this.draftActivityRevision += 1; }
        return;
      }
      if (e.type === 'updateColumnFilters' && e.session === this.filterSession && Number.isSafeInteger(e.revision) && e.revision > this.latestFilterRevision) {
        this.latestFilterRevision = e.revision;
      }
      const mutatesTable = ['replaceCells', 'pasteCells', 'insertColumn', 'insertColumns', 'deleteColumn', 'deleteColumns',
        'insertRow', 'insertRows', 'deleteRow', 'deleteRows', 'reorderColumns', 'reorderRows', 'sortColumn', 'pasteFromClipboard'].includes(e.type) || (e.type === 'copyCells' && e.cut === true);
      // Observe new drafts immediately, even while an earlier queued edit awaits
      // applyEdit. An ACK received before that activity cannot authorize reload.
      if (mutatesTable || ['cellEditStarted', 'editCell', 'discardCellDraft'].includes(e.type)) {
        this.draftActivityRevision += 1;
      }
      const receivedRevision = this.draftActivityRevision;
      return this.enqueueOperation(async () => {
      if (mutatesTable && this.failedCellEdits.size) {
        const failed = this.failedCellEdits.values().next().value!;
        void webviewPanel.webview.postMessage({ type: 'editCellFailed', row: failed.row, col: failed.col, retry: true });
        void vscode.window.showErrorMessage('CSV: Retry the failed cell edit or press Escape to discard it before changing the table.');
        return;
      }
      switch (e.type) {
        case 'selectionChanged':
          if (e.session === this.filterSession && e.filterEpoch === this.filterEpoch) {
            this.numericSelection = parseNumericSelection(e.selection);
            this.refreshSelectionStatistics(true);
          }
          break;
        case 'webviewReady': {
          if (this.viewCommitRequested) {
            this.postViewCommitRequest();
          }
          break;
        }
        case 'viewRefreshReady': {
          if (e.session !== this.filterSession) { break; }
          if (this.viewCommitRequested && e.requestId !== this.viewCommitSequence) {
            break;
          }
          if (!this.viewCommitRequested && e.requestId !== undefined) {
            break;
          }
          if (this.viewCommitRequested && (this.viewCommitNeedsFreshAck || receivedRevision !== this.draftActivityRevision)) {
            this.viewCommitNeedsFreshAck = false;
            this.viewCommitSequence += 1;
            this.postViewCommitRequest();
            break;
          }
          this.captureFilterDraft(e.filterDraft);
          await this.finishViewCommit();
          break;
        }
        case 'editCell':
          await this.updateDocument(e.row, e.col, e.value);
          break;
        case 'discardCellDraft':
          this.discardFailedCellDraft(e.row, e.col);
          break;
        case 'replaceCells':
          await this.replaceCells(e.replacements);
          break;
        case 'pasteCells':
          await this.pasteCells(e.text, e.anchorRow, e.anchorCol, e.selection);
          break;
        case 'requestChunk':
          await this.requestChunk(e.start, e.requestId, e.filterEpoch, e.session);
          break;
        case 'findMatches':
          await this.findMatches(e.requestId, e.query, e.options);
          break;
        case 'save':
          if (this.viewCommitRequested) {
            this.saveAfterCommit();
          } else {
            await this.handleSave();
          }
          break;
        case 'updateColumnFilters':
          await this.updateColumnFilters(e.revision, e.filters, e.session);
          break;
        case 'freezePanesChanged':
          await this.setFrozenPanes({ rows: e.rows, columns: e.columns });
          break;
        case 'columnSizesChanged':
          await CsvEditorProvider.setColumnSizesForUri(this.context, this.document.uri, e.columnSizes);
          break;
        case 'setHeader': {
          if (typeof e.enabled === 'boolean') {
            const uri = this.document.uri;
            await CsvEditorProvider.setHeaderForUri(this.context, uri, e.enabled);
            CsvEditorProvider.editors
              .filter(editor => editor.getDocumentUri().toString() === uri.toString())
              .forEach(editor => editor.refresh());
          }
          break;
        }
        case 'setSerialIndex': {
          if (typeof e.enabled === 'boolean') {
            const uri = this.getDocumentUri();
            if (CsvEditorProvider.getSerialIndexForUri(this.context, uri) !== e.enabled) {
              await CsvEditorProvider.setSerialIndexForUri(this.context, uri, e.enabled);
              CsvEditorProvider.editors
                .filter(editor => editor.getDocumentUri().toString() === uri.toString())
                .forEach(editor => editor.refreshViewSafely());
            }
          }
          break;
        }
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
      });
    });

    changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument(e => {
      if (
        e.document.uri.toString() === document.uri.toString() &&
        !this.isUpdatingDocument &&
        !this.isSaving
      ) {
        setTimeout(() => this.updateWebviewContent(), 250);
      }
    });

    saveDocumentSubscription = vscode.workspace.onWillSaveTextDocument(e => {
      if (e.document.uri.toString() === document.uri.toString() && !this.isSaving) {
        // Native File > Save can run while the webview's blur edit is applying.
        // The custom save command is already in this queue and must not await itself.
        e.waitUntil(this.pendingOperation);
      }
    });
  }

  private enqueueOperation(operation: () => void | Promise<void>): Promise<void> {
    // Event listeners are not awaited by VS Code. Serialize mutations, reads and
    // saves so every command sees the result of the preceding document edit.
    this.pendingOperation = this.pendingOperation.then(async () => {
      await operation();
      this.refreshSelectionStatistics();
    }).catch(error => {
      console.error('CSV: Editor operation failed', error);
    });
    return this.pendingOperation;
  }

  private async warnAboutPossibleDecoding(): Promise<void> {
    if (this.document.uri.scheme === 'untitled' || !this.document.getText().includes('\uFFFD') || CsvEditorController.encodingWarnings.has(this.document)) {
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

  private captureOtherEditorOwner(uri: vscode.Uri, viewColumn: vscode.ViewColumn | undefined): (() => Promise<void>) | undefined {
    const group = vscode.window.tabGroups.activeTabGroup;
    if (!group) { return; }
    const tab = group.activeTab;
    const input: any = tab?.input;
    const stillOpen = () => vscode.window.tabGroups.all.includes(group) && !!tab && group.tabs.includes(tab);
    const activeController = CsvEditorProvider.editors.find(editor => editor !== this && editor.isActive() && editor.getViewColumn() === group.viewColumn);
    const panel = activeController?.currentWebviewPanel;
    if (panel) {
      const document = activeController.document;
      return async () => {
        if (!vscode.window.tabGroups.all.includes(group)) { return; }
        if (activeController.currentWebviewPanel === panel && panel.viewColumn === group.viewColumn && stillOpen()) {
          panel.reveal(group.viewColumn, false);
        } else if (!activeController.currentWebviewPanel && !document.isClosed && group.tabs.some(candidate => {
          const native: any = candidate.input;
          return !native?.viewType && native?.uri?.toString() === document.uri.toString();
        })) {
          // Another Off handoff can replace the captured grid first. Reuse
          // its native owner only while that owner still has a live tab here.
          await vscode.window.showTextDocument(document, { viewColumn: group.viewColumn, preview: false });
        }
      };
    }
    const activeUri: vscode.Uri | undefined = input?.uri;
    if (!activeUri || (group.viewColumn === viewColumn && activeUri.toString() === uri.toString())) { return; }
    if (input.viewType === CsvEditorProvider.viewType) { return; }
    if (input.viewType) {
      return async () => { if (stillOpen()) { await vscode.commands.executeCommand('vscode.openWith', activeUri, input.viewType, { viewColumn: group.viewColumn, preserveFocus: false }); } };
    }
    const editor = vscode.window.visibleTextEditors.find(candidate => candidate.viewColumn === group.viewColumn && candidate.document.uri.toString() === activeUri.toString());
    if (editor) {
      return async () => {
        if (!stillOpen()) { return; }
        // The owner may have acquired its standalone table while the saved-file
        // handoff was pending. Reveal that live view instead of promoting text.
        const controller = CsvEditorProvider.editors.find(candidate => candidate !== this && candidate.getViewColumn() === group.viewColumn && candidate.getDocumentUri().toString() === activeUri.toString());
        if (controller?.currentWebviewPanel) { controller.currentWebviewPanel.reveal(group.viewColumn, false); }
        else if (!editor.document.isClosed) { await vscode.window.showTextDocument(editor.document, { viewColumn: group.viewColumn, preview: false }); }
      };
    }
  }

  private async openWithDefaultEditorAndClose(webviewPanel: vscode.WebviewPanel, uri: vscode.Uri, reason?: 'disabled' | 'language'): Promise<void> {
    if (this.disposed) { return; }
    if (!this.defaultEditorHandoff) {
      const authorization = reason ? {
        activity: this.draftActivityRevision, document: this.document, version: this.document.version,
        language: this.document.languageId, session: this.filterSession, filterRevision: this.latestFilterRevision,
        columnsRevision: this.filterColumnsRevision
      } : undefined;
      let reprepare = false;
      const pending = CsvEditorController.nativeHandoffQueue.then(async () => {
        if (this.disposed || this.document.isClosed) { return; }
        const supported = uri.scheme !== 'untitled' || this.document.languageId === 'csv' || this.document.languageId === 'tsv';
        if (supported && CsvEditorProvider.editors.includes(this) && vscode.workspace.getConfiguration('csv', uri).get<boolean>('enabled', true)) { return; }
        if (authorization && (authorization.activity !== this.draftActivityRevision || authorization.document !== this.document ||
            authorization.version !== this.document.version || authorization.language !== this.document.languageId ||
            authorization.session !== this.filterSession || authorization.filterRevision !== this.latestFilterRevision ||
            authorization.columnsRevision !== this.filterColumnsRevision || this.pendingDocumentReference)) {
          // A different handoff held the native queue after this view's ACK.
          // Release this slot and request a new ACK without blocking its own
          // message queue, where the final cell/filter edits must be applied.
          reprepare = true;
          return;
        }
        let restoreOwner = this.captureOtherEditorOwner(uri, webviewPanel.viewColumn);
        const focusSubscription = vscode.window.onDidChangeActiveTextEditor(() => {
          const next = this.captureOtherEditorOwner(uri, webviewPanel.viewColumn);
          if (next) { restoreOwner = next; }
        });
        const wasActive = webviewPanel.active;
        try {
          const opts = { viewColumn: webviewPanel.viewColumn, preserveFocus: !wasActive };
          if (uri.scheme === 'untitled') {
            await vscode.window.showTextDocument(this.document, { ...opts, preview: false });
          } else {
            const existing = vscode.window.visibleTextEditors.find(editor =>
              editor.document.uri.toString() === uri.toString() && editor.viewColumn === webviewPanel.viewColumn);
            if (!existing) {
              await vscode.commands.executeCommand('vscode.openWith', uri, 'default', opts);
            }
          }
        } finally {
          focusSubscription.dispose();
          const supported = uri.scheme !== 'untitled' || this.document.languageId === 'csv' || this.document.languageId === 'tsv';
          const retainTable = supported && !this.disposed && CsvEditorProvider.editors.includes(this) &&
            vscode.workspace.getConfiguration('csv', uri).get<boolean>('enabled', true);
          const group = vscode.window.tabGroups.activeTabGroup;
          const input: any = group?.activeTab?.input;
          const nativeHandoffIsActive = group?.viewColumn === webviewPanel.viewColumn && !input?.viewType && input?.uri?.toString() === uri.toString();
          if (!retainTable) { try { webviewPanel.dispose(); } catch {} }
          // Only undo activation caused by this handoff. A later user choice in
          // another tab/group always keeps focus and its live document owner.
          if (nativeHandoffIsActive) {
            if (restoreOwner) { await restoreOwner(); }
            else if (retainTable && wasActive) { webviewPanel.reveal(webviewPanel.viewColumn, false); }
          }
        }
      });
      // Only native opens/disposal/restoration serialize; draft ACKs remain
      // independent, so a failed edit in one file cannot block other files.
      CsvEditorController.nativeHandoffQueue = pending.then(() => {}, () => {});
      this.defaultEditorHandoff = pending;
      void pending.then(() => {
        if (this.defaultEditorHandoff === pending) { this.defaultEditorHandoff = undefined; }
        if (reprepare && !this.disposed && reason) { this.revealSourceAfterCommit(reason); }
      }, () => {
        if (this.defaultEditorHandoff === pending) { this.defaultEditorHandoff = undefined; }
      });
    }
    await this.defaultEditorHandoff;
  }

  private async confirmLargeFileOpen(
    config: vscode.WorkspaceConfiguration,
    webviewPanel: vscode.WebviewPanel,
    token: vscode.CancellationToken
  ): Promise<boolean> {
    if (this.document.uri.scheme === 'untitled') {
      return true;
    }
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
    if (this.disposed) { return; }
    const config = vscode.workspace.getConfiguration('csv', this.document.uri);
    const enabled = config.get<boolean>('enabled', true);
    if (this.failedCellEdits.size) {
      this.refreshAfterDraftCommit = true;
      if (!enabled) {
        void vscode.window.showErrorMessage('CSV: Retry the failed cell edit or press Escape to discard it before disabling the table view.');
      }
      return;
    }
    if (!enabled) {
      this.revealSourceAfterCommit();
    } else {
      if (this.defaultEditorHandoff) { return; }
      if (this.viewCommitRequested || this.failedCellEdits.size) {
        this.refreshAfterDraftCommit = true;
        return;
      }
      if (this.currentWebviewPanel && !this.viewCommitRequested && !this.failedCellEdits.size) {
        this.forceReload();
      }
    }
  }

  public getViewColumn(): vscode.ViewColumn | undefined {
    return this.currentWebviewPanel?.viewColumn;
  }

  public commitPendingDraft(): Promise<boolean> {
    const panel = this.currentWebviewPanel;
    if (!panel) {
      return Promise.resolve(false);
    }
    return new Promise(resolve => {
      const waiter = {
        resolve,
        timer: setTimeout(() => {
          this.draftCommitWaiters.delete(waiter);
          resolve(false);
        }, CsvEditorController.DRAFT_COMMIT_TIMEOUT_MS)
      };
      this.draftCommitWaiters.add(waiter);
      const alreadyRequested = this.viewCommitRequested;
      this.requestViewCommit();
      if (alreadyRequested && panel.visible) {
        this.postViewCommitRequest();
      }
    });
  }

  private resolveDraftCommitWaiters(success: boolean): void {
    for (const waiter of this.draftCommitWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(success);
    }
    this.draftCommitWaiters.clear();
  }

  public revealSourceAfterCommit(reason: 'disabled' | 'language' = 'disabled'): void {
    const panel = this.currentWebviewPanel;
    if (!panel) {
      return;
    }
    // A deliberate close takes priority over a pending Save As or re-render.
    this.pendingClose = true;
    this.pendingViewAction = async () => {
      const enabled = vscode.workspace.getConfiguration('csv', this.document.uri).get<boolean>('enabled', true);
      const supportedLanguage = this.document.languageId === 'csv' || this.document.languageId === 'tsv';
      if (enabled && (reason === 'disabled' || supportedLanguage)) {
        // A quick re-enable/language roundtrip still commits the active draft.
        this.updateWebviewContent();
        return;
      }
      await this.openWithDefaultEditorAndClose(panel, this.document.uri, reason);
    };
    this.requestViewCommit();
  }

  public saveUntitledAfterCommit(): void {
    if (this.document.uri.scheme === 'untitled') {
      this.saveAfterCommit();
    }
  }

  private saveAfterCommit(): void {
    if (!this.currentWebviewPanel || this.pendingClose) {
      return;
    }
    this.pendingViewAction = async () => {
      await this.handleSave();
      this.updateWebviewContent();
    };
    this.requestViewCommit();
  }

  private postViewCommitRequest(): void {
    const panel = this.currentWebviewPanel;
    if (!panel) {
      this.resolveDraftCommitWaiters(false);
      return;
    }
    try {
      void Promise.resolve(panel.webview.postMessage({
        type: 'prepareViewRefresh', requestId: this.viewCommitSequence
      })).then(delivered => {
        if (!delivered) { this.resolveDraftCommitWaiters(false); }
      }, () => this.resolveDraftCommitWaiters(false));
    } catch {
      this.resolveDraftCommitWaiters(false);
    }
  }

  private requestViewCommit(): void {
    const panel = this.currentWebviewPanel;
    if (!panel || this.viewCommitRequested) {
      return;
    }
    this.viewCommitRequested = true;
    this.viewCommitNeedsFreshAck = false;
    this.viewCommitSequence += 1;
    if (panel.visible) {
      // The final edit arrives before the acknowledgment in the ordered queue.
      // webviewReady resends this request if the first script is still loading.
      this.postViewCommitRequest();
    } else {
      void this.enqueueOperation(() => this.finishViewCommit());
    }
  }

  private requestRecoveryRefresh(): void {
    this.refreshAfterDraftCommit = true;
    if (this.viewCommitRequested) {
      // A recovery cannot reuse the snapshot taken before its queued edit.
      this.viewCommitNeedsFreshAck = true;
      return;
    }
    // The acknowledgment itself runs on the ordered queue, so never await it here.
    this.requestViewCommit();
  }

  private async finishViewCommit(): Promise<void> {
    this.viewCommitRequested = false;
    if (this.failedCellEdits.size) {
      // Keep the live DOM and any pending action until its failed cell can be retried.
      this.resolveDraftCommitWaiters(false);
      return;
    }
    const hadWaiters = this.draftCommitWaiters.size > 0;
    if (this.pendingDocumentReference) {
      this.document = this.pendingDocumentReference.document;
      this.pendingDocumentReference = undefined;
      this.separatorCache = undefined;
    }
    const action = this.pendingViewAction;
    this.pendingViewAction = undefined;
    this.pendingClose = false;
    const refreshNeeded = this.refreshAfterDraftCommit;
    this.refreshAfterDraftCommit = false;
    if (action) {
      await action();
    } else if (!hadWaiters || refreshNeeded) {
      this.updateWebviewContent();
    }
    // An awaited action can leave a newer request pending. Its waiters need
    // that request's own ACK, even when this older action just completed.
    if (!this.viewCommitRequested) { this.resolveDraftCommitWaiters(!!this.currentWebviewPanel && !this.failedCellEdits.size); }
  }

  private forceReload() {
    if (!this.currentWebviewPanel || this.failedCellEdits.size) return;
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

  private getFilterColumns(data: string[][]): FilterColumn[] {
    const offset = Math.min(Math.max(0, this.getHiddenRows()), data.length);
    const header = this.getEffectiveHeader(data, offset);
    const body = data.slice(offset + (header ? 1 : 0));
    const count = Math.max(1, data.reduce((max, row) => Math.max(max, row.length), 0));
    return Array.from({ length: count }, (_, column) => {
      const values = body.map(row => row[column] ?? '');
      const inferred = this.estimateColumnDataType(values);
      let dataType: FilterDataType = inferred === 'integer' || inferred === 'float' ? 'number'
        : inferred === 'date' || inferred === 'boolean' ? inferred : 'string';
      if (inferred === 'string') {
        const nonblank = values.filter(value => value.trim() !== '');
        if (nonblank.length && nonblank.every(value => parseFilterDate(value) !== undefined)) {
          dataType = 'date';
        }
      }
      return { column, label: (header ? data[offset]?.[column] : '') || `Column ${column + 1}`, dataType, operators: getFilterOperatorChoices(dataType) };
    });
  }

  private filterResponse(): Record<string, unknown> {
    if (!this.currentFilterView) { return { filterEpoch: this.filterEpoch }; }
    const { chunkState, ...payload } = this.currentFilterView;
    return { ...payload, filterEpoch: this.filterEpoch };
  }

  private async updateColumnFilters(rawRevision: unknown, rawFilters: unknown, session: unknown): Promise<void> {
    const panel = this.currentWebviewPanel;
    if (!panel || session !== this.filterSession) { return; }
    const reply = (extra: Record<string, unknown>) => {
      if (session !== this.filterSession || panel !== this.currentWebviewPanel) { return; }
      void panel.webview.postMessage({ type: 'columnFiltersResult', session: this.filterSession, revision: rawRevision, ...this.filterResponse(), ...extra });
    };
    if (typeof rawRevision !== 'number' || !Number.isSafeInteger(rawRevision) || rawRevision <= 0) {
      reply({ error: 'Filter revisions must be positive safe integers.' });
      return;
    }
    if (rawRevision !== this.latestFilterRevision || rawRevision <= this.filterEpoch) { return; }
    if (this.failedCellEdits.size) {
      reply({ error: 'Retry the failed cell edit before changing filters.' });
      return;
    }
    if (this.pendingDocumentReference || this.viewCommitRequested) {
      reply({ error: 'Finish the current editor change before changing filters.' });
      return;
    }
    if (!Array.isArray(rawFilters) || rawFilters.length > MAX_COLUMN_FILTERS) {
      reply({ error: `Provide at most ${MAX_COLUMN_FILTERS} filter conditions.` });
      return;
    }
    const data = this.trimTrailingEmptyRows(Papa.parse<string[]>(this.document.getText(), { delimiter: this.getSeparator() }).data);
    const columns = this.getFilterColumns(data);
    const filters: ColumnFilter[] = [];
    const errors: Array<{ index: number; message: string }> = [];
    rawFilters.forEach((raw: unknown, index: number) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        errors.push({ index, message: 'Provide a valid filter condition.' });
        return;
      }
      const item = raw as Record<string, unknown>;
      if (Object.keys(item).some(key => !['column', 'operator', 'value', 'dataType'].includes(key)) ||
          typeof item.column !== 'number' || !Number.isSafeInteger(item.column) || item.column < 0 || item.column >= columns.length ||
          typeof item.operator !== 'string' || typeof item.value !== 'string' || item.value.length > MAX_FILTER_VALUE_LENGTH ||
          (item.dataType !== undefined && (typeof item.dataType !== 'string' || !['string', 'number', 'date', 'boolean'].includes(item.dataType)))) {
        errors.push({ index, message: 'Provide a valid column, operator, type and filter value.' });
        return;
      }
      const column = columns[item.column];
      const choice = column.operators.find(operator => operator.operator === item.operator);
      if (!choice) {
        errors.push({ index, message: `Choose an operator supported by this ${column.dataType} column.` });
        return;
      }
      const typed = !['contains', 'notContains', 'regex', 'empty', 'notEmpty'].includes(choice.operator);
      const dataType = typed && column.dataType !== 'string' ? column.dataType : undefined;
      // Empty text boxes remain local drafts, including incomplete typed queries.
      if (choice.operator !== 'empty' && choice.operator !== 'notEmpty' && item.value.length === 0) { return; }
      const error = validateColumnFilterInput(choice.operator, item.value, dataType);
      if (error) { errors.push({ index, message: error }); return; }
      filters.push({ column: item.column, operator: choice.operator, value: item.value, ...(dataType ? { dataType } : {}) });
    });
    if (errors.length) { reply({ errors, columns }); return; }
    const view = this.buildFilterView(data, filters);
    if (session !== this.filterSession || rawRevision !== this.latestFilterRevision) { return; }
    const previous = CsvEditorProvider.getColumnFiltersForUri(this.context, this.document.uri);
    try {
      await CsvEditorProvider.setColumnFiltersForUri(this.context, this.document.uri, filters);
      if (session !== this.filterSession || rawRevision !== this.latestFilterRevision) {
        await CsvEditorProvider.setColumnFiltersForUri(this.context, this.document.uri, previous);
        return;
      }
    } catch {
      reply({ error: 'The filter conditions could not be saved. Try again.' });
      return;
    }
    this.chunkRenderState = view.chunkState;
    this.currentFilterView = view;
    this.currentHeader = view.headerEnabled;
    this.filterEpoch = rawRevision;
    this.resetSelectionStatistics(data);
    reply({});
  }

  private captureFilterDraft(raw: unknown): void {
    this.pendingFilterDraft = undefined;
    const columns = this.currentFilterView?.columns;
    if (!columns || !raw || typeof raw !== 'object' || Array.isArray(raw)) { return; }
    const item = raw as Record<string, unknown>;
    if (item.session !== this.filterSession || item.filterColumnsRevision !== this.filterColumnsRevision ||
        !Array.isArray(item.rows) || item.rows.length > MAX_COLUMN_FILTERS ||
        !Array.isArray(item.columns) || item.columns.length !== columns.length) { return; }
    if (!item.columns.every((column: unknown, index: number) => {
      if (!column || typeof column !== 'object' || Array.isArray(column)) { return false; }
      const identity = column as Record<string, unknown>;
      return identity.column === columns[index].column && identity.label === columns[index].label;
    })) { return; }
    const rows: FilterDraft['rows'] = [];
    for (const rawRow of item.rows as unknown[]) {
      if (!rawRow || typeof rawRow !== 'object' || Array.isArray(rawRow)) { return; }
      const row = rawRow as Record<string, unknown>;
      const operator = getFilterOperatorChoices('number').find(choice => choice.operator === row.operator)?.operator;
      if (typeof row.column !== 'number' || !Number.isSafeInteger(row.column) || row.column < 0 || row.column >= columns.length ||
          !operator || typeof row.value !== 'string' || row.value.length > MAX_FILTER_VALUE_LENGTH ||
          (row.composing !== undefined && typeof row.composing !== 'boolean')) { return; }
      // Preserve blank and invalid queries as drafts; only submission validates their meaning.
      rows.push({ column: row.column, operator, value: row.value, ...(row.composing ? { composing: true } : {}) });
    }
    const draft: FilterDraft = {
      session: this.filterSession,
      filterColumnsRevision: this.filterColumnsRevision,
      rows,
      columns: columns.map(column => ({ column: column.column, label: column.label }))
    };
    if (item.focus !== undefined) {
      if (!item.focus || typeof item.focus !== 'object' || Array.isArray(item.focus)) { return; }
      const focus = item.focus as Record<string, unknown>;
      if (typeof focus.row !== 'number' || !Number.isSafeInteger(focus.row) || focus.row < 0 || focus.row >= rows.length ||
          (focus.field !== 'column' && focus.field !== 'operator' && focus.field !== 'value' && focus.field !== 'remove')) { return; }
      draft.focus = { row: focus.row, field: focus.field };
      if (focus.selectionStart !== undefined || focus.selectionEnd !== undefined || focus.selectionDirection !== undefined) {
        if (focus.field !== 'value' || typeof focus.selectionStart !== 'number' || typeof focus.selectionEnd !== 'number' ||
            !Number.isSafeInteger(focus.selectionStart) || !Number.isSafeInteger(focus.selectionEnd) ||
            focus.selectionStart < 0 || focus.selectionEnd < focus.selectionStart || focus.selectionEnd > rows[focus.row].value.length ||
            (focus.selectionDirection !== 'forward' && focus.selectionDirection !== 'backward' && focus.selectionDirection !== 'none')) { return; }
        Object.assign(draft.focus, { selectionStart: focus.selectionStart, selectionEnd: focus.selectionEnd, selectionDirection: focus.selectionDirection });
      }
    }
    this.pendingFilterDraft = { uri: this.filterSessionUri, draft };
  }

  private consumeFilterDraft(columns: FilterColumn[]): FilterDraft | undefined {
    const pending = this.pendingFilterDraft;
    this.pendingFilterDraft = undefined;
    if (!pending || pending.uri !== this.document.uri.toString() || pending.draft.filterColumnsRevision !== this.filterColumnsRevision ||
        pending.draft.columns.length !== columns.length || pending.draft.columns.some((column, index) =>
          column.column !== columns[index].column || column.label !== columns[index].label)) { return undefined; }
    return pending.draft;
  }

  private async remapFilters(columnOrder: number[]): Promise<void> {
    if (columnOrder.length !== this.currentFilterView?.columns.length || columnOrder.some((column, index) => column !== index)) {
      this.filterColumnsRevision++;
      this.pendingFilterDraft = undefined;
    }
    await CsvEditorProvider.setColumnFiltersForUri(this.context, this.document.uri,
      remapColumnFilters(CsvEditorProvider.getColumnFiltersForUri(this.context, this.document.uri), columnOrder));
  }

  public refreshViewSafely(): void {
    this.refreshAfterDraftCommit = true;
    this.requestViewCommit();
  }

  public getCurrentFrozenPanes(): FrozenPanes {
    return CsvEditorProvider.getFrozenPanesForUri(this.context, this.document.uri, this.currentHeader);
  }

  private updateWordWrapContext(): void {
    if (this.isActive()) {
      void vscode.commands.executeCommand('setContext', 'csv.wordWrapEnabled', this.wordWrapEnabled);
    }
  }

  private resetSelectionStatistics(data: string[][]): void {
    this.selectionData = { version: this.document.version, data };
    this.numericSelection = undefined;
    this.selectionStatusText = undefined;
    this.selectionStatisticsVersion = -1;
    this.selectionStatusBar?.hide();
  }

  private refreshSelectionStatistics(force = false): void {
    if (this.disposed || (!force && this.selectionStatisticsVersion === this.document.version)) { return; }
    this.selectionStatisticsVersion = this.document.version;
    const view = this.currentFilterView;
    if (!this.numericSelection || !view) {
      this.selectionStatusText = undefined;
    } else {
      if (this.selectionData?.version !== this.document.version) {
        this.selectionData = {
          version: this.document.version,
          data: this.trimTrailingEmptyRows(Papa.parse<string[]>(this.document.getText(), { delimiter: this.getSeparator() }).data)
        };
      }
      const stats = computeSelectionStatistics(this.selectionData.data, this.numericSelection,
        view.firstVisibleRow + (view.headerEnabled ? 1 : 0), view.filters.length ? view.visibleRowIds : undefined);
      this.selectionStatusText = stats.count ? formatSelectionStatistics(stats) : undefined;
    }
    this.updateSelectionStatusBar();
  }

  private updateSelectionStatusBar(): void {
    if (!this.isActive() || !this.selectionStatusText || this.disposed) {
      this.selectionStatusBar?.hide();
      return;
    }
    if (!this.selectionStatusBar) {
      this.selectionStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
      this.selectionStatusBar.name = 'CSV Numeric Selection';
      this.selectionStatusBar.tooltip = 'Sum, average, and count of selected numeric data cells. Headers, hidden rows, blanks, and text are excluded.';
      this.context.subscriptions.push(this.selectionStatusBar);
    }
    this.selectionStatusBar.text = this.selectionStatusText;
    this.selectionStatusBar.show();
  }

  public setWordWrap(enabled: boolean): void {
    void this.currentWebviewPanel?.webview.postMessage({ type: 'setWordWrap', enabled });
  }

  public async setFrozenPanes(change: Partial<FrozenPanes>): Promise<void> {
    await CsvEditorProvider.setFrozenPanesForUri(this.context, this.document.uri, change);
    this.currentWebviewPanel?.webview.postMessage({ type: 'frozenPanes', ...this.getCurrentFrozenPanes() });
  }

  public updateDocumentReference(document: vscode.TextDocument): void {
    if (document.uri.toString() === this.document.uri.toString()) {
      this.pendingDocumentReference = {
        document,
        separator: this.pendingDocumentReference?.separator ?? this.renderedSeparator ?? this.getSeparator()
      };
      this.refreshAfterDraftCommit = true;
      this.requestViewCommit();
    }
  }

  public getDocumentUri(): vscode.Uri {
    return this.document.uri;
  }

  public getCurrentSeparator(): string {
    return this.getSeparator();
  }

  // ───────────── Document Editing Methods ─────────────

  private reportFailedCellEdit(row: number, col: number): void {
    this.failedCellEdits.set(`${row}:${col}`, { row, col });
    void this.currentWebviewPanel?.webview.postMessage({
      type: 'editCellFailed', row, col, retry: !!this.viewCommitRequested
    });
  }

  private postCommittedCell(row: number, col: number, value: string): void {
    const clickableLinks = vscode.workspace.getConfiguration('csv', this.document.uri).get<boolean>('clickableLinks', true);
    void this.currentWebviewPanel?.webview.postMessage({
      type: 'updateCell', row, col, value, rendered: this.formatCellContent(value, clickableLinks)
    });
  }

  private clearFailedCellEdit(row: number, col: number, value: string): void {
    if (this.failedCellEdits.delete(`${row}:${col}`)) {
      this.postCommittedCell(row, col, value);
      if (!this.failedCellEdits.size) { this.requestRecoveryRefresh(); }
    }
  }

  private discardFailedCellDraft(row: number, col: number): void {
    const failed = this.failedCellEdits.get(`${row}:${col}`);
    if (!failed) {
      return;
    }
    // Escape discards the failed DOM draft, never overwrites the current owner.
    const document = this.pendingDocumentReference?.document ?? this.document;
    const data = Papa.parse<string[]>(document.getText(), { delimiter: this.getSeparator() }).data;
    this.clearFailedCellEdit(row, col, String(data[row]?.[col] ?? ''));

  }

  private async updateDocument(row: number, col: number, value: string) {
    // The old document may be closed during a language change. Apply its final
    // draft to the live shared URI using the delimiter of the still-visible grid.
    const document = this.pendingDocumentReference?.document ?? this.document;
    this.isUpdatingDocument = true;
    let structuralChange = false;
    let filterMembershipChanged = false;
    let applied = false;
    try {
      const separator = this.getSeparator();
      const oldText = document.getText();
      const result = Papa.parse(oldText, { dynamicTyping: false, delimiter: separator });
      const data = result.data as string[][];
      const hadRows = data.length;
      const hadColsAtRow = (data[row] ? data[row].length : 0);
      const previousValue =
        row < hadRows && col < hadColsAtRow
          ? String(data[row][col] ?? '')
          : undefined;

      const filters = CsvEditorProvider.getColumnFiltersForUri(this.context, this.document.uri);
      const matches = compileColumnFilters(filters);
      const previouslyMatched = matches(data[row] ?? []);
      const { data: nextData, trimmed, createdRow, createdCol } = this.mutateDataForEdit(data, row, col, value);
      filterMembershipChanged = filters.length > 0 && previouslyMatched !== matches(nextData[row] ?? []);
      structuralChange = !!(trimmed || createdRow || createdCol || row >= hadRows || col >= hadColsAtRow);

      if (!structuralChange && previousValue === value) {
        this.clearFailedCellEdit(row, col, value);
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
        this.clearFailedCellEdit(row, col, value);
        return;
      }

      const fullRange = new vscode.Range(
        0, 0,
        document.lineCount,
        document.lineCount ? document.lineAt(document.lineCount - 1).text.length : 0
      );
      const edit = new vscode.WorkspaceEdit();
      edit.replace(document.uri, fullRange, newCsvText);
      applied = await vscode.workspace.applyEdit(edit);
    } catch (error) {
      this.reportFailedCellEdit(row, col);
      throw error;
    } finally {
      this.isUpdatingDocument = false;
    }

    if (!applied) {
      this.reportFailedCellEdit(row, col);
      return;
    }
    const recoveredDraft = this.failedCellEdits.delete(`${row}:${col}`);

    console.log(`CSV: Updated row ${row + 1}, column ${col + 1}`);
    const config = vscode.workspace.getConfiguration('csv', document.uri);
    const clickableLinks = config.get<boolean>('clickableLinks', true);
    const rendered = this.formatCellContent(value ?? '', clickableLinks);
    this.currentWebviewPanel?.webview.postMessage({ type: 'updateCell', row, col, value, rendered });

    // Trigger a full re-render if structure may have changed (new row/col created)
    if (recoveredDraft && !this.failedCellEdits.size) {
      this.requestRecoveryRefresh();
    }
    if (filterMembershipChanged) {
      this.refreshViewSafely();
    } else if (structuralChange && !this.pendingDocumentReference) {
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
          cells += `<td tabindex="0" style="min-width:${Math.min(state.columnWidths[cIdx] || 0, 100)}ch;max-width:100ch;border:1px solid var(--csv-table-border, ${state.isDark ? '#555' : '#ccc'});color:${state.columnColors[cIdx]};overflow:visible;white-space: pre-wrap;overflow-wrap:anywhere;"${titleAttr} data-row="${absRow}" data-col="${cIdx}">${safe}</td>`;
        }
        const idxCell = state.addSerialIndex
          ? `<td tabindex="0" style="min-width:${state.serialIndexWidthCh}ch;max-width:${state.serialIndexWidthCh}ch;border:1px solid var(--csv-table-border, ${state.isDark ? '#555' : '#ccc'});color:#888;" data-row="${absRow}" data-col="-1">${displayIdx}</td>`
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
        ? `<td tabindex="0" style="min-width:${state.serialIndexWidthCh}ch;max-width:${state.serialIndexWidthCh}ch;border:1px solid var(--csv-table-border, ${state.isDark ? '#555' : '#ccc'});color:#888;" data-row="${virtualAbs}" data-col="-1">${displayIdx}</td>`
        : '';
      const dataCells = Array.from({ length: state.numColumns }, (_, i) => `<td tabindex="0" style="min-width:${Math.min(state.columnWidths[i] || 0, 100)}ch;max-width:100ch;border:1px solid var(--csv-table-border, ${state.isDark ? '#555' : '#ccc'});color:${state.columnColors[i]};overflow:visible;white-space: pre-wrap;overflow-wrap:anywhere;" data-row="${virtualAbs}" data-col="${i}"></td>`).join('');
      return { html: `<tr>${idxCell}${dataCells}</tr>`, nextStart: -1, done: true };
    }

    return { html: '', nextStart: -1, done: true };
  }

  private async requestChunk(rawStart: unknown, requestId: unknown, filterEpoch: unknown, session: unknown): Promise<void> {
    if (!this.currentWebviewPanel || !this.chunkRenderState || filterEpoch !== this.filterEpoch || session !== this.filterSession) {
      return;
    }
    const start = Number(rawStart);
    if (!Number.isInteger(start) || start < 0) {
      this.currentWebviewPanel.webview.postMessage({
        type: 'chunkData',
        session: this.filterSession,
        filterEpoch: this.filterEpoch,
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
      session: this.filterSession,
      filterEpoch: this.filterEpoch,
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
      if (this.document.uri.scheme === 'untitled') {
        // Native Save owns the actual Save As transition. The temporary grid
        // closes when VS Code closes the original untitled document.
        await vscode.window.showTextDocument(this.document, { viewColumn: this.currentWebviewPanel?.viewColumn, preview: false });
        await vscode.commands.executeCommand('workbench.action.files.save');
        return;
      }
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
    const matches = compileColumnFilters(filters);
    const matchingSlots = body.map((_row, slot) => slot).filter(slot => matches(body[slot]));
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
    if (!this.currentWebviewPanel || this.failedCellEdits.size || this.pendingDocumentReference) return;
    if (this.viewCommitRequested) {
      this.refreshAfterDraftCommit = true;
      return;
    }

    const webview = this.currentWebviewPanel.webview;
    const config = vscode.workspace.getConfiguration('csv', this.document.uri);
    const separator = this.getSeparator();
    this.renderedSeparator = separator;

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
    const view = this.buildFilterView(data, filters);
    const filterDraft = this.consumeFilterDraft(view.columns);
    this.currentHeader = view.headerEnabled;
    this.chunkRenderState = view.chunkState;
    this.currentFilterView = view;
    this.latestFilterRevision = 0;
    this.filterEpoch = 0;
    this.filterSession = this.getNonce();
    this.filterSessionUri = this.document.uri.toString();
    this.resetSelectionStatistics(data);
    const mouseWheelZoomEnabled = config.get<boolean>('mouseWheelZoom', true);
    const mouseWheelZoomInvert = config.get<boolean>('mouseWheelZoomInvert', false);
    const { tableHtml, chunksJson, colorCss, nextChunkStart, hasRemoteChunks } = view;

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
      headerEnabled: view.headerEnabled,
      firstVisibleRow: view.firstVisibleRow,
      mouseWheelZoomEnabled,
      mouseWheelZoomInvert,
      columnSizes: CsvEditorProvider.getColumnSizesForUri(this.context, this.document.uri),
      frozenPanes: this.getCurrentFrozenPanes(),
      realRowCount: data.length,
      visibleRowIds: view.visibleRowIds,
      filterMetadata: { session: this.filterSession, filterColumnsRevision: this.filterColumnsRevision, filters, columns: view.columns, matchedRows: view.matchedRows, totalRows: view.totalRows, maxFilters: MAX_COLUMN_FILTERS, revision: 0, ...(filterDraft ? { filterDraft } : {}) }
    });
  }

  private buildFilterView(data: string[][], filters: ColumnFilter[]): FilterRender {
    const config = vscode.workspace.getConfiguration('csv', this.document.uri);
    const hiddenRows = Math.min(Math.max(0, this.getHiddenRows()), data.length);
    const headerEnabled = this.getEffectiveHeader(data, hiddenRows);
    const columnColorMode = CsvEditorController.resolveEffectiveColumnColorMode(
      config.get<string>('columnColorMode', 'type'), this.isDiffContext, config.get<boolean>('diffUseThemeForeground', true));
    const render = this.generateTableAndChunks(data, headerEnabled,
      CsvEditorProvider.getSerialIndexForUri(this.context, this.document.uri), hiddenRows,
      config.get<boolean>('clickableLinks', true), columnColorMode, config.get<string>('columnColorPalette', 'default'),
      config.get<boolean>('showTrailingEmptyRow', true), 0, filters);
    const visible = visibleSourceRows(data, hiddenRows, headerEnabled, filters);
    return { ...render, filters, columns: this.getFilterColumns(data), headerEnabled,
      firstVisibleRow: hiddenRows, realRowCount: data.length,
      visibleRowIds: filters.length ? [...visible, data.length] : [],
      matchedRows: visible.filter(row => !(headerEnabled && row === hiddenRows)).length,
      totalRows: Math.max(0, data.length - hiddenRows - (headerEnabled ? 1 : 0)) };
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
    const matches = compileColumnFilters(filters);
    const rowIds = bodyData.map((_row, index) => bodyStart + index).filter(row => matches(data[row]));
    bodyData = rowIds.map(row => data[row]);
    const visibleForWidth = headerFlag ? [headerRow, ...bodyData] : bodyData;
    let numColumns = data.reduce((max, row) => Math.max(max, row.length), 0);
    if (numColumns === 0) numColumns = 1; // ensure at least 1 column for the virtual row

    const columnData = Array.from({ length: numColumns }, (_, i) => bodyData.map(row => row[i] || ''));
    const columnTypes = columnData.map(col => this.estimateColumnDataType(col));
    const useThemeForeground = columnColorMode === 'theme';
    const palette = columnColorPalette === 'cool'
      ? 'cool'
      : (columnColorPalette === 'warm' ? 'warm' : 'default');
    const columnColors = useThemeForeground
      ? Array.from({ length: numColumns }, () => 'var(--vscode-editor-foreground)')
      : columnTypes.map((type, i) => `var(--csv-column-${i}, ${this.getColumnColor(type, isDark, i, palette)})`);
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
            cells += `<td tabindex="0" style="min-width:${Math.min(columnWidths[cIdx]||0,100)}ch;max-width:100ch;border:1px solid var(--csv-table-border, ${isDark?'#555':'#ccc'});color:${columnColors[cIdx]};overflow:visible;white-space: pre-wrap;overflow-wrap:anywhere;"${titleAttr} data-row="${absRow}" data-col="${cIdx}">${safe}</td>`;
          }

          return `<tr>${
            addSerialIndex ? `<td tabindex="0" style="min-width:${serialIndexWidthCh}ch;max-width:${serialIndexWidthCh}ch;border:1px solid var(--csv-table-border, ${isDark?'#555':'#ccc'});color:#888;" data-row="${absRow}" data-col="-1">${displayIdx}</td>` : ''
          }${cells}</tr>`;
        }).join('');

        chunks.push(htmlChunk);
        serializedChunkCount++;
      }
    }

    // Body classes change in place; inherited variables update every mounted or
    // later-loaded cell without overriding the user's mode or reloading a draft.
    const colorCss = useThemeForeground
      ? ''
      : `body:is(.vscode-light, .vscode-high-contrast-light) { ${columnTypes.map((type, i) => `--csv-column-${i}: ${this.getColumnColor(type, false, i, palette)};`).join('')} }` +
        `body:is(.vscode-dark, .vscode-high-contrast) { ${columnTypes.map((type, i) => `--csv-column-${i}: ${this.getColumnColor(type, true, i, palette)};`).join('')} }`;

    let tableHtml = `<table>`;
    if (headerFlag) {
      tableHtml += `<thead><tr>${
        addSerialIndex
          ? `<th tabindex="0" data-serial-index="1" style="min-width: ${serialIndexWidthCh}ch; max-width: ${serialIndexWidthCh}ch; border: 1px solid var(--csv-table-border, ${isDark ? '#555' : '#ccc'}); background-color: var(--csv-header-background, ${isDark ? '#1e1e1e' : '#ffffff'}); color: #888;"></th>`
          : ''
      }`;
      for (let i = 0; i < numColumns; i++) {
        const safe = this.formatCellContent(headerRow[i] || '', clickableLinks);
        tableHtml += `<th tabindex="0" style="min-width: ${Math.min(columnWidths[i] || 0, 100)}ch; max-width: 100ch; border: 1px solid var(--csv-table-border, ${isDark ? '#555' : '#ccc'}); background-color: var(--csv-header-background, ${isDark ? '#1e1e1e' : '#ffffff'}); color: ${columnColors[i]}; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;" data-row="${offset}" data-col="${i}" data-filter-column="${filters.some(filter => filter.column === i) ? 'active' : 'none'}">${safe}</th>`;
      }
      tableHtml += `</tr></thead><tbody>`;
      const initialBodyRows = chunked ? allRows.slice(0, chunkRows) : allRows;
      initialBodyRows.forEach((row, r) => {
        tableHtml += `<tr>${
          addSerialIndex
            ? `<td tabindex="0" style="min-width: ${serialIndexWidthCh}ch; max-width: ${serialIndexWidthCh}ch; border: 1px solid var(--csv-table-border, ${isDark ? '#555' : '#ccc'}); color: #888;" data-row="${rowIds[r]}" data-col="-1">${rowIds[r] - bodyStart + 1}</td>`
            : ''
        }`;
        for (let i = 0; i < numColumns; i++) {
          const rawValue = row[i] || '';
          const safe = this.formatCellContent(rawValue, clickableLinks);
          const titleAttr = this.getMultilineCellTitleAttr(rawValue);
          tableHtml += `<td tabindex="0" style="min-width: ${Math.min(columnWidths[i] || 0, 100)}ch; max-width: 100ch; border: 1px solid var(--csv-table-border, ${isDark ? '#555' : '#ccc'}); color: ${columnColors[i]}; overflow: visible; white-space: pre-wrap; overflow-wrap: anywhere;"${titleAttr} data-row="${rowIds[r]}" data-col="${i}">${safe}</td>`;
        }
        tableHtml += `</tr>`;
      });
      if (!chunked && includeTrailingEmptyRow) {
        const virtualAbs = data.length;
        const idxCell = addSerialIndex ? `<td tabindex="0" style="min-width: ${serialIndexWidthCh}ch; max-width: ${serialIndexWidthCh}ch; border: 1px solid var(--csv-table-border, ${isDark ? '#555' : '#ccc'}); color: #888;" data-row="${virtualAbs}" data-col="-1">${virtualAbs - bodyStart + 1}</td>` : '';
        const dataCells = Array.from({ length: numColumns }, (_, i) => `<td tabindex="0" style="min-width: ${Math.min(columnWidths[i] || 0, 100)}ch; max-width: 100ch; border: 1px solid var(--csv-table-border, ${isDark ? '#555' : '#ccc'}); color: ${columnColors[i]}; overflow: visible; white-space: pre-wrap; overflow-wrap: anywhere;" data-row="${virtualAbs}" data-col="${i}"></td>`).join('');
        tableHtml += `<tr>${idxCell}${dataCells}</tr>`;
      }
      tableHtml += `</tbody>`;
    } else {
      tableHtml += `<tbody>`;
      const nonHeaderRows = chunked ? allRows.slice(0, chunkRows) : allRows;
      nonHeaderRows.forEach((row, r) => {
        tableHtml += `<tr>${
          addSerialIndex
            ? `<td tabindex="0" style="min-width: ${serialIndexWidthCh}ch; max-width: ${serialIndexWidthCh}ch; border: 1px solid var(--csv-table-border, ${isDark ? '#555' : '#ccc'}); color: #888;" data-row="${rowIds[r]}" data-col="-1">${rowIds[r] - bodyStart + 1}</td>`
            : ''
        }`;
        for (let i = 0; i < numColumns; i++) {
          const rawValue = row[i] || '';
          const safe = this.formatCellContent(rawValue, clickableLinks);
          const titleAttr = this.getMultilineCellTitleAttr(rawValue);
          tableHtml += `<td tabindex="0" style="min-width: ${Math.min(columnWidths[i] || 0, 100)}ch; max-width: 100ch; border: 1px solid var(--csv-table-border, ${isDark ? '#555' : '#ccc'}); color: ${columnColors[i]}; overflow: visible; white-space: pre-wrap; overflow-wrap: anywhere;"${titleAttr} data-row="${rowIds[r]}" data-col="${i}">${safe}</td>`;
        }
        tableHtml += `</tr>`;
      });
      if (!chunked && includeTrailingEmptyRow) {
        const virtualAbs = data.length;
        const displayIdx = virtualAbs - bodyStart + 1;
        const idxCell = addSerialIndex ? `<td tabindex="0" style="min-width: ${serialIndexWidthCh}ch; max-width: ${serialIndexWidthCh}ch; border: 1px solid var(--csv-table-border, ${isDark ? '#555' : '#ccc'}); color: #888;" data-row="${virtualAbs}" data-col="-1">${displayIdx}</td>` : '';
        const dataCells = Array.from({ length: numColumns }, (_, i) => `<td tabindex="0" style="min-width: ${Math.min(columnWidths[i] || 0, 100)}ch; max-width: 100ch; border: 1px solid var(--csv-table-border, ${isDark ? '#555' : '#ccc'}); color: ${columnColors[i]}; overflow: visible; white-space: pre-wrap; overflow-wrap: anywhere;" data-row="${virtualAbs}" data-col="${i}"></td>`).join('');
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
        const idxCell = addSerialIndex ? `<td tabindex="0" style="min-width: ${serialIndexWidthCh}ch; max-width: ${serialIndexWidthCh}ch; border: 1px solid var(--csv-table-border, ${isDark ? '#555' : '#ccc'}); color: #888;" data-row="${virtualAbs}" data-col="-1">${displayIdx}</td>` : '';
        const dataCells = Array.from({ length: numColumns }, (_, i) => `<td tabindex="0" style="min-width: ${Math.min(columnWidths[i] || 0, 100)}ch; max-width: 100ch; border: 1px solid var(--csv-table-border, ${isDark ? '#555' : '#ccc'}); color: ${columnColors[i]}; overflow: visible; white-space: pre-wrap; overflow-wrap: anywhere;" data-row="${virtualAbs}" data-col="${i}"></td>`).join('');
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

  private getMediaUri(...segments: string[]): vscode.Uri {
    return this.context.extensionUri.with({
      path: path.posix.join(this.context.extensionUri.path, 'media', ...segments)
    });
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
    headerEnabled: boolean;
    mouseWheelZoomEnabled: boolean;
    mouseWheelZoomInvert: boolean;
    columnSizes: Record<string, number>;
    frozenPanes: FrozenPanes;
    firstVisibleRow: number;
    realRowCount: number;
    visibleRowIds: number[];
    filterMetadata: { session: string; filterColumnsRevision: number; filters: ColumnFilter[]; columns: FilterColumn[]; matchedRows: number; totalRows: number; maxFilters: number; revision: number; filterDraft?: FilterDraft };
  }): string {
    const { webview, nonce, fontFamily, fontSize, cellPadding, separator, tableHtml, chunksJson, extraColumnColorCss, nextChunkStart, hasRemoteChunks, headerEnabled, mouseWheelZoomEnabled, mouseWheelZoomInvert, columnSizes, frozenPanes, firstVisibleRow, realRowCount, visibleRowIds, filterMetadata } = args;
    const themeKind = vscode.window.activeColorTheme.kind;
    const isDark = themeKind === vscode.ColorThemeKind.Dark || themeKind === vscode.ColorThemeKind.HighContrast;
    const scriptUri = webview.asWebviewUri(
      this.getMediaUri('main.js')
    );

    const filterScriptUri = webview.asWebviewUri(this.getMediaUri('column-filters.js'));
    const filterMetadataJson = JSON.stringify(filterMetadata).replace(/[<>&\u2028\u2029]/g, character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'));
    const frozenPanesScriptUri = webview.asWebviewUri(
      this.getMediaUri('frozen-panes.js')
    );
    const contrastStyleUri = webview.asWebviewUri(
      this.getMediaUri('high-contrast.css')
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
      /* Preserve the existing light/dark colors as theme classes change. */
      body:is(.vscode-light, .vscode-high-contrast-light) {
        --csv-table-border: #ccc;
        --csv-header-background: #ffffff;
        --csv-selection-background: #cce0ff;
        --csv-find-highlight-background: #fefefe;
        --csv-find-active-background: #ffffcc;
        --csv-link-color: #0066cc;
        --csv-link-hover-color: #0044aa;
        --csv-menu-background: #ffffff;
        --csv-menu-hover-background: #eeeeee;
      }
      body:is(.vscode-dark, .vscode-high-contrast) {
        --csv-table-border: #555;
        --csv-header-background: #1e1e1e;
        --csv-selection-background: #333333;
        --csv-find-highlight-background: #2a2a2a;
        --csv-find-active-background: #444444;
        --csv-link-color: #6cb6ff;
        --csv-link-hover-color: #8ecfff;
        --csv-menu-background: #2d2d2d;
        --csv-menu-hover-background: #3d3d3d;
      }
      body { font-family: ${this.escapeCss(fontFamily)}; font-size: ${fontSize}px; margin: 0; padding: 0; user-select: none; }
      .table-container { overflow: auto; height: 100vh; }
      table { border-collapse: collapse; width: max-content; }
      th, td { padding: ${cellPadding}px 8px; border: 1px solid var(--csv-table-border, ${isDark ? '#555' : '#ccc'}); font-size: inherit; }
      th { position: static; background-color: var(--csv-header-background, ${isDark ? '#1e1e1e' : '#ffffff'}); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
      td { overflow: visible; white-space: pre-wrap; overflow-wrap: anywhere; }
      #csv-root.csv-cutoff td:not(.editing) { overflow: hidden !important; white-space: nowrap !important; overflow-wrap: normal !important; text-overflow: ellipsis; }
      td.selected, th.selected { background-color: var(--csv-selection-background, ${isDark ? '#333333' : '#cce0ff'}) !important; }
      td.editing, th.editing { overflow: visible !important; white-space: pre-wrap !important; overflow-wrap: anywhere !important; max-width: none !important; }
      .highlight { background-color: var(--csv-find-highlight-background, ${isDark ? '#2a2a2a' : '#fefefe'}) !important; }
      .active-match { background-color: var(--csv-find-active-background, ${isDark ? '#444444' : '#ffffcc'}) !important; }
      .csv-link { color: var(--csv-link-color, ${isDark ? '#6cb6ff' : '#0066cc'}); text-decoration: underline; cursor: pointer; }
      .csv-link:hover { color: var(--csv-link-hover-color, ${isDark ? '#8ecfff' : '#0044aa'}); }
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
      #contextMenu { position: fixed; display: none; width: max-content; box-sizing: border-box; overflow: auto; overflow-wrap: anywhere; background: var(--csv-menu-background, ${isDark ? '#2d2d2d' : '#ffffff'}); border: 1px solid var(--csv-table-border, ${isDark ? '#555' : '#ccc'}); z-index: 10000; font-family: ${this.escapeCss(fontFamily)}; font-size: inherit; }
      #contextMenu div { padding: 4px 12px; cursor: pointer; }
      #contextMenu div:hover { background: var(--csv-menu-hover-background, ${isDark ? '#3d3d3d' : '#eeeeee'}); }

      #csv-root .csv-frozen-row, #csv-root .csv-frozen-column {
        position: sticky;
        background-color: var(--vscode-editor-background, ${isDark ? '#1e1e1e' : '#ffffff'}) !important;
      }
      /* Paint collapsed divider seams with the sticky cells instead of the scrolling table. */
      #csv-root .csv-frozen-row::before {
        content: "";
        position: absolute;
        inset: -0.5px 0;
        border-block: 1px solid var(--csv-contrast-border, var(--csv-table-border, ${isDark ? '#555' : '#ccc'}));
        box-sizing: border-box;
        pointer-events: none;
      }
      /* An outline paints the divider outside clipped cell contents. Keep its
         specificity below the high-contrast selection and Find outlines. */
      .csv-cutoff .csv-frozen-row {
        outline: 2px solid var(--csv-contrast-border, var(--csv-table-border, ${isDark ? '#555' : '#ccc'}));
        outline-offset: -1px;
      }
      /* Retain state outline colors while covering the outer seam in HC themes. */
      .csv-cutoff .csv-frozen-row:is(.selected, .highlight, .active-match) {
        outline-width: 2px;
        outline-offset: -1px;
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
      #filterStatus { position: sticky; top: 0; left: 0; z-index: 6; display: flex; flex-direction: column; gap: 8px; align-items: stretch; max-height: 25vh; overflow: auto; padding: 6px; background: var(--vscode-editorWidget-background, ${isDark ? '#252526' : '#ffffff'}); color: var(--vscode-editorWidget-foreground, inherit); border-bottom: 1px solid var(--vscode-editorWidget-border, ${isDark ? '#555' : '#ccc'}); }
      #filterStatus[hidden] { display: none; }
      #filterStatus button { color: inherit; background: transparent; border: 1px solid var(--vscode-button-border, currentColor); border-radius: 3px; cursor: pointer; }
      .column-filter-toolbar, .column-filter-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
      .column-filter-conditions { display: flex; flex-direction: column; gap: 6px; }
      .column-filter-row select, .column-filter-row input { max-width: 100%; min-width: 0; box-sizing: border-box; font: inherit; color: var(--vscode-input-foreground, inherit); background: var(--vscode-input-background, transparent); border: 1px solid var(--vscode-input-border, var(--vscode-editorWidget-border, currentColor)); }
      .column-filter-row input { flex: 1 1 18ch; }
      .column-filter-error { color: var(--vscode-errorForeground, inherit); flex-basis: 100%; }
      .column-filter-type, .column-filter-and { font-size: 0.9em; }
      th[data-filter-column="active"]::after { content: " ⏷"; }
      #filterStatus button:focus-visible { outline: 2px solid var(--vscode-focusBorder); }
      /* Per-column computed colors */
    </style>
    <style id="__csvColumnColors" nonce="${nonce}">${extraColumnColorCss}</style>
    <link rel="stylesheet" href="${contrastStyleUri}">
  </head>
  <body>
    <div id="csv-root" data-headerenabled="${headerEnabled ? '1' : '0'}" data-roworder="${this.escapeHtml(JSON.stringify(visibleRowIds))}" data-filtered="${filterMetadata.filters.length ? '1' : '0'}" data-filterepoch="0" data-frozenrows="${frozenPanes.rows}" data-frozencolumns="${frozenPanes.columns}" data-firstrow="${firstVisibleRow}" data-realrowcount="${realRowCount}" data-columnsizes="${this.escapeHtml(JSON.stringify(columnSizes))}" class="table-container csv-cutoff" data-sepcode="${sepCode}" data-fontsize="${fontSize}" data-wheelzoomenabled="${mouseWheelZoomEnabled ? '1' : '0'}" data-wheelzoominvert="${mouseWheelZoomInvert ? '1' : '0'}" data-nextchunkstart="${nextChunkStart >= 0 ? nextChunkStart : ''}" data-hasmorechunks="${hasRemoteChunks ? '1' : '0'}">
      <div id="filterStatus" aria-label="Column filters"${filterMetadata.filters.length ? '' : ' hidden'}></div>
      ${tableHtml}
    </div>

    <script id="__csvFilters" type="application/json" nonce="${nonce}">${filterMetadataJson}</script>
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
            <button id="replaceAll" class="fr-action-btn" type="button" aria-label="Replace All" title="${filterMetadata.filters.length ? 'Replace All in matching filtered rows' : 'Replace All'}" disabled>⇅</button>
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
    <script nonce="${nonce}" src="${filterScriptUri}"></script>
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
    if (this.pendingDocumentReference) {
      return this.pendingDocumentReference.separator;
    }
    if ((this.failedCellEdits.size || this.refreshAfterDraftCommit) && this.renderedSeparator !== undefined) {
      return this.renderedSeparator;
    }
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

    const filePath = this.document.uri.scheme === 'untitled'
      ? this.document.languageId === 'tsv' ? 'untitled.tsv' : 'untitled.csv'
      : this.document?.uri.fsPath || this.document?.uri.path || '';
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
    return normalized === 'http' || normalized === 'https' || normalized === 'ftp' || normalized === 'mailto' || normalized === 'file';
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
    // Supports http, https, ftp, file, mailto, and www.*.* (Google Sheets-like behavior).
    const urlPattern = /\b(?:(?:https?:\/\/|ftp:\/\/|file:\/\/|mailto:)[^\s<>&"']+(?:&amp;[^\s<>&"']+)*|www\.[^\s<>&"']+\.[^\s<>&"']+)/gi;
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
    await controller.resolveCustomTextEditor(document, webviewPanel, _token);
  }

  public static getActiveProvider(): CsvEditorController | undefined {
    const current = CsvEditorProvider.currentActive;
    return current?.isActive() ? current : CsvEditorProvider.editors.find(ed => ed.isActive());
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
