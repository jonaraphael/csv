import Papa from 'papaparse';
import * as vscode from 'vscode';
import * as path from 'path';

// Per-document controller. Manages one webview + document.
class CsvEditorController {
  // Note: Global registry lives on CsvEditorProvider (wrapper)

  private isUpdatingDocument = false;
  private isSaving = false;
  private currentWebviewPanel: vscode.WebviewPanel | undefined;
  private document!: vscode.TextDocument;

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
      try {
        const opts: any = { viewColumn: webviewPanel.viewColumn, preserveFocus: !webviewPanel.active, preview: webviewPanel.active ? webviewPanel.active : false };
        await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default', opts);
      } finally {
        try { webviewPanel.dispose(); } catch {}
      }
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
        case 'sortColumn':
          await this.sortColumn(e.index, e.ascending);
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

  // ───────────── Document Editing Methods ─────────────

  private async updateDocument(row: number, col: number, value: string) {
    this.isUpdatingDocument = true;
    const separator = this.getSeparator();
    const oldText = this.document.getText();
    const result = Papa.parse(oldText, { dynamicTyping: false, delimiter: separator });
    const data = result.data as string[][];
    const hadRows = data.length;
    const hadColsAtRow = (data[row] ? data[row].length : 0);

    const { data: nextData, trimmed, createdRow, createdCol } = this.mutateDataForEdit(data, row, col, value);

    const newCsvText = Papa.unparse(nextData, { delimiter: separator });

    const fullRange = new vscode.Range(
      0, 0,
      this.document.lineCount,
      this.document.lineCount ? this.document.lineAt(this.document.lineCount - 1).text.length : 0
    );
    const edit = new vscode.WorkspaceEdit();
    edit.replace(this.document.uri, fullRange, newCsvText);
    await vscode.workspace.applyEdit(edit);

    this.isUpdatingDocument = false;
    console.log(`CSV: Updated row ${row + 1}, column ${col + 1} to "${value}"`);
    this.currentWebviewPanel?.webview.postMessage({ type: 'updateCell', row, col, value });

    // Trigger a full re-render if structure may have changed (new row/col created)
    if (trimmed || createdRow || createdCol || row >= hadRows || col >= hadColsAtRow) {
      try { this.updateWebviewContent(); } catch (e) { console.error('CSV: refresh failed after structural edit', e); }
    }
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

    const { tableHtml, chunksJson, colorCss } =
      this.generateTableAndChunks(data, treatHeader, addSerialIndex, hiddenRows);

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
    hiddenRows: number
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
    const columnColors = columnTypes.map((type, i) => this.getColumnColor(type, isDark, i));
    const columnWidths = this.computeColumnWidths(visibleForWidth);

    const CHUNK_SIZE = 1000;
    const allRows = headerFlag ? bodyData : data.slice(offset);
    const allRowsCount = allRows.length; // preserve total before any truncation
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
            const safe = this.escapeHtml(row[cIdx] || '');
            cells += `<td tabindex="0" style="min-width:${Math.min(columnWidths[cIdx]||0,100)}ch;max-width:100ch;border:1px solid ${isDark?'#555':'#ccc'};color:${columnColors[cIdx]};overflow:hidden;white-space:nowrap;text-overflow:ellipsis;" data-row="${absRow}" data-col="${cIdx}">${safe}</td>`;
          }

          return `<tr>${
            addSerialIndex ? `<td tabindex="0" style="min-width:4ch;max-width:4ch;border:1px solid ${isDark?'#555':'#ccc'};color:#888;" data-row="${absRow}" data-col="-1">${displayIdx}</td>` : ''
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

    const colorCss = columnColors
      .map((hex, i) => `td[data-col="${i}"], th[data-col="${i}"] { color: ${hex}; }`)
      .join('');

    let tableHtml = `<table>`;
    if (headerFlag) {
      tableHtml += `<thead><tr>${
        addSerialIndex
          ? `<th tabindex="0" style="min-width: 4ch; max-width: 4ch; border: 1px solid ${isDark ? '#555' : '#ccc'}; background-color: ${isDark ? '#1e1e1e' : '#ffffff'}; color: #888;"></th>`
          : ''
      }`;
      for (let i = 0; i < numColumns; i++) {
        const safe = this.escapeHtml(headerRow[i] || '');
        tableHtml += `<th tabindex="0" style="min-width: ${Math.min(columnWidths[i] || 0, 100)}ch; max-width: 100ch; border: 1px solid ${isDark ? '#555' : '#ccc'}; background-color: ${isDark ? '#1e1e1e' : '#ffffff'}; color: ${columnColors[i]}; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;" data-row="${offset}" data-col="${i}">${safe}</th>`;
      }
      tableHtml += `</tr></thead><tbody>`;
      bodyData.forEach((row, r) => {
        tableHtml += `<tr>${
          addSerialIndex
            ? `<td tabindex="0" style="min-width: 4ch; max-width: 4ch; border: 1px solid ${isDark ? '#555' : '#ccc'}; color: #888;" data-row="${offset + 1 + r}" data-col="-1">${r + 1}</td>`
            : ''
        }`;
        for (let i = 0; i < numColumns; i++) {
          const safe = this.escapeHtml(row[i] || '');
          tableHtml += `<td tabindex="0" style="min-width: ${Math.min(columnWidths[i] || 0, 100)}ch; max-width: 100ch; border: 1px solid ${isDark ? '#555' : '#ccc'}; color: ${columnColors[i]}; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;" data-row="${offset + 1 + r}" data-col="${i}">${safe}</td>`;
        }
        tableHtml += `</tr>`;
      });
      if (!chunked) {
        const virtualAbs = offset + 1 + bodyData.length;
        const idxCell = addSerialIndex ? `<td tabindex="0" style="min-width: 4ch; max-width: 4ch; border: 1px solid ${isDark ? '#555' : '#ccc'}; color: #888;" data-row="${virtualAbs}" data-col="-1">${bodyData.length + 1}</td>` : '';
        const dataCells = Array.from({ length: numColumns }, (_, i) => `<td tabindex="0" style="min-width: ${Math.min(columnWidths[i] || 0, 100)}ch; max-width: 100ch; border: 1px solid ${isDark ? '#555' : '#ccc'}; color: ${columnColors[i]}; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;" data-row="${virtualAbs}" data-col="${i}"></td>`).join('');
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
            ? `<td tabindex="0" style="min-width: 4ch; max-width: 4ch; border: 1px solid ${isDark ? '#555' : '#ccc'}; color: #888;" data-row="${offset + r}" data-col="-1">${r + 1}</td>`
            : ''
        }`;
        for (let i = 0; i < numColumns; i++) {
          const safe = this.escapeHtml(row[i] || '');
          tableHtml += `<td tabindex="0" style="min-width: ${Math.min(columnWidths[i] || 0, 100)}ch; max-width: 100ch; border: 1px solid ${isDark ? '#555' : '#ccc'}; color: ${columnColors[i]}; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;" data-row="${offset + r}" data-col="${i}">${safe}</td>`;
        }
        tableHtml += `</tr>`;
      });
      if (!chunked) {
        const virtualAbs = offset + nonHeaderRows.length;
        const displayIdx = nonHeaderRows.length + 1;
        const idxCell = addSerialIndex ? `<td tabindex="0" style="min-width: 4ch; max-width: 4ch; border: 1px solid ${isDark ? '#555' : '#ccc'}; color: #888;" data-row="${virtualAbs}" data-col="-1">${displayIdx}</td>` : '';
        const dataCells = Array.from({ length: numColumns }, (_, i) => `<td tabindex="0" style="min-width: ${Math.min(columnWidths[i] || 0, 100)}ch; max-width: 100ch; border: 1px solid ${isDark ? '#555' : '#ccc'}; color: ${columnColors[i]}; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;" data-row="${virtualAbs}" data-col="${i}"></td>`).join('');
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
      const idxCell = addSerialIndex ? `<td tabindex="0" style="min-width: 4ch; max-width: 4ch; border: 1px solid ${isDark ? '#555' : '#ccc'}; color: #888;" data-row="${virtualAbs}" data-col="-1">${displayIdx}</td>` : '';
      const dataCells = Array.from({ length: numColumns }, (_, i) => `<td tabindex="0" style="min-width: ${Math.min(columnWidths[i] || 0, 100)}ch; max-width: 100ch; border: 1px solid ${isDark ? '#555' : '#ccc'}; color: ${columnColors[i]}; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;" data-row="${virtualAbs}" data-col="${i}"></td>`).join('');
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

    const numColumns = Math.max(
      headerRow.length,
      ...body.map(r => r.length),
      0
    );
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
      th, td { padding: ${cellPadding}px 8px; border: 1px solid ${isDark ? '#555' : '#ccc'}; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
      th { position: sticky; top: 0; background-color: ${isDark ? '#1e1e1e' : '#ffffff'}; }
      td.selected, th.selected { background-color: ${isDark ? '#333333' : '#cce0ff'} !important; }
      td.editing, th.editing { overflow: visible !important; white-space: normal !important; max-width: none !important; }
      .highlight { background-color: ${isDark ? '#222222' : '#fefefe'} !important; }
      .active-match { background-color: ${isDark ? '#444444' : '#ffffcc'} !important; }
      #findWidget {
        position: fixed;
        top: 20px;
        right: 20px;
        background: #f9f9f9;
        border: 1px solid #ddd;
        border-radius: 4px;
        padding: 8px 12px;
        box-shadow: 0 2px 8px rgba(0,0,0,0.15);
        z-index: 1000;
        display: none;
        font-family: ${this.escapeCss(fontFamily)};
      }
      #findWidget input {
        border: 1px solid #ccc;
        border-radius: 3px;
        padding: 4px 8px;
        font-size: 14px;
        width: 250px;
      }
      #findWidget span { margin-left: 8px; font-size: 14px; color: #666; }
      #findWidget button {
        background: #007acc;
        border: none;
        color: white;
        padding: 4px 8px;
        margin-left: 8px;
        border-radius: 3px;
        font-size: 14px;
        cursor: pointer;
      }
      #findWidget button:hover { background: #005f9e; }
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

    <div id="findWidget">
      <input id="findInput" type="text" placeholder="Find...">
      <span id="findStatus"></span>
      <button id="findClose">✕</button>
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
    // Default inherited from file
    return this.document?.uri.fsPath.toLowerCase().endsWith('.tsv') ? '\t' : ',';
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

  private getColumnColor(type: string, isDark: boolean, columnIndex: number): string {
    let hueRange = 0, isDefault = false;
    switch (type){
      case "boolean": hueRange = 30; break;
      case "date": hueRange = 210; break;
      case "float": hueRange = isDark ? 60 : 270; break;
      case "integer": hueRange = 120; break;
      case "string": hueRange = 0; break;
      case "empty": isDefault = true; break;
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
    getColumnColor(t: string, dark: boolean, i: number): string {
      const c: any = new (CsvEditorController as any)({} as any);
      return c.getColumnColor(t, dark, i);
    },
    hslToHex(h: number, s: number, l: number): string {
      const c: any = new (CsvEditorController as any)({} as any);
      return c.hslToHex(h, s, l);
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
    getEffectiveSeparator(filePath: string, override: string | undefined): string {
      const c: any = new (CsvEditorController as any)({} as any);
      const fakeUri = { toString: () => `vscode-test://csv/${filePath}`, fsPath: filePath } as any;
      const state: Record<string, any> = {};
      if (override !== undefined) {
        state[CsvEditorProvider.sepKey] = { [fakeUri.toString()]: override };
      }
      c.context = {
        workspaceState: {
          get: (key: string, def: any) => (key in state ? state[key] : def),
          update: async (key: string, val: any) => { state[key] = val; }
        }
      } as any;
      c.document = { uri: fakeUri } as any;
      return c.getSeparator();
    },
    // Expose chunking/table generation for large-data tests. Returns parsed chunk count.
    generateTableChunksMeta(data: string[][], treatHeader: boolean, addSerialIndex: boolean, hiddenRows: number): { chunkCount: number; hasTable: boolean } {
      const c: any = new (CsvEditorController as any)({} as any);
      const result = c.generateTableAndChunks(data, treatHeader, addSerialIndex, hiddenRows);
      try {
        const chunks = JSON.parse(result.chunksJson);
        return { chunkCount: Array.isArray(chunks) ? chunks.length : 0, hasTable: typeof result.tableHtml === 'string' && result.tableHtml.includes('<table') };
      } catch {
        return { chunkCount: 0, hasTable: false };
      }
    },
    generateTableAndChunksRaw(data: string[][], treatHeader: boolean, addSerialIndex: boolean, hiddenRows: number): { tableHtml: string; chunks: string[] } {
      const c: any = new (CsvEditorController as any)({} as any);
      const result = c.generateTableAndChunks(data, treatHeader, addSerialIndex, hiddenRows);
      let chunks: string[] = [];
      try { chunks = JSON.parse(result.chunksJson); } catch {}
      return { tableHtml: result.tableHtml, chunks };
    }
  };
}
