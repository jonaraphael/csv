import Papa from 'papaparse';
import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
  console.log('CSV: Extension activated');
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      CsvEditorProvider.viewType,
      new CsvEditorProvider(context),
      { supportsMultipleEditorsPerDocument: false }
    )
  );
}

export function deactivate() {
  console.log('CSV: Extension deactivated');
}

class CsvEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = 'csv.editor';
  private isUpdatingDocument = false;
  private isSaving = false;
  private currentWebviewPanel: vscode.WebviewPanel | undefined;

  constructor(private readonly context: vscode.ExtensionContext) { }

  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    console.log('CSV: resolveCustomTextEditor called');
    this.currentWebviewPanel = webviewPanel;
    webviewPanel.webview.options = { enableScripts: true };
    this.updateWebviewContent(document, webviewPanel.webview);

    webviewPanel.webview.onDidReceiveMessage(async e => {
      switch (e.type) {
        case 'editCell':
          this.updateDocument(document, e.row, e.col, e.value);
          break;
        case 'save':
          await this.handleSave(document);
          break;
        case 'copyToClipboard':
          await vscode.env.clipboard.writeText(e.text);
          console.log('CSV: Copied to clipboard from extension side');
          break;
      }
    });

    let updateTimeout: NodeJS.Timeout | undefined;
    const changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument(e => {
      if (e.document.uri.toString() === document.uri.toString()) {
        if (this.isUpdatingDocument || this.isSaving) return;
        clearTimeout(updateTimeout);
        updateTimeout = setTimeout(() => {
          console.log('CSV: Document changed externally, updating webview');
          this.updateWebviewContent(document, webviewPanel.webview);
        }, 250);
      }
    });

    webviewPanel.onDidDispose(() => {
      console.log('CSV: Webview disposed');
      changeDocumentSubscription.dispose();
      this.currentWebviewPanel = undefined;
    });
  }

  private async handleSave(document: vscode.TextDocument) {
    this.isSaving = true;
    try {
      const success = await document.save();
      if (success) {
        console.log('CSV: Document saved');
      } else {
        console.error('CSV: Failed to save document');
      }
    } catch (error) {
      console.error('CSV: Error saving document', error);
    } finally {
      this.isSaving = false;
    }
  }

  private async updateDocument(document: vscode.TextDocument, row: number, col: number, value: string) {
    this.isUpdatingDocument = true;
    const edit = new vscode.WorkspaceEdit();
    const csvText = document.getText();
    const result = Papa.parse(csvText, { dynamicTyping: false });
    const data = result.data as string[][];

    // Ensure the target row exists
    while (data.length <= row) {
      data.push([]);
    }
    // Ensure the target column exists
    while (data[row].length <= col) {
      data[row].push('');
    }
    data[row][col] = value;

    const newCsvText = Papa.unparse(data);
    const fullRange = new vscode.Range(0, 0, document.lineCount, document.lineAt(document.lineCount - 1).text.length);
    edit.replace(document.uri, fullRange, newCsvText);
    const success = await vscode.workspace.applyEdit(edit);
    this.isUpdatingDocument = false;
    if (success) {
      console.log(`CSV: Updated row ${row + 1}, column ${col + 1} to "${value}"`);
      if (this.currentWebviewPanel) {
        this.currentWebviewPanel.webview.postMessage({
          type: 'updateCell',
          row: row,
          col: col,
          value: value
        });
      }
    } else {
      console.error('CSV: Failed to apply edit');
    }
  }

  private updateWebviewContent(document: vscode.TextDocument, webview: vscode.Webview) {
    console.log('CSV: Updating webview content');
    const text = document.getText();
    let data: string[][];
    try {
      const result = Papa.parse(text, { dynamicTyping: false });
      data = result.data as string[][];
      console.log(`CSV: Parsed CSV data with ${data.length} rows`);
    } catch (error) {
      console.error('CSV: Error parsing CSV content', error);
      data = [];
    }
    if (data.length === 0) {
      webview.html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>CSV</title>
  <style>body { font-family: monospace; padding: 10px; }</style>
</head>
<body>
  <p>No data found in CSV.</p>
</body>
</html>`;
      return;
    }

    const columnWidths = this.computeColumnWidths(data);
    console.log(`CSV: Computed column widths: ${columnWidths}`);
    const numColumns = Math.max(...data.map(row => row.length));
    let columnData: string[][] = Array.from({ length: numColumns }, () => []);
    for (let r = 1; r < data.length; r++) {
      const row = data[r];
      for (let i = 0; i < numColumns; i++) {
        columnData[i].push(row[i] || "");
      }
    }
    const columnTypes = columnData.map(col => this.estimateColumnDataType(col));
    const isDark = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark;
    const columnColors = columnTypes.map((type, index) => this.getColumnColor(type, isDark, index));

    let tableHtml = `<table>`;
    const header = data[0];
    tableHtml += `<thead><tr>`;
    for (let i = 0; i < header.length; i++) {
      const width = Math.min(columnWidths[i] || 0, 100);
      const color = columnColors[i];
      tableHtml += `<th style="min-width: ${width}ch; max-width: 100ch; border: 1px solid #555; background-color: ${isDark ? '#1e1e1e' : '#ffffff'}; color: ${color}; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;" data-row="0" data-col="${i}">${header[i]}</th>`;
    }
    tableHtml += `</tr></thead>`;
    tableHtml += `<tbody>`;
    for (let r = 1; r < data.length; r++) {
      const row = data[r];
      tableHtml += `<tr>`;
      for (let i = 0; i < row.length; i++) {
        const width = Math.min(columnWidths[i] || 0, 100);
        const color = columnColors[i];
        tableHtml += `<td tabindex="0" style="min-width: ${width}ch; max-width: 100ch; border: 1px solid #555; color: ${color}; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;" data-row="${r}" data-col="${i}">${row[i]}</td>`;
      }
      tableHtml += `</tr>`;
    }
    tableHtml += `</tbody></table>`;
    const nonce = getNonce();
    webview.html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CSV</title>
  <style nonce="${nonce}">
    body { font-family: monospace; margin: 0; padding: 0; user-select: none; }
    .table-container { overflow-x: auto; max-height: 100vh; }
    table { border-collapse: collapse; width: max-content; }
    th, td { padding: 4px 8px; overflow: hidden; cursor: default; position: relative; }
    th { position: sticky; top: 0; z-index: 2; }
    td.selected, th.selected { background-color: ${isDark ? '#333333' : '#cce0ff'} !important; }
    td.editing, th.editing { overflow: visible !important; white-space: normal !important; max-width: none !important; }
  </style>
</head>
<body>
  <div class="table-container">
    ${tableHtml}
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let isUpdating = false, isSelecting = false, anchorCell = null, currentSelection = [], startCell = null, endCell = null, editingCell = null, originalCellValue = null;
    const table = document.querySelector('table');
    function getCellCoords(cell) {
      return { row: parseInt(cell.getAttribute('data-row')), col: parseInt(cell.getAttribute('data-col')) };
    }
    function clearSelection() {
      currentSelection.forEach(c => c.classList.remove('selected'));
      currentSelection = [];
    }
    function selectRange(start, end) {
      clearSelection();
      const startRow = Math.min(start.row, end.row), endRow = Math.max(start.row, end.row);
      const startCol = Math.min(start.col, end.col), endCol = Math.max(start.col, end.col);
      for (let r = startRow; r <= endRow; r++) {
        for (let c = startCol; c <= endCol; c++) {
          const selector = (r === 0 ? 'th' : 'td') + '[data-row="'+r+'"][data-col="'+c+'"]';
          const selCell = table.querySelector(selector);
          if (selCell) { selCell.classList.add('selected'); currentSelection.push(selCell); }
        }
      }
    }
    table.addEventListener('mousedown', e => {
      if (e.target.tagName !== 'TD' && e.target.tagName !== 'TH') return;
      if (editingCell && editingCell !== e.target) editingCell.blur();
      if (e.shiftKey) { startCell = startCell || e.target; endCell = e.target; isSelecting = true; }
      else { startCell = e.target; endCell = e.target; isSelecting = true; }
      e.preventDefault();
    });
    table.addEventListener('mousemove', e => {
      if (!isSelecting) return;
      if (e.target.tagName === 'TD' || e.target.tagName === 'TH') {
        endCell = e.target;
        selectRange(getCellCoords(startCell), getCellCoords(endCell));
      }
    });
    table.addEventListener('mouseup', e => {
      if (!isSelecting) return;
      isSelecting = false;
      if (startCell === endCell) { clearSelection(); editCell(startCell); }
      else { anchorCell = startCell; }
    });
    table.addEventListener('click', e => {
      if (e.shiftKey && anchorCell && (e.target.tagName === 'TD' || e.target.tagName === 'TH')) {
        selectRange(getCellCoords(anchorCell), getCellCoords(e.target));
      } else if (!e.shiftKey && (e.target.tagName === 'TD' || e.target.tagName === 'TH')) {
        anchorCell = e.target;
      }
    });
    function setCursorToEnd(cell) {
      setTimeout(() => {
        const range = document.createRange();
        range.selectNodeContents(cell);
        range.collapse(false);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }, 10);
    }
    function editCell(cell) {
      if (editingCell === cell) return;
      if (editingCell) editingCell.blur();
      originalCellValue = cell.innerText;
      editingCell = cell;
      cell.classList.add('editing');
      cell.setAttribute('contenteditable', 'true');
      cell.focus();
      setCursorToEnd(cell);
    }
    table.addEventListener('blur', e => {
      if (!editingCell) return;
      if (e.target === editingCell) {
        const row = parseInt(editingCell.getAttribute('data-row')), col = parseInt(editingCell.getAttribute('data-col'));
        const value = editingCell.innerText;
        editingCell.removeAttribute('contenteditable');
        editingCell.classList.remove('editing');
        editingCell = null;
        vscode.postMessage({ type: 'editCell', row: row, col: col, value: value });
      }
    }, true);
    table.addEventListener('keydown', e => {
      if (editingCell && ((e.ctrlKey || e.metaKey) && e.key === 's')) {
        e.preventDefault();
        editingCell.blur();
        vscode.postMessage({ type: 'save' });
      }
      if (editingCell && e.key === 'Enter') {
        e.preventDefault();
        const row = parseInt(editingCell.getAttribute('data-row')), col = parseInt(editingCell.getAttribute('data-col'));
        editingCell.blur();
        const nextRow = row + 1;
        const nextCell = table.querySelector('td[data-row="'+nextRow+'"][data-col="'+col+'"]');
        if (nextCell) editCell(nextCell);
      }
      if (editingCell && e.key === 'Tab') {
        e.preventDefault();
        const row = parseInt(editingCell.getAttribute('data-row')), col = parseInt(editingCell.getAttribute('data-col'));
        editingCell.blur();
        const nextCol = col + 1;
        const nextCell = table.querySelector('td[data-row="'+row+'"][data-col="'+nextCol+'"]');
        if (nextCell) editCell(nextCell);
      }
      if (editingCell && e.key === 'Escape') {
        e.preventDefault();
        editingCell.innerText = originalCellValue;
        editingCell.blur();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'c' && currentSelection.length > 0) {
        e.preventDefault();
        copySelectionToClipboard();
      }
    });
    function copySelectionToClipboard() {
      if (currentSelection.length === 0) return;
      const coords = currentSelection.map(cell => getCellCoords(cell));
      const minRow = Math.min(...coords.map(c => c.row)), maxRow = Math.max(...coords.map(c => c.row));
      const minCol = Math.min(...coords.map(c => c.col)), maxCol = Math.max(...coords.map(c => c.col));
      let csv = '';
      for (let r = minRow; r <= maxRow; r++) {
        let rowVals = [];
        for (let c = minCol; c <= maxCol; c++) {
          const selector = (r === 0 ? 'th' : 'td') + '[data-row="'+r+'"][data-col="'+c+'"]';
          const cell = table.querySelector(selector);
          rowVals.push(cell ? cell.innerText : '');
        }
        csv += rowVals.join(',') + '\\n';
      }
      vscode.postMessage({ type: 'copyToClipboard', text: csv.trimEnd() });
    }
    window.addEventListener('message', event => {
      const message = event.data;
      if (message.type === 'updateCell') {
        isUpdating = true;
        const { row, col, value } = message;
        const cell = table.querySelector('td[data-row="'+row+'"][data-col="'+col+'"]');
        if (cell) { cell.innerText = value; }
        isUpdating = false;
      }
    });
  </script>
</body>
</html>`;
  }

  private computeColumnWidths(data: string[][]): number[] {
    const numColumns = Math.max(...data.map(row => row.length));
    const widths = new Array(numColumns).fill(0);
    for (let row of data) {
      for (let i = 0; i < numColumns; i++) {
        const cell = row[i] || '';
        widths[i] = Math.max(widths[i], cell.length);
      }
    }
    console.log(`CSV: Column widths: ${widths}`);
    return widths;
  }

  private isDate(value: string): boolean {
    const timestamp = Date.parse(value);
    return !isNaN(timestamp);
  }

  private estimateColumnDataType(column: string[]): string {
    let allBoolean = true, allDate = true, allInteger = true, allFloat = true, allEmpty = true;
    for (const cell of column) {
      const items = cell.split(',').map(item => item.trim());
      for (const item of items) {
        if (item === '') continue;
        allEmpty = false;
        const lower = item.toLowerCase();
        if (!(lower === 'true' || lower === 'false')) allBoolean = false;
        if (!this.isDate(item)) allDate = false;
        const num = Number(item);
        if (!Number.isInteger(num)) allInteger = false;
        if (isNaN(num)) { allFloat = false; }
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
    let hueRange = 0;
    let isDefault = false;
    switch (type) {
      case "boolean": hueRange = 30; break;
      case "date": hueRange = 210; break;
      case "float": hueRange = isDark ? 60 : 270; break;
      case "integer": hueRange = 120; break;
      case "string": hueRange = 0; break;
      case "empty": isDefault = true; break;
    }
    if (isDefault) {
      return isDark ? "#BBB" : "#444";
    }
    const saturationOffset = ((columnIndex * 7) % 31) - 15;
    const saturation = saturationOffset + (isDark ? 60 : 80);
    const lightnessOffset = ((columnIndex * 13) % 31) - 15;
    const lightness = lightnessOffset + (isDark ? 50 : 60);
    const hueOffset = ((columnIndex * 17) % 31) - 15;
    const finalHue = (hueRange + hueOffset + 360) % 360;
    return this.hslToHex(finalHue, saturation, lightness);
  }

  private hslToHex(h: number, s: number, l: number): string {
    s /= 100;
    l /= 100;
    const k = (n: number) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
    const r = Math.round(255 * f(0));
    const g = Math.round(255 * f(8));
    const b = Math.round(255 * f(4));
    const toHex = (x: number) => x.toString(16).padStart(2, '0');
    return "#" + toHex(r) + toHex(g) + toHex(b);
  }
}

function getNonce() {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

export { CsvEditorProvider };
