import Papa from 'papaparse';
import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
  console.log('CSV: Extension activated');
  context.subscriptions.push(
    vscode.commands.registerCommand('csv.toggleExtension', async () => {
      const config = vscode.workspace.getConfiguration('csv');
      const enabled = config.get<boolean>('enabled', true);
      await config.update('enabled', !enabled, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(`CSV extension ${!enabled ? 'enabled' : 'disabled'}.`);
      CsvEditorProvider.editors.forEach(editor => editor.refresh());
    }),
    vscode.commands.registerCommand('csv.toggleHeader', async () => {
      const config = vscode.workspace.getConfiguration('csv');
      const treatHeader = config.get<boolean>('treatFirstRowAsHeader', true);
      await config.update('treatFirstRowAsHeader', !treatHeader, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(`CSV treating first row as header is now ${!treatHeader ? 'enabled' : 'disabled'}.`);
      CsvEditorProvider.editors.forEach(editor => editor.refresh());
    }),
    vscode.commands.registerCommand('csv.toggleSerialIndex', async () => {
      const config = vscode.workspace.getConfiguration('csv');
      const addSerialIndex = config.get<boolean>('addSerialIndex', false);
      await config.update('addSerialIndex', !addSerialIndex, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(`CSV serial index is now ${!addSerialIndex ? 'enabled' : 'disabled'}.`);
      CsvEditorProvider.editors.forEach(editor => editor.refresh());
    }),
    vscode.commands.registerCommand('csv.changeSeparator', async () => {
      const config = vscode.workspace.getConfiguration('csv');
      const currentSep = config.get<string>('separator', ',');
      const input = await vscode.window.showInputBox({
        prompt: "Enter new CSV separator",
        value: currentSep
      });
      if (input !== undefined) {
        await config.update('separator', input, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(`CSV separator changed to "${input}"`);
        CsvEditorProvider.editors.forEach(editor => editor.refresh());
      }
    })
  );

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
  public static editors: CsvEditorProvider[] = [];
  private isUpdatingDocument = false;
  private isSaving = false;
  private currentWebviewPanel: vscode.WebviewPanel | undefined;
  private document!: vscode.TextDocument;

  constructor(private readonly context: vscode.ExtensionContext) { }

  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    console.log('CSV: resolveCustomTextEditor called');
    this.document = document;
    const config = vscode.workspace.getConfiguration('csv');
    const enabled = config.get<boolean>('enabled', true);
    if (!enabled) {
      vscode.window.showInformationMessage("CSV extension is disabled. Use the command palette to enable it.");
      await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
      return;
    }
    this.currentWebviewPanel = webviewPanel;
    CsvEditorProvider.editors.push(this);
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
      const index = CsvEditorProvider.editors.indexOf(this);
      if (index !== -1) {
        CsvEditorProvider.editors.splice(index, 1);
      }
      this.currentWebviewPanel = undefined;
    });
  }

  public refresh() {
    const config = vscode.workspace.getConfiguration('csv');
    const enabled = config.get<boolean>('enabled', true);
    if (!enabled) {
      if (this.currentWebviewPanel) {
        this.currentWebviewPanel.dispose();
        vscode.commands.executeCommand('vscode.openWith', this.document.uri, 'default');
      }
    } else {
      if (this.currentWebviewPanel) {
        this.updateWebviewContent(this.document, this.currentWebviewPanel.webview);
      }
    }
  }

  private async handleSave(document: vscode.TextDocument) {
    this.isSaving = true;
    try {
      const success = await document.save();
      console.log(success ? 'CSV: Document saved' : 'CSV: Failed to save document');
    } catch (error) {
      console.error('CSV: Error saving document', error);
    } finally {
      this.isSaving = false;
    }
  }

  private async updateDocument(document: vscode.TextDocument, row: number, col: number, value: string) {
    this.isUpdatingDocument = true;
    const config = vscode.workspace.getConfiguration('csv');
    const separator = config.get<string>('separator', ',');
    const csvText = document.getText();
    const result = Papa.parse(csvText, { dynamicTyping: false, delimiter: separator });
    const data = result.data as string[][];
    while (data.length <= row) { data.push([]); }
    while (data[row].length <= col) { data[row].push(''); }
    data[row][col] = value;
    const newCsvText = Papa.unparse(data, { delimiter: separator });
    const fullRange = new vscode.Range(0, 0, document.lineCount, document.lineAt(document.lineCount - 1).text.length);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, fullRange, newCsvText);
    const success = await vscode.workspace.applyEdit(edit);
    this.isUpdatingDocument = false;
    if (success) {
      console.log(`CSV: Updated row ${row + 1}, column ${col + 1} to "${value}"`);
      if (this.currentWebviewPanel) {
        this.currentWebviewPanel.webview.postMessage({ type: 'updateCell', row, col, value });
      }
    } else {
      console.error('CSV: Failed to apply edit');
    }
  }

  private updateWebviewContent(document: vscode.TextDocument, webview: vscode.Webview) {
    console.log('CSV: Updating webview content');
    const config = vscode.workspace.getConfiguration('csv');
    const treatHeader = config.get<boolean>('treatFirstRowAsHeader', true);
    const addSerialIndex = config.get<boolean>('addSerialIndex', false);
    const separator = config.get<string>('separator', ',');
    const text = document.getText();
    let result;
    try {
      result = Papa.parse(text, { dynamicTyping: false, delimiter: separator });
      console.log(`CSV: Parsed CSV data with ${result.data.length} rows`);
    } catch (error) {
      console.error('CSV: Error parsing CSV content', error);
      result = { data: [] };
    }
    const data = result.data as string[][];
    if (data.length === 0) {
      webview.html = `<!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8">
    <title>CSV</title>
    <style>body { font-family: monospace; padding: 10px; }</style>
  </head>
  <body><p>No data found in CSV.</p></body>
</html>`;
      return;
    }
    let dataForColor = treatHeader ? data.slice(1) : data;
    const numColumns = Math.max(...data.map(row => row.length));
    let columnData: string[][] = Array.from({ length: numColumns }, () => []);
    for (let r = 0; r < dataForColor.length; r++) {
      const row = dataForColor[r];
      for (let i = 0; i < numColumns; i++) {
        columnData[i].push(row[i] || "");
      }
    }
    const columnTypes = columnData.map(col => this.estimateColumnDataType(col));
    const isDark = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark;
    const columnColors = columnTypes.map((type, index) => this.getColumnColor(type, isDark, index));
    const columnWidths = this.computeColumnWidths(data);
    let tableHtml = `<table>`;
    if (treatHeader) {
      const header = data[0];
      tableHtml += `<thead><tr>`;
      if (addSerialIndex) {
        tableHtml += `<th style="min-width: 4ch; max-width: 4ch; border: 1px solid #555; background-color: ${isDark ? '#1e1e1e' : '#ffffff'}; color: #888; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;" data-row="0" data-col="-1">#</th>`;
      }
      for (let i = 0; i < header.length; i++) {
        tableHtml += `<th style="min-width: ${Math.min(columnWidths[i] || 0, 100)}ch; max-width: 100ch; border: 1px solid #555; background-color: ${isDark ? '#1e1e1e' : '#ffffff'}; color: ${columnColors[i]}; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;" data-row="0" data-col="${i}">${header[i]}</th>`;
      }
      tableHtml += `</tr></thead>`;
      tableHtml += `<tbody>`;
      for (let r = 1; r < data.length; r++) {
        const row = data[r];
        tableHtml += `<tr>`;
        if (addSerialIndex) {
          tableHtml += `<td tabindex="0" style="min-width: 4ch; max-width: 4ch; border: 1px solid #555; color: #888; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;" data-row="${r}" data-col="-1">${r}</td>`;
        }
        for (let i = 0; i < row.length; i++) {
          tableHtml += `<td tabindex="0" style="min-width: ${Math.min(columnWidths[i] || 0, 100)}ch; max-width: 100ch; border: 1px solid #555; color: ${columnColors[i]}; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;" data-row="${r}" data-col="${i}">${row[i]}</td>`;
        }
        tableHtml += `</tr>`;
      }
      tableHtml += `</tbody>`;
    } else {
      tableHtml += `<tbody>`;
      for (let r = 0; r < data.length; r++) {
        const row = data[r];
        tableHtml += `<tr>`;
        if (addSerialIndex) {
          tableHtml += `<td tabindex="0" style="min-width: 4ch; max-width: 4ch; border: 1px solid #555; color: #888; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;" data-row="${r}" data-col="-1">${r+1}</td>`;
        }
        for (let i = 0; i < row.length; i++) {
          tableHtml += `<td tabindex="0" style="min-width: ${Math.min(columnWidths[i] || 0, 100)}ch; max-width: 100ch; border: 1px solid #555; color: ${columnColors[i]}; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;" data-row="${r}" data-col="${i}">${row[i]}</td>`;
        }
        tableHtml += `</tr>`;
      }
      tableHtml += `</tbody>`;
    }
    tableHtml += `</table>`;
    const nonce = getNonce();
    // Inline styles now include a rule for .highlight
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
        font-family: sans-serif;
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
    </style>
  </head>
  <body>
    <div class="table-container">${tableHtml}</div>
    <div id="findWidget">
      <input id="findInput" type="text" placeholder="Find...">
      <span id="findStatus"></span>
      <button id="findClose">✕</button>
    </div>
    <script nonce="${nonce}">
      document.body.setAttribute('tabindex', '0');
      document.body.focus();

      const vscode = acquireVsCodeApi();
      let isUpdating = false, isSelecting = false, anchorCell = null, currentSelection = [];
      let startCell = null, endCell = null, selectionMode = "cell";
      let editingCell = null, originalCellValue = "";
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
        const minRow = Math.min(start.row, end.row), maxRow = Math.max(start.row, end.row);
        const minCol = Math.min(start.col, end.col), maxCol = Math.max(start.col, end.col);
        for (let r = minRow; r <= maxRow; r++) {
          for (let c = minCol; c <= maxCol; c++) {
            const selector = (r === 0 ? 'th' : 'td') + '[data-row="'+r+'"][data-col="'+c+'"]';
            const selCell = table.querySelector(selector);
            if (selCell) { selCell.classList.add('selected'); currentSelection.push(selCell); }
          }
        }
      }
      function selectFullColumnRange(col1, col2) {
        clearSelection();
        const minCol = Math.min(col1, col2), maxCol = Math.max(col1, col2);
        const rows = table.querySelectorAll('tr');
        rows.forEach(row => {
          Array.from(row.children).forEach(cell => {
            const cellCol = cell.getAttribute('data-col');
            if (cellCol !== null && parseInt(cellCol) >= minCol && parseInt(cellCol) <= maxCol) {
              cell.classList.add('selected');
              currentSelection.push(cell);
            }
          });
        });
      }
      function selectFullRowRange(row1, row2) {
        clearSelection();
        const minRow = Math.min(row1, row2), maxRow = Math.max(row1, row2);
        const rows = table.querySelectorAll('tr');
        rows.forEach(row => {
          Array.from(row.children).forEach(cell => {
            const r = cell.getAttribute('data-row');
            if (r !== null && parseInt(r) >= minRow && parseInt(r) <= maxRow) {
              cell.classList.add('selected');
              currentSelection.push(cell);
            }
          });
        });
      }
      
      // Find widget code
      const findWidget = document.getElementById('findWidget');
      const findInput = document.getElementById('findInput');
      const findStatus = document.getElementById('findStatus');
      const findClose = document.getElementById('findClose');
      let findMatches = [];
      let currentMatchIndex = -1;

      function updateFindStatus() {
        if(findMatches.length > 0){
          findStatus.innerText = (currentMatchIndex+1) + " of " + findMatches.length + " (Cmd+G to advance)";
        } else {
          findStatus.innerText = "";
        }
      }

      function updateFindMatches() {
        const query = findInput.value.toLowerCase();
        document.querySelectorAll('.highlight, .active-match').forEach(el => {
          el.classList.remove('highlight');
          el.classList.remove('active-match');
        });
        findMatches = [];
        if(query === "") {
          updateFindStatus();
          return;
        }
        const cells = document.querySelectorAll('td, th');
        cells.forEach(cell => {
          if(cell.innerText.toLowerCase().includes(query)) {
            findMatches.push(cell);
            cell.classList.add('highlight');
          }
        });
        if(findMatches.length > 0) {
          currentMatchIndex = 0;
          findMatches[currentMatchIndex].classList.add('active-match');
          findMatches[currentMatchIndex].scrollIntoView({block:'center', inline:'center', behavior:'smooth'});
        }
        updateFindStatus();
      }

      function selectAllCells() {
        clearSelection();
        const cells = document.querySelectorAll('td, th');
        cells.forEach(cell => {
          cell.classList.add('selected');
          currentSelection.push(cell);
        });
      }

      findInput.addEventListener('input', updateFindMatches);

      findInput.addEventListener('keydown', (e) => {
        if(e.key === 'Escape'){
          findWidget.style.display = 'none';
          findInput.value = "";
          document.querySelectorAll('.highlight, .active-match').forEach(el => {
            el.classList.remove('highlight');
            el.classList.remove('active-match');
          });
          findStatus.innerText = "";
          findInput.blur();
        }
        // Handle next (cmd+g) and previous (cmd+shift+g)
        if((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'g'){
          e.preventDefault();
          if(findMatches.length === 0) return;
          findMatches[currentMatchIndex].classList.remove('active-match');
          if(e.shiftKey){
            currentMatchIndex = (currentMatchIndex - 1 + findMatches.length) % findMatches.length;
          } else {
            currentMatchIndex = (currentMatchIndex + 1) % findMatches.length;
          }
          findMatches[currentMatchIndex].classList.add('active-match');
          findMatches[currentMatchIndex].scrollIntoView({block:'center', inline:'center', behavior:'smooth'});
          updateFindStatus();
        }
      });

      findClose.addEventListener('click', () => {
        findWidget.style.display = 'none';
        findInput.value = "";
        document.querySelectorAll('.highlight, .active-match').forEach(el => {
          el.classList.remove('highlight');
          el.classList.remove('active-match');
        });
        findStatus.innerText = "";
        findInput.blur();
      });

      document.addEventListener('keydown', (e) => {
        if((e.ctrlKey || e.metaKey) && e.key === 'f'){
          e.preventDefault();
          findWidget.style.display = 'block';
          findInput.focus();
          return;
        }

        // If cmd/ctrl+a is pressed and no cell is currently being edited, select all cells.
        if ((e.ctrlKey || e.metaKey) && e.key === 'a' && !editingCell) {
          e.preventDefault();
          selectAllCells();
          return;
        }
        if ((e.ctrlKey || e.metaKey) && e.key === 'c' && currentSelection.length > 0) {
          e.preventDefault();
          copySelectionToClipboard();
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
          const nextCell = table.querySelector('td[data-row="'+row+'"][data-col="'+(col+1)+'"]');
          if (nextCell) editCell(nextCell);
        }
        if (editingCell && e.key === 'Escape') {
          e.preventDefault();
          editingCell.innerText = originalCellValue;
          editingCell.blur();
        }
      });
      
      // Mouse events for selection
      table.addEventListener('mousedown', (e) => {
        if(e.target.tagName !== 'TD' && e.target.tagName !== 'TH') return;
        const target = e.target;
        if(target.tagName === 'TH') { selectionMode = "column"; }
        else if(target.getAttribute('data-col') === '-1') { selectionMode = "row"; }
        else { selectionMode = "cell"; }
        startCell = target;
        endCell = target;
        isSelecting = true;
        e.preventDefault();
      });
      table.addEventListener('mousemove', (e) => {
        if(!isSelecting) return;
        let target = e.target;
        if(selectionMode === "cell") {
          if(target.tagName === 'TD' || target.tagName === 'TH'){
            endCell = target;
            selectRange(getCellCoords(startCell), getCellCoords(endCell));
          }
        } else if(selectionMode === "column") {
          if(target.tagName !== 'TH'){
            const col = target.getAttribute('data-col');
            target = table.querySelector('thead th[data-col="'+col+'"]') || target;
          }
          endCell = target;
          const startCol = parseInt(startCell.getAttribute('data-col'));
          const endCol = parseInt(endCell.getAttribute('data-col'));
          selectFullColumnRange(startCol, endCol);
        } else if(selectionMode === "row") {
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
      table.addEventListener('mouseup', (e) => {
        if(!isSelecting) return;
        isSelecting = false;
        if(selectionMode === "cell") {
          if(startCell === endCell){ clearSelection(); editCell(startCell); }
          else { anchorCell = startCell; }
        } else if(selectionMode === "column") {
          const startCol = parseInt(startCell.getAttribute('data-col'));
          const endCol = parseInt(endCell.getAttribute('data-col'));
          selectFullColumnRange(startCol, endCol);
          anchorCell = startCell;
        } else if(selectionMode === "row") {
          const startRow = parseInt(startCell.getAttribute('data-row'));
          const endRow = parseInt(endCell.getAttribute('data-row'));
          selectFullRowRange(startRow, endRow);
          anchorCell = startCell;
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
        if(editingCell === cell) return;
        if(editingCell) editingCell.blur();
        originalCellValue = cell.innerText;
        editingCell = cell;
        cell.classList.add('editing');
        cell.setAttribute('contenteditable', 'true');
        cell.focus();
        setCursorToEnd(cell);
      }
      function copySelectionToClipboard() {
        if(currentSelection.length === 0) return;
        const coords = currentSelection.map(cell => getCellCoords(cell));
        const minRow = Math.min(...coords.map(c => c.row)), maxRow = Math.max(...coords.map(c => c.row));
        const minCol = Math.min(...coords.map(c => c.col)), maxCol = Math.max(...coords.map(c => c.col));
        let csv = '';
        for(let r = minRow; r <= maxRow; r++){
          let rowVals = [];
          for(let c = minCol; c <= maxCol; c++){
            const selector = (r === 0 ? 'th' : 'td') + '[data-row="'+r+'"][data-col="'+c+'"]';
            const cell = table.querySelector(selector);
            rowVals.push(cell ? cell.innerText : '');
          }
          csv += rowVals.join(',') + '\\n';
        }
        vscode.postMessage({ type: 'copyToClipboard', text: csv.trimEnd() });
      }
      window.addEventListener('message', (event) => {
        const message = event.data;
        if(message.type === 'updateCell'){
          isUpdating = true;
          const { row, col, value } = message;
          const cell = table.querySelector('td[data-row="'+row+'"][data-col="'+col+'"]');
          if(cell) { cell.innerText = value; }
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
    switch (type) {
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
    const lightness = lightnessOffset + (isDark ? 50 : 60);
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
