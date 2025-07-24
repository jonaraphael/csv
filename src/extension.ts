import { getFonts } from 'font-list';
import Papa from 'papaparse';
import * as vscode from 'vscode';

/**
 * Activates the CSV extension by registering commands and the custom CSV editor.
 */
export function activate(context: vscode.ExtensionContext) {
  console.log('CSV: Extension activated');

  // Helper to toggle a boolean CSV configuration and refresh all open CSV editors.
  const toggleBooleanConfig = async (key: string, defaultVal: boolean, messagePrefix: string) => {
    const config = vscode.workspace.getConfiguration('csv');
    const currentVal = config.get<boolean>(key, defaultVal);
    const newVal = !currentVal;
    await config.update(key, newVal, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage(`${messagePrefix} ${newVal ? 'enabled' : 'disabled'}.`);
    CsvEditorProvider.editors.forEach(editor => editor.refresh());
  };

  // Register CSV-related commands.
  context.subscriptions.push(
    vscode.commands.registerCommand('csv.toggleExtension', () =>
      toggleBooleanConfig('enabled', true, 'CSV extension')
    ),
    vscode.commands.registerCommand('csv.toggleHeader', () =>
      toggleBooleanConfig('treatFirstRowAsHeader', true, 'CSV first row as header is now')
    ),
    vscode.commands.registerCommand('csv.toggleSerialIndex', () =>
      toggleBooleanConfig('addSerialIndex', false, 'CSV serial index is now')
    ),
    vscode.commands.registerCommand('csv.changeSeparator', async () => {
      const config = vscode.workspace.getConfiguration('csv');
      const currentSep = config.get<string>('separator', ',');
      const input = await vscode.window.showInputBox({ prompt: 'Enter new CSV separator', value: currentSep });
      if (input !== undefined) {
        await config.update('separator', input, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(`CSV separator changed to "${input}"`);
        CsvEditorProvider.editors.forEach(editor => editor.refresh());
      }
    }),
    vscode.commands.registerCommand('csv.changeFontFamily', async () => {
      const csvCfg     = vscode.workspace.getConfiguration('csv');
      const editorCfg  = vscode.workspace.getConfiguration('editor');

      const currentCsvFont   = csvCfg.get<string>('fontFamily', '');
      const inheritedFont    = editorCfg.get<string>('fontFamily', 'Menlo');
      const currentEffective = currentCsvFont || inheritedFont;

      // Build QuickPick list
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
      if (choice === undefined) { return; }                      // user aborted

      const newVal = choice === '(inherit editor setting)' ? '' : choice;
      await csvCfg.update('fontFamily', newVal, vscode.ConfigurationTarget.Global);

      vscode.window.showInformationMessage(
        newVal
          ? `CSV font set to “${newVal}”.`
          : 'CSV font now inherits editor.fontFamily.'
      );
      // Refresh all open CSV editors
      CsvEditorProvider.editors.forEach(ed => ed.refresh());
    })

  );

  // Register the custom editor provider for CSV files.
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      CsvEditorProvider.viewType,
      new CsvEditorProvider(context),
      { supportsMultipleEditorsPerDocument: false }
    )
  );
}

/**
 * Deactivates the CSV extension.
 */
export function deactivate() {
  console.log('CSV: Extension deactivated');
}

/**
 * Provides a custom CSV editor with an interactive webview.
 */
class CsvEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = 'csv.editor';
  public static editors: CsvEditorProvider[] = [];
  private isUpdatingDocument = false;
  private isSaving = false;
  private currentWebviewPanel: vscode.WebviewPanel | undefined;
  private document!: vscode.TextDocument;

  constructor(private readonly context: vscode.ExtensionContext) {}

  /**
   * Sets up the CSV editor when a CSV document is opened.
   */
  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    this.document = document;
    const config = vscode.workspace.getConfiguration('csv');
    if (!config.get<boolean>('enabled', true)) {
      vscode.window.showInformationMessage('CSV extension is disabled. Use the command palette to enable it.');
      await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
      return;
    }
    this.currentWebviewPanel = webviewPanel;
    CsvEditorProvider.editors.push(this);
    webviewPanel.webview.options = { enableScripts: true };
    this.updateWebviewContent();
    webviewPanel.webview.postMessage({ type: 'focus' });
    webviewPanel.onDidChangeViewState(e => {
      if (e.webviewPanel.active) {
        e.webviewPanel.webview.postMessage({ type: 'focus' });
      }
    });

    // Handle messages from the webview.
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
        case 'deleteColumn':
          await this.deleteColumn(e.index);
          break;
        /* ──────── NEW ──────── */
        case 'insertRow':
          await this.insertRow(e.index);
          break;
        case 'deleteRow':
          await this.deleteRow(e.index);
          break;
        case 'sortColumn':
          await this.sortColumn(e.index, e.ascending);
          break;
      }
    });

    // Update the webview when the document changes externally.
    const changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument(e => {
      if (e.document.uri.toString() === document.uri.toString() && !this.isUpdatingDocument && !this.isSaving) {
        setTimeout(() => this.updateWebviewContent(), 250);
      }
    });

    // Clean up subscriptions when the webview is disposed.
    webviewPanel.onDidDispose(() => {
      changeDocumentSubscription.dispose();
      CsvEditorProvider.editors = CsvEditorProvider.editors.filter(editor => editor !== this);
      this.currentWebviewPanel = undefined;
    });
  }

  /**
   * Refreshes the webview content or reopens the document in the default editor if disabled.
   */
  public refresh() {
    const config = vscode.workspace.getConfiguration('csv');
    if (!config.get<boolean>('enabled', true)) {
      this.currentWebviewPanel?.dispose();
      vscode.commands.executeCommand('vscode.openWith', this.document.uri, 'default');
    } else {
      this.currentWebviewPanel && this.updateWebviewContent();
    }
  }

  // ───────────── Document Editing Methods ─────────────

  /**
   * Updates a specific cell in the CSV document.
   * Tries a targeted edit first and falls back to rebuilding the CSV if necessary.
   */
  private async updateDocument(row: number, col: number, value: string) {
    this.isUpdatingDocument = true;
    const separator = this.getSeparator();
    const oldText = this.document.getText();
    const lines = oldText.split(/\r?\n/);
    let editSucceeded = false;

    if (row < lines.length) {
      const line = lines[row];
      const cells = line.split(separator);
      if (col < cells.length) {
        let startColOffset = 0;
        for (let i = 0; i < col; i++) {
          startColOffset += cells[i].length + separator.length;
        }
        const oldCellText = cells[col];
        const startPos = new vscode.Position(row, startColOffset);
        const endPos = new vscode.Position(row, startColOffset + oldCellText.length);
        const range = new vscode.Range(startPos, endPos);
        const edit = new vscode.WorkspaceEdit();
        edit.replace(this.document.uri, range, value);
        editSucceeded = await vscode.workspace.applyEdit(edit);
      }
    }

    // If a direct cell edit fails, rebuild the entire CSV.
    if (!editSucceeded) {
      const result = Papa.parse(oldText, { dynamicTyping: false, delimiter: separator });
      const data = result.data as string[][];
      while (data.length <= row) data.push([]);
      while (data[row].length <= col) data[row].push('');
      data[row][col] = value;
      const newCsvText = Papa.unparse(data, { delimiter: separator });
      const fullRange = new vscode.Range(0, 0, this.document.lineCount, this.document.lineCount ? this.document.lineAt(this.document.lineCount - 1).text.length : 0);
      const edit = new vscode.WorkspaceEdit();
      edit.replace(this.document.uri, fullRange, newCsvText);
      await vscode.workspace.applyEdit(edit);
    }
    this.isUpdatingDocument = false;
    console.log(`CSV: Updated row ${row + 1}, column ${col + 1} to "${value}"`);
    this.currentWebviewPanel?.webview.postMessage({ type: 'updateCell', row, col, value });
  }

  /**
   * Saves the CSV document.
   */
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

  /**
   * Inserts a new empty column at the specified index for all rows.
   */
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
    const fullRange = new vscode.Range(0, 0, this.document.lineCount, this.document.lineCount ? this.document.lineAt(this.document.lineCount - 1).text.length : 0);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(this.document.uri, fullRange, newText);
    await vscode.workspace.applyEdit(edit);
    this.isUpdatingDocument = false;
    this.updateWebviewContent();
  }

  /**
   * Deletes the column at the specified index from all rows.
   */
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
    const fullRange = new vscode.Range(0, 0, this.document.lineCount, this.document.lineCount ? this.document.lineAt(this.document.lineCount - 1).text.length : 0);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(this.document.uri, fullRange, newText);
    await vscode.workspace.applyEdit(edit);
    this.isUpdatingDocument = false;
    this.updateWebviewContent();
  }
  /* ───────────── NEW SORT COLUMN METHOD ───────────── */
  /**
   * Sorts the CSV rows (skipping the header if it is being treated as one)
   * by the given column index, ascending ⇧ or descending ⇩.
   */
  private async sortColumn(index: number, ascending: boolean) {
    this.isUpdatingDocument = true;

    const config       = vscode.workspace.getConfiguration('csv');
    const separator    = this.getSeparator();
    const treatHeader  = config.get<boolean>('treatFirstRowAsHeader', true);

    const text   = this.document.getText();
    const result = Papa.parse(text, { dynamicTyping: false, delimiter: separator });
    const rows   = result.data as string[][];

    let header: string[] = [];
    let body:   string[][] = rows;

    if (treatHeader && rows.length) {
      header = rows[0];
      body   = rows.slice(1);
    }

    const cmp = (a: string, b: string) => {
      const na = parseFloat(a), nb = parseFloat(b);
      if (!isNaN(na) && !isNaN(nb)) return na - nb;        // numeric compare
      return a.localeCompare(b, undefined, { sensitivity: 'base' });
    };

    body.sort((r1, r2) => {
      const diff = cmp(r1[index] ?? '', r2[index] ?? '');
      return ascending ? diff : -diff;
    });

    const newCsv = Papa.unparse(treatHeader ? [header, ...body] : body, { delimiter: separator });

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


  /* ───────────── NEW ROW METHODS ───────────── */

  /**
   * Inserts a new empty row at the specified index.
   */
  private async insertRow(index: number) {
    this.isUpdatingDocument = true;
    const separator = this.getSeparator();
    const text = this.document.getText();
    const result = Papa.parse(text, { dynamicTyping: false, delimiter: separator });
    const data = result.data as string[][];
    const numColumns = Math.max(...data.map(r => r.length), 0);
    const newRow = Array(numColumns).fill('');
    if (index > data.length) {
      while (data.length < index) data.push(Array(numColumns).fill(''));
    }
    data.splice(index, 0, newRow);
    const newText = Papa.unparse(data, { delimiter: separator });
    const fullRange = new vscode.Range(0, 0, this.document.lineCount, this.document.lineCount ? this.document.lineAt(this.document.lineCount - 1).text.length : 0);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(this.document.uri, fullRange, newText);
    await vscode.workspace.applyEdit(edit);
    this.isUpdatingDocument = false;
    this.updateWebviewContent();
  }

  /**
   * Deletes the row at the specified index.
   */
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
    const fullRange = new vscode.Range(0, 0, this.document.lineCount, this.document.lineCount ? this.document.lineAt(this.document.lineCount - 1).text.length : 0);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(this.document.uri, fullRange, newText);
    await vscode.workspace.applyEdit(edit);
    this.isUpdatingDocument = false;
    this.updateWebviewContent();
  }

  // ───────────── Webview Rendering Methods ─────────────

  /**
   * Parses the CSV text and updates the webview with a rendered HTML table.
   */
  private updateWebviewContent() {
    const config = vscode.workspace.getConfiguration('csv');
    const treatHeader = config.get<boolean>('treatFirstRowAsHeader', true);
    const addSerialIndex = config.get<boolean>('addSerialIndex', false);
    const separator = this.getSeparator();
    const text = this.document.getText();
    let result;
    try {
      result = Papa.parse(text, { dynamicTyping: false, delimiter: separator });
      console.log(`CSV: Parsed CSV data with ${result.data.length} rows`);
    } catch (error) {
      console.error('CSV: Error parsing CSV content', error);
      result = { data: [] };
    }
    /* Prefer csv.fontFamily if set, otherwise fall back to the workspace-wide editor.fontFamily
      and finally to a hard-coded Menlo default. */
    const fontFamily =
      config.get<string>('fontFamily') ||
      vscode.workspace.getConfiguration('editor').get<string>('fontFamily', 'Menlo');
    const cellPadding = config.get<number>('cellPadding', 4);
    const data = result.data as string[][];
    const htmlContent = this.generateHtmlContent(data, treatHeader, addSerialIndex, fontFamily);
    const nonce = getNonce();
    this.currentWebviewPanel!.webview.html = this.wrapHtml(htmlContent, nonce, fontFamily, cellPadding);
  }

  /**
   * Generates an HTML table from CSV data.
   */
  private generateHtmlContent(data: string[][], treatHeader: boolean, addSerialIndex: boolean, fontFamily: string): string {
    /* ──────── NEW: ensure at least one editable cell ──────── */
    if (data.length === 0) {
      data.push(['']);          // single empty row + cell
      treatHeader = false;      // no header in an empty sheet
    }

    const isDark = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark;
    const headerRow = treatHeader ? data[0] : [];
    const bodyData = treatHeader ? data.slice(1) : data;
    const numColumns = Math.max(...data.map(row => row.length));
    const columnData = Array.from({ length: numColumns }, (_, i) => bodyData.map(row => row[i] || ''));
    const columnTypes = columnData.map(col => this.estimateColumnDataType(col));
    const columnColors = columnTypes.map((type, i) => this.getColumnColor(type, isDark, i));
    const columnWidths = this.computeColumnWidths(data);
    /* ──────────── VIRTUAL-SCROLL SUPPORT ──────────── */
    const CHUNK_SIZE = 1000;                           // rows per chunk
    const allRows      = treatHeader ? bodyData : data;
    const chunks: string[] = [];

    if (allRows.length > CHUNK_SIZE) {
      for (let i = CHUNK_SIZE; i < allRows.length; i += CHUNK_SIZE) {
        const htmlChunk = allRows.slice(i, i + CHUNK_SIZE).map((row, localR) => {
          const absRow = treatHeader ? i + localR + 1 : i + localR;
          const cells  = row.map((cell, cIdx) => {
            const safe = this.escapeHtml(cell);
            return `<td tabindex="0" style="min-width:${Math.min(columnWidths[cIdx]||0,100)}ch;max-width:100ch;border:1px solid ${isDark?'#555':'#ccc'};color:${columnColors[cIdx]};overflow:hidden;white-space:nowrap;text-overflow:ellipsis;" data-row="${absRow}" data-col="${cIdx}">${safe}</td>`;
          }).join('');

          return `<tr>${
            addSerialIndex ? `<td tabindex="0" style="min-width:4ch;max-width:4ch;border:1px solid ${isDark?'#555':'#ccc'};color:#888;" data-row="${absRow}" data-col="-1">${absRow}</td>` : ''
          }${cells}</tr>`;
        }).join('');

        chunks.push(htmlChunk);
      }

      // keep **only** the first chunk in the initial render
      if (treatHeader) bodyData.length = CHUNK_SIZE;
      else             data.length     = CHUNK_SIZE;
    }
    /* ────────── END VIRTUAL-SCROLL SUPPORT ────────── */

    let tableHtml = `<table>`;
    if (treatHeader) {
      tableHtml += `<thead><tr>${
        addSerialIndex
          ? `<th style="min-width: 4ch; max-width: 4ch; border: 1px solid ${isDark ? '#555' : '#ccc'}; background-color: ${isDark ? '#1e1e1e' : '#ffffff'}; color: #888;">#</th>`
          : ''
      }`;
      headerRow.forEach((cell, i) => {
        const safe = this.escapeHtml(cell);
        tableHtml += `<th style="min-width: ${Math.min(columnWidths[i] || 0, 100)}ch; max-width: 100ch; border: 1px solid ${isDark ? '#555' : '#ccc'}; background-color: ${isDark ? '#1e1e1e' : '#ffffff'}; color: ${columnColors[i]}; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;" data-row="0" data-col="${i}">${safe}</th>`;
      });
      tableHtml += `</tr></thead><tbody>`;
      bodyData.forEach((row, r) => {
        tableHtml += `<tr>${
          addSerialIndex
            ? `<td tabindex="0" style="min-width: 4ch; max-width: 4ch; border: 1px solid ${isDark ? '#555' : '#ccc'}; color: #888;" data-row="${r + 1}" data-col="-1">${r + 1}</td>`
            : ''
        }`;
        row.forEach((cell, i) => {
          const safe = this.escapeHtml(cell);
          tableHtml += `<td tabindex="0" style="min-width: ${Math.min(columnWidths[i] || 0, 100)}ch; max-width: 100ch; border: 1px solid ${isDark ? '#555' : '#ccc'}; color: ${columnColors[i]}; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;" data-row="${r + 1}" data-col="${i}">${safe}</td>`;
        });
        tableHtml += `</tr>`;
      });
      tableHtml += `</tbody>`;
    } else {
      tableHtml += `<tbody>`;
      data.forEach((row, r) => {
        tableHtml += `<tr>${
          addSerialIndex
            ? `<td tabindex="0" style="min-width: 4ch; max-width: 4ch; border: 1px solid ${isDark ? '#555' : '#ccc'}; color: #888;" data-row="${r}" data-col="-1">${r + 1}</td>`
            : ''
        }`;
        row.forEach((cell, i) => {
          const safe = this.escapeHtml(cell);
          tableHtml += `<td tabindex="0" style="min-width: ${Math.min(columnWidths[i] || 0, 100)}ch; max-width: 100ch; border: 1px solid ${isDark ? '#555' : '#ccc'}; color: ${columnColors[i]}; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;" data-row="${r}" data-col="${i}">${safe}</td>`;
        });
        tableHtml += `</tr>`;
      });
      tableHtml += `</tbody>`;
    }
    tableHtml += `</table>`;
    const chunksJson = JSON.stringify(chunks);
    return `
      <script id="__csvChunks" type="application/json">${chunksJson}</script>
      <div class="table-container">${tableHtml}</div>
    `;
  }

  /**
   * Wraps the provided HTML content in a complete HTML document with a strict Content Security Policy.
   */
  private wrapHtml(content: string, nonce: string, fontFamily: string, cellPadding: number): string {
    const isDark = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark;
    return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>CSV</title>
    <style nonce="${nonce}">
      body { font-family: ${fontFamily}; margin: 0; padding: 0; user-select: none; }
      .table-container { overflow-x: auto; max-height: 100vh; }
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
        font-family: ${fontFamily};
      }
      #findWidget input {
        border: 1px solid #ccc;
        border-radius: 3px;
        padding: 4px 8px;
        font-size: 14px;
        width: 250px;
      }
      #findWidget span {
        margin-left: 8px;
        font-size: 14px;
        color: #666;
      }
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
      #contextMenu { position: absolute; display: none; background: ${isDark ? '#2d2d2d' : '#ffffff'}; border: 1px solid ${isDark ? '#555' : '#ccc'}; z-index: 10000; font-family: ${fontFamily}; }
      #contextMenu div { padding: 4px 12px; cursor: pointer; }
      #contextMenu div:hover { background: ${isDark ? '#3d3d3d' : '#eeeeee'}; }
    </style>
  </head>
  <body>
    ${content}
    <div id="findWidget">
      <input id="findInput" type="text" placeholder="Find...">
      <span id="findStatus"></span>
      <button id="findClose">✕</button>
    </div>
    <div id="contextMenu"></div>
    <script nonce="${nonce}">
      document.body.setAttribute('tabindex', '0'); document.body.focus();
      const vscode = acquireVsCodeApi();
      let lastContextIsHeader = false;   // remembers whether we right-clicked a <th>
      let isUpdating = false, isSelecting = false, anchorCell = null, currentSelection = [];
      let startCell = null, endCell = null, selectionMode = "cell";
      let editingCell = null, originalCellValue = "";
      const table = document.querySelector('table');
      /* ──────────── VIRTUAL-SCROLL LOADER ──────────── */
      const CHUNK_SIZE = 1000;
      const chunkScript = document.getElementById('__csvChunks');
      let csvChunks = chunkScript ? JSON.parse(chunkScript.textContent) : [];

      if (csvChunks.length) {
        const scrollContainer = document.querySelector('.table-container');
        const tbody           = table.tBodies[0];

        const loadNextChunk = () => {
          if (!csvChunks.length) return;
          tbody.insertAdjacentHTML('beforeend', csvChunks.shift());
        };

        // Use IntersectionObserver on the last row for efficiency
        const io = new IntersectionObserver((entries)=>{
          if (entries[0].isIntersecting) {
            loadNextChunk();
            // observe the new last <tr>
            io.observe(tbody.querySelector('tr:last-child'));
          }
        }, { root: scrollContainer, rootMargin: '0px 0px 200px 0px' });

        // initial observation
        io.observe(tbody.querySelector('tr:last-child'));
      }
      /* ───────── END VIRTUAL-SCROLL LOADER ───────── */

      const hasHeader = document.querySelector('thead') !== null;
      const getCellCoords = cell => ({ row: parseInt(cell.getAttribute('data-row')), col: parseInt(cell.getAttribute('data-col')) });
      const clearSelection = () => { currentSelection.forEach(c => c.classList.remove('selected')); currentSelection = []; };
      const contextMenu = document.getElementById('contextMenu');

      /* ──────── UPDATED showContextMenu ──────── */
      const showContextMenu = (x, y, row, col) => {
        contextMenu.innerHTML = '';
        const item = (label, cb) => {
          const d = document.createElement('div');
          d.textContent = label;
          d.addEventListener('click', () => { cb(); contextMenu.style.display = 'none'; });
          contextMenu.appendChild(d);
        };
        const divider = () => {
          const d = document.createElement('div');
          d.style.borderTop = '1px solid #888';
          d.style.margin = '1px 0';
          contextMenu.appendChild(d);
        };
        let addedRowItems = false;

        /* Header-only: SORT functionality */
        if (lastContextIsHeader) {
          item('Sort: A-Z', () =>
            vscode.postMessage({ type: 'sortColumn', index: col, ascending: true }));
          item('Sort: Z-A', () =>
            vscode.postMessage({ type: 'sortColumn', index: col, ascending: false }));
        }        

        /* Row section */
        if (!isNaN(row) && row >= 0) {
          if (contextMenu.children.length) divider();
          item('Add ROW: above', () => vscode.postMessage({ type: 'insertRow',   index: row     }));
          item('Add ROW: below', () => vscode.postMessage({ type: 'insertRow',   index: row + 1 }));
          item('Delete ROW',      () => vscode.postMessage({ type: 'deleteRow',  index: row     }));
          addedRowItems = true;
        }

        /* Column section, preceded by divider if row items exist */
        if (!isNaN(col) && col >= 0) {
          if (addedRowItems) divider();
          item('Add COLUMN: left',  () => vscode.postMessage({ type: 'insertColumn', index: col     }));
          item('Add COLUMN: right', () => vscode.postMessage({ type: 'insertColumn', index: col + 1 }));
          item('Delete COLUMN',     () => vscode.postMessage({ type: 'deleteColumn', index: col     }));
        }

        contextMenu.style.left = x + 'px';
        contextMenu.style.top = y + 'px';
        contextMenu.style.display = 'block';
      };

      document.addEventListener('click', () => { contextMenu.style.display = 'none'; });

      /* ──────── UPDATED contextmenu listener ──────── */
      table.addEventListener('contextmenu', e => {
        const target = e.target;
        if(target.tagName !== 'TH' && target.tagName !== 'TD') return;
        const colAttr = target.getAttribute('data-col');
        const rowAttr = target.getAttribute('data-row');
        const col = parseInt(colAttr);
        const row = parseInt(rowAttr);
        if ((isNaN(col) || col === -1) && (isNaN(row) || row === -1)) return;
        e.preventDefault();
        lastContextIsHeader = target.tagName === 'TH';
        showContextMenu(e.pageX, e.pageY, row, col);
      });

      table.addEventListener('mousedown', e => {
        if(e.target.tagName !== 'TD' && e.target.tagName !== 'TH') return;
        const target = e.target;

        // ──────── NEW: Shift+Click range selection ────────
        if (
          e.shiftKey &&
          anchorCell &&
          !editingCell &&
          target.getAttribute('data-row') !== null &&
          target.getAttribute('data-col') !== null &&
          anchorCell.getAttribute('data-row') !== null &&
          anchorCell.getAttribute('data-col') !== null &&
          target.getAttribute('data-col') !== '-1' &&
          anchorCell.getAttribute('data-col') !== '-1'
        ) {
          e.preventDefault();
          selectRange(
            getCellCoords(anchorCell),
            getCellCoords(target)
          );
          anchorCell.focus();
          return;
        }

        if(editingCell){ if(e.target !== editingCell) editingCell.blur(); else return; } else clearSelection();

        /* ──────── NEW: select-all via top-left header cell ──────── */
        if (
          target.tagName === 'TH' &&                 // header cell
          !target.hasAttribute('data-col') &&        // serial-index header has *no* data-col
          !target.hasAttribute('data-row')           // and no data-row
        ) {
          e.preventDefault();                        // stop normal selection
          clearSelection();
          selectAllCells();                          // highlight every th & td
          isSelecting = false;                       // cancel drag-select logic
          anchorCell  = null;
          return;                                    // done
        }
        /* ──────── END NEW BLOCK ──────── */
        
        selectionMode = (target.tagName === 'TH') ? "column" : (target.getAttribute('data-col') === '-1' ? "row" : "cell");
        startCell = target; endCell = target; isSelecting = true; e.preventDefault();
        target.focus();
      });
      table.addEventListener('mousemove', e => {
        if(!isSelecting) return;
        let target = e.target;
        if(selectionMode === "cell"){
          if(target.tagName === 'TD' || target.tagName === 'TH'){
            endCell = target;
            selectRange(getCellCoords(startCell), getCellCoords(endCell));
          }
        } else if(selectionMode === "column"){
          if(target.tagName !== 'TH'){
            const col = target.getAttribute('data-col');
            target = table.querySelector('thead th[data-col="'+col+'"]') || target;
          }
          endCell = target;
          const startCol = parseInt(startCell.getAttribute('data-col'));
          const endCol = parseInt(endCell.getAttribute('data-col'));
          selectFullColumnRange(startCol, endCol);
        } else if(selectionMode === "row"){
          if(target.getAttribute('data-col') !== '-1'){
            const row = target.getAttribute('data-row');
            target = table.querySelector('td[data-col="-1"][data-row="'+row+'"]') || target;
          }
          endCell = target;
          const startRow = parseInt(startCell.getAttribute('data-row'));
          const endRow = parseInt(endCell.getAttribute('data-row'));
          selectFullRowRange(startRow, endRow);
        }
      });
      table.addEventListener('mouseup', e => {
        if(!isSelecting) return;
        isSelecting = false;
        if(selectionMode === "cell"){
          if(startCell === endCell){
            clearSelection(); startCell.classList.add('selected'); currentSelection.push(startCell); anchorCell = startCell;
          } else { anchorCell = startCell; }
        } else if(selectionMode === "column"){
          const startCol = parseInt(startCell.getAttribute('data-col'));
          const endCol = parseInt(endCell.getAttribute('data-col'));
          selectFullColumnRange(startCol, endCol); anchorCell = startCell;
        } else if(selectionMode === "row"){
          const startRow = parseInt(startCell.getAttribute('data-row'));
          const endRow = parseInt(endCell.getAttribute('data-row'));
          selectFullRowRange(startRow, endRow); anchorCell = startCell;
        }
      });
      const selectRange = (start, end) => {
        clearSelection();
        const minRow = Math.min(start.row, end.row), maxRow = Math.max(start.row, end.row);
        const minCol = Math.min(start.col, end.col), maxCol = Math.max(start.col, end.col);
        for(let r = minRow; r <= maxRow; r++){
          for(let c = minCol; c <= maxCol; c++){
            const selector = (hasHeader && r === 0 ? 'th' : 'td') + '[data-row="'+r+'"][data-col="'+c+'"]';
            const selCell = table.querySelector(selector);
            if(selCell){ selCell.classList.add('selected'); currentSelection.push(selCell); }
          }
        }
      };
      const selectFullColumnRange = (col1, col2) => {
        clearSelection();
        const minCol = Math.min(col1, col2), maxCol = Math.max(col1, col2);
        table.querySelectorAll('tr').forEach(row => {
          Array.from(row.children).forEach(cell => {
            const cellCol = cell.getAttribute('data-col');
            if(cellCol !== null && parseInt(cellCol) >= minCol && parseInt(cellCol) <= maxCol){
              cell.classList.add('selected'); currentSelection.push(cell);
            }
          });
        });
      };
      const selectFullRowRange = (row1, row2) => {
        clearSelection();
        const minRow = Math.min(row1, row2), maxRow = Math.max(row1, row2);
        table.querySelectorAll('tr').forEach(row => {
          Array.from(row.children).forEach(cell => {
            const r = cell.getAttribute('data-row');
            if(r !== null && parseInt(r) >= minRow && parseInt(r) <= maxRow){
              cell.classList.add('selected'); currentSelection.push(cell);
            }
          });
        });
      };
      const findWidget = document.getElementById('findWidget');
      const findInput = document.getElementById('findInput');
      const findStatus = document.getElementById('findStatus');
      const findClose = document.getElementById('findClose');
      let findMatches = [];
      let currentMatchIndex = -1;
      const updateFindStatus = () => { findStatus.innerText = findMatches.length > 0 ? (currentMatchIndex+1) + " of " + findMatches.length + " (Cmd+G to advance)" : ""; };
      const updateFindMatches = () => {
        const query = findInput.value.toLowerCase();
        document.querySelectorAll('.highlight, .active-match').forEach(el => { el.classList.remove('highlight'); el.classList.remove('active-match'); });
        findMatches = [];
        if(query === ""){ updateFindStatus(); return; }
        document.querySelectorAll('td, th').forEach(cell => {
          if(cell.innerText.toLowerCase().includes(query)){
            findMatches.push(cell); cell.classList.add('highlight');
          }
        });
        if(findMatches.length > 0){
          currentMatchIndex = 0;
          findMatches[currentMatchIndex].classList.add('active-match');
          findMatches[currentMatchIndex].scrollIntoView({block:'center', inline:'center', behavior:'smooth'});
        }
        updateFindStatus();
      };
      findInput.addEventListener('input', updateFindMatches);
      findInput.addEventListener('keydown', e => {
        if(e.key === 'Escape'){
          findWidget.style.display = 'none'; findInput.value = "";
          document.querySelectorAll('.highlight, .active-match').forEach(el => { el.classList.remove('highlight'); el.classList.remove('active-match'); });
          findStatus.innerText = ""; findInput.blur();
        }
        if((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'g'){
          e.preventDefault();
          if(findMatches.length === 0) return;
          findMatches[currentMatchIndex].classList.remove('active-match');
          currentMatchIndex = e.shiftKey ? (currentMatchIndex - 1 + findMatches.length) % findMatches.length : (currentMatchIndex + 1) % findMatches.length;
          findMatches[currentMatchIndex].classList.add('active-match');
          findMatches[currentMatchIndex].scrollIntoView({block:'center', inline:'center', behavior:'smooth'});
          updateFindStatus();
        }
      });
      findClose.addEventListener('click', () => { findWidget.style.display = 'none'; findInput.value = "";
        document.querySelectorAll('.highlight, .active-match').forEach(el => { el.classList.remove('highlight'); el.classList.remove('active-match'); });
        findStatus.innerText = ""; findInput.blur();
      });
      document.addEventListener('keydown', e => {
        if((e.ctrlKey || e.metaKey) && e.key === 'f'){
          e.preventDefault(); findWidget.style.display = 'block'; findInput.focus(); return;
        }
        if ((e.ctrlKey || e.metaKey) && e.key === 'a' && !editingCell) {
          e.preventDefault(); selectAllCells(); return;
        }
        if ((e.ctrlKey || e.metaKey) && e.key === 'c' && currentSelection.length > 0) {
          e.preventDefault(); copySelectionToClipboard(); return;
        }

        /* ──────── NEW: ENTER + DIRECT TYPING HANDLERS ──────── */
        if (!editingCell && anchorCell && currentSelection.length === 1) {
          /* Enter opens edit mode */
          if (e.key === 'Enter') {
            e.preventDefault();
            editCell(anchorCell);
            return;
          }
          /* Typing clears cell and opens edit mode */
          if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
            e.preventDefault();
            const cell = anchorCell;
            editCell(cell);
            cell.innerText = '';
            if (document.execCommand) {
              document.execCommand('insertText', false, e.key);
            } else {
              cell.innerText = e.key;
            }
            setCursorToEnd(cell);
            return;
          }
        }

        /* ──────── ARROW KEY NAVIGATION ──────── */
        if (!editingCell && anchorCell && ['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key)) {
          const { row, col } = getCellCoords(anchorCell);
          let targetRow = row, targetCol = col;
          switch(e.key){
            case 'ArrowUp':   targetRow = row - 1; break;
            case 'ArrowDown': targetRow = row + 1; break;
            case 'ArrowLeft': targetCol = col - 1; break;
            case 'ArrowRight':targetCol = col + 1; break;
          }
          if(targetRow < 0 || targetCol < 0) return;
          const tag = (hasHeader && targetRow === 0 ? 'th' : 'td');
          const nextCell = table.querySelector(\`\${tag}[data-row="\${targetRow}"][data-col="\${targetCol}"]\`);
          if(nextCell){
            e.preventDefault();
            clearSelection();
            nextCell.classList.add('selected');
            currentSelection.push(nextCell);
            anchorCell = nextCell;
            nextCell.focus({preventScroll:true});
            nextCell.scrollIntoView({ block:'nearest', inline:'nearest', behavior:'smooth' });
          }
          return;
        }

        if (editingCell && ((e.ctrlKey || e.metaKey) && e.key === 's')) {
          e.preventDefault();
          editingCell.blur();
          vscode.postMessage({ type: 'save' });
        }
        if (editingCell && e.key === 'Enter') {
          e.preventDefault();
          const { row, col } = getCellCoords(editingCell);
          editingCell.blur();
          const nextCell = table.querySelector('td[data-row="'+(row+1)+'"][data-col="'+col+'"]');
          if (nextCell) editCell(nextCell);
        }
        if (editingCell && e.key === 'Tab') {
          e.preventDefault();
          const { row, col } = getCellCoords(editingCell);
          editingCell.blur();
          let nextCell;
          if (e.shiftKey) {
            nextCell = table.querySelector('td[data-row="'+row+'"][data-col="'+(col-1)+'"]');
          } else {
            nextCell = table.querySelector('td[data-row="'+row+'"][data-col="'+(col+1)+'"]');
          }
          if (nextCell) {
            editCell(nextCell);
          }
        }
        if (editingCell && e.key === 'Escape') {
          e.preventDefault(); editingCell.innerText = originalCellValue; editingCell.blur();
        }
        if (!editingCell && e.key === 'Escape') {
          clearSelection();
        }
      });
      const selectAllCells = () => { clearSelection(); document.querySelectorAll('td, th').forEach(cell => { cell.classList.add('selected'); currentSelection.push(cell); }); };
      const setCursorToEnd = cell => { setTimeout(() => { 
        const range = document.createRange(); range.selectNodeContents(cell); range.collapse(false);
        const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
      }, 10); };
      const setCursorAtPoint = (cell, x, y) => {
        let range;
        if(document.caretRangeFromPoint) { range = document.caretRangeFromPoint(x,y); }
        else if(document.caretPositionFromPoint) { let pos = document.caretPositionFromPoint(x,y); range = document.createRange(); range.setStart(pos.offsetNode, pos.offset); }
        if(range){ let sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range); }
      };
      const editCell = (cell, event) => {
        if(editingCell === cell) return;
        if(editingCell) editingCell.blur();
        cell.classList.remove('selected');
        originalCellValue = cell.textContent;
        editingCell = cell;
        cell.classList.add('editing');
        cell.setAttribute('contenteditable', 'true');
        cell.focus();
        const onBlurHandler = () => {
          const value = cell.textContent;
          const coords = getCellCoords(cell);
          vscode.postMessage({ type: 'editCell', row: coords.row, col: coords.col, value: value });
          cell.removeAttribute('contenteditable');
          cell.classList.remove('editing');
          editingCell = null;
          cell.removeEventListener('blur', onBlurHandler);
        };
        cell.addEventListener('blur', onBlurHandler);
        event ? setCursorAtPoint(cell, event.clientX, event.clientY) : setCursorToEnd(cell);
      };
      table.addEventListener('dblclick', e => { const target = e.target; if(target.tagName !== 'TD' && target.tagName !== 'TH') return; clearSelection(); editCell(target, e); });
      const copySelectionToClipboard = () => {
        if (currentSelection.length === 0) return;

        const coords = currentSelection
          .map(cell => getCellCoords(cell))
          .filter(c => !isNaN(c.row) && !isNaN(c.col));   // ← keep only valid cells
        if (coords.length === 0) return;                  // nothing to copy
        const minRow = Math.min(...coords.map(c => c.row)), maxRow = Math.max(...coords.map(c => c.row));
        const minCol = Math.min(...coords.map(c => c.col)), maxCol = Math.max(...coords.map(c => c.col));
        let csv = '';
        for(let r = minRow; r <= maxRow; r++){
          let rowVals = [];
          for(let c = minCol; c <= maxCol; c++){
            const selector = (hasHeader && r === 0 ? 'th' : 'td') + '[data-row="'+r+'"][data-col="'+c+'"]';
            const cell = table.querySelector(selector);
            rowVals.push(cell ? cell.innerText : '');
          }
          csv += rowVals.join(',') + '\\n';
        }
        vscode.postMessage({ type: 'copyToClipboard', text: csv.trimEnd() });
      };
      window.addEventListener('message', event => {
        const message = event.data;
        if(message.type === 'focus'){
          document.body.focus();
        } else if(message.type === 'updateCell'){
          isUpdating = true;
          const { row, col, value } = message;
          const cell = table.querySelector('td[data-row="'+row+'"][data-col="'+col+'"]');
          if (cell) { cell.textContent = value; }
          isUpdating = false;
        }
      });
      document.addEventListener('keydown', e => {
        if(!editingCell && e.key === 'Escape'){
          clearSelection();
        }
      });
    </script>
  </body>
</html>`;
  }

  // ───────────── Utility Methods ─────────────

  /**
   * Computes maximum column widths (in character count) for all columns.
   */
  private computeColumnWidths(data: string[][]): number[] {
    const numColumns = Math.max(...data.map(row => row.length));
    const widths = Array(numColumns).fill(0);
    for (const row of data) {
      for (let i = 0; i < numColumns; i++){
        widths[i] = Math.max(widths[i], (row[i] || '').length);
      }
    }
    console.log(`CSV: Column widths: ${widths}`);
    return widths;
  }

  /**
   * Determines the delimiter to use based on configuration and file extension.
   * `.tsv` files default to a tab separator when the setting is untouched.
   */
  private getSeparator(): string {
    const config = vscode.workspace.getConfiguration('csv');
    let sep = config.get<string>('separator', ',');
    if (sep === ',' && this.document?.uri.fsPath.toLowerCase().endsWith('.tsv')) {
      sep = '\t';
    }
    return sep;
  }

  /**
   * Escapes HTML special characters in a string to prevent injection.
   */
  private escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, m => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    })[m] as string);
  }

  /**
   * Checks whether a string can be parsed as a date.
   */
  private isDate(value: string): boolean {
    return !isNaN(Date.parse(value));
  }

  /**
   * Estimates the data type of a CSV column based on its content.
   */
  private estimateColumnDataType(column: string[]): string {
    let allBoolean = true, allDate = true, allInteger = true, allFloat = true, allEmpty = true;
    for (const cell of column) {
      const items = cell.split(',').map(item => item.trim());
      for (const item of items){
        if (item === '') continue;
        allEmpty = false;
        const lower = item.toLowerCase();
        if (!(lower === 'true' || lower === 'false')) allBoolean = false;
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

  /**
   * Returns a color (in hex) for a column based on its estimated type, current theme, and column index.
   */
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

  /**
   * Converts HSL values to a hex color string.
   */
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
}

/**
 * Generates a random nonce string for Content Security Policy.
 */
function getNonce() {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++){
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

export { CsvEditorProvider };
