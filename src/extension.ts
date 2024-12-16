import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
  console.log('CSV: Extension activated');

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      CsvEditorProvider.viewType,
      new CsvEditorProvider(context),
      {
        supportsMultipleEditorsPerDocument: false
      }
    )
  );
}

export function deactivate() {
  console.log('CSV: Extension deactivated');
}

class CsvEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = 'csv.editor';
  private isUpdatingDocument: boolean = false;
  private isSaving: boolean = false; // New flag to handle save operations
  private currentWebviewPanel: vscode.WebviewPanel | undefined;

  constructor(private readonly context: vscode.ExtensionContext) { }

  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    console.log('CSV: resolveCustomTextEditor called');

    this.currentWebviewPanel = webviewPanel;

    webviewPanel.webview.options = {
      enableScripts: true,
    };

    this.updateWebviewContent(document, webviewPanel.webview);

    webviewPanel.webview.onDidReceiveMessage(async e => {
      switch (e.type) {
        case 'editCell':
          this.updateDocument(document, e.row, e.col, e.value);
          return;
        case 'save':
          this.handleSave(document);
          return;
        case 'copyToClipboard':
          await vscode.env.clipboard.writeText(e.text);
          console.log('CSV: Copied to clipboard from extension side');
          return;
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

  // Refactored handleSave method using try...catch...finally
  private async handleSave(document: vscode.TextDocument) {
    this.isSaving = true; // Set the saving flag
    try {
      const success = await document.save();
      if (!success) {
        console.error('CSV: Failed to save document');
      } else {
        console.log('CSV: Document saved');
      }
    } catch (error) {
      console.error('CSV: Error saving document', error);
    } finally {
      this.isSaving = false; // Reset the saving flag
    }
  }

  private async updateDocument(document: vscode.TextDocument, row: number, col: number, value: string) {
    this.isUpdatingDocument = true;
    const edit = new vscode.WorkspaceEdit();
    const line = document.lineAt(row).text;
    const parsed = this.parseCsvLine(line);

    if (col >= parsed.length) {
      while (parsed.length <= col) {
        parsed.push('');
      }
    }

    parsed[col] = value;

    const newLine = this.constructCsvLine(parsed);
    const range = new vscode.Range(row, 0, row, line.length);
    edit.replace(document.uri, range, newLine);

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

  private constructCsvLine(cells: string[]): string {
    return cells.map(cell => {
      if (cell.includes('"') || cell.includes(',') || cell.includes('\n') || cell.includes('\\')) { // Added backslash check
        return `"${cell.replace(/"/g, '""').replace(/\\/g, '\\\\')}"`; // Escape backslashes as well
      }
      return cell;
    }).join(',');
  }

  private updateWebviewContent(document: vscode.TextDocument, webview: vscode.Webview) {
    console.log('CSV: Updating webview content');
    const text = document.getText();
    try {
      const html = this.getHtmlForWebview(webview, text);
      webview.html = html;
      console.log('CSV: Webview content updated');
    } catch (error) {
      console.error('CSV: Error updating webview content', error);
    }
  }

  private isDate(value: string): boolean {
    const timestamp = Date.parse(value);
    return !isNaN(timestamp);
  }

  private estimateColumnDataType(column: string[]): string {
    let allBoolean = true;
    let allDate = true;
    let allInteger = true;
    let allFloat = true;
    let allEmpty = true;

    for (const cell of column) {
      // Split by comma and trim whitespace
      const items = cell.split(',').map(item => item.trim());
      for (const item of items) {
        if (item === '') {
          continue; // Skip empty items
        }
        allEmpty = false;

        // Check for boolean
        const lower = item.toLowerCase();
        if (!(lower === 'true' || lower === 'false')) {
          allBoolean = false;
        }

        // Check for date
        if (!this.isDate(item)) {
          allDate = false;
        }

        // Check for integer
        const num = Number(item);
        if (!Number.isInteger(num)) {
          allInteger = false;
        }

        // Check for float
        if (isNaN(num)) {
          allFloat = false;
        } else {
          if (item.includes('.')) {
            // It's a float
          } else {
            // It's an integer
          }
        }
      }
    }

    // Determine the most specific type
    if (allEmpty) {
      return "empty";
    }
    if (allBoolean) {
      return "boolean";
    }
    if (allDate) {
      return "date";
    }
    if (allInteger) {
      return "integer";
    }
    if (allFloat) {
      return "float";
    }
    return "string";
  }

  private getColumnColor(type: string, isDark: boolean, columnIndex: number): string {
    let hueRange = 0; 
    let isDefault = false;

    switch (type) {
        case "boolean":
            hueRange = 30;  
            break;
        case "date":
            hueRange = 210; 
            break;
        case "float":
            hueRange = isDark ? 60 : 270; 
            break;
        case "integer":
            hueRange = 120; 
            break;
        case "string":
            hueRange = 0;   
            break;
        case "empty":
            isDefault = true; 
            break;
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
    const f = (n: number) =>
      l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
    const r = Math.round(255 * f(0));
    const g = Math.round(255 * f(8));
    const b = Math.round(255 * f(4));
    const toHex = (x: number) => x.toString(16).padStart(2, '0');
    return "#" + toHex(r) + toHex(g) + toHex(b);
  }

  private getHtmlForWebview(webview: vscode.Webview, text: string): string {
    console.log('CSV: Generating HTML for webview');

    const isDark = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark;
    const nonce = getNonce();
    const data = this.parseCsv(text);
    console.log(`CSV: Parsed CSV data with ${data.length} rows`);

    if (data.length === 0) {
        return `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <title>CSV</title>
                <style>
                    body { 
                        font-family: monospace; 
                        padding: 10px; 
                    }
                </style>
            </head>
            <body>
                <p>No data found in CSV.</p>
            </body>
            </html>
        `;
    }

    const columnWidths = this.computeColumnWidths(data);
    console.log(`CSV: Computed column widths: ${columnWidths}`);

    const numColumns = Math.max(...data.map(row => row.length));
    const columnData: string[][] = Array.from({ length: numColumns }, () => []);
    for (let rowIndex = 1; rowIndex < data.length; rowIndex++) {
        const row = data[rowIndex];
        for (let i = 0; i < numColumns; i++) {
            columnData[i].push(row[i] || "");
        }
    }

    const columnTypes = columnData.map(col => this.estimateColumnDataType(col));
    const columnColors = columnTypes.map((type, index) => this.getColumnColor(type, isDark, index));

    let tableHtml = '<table>';
    const header = data[0];
    tableHtml += '<thead><tr>';
    for (let i = 0; i < header.length; i++) {
        const width = Math.min(columnWidths[i], 100); 
        const color = columnColors[i];
        tableHtml += `<th style="
            min-width: ${width}ch; 
            max-width: 100ch;
            border: 1px solid #555; 
            background-color: ${isDark ? '#1e1e1e' : '#ffffff'}; 
            color: ${color};
            overflow: hidden;
            white-space: nowrap;
            text-overflow: ellipsis;"
            data-row="0" 
            data-col="${i}"
            >${header[i]}</th>`;
    }
    tableHtml += '</tr></thead>';

    tableHtml += '<tbody>';
    for (let rowIndex = 1; rowIndex < data.length; rowIndex++) {
        const row = data[rowIndex];
        tableHtml += '<tr>';
        for (let i = 0; i < row.length; i++) {
            const width = Math.min(columnWidths[i], 100); 
            const color = columnColors[i]; 
            tableHtml += `<td tabindex="0" style="
                min-width: ${width}ch; 
                max-width: 100ch; 
                border: 1px solid #555; 
                color: ${color};
                overflow: hidden; 
                white-space: nowrap; 
                text-overflow: ellipsis;"
                data-row="${rowIndex}" 
                data-col="${i}"
                >${row[i]}</td>`;
        }
        tableHtml += '</tr>';
    }
    tableHtml += '</tbody>';
    tableHtml += '</table>';

    return `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>CSV</title>
            <style nonce="${nonce}">
                body { 
                    font-family: monospace; 
                    margin: 0; 
                    padding: 0; 
                    user-select: none;
                }
                .table-container {
                    overflow-x: auto;
                    max-height: 100vh;
                }
                table { 
                    border-collapse: collapse; 
                    width: max-content; 
                }
                th, td { 
                    padding: 4px 8px; 
                    overflow: hidden; 
                    cursor: default;
                    position: relative;
                }
                th { 
                    position: sticky; 
                    top: 0; 
                    z-index: 2;
                }
                td.selected, th.selected {
                    background-color: ${isDark ? '#333333' : '#cce0ff'} !important;
                }
                td.editing, th.editing {
                    overflow: visible !important;
                    white-space: normal !important;
                    max-width: none !important;
                }
            </style>
        </head>
        <body>
            <div class="table-container">
                ${tableHtml}
            </div>
            <script nonce="${nonce}">
          const vscode = acquireVsCodeApi();
          let isUpdating = false;
          let isSelecting = false;
          let anchorCell = null;
          let currentSelection = [];
          let startCell = null; 
          let endCell = null;
          let editingCell = null;
          let originalCellValue = null;

          const table = document.querySelector('table');
          const container = document.querySelector('.table-container');

          // Selection and Editing logic
          function getCellCoords(cell) {
            const row = parseInt(cell.getAttribute('data-row'));
            const col = parseInt(cell.getAttribute('data-col'));
            return {row, col};
          }

          function clearSelection() {
            currentSelection.forEach(c => c.classList.remove('selected'));
            currentSelection = [];
          }

          function selectRange(start, end) {
            clearSelection();
            const startRow = Math.min(start.row, end.row);
            const endRow = Math.max(start.row, end.row);
            const startCol = Math.min(start.col, end.col);
            const endCol = Math.max(start.col, end.col);

            for (let r = startRow; r <= endRow; r++) {
              let rowCells = r === 0 ? table.querySelectorAll(\`thead th[data-row="0"]\`) : table.querySelectorAll(\`tbody tr:nth-child(\${r}) td[data-row="\${r}"]\`);
              for (let c = startCol; c <= endCol; c++) {
                const selCell = table.querySelector((r === 0 ? 'th' : 'td')+\`[data-row="\${r}"][data-col="\${c}"]\`);
                if (selCell) {
                  selCell.classList.add('selected');
                  currentSelection.push(selCell);
                }
              }
            }
          }

          table.addEventListener('mousedown', (e) => {
            if (editingCell && (e.target.tagName === 'TD' || e.target.tagName === 'TH')) {
              // Allow text selection within the editing cell
              return;
            }

            if (e.target.tagName !== 'TD' && e.target.tagName !== 'TH') return;

            if (editingCell && editingCell !== e.target) {
              editingCell.blur();
            }

            if (e.shiftKey) {
              if (!startCell) {
                startCell = e.target;
              }
              endCell = e.target;
              isSelecting = true;
            } else {
              startCell = e.target;
              endCell = e.target;
              isSelecting = true;
            }

            e.preventDefault();
          });

          table.addEventListener('mousemove', (e) => {
            if (!isSelecting) return;
            if (e.target.tagName === 'TD' || e.target.tagName === 'TH') {
              endCell = e.target;
              selectRange(getCellCoords(startCell), getCellCoords(endCell));
            }
          });

          table.addEventListener('mouseup', (e) => {
            if (!isSelecting) return;
            isSelecting = false;
            if (startCell === endCell) {
              clearSelection();
              editCell(startCell);
            } else {
              anchorCell = startCell;
            }
          });

          table.addEventListener('click', (e) => {
            if (e.shiftKey && anchorCell && (e.target.tagName === 'TD' || e.target.tagName === 'TH')) {
              selectRange(getCellCoords(anchorCell), getCellCoords(e.target));
            } else if (!e.shiftKey && (e.target.tagName === 'TD' || e.target.tagName === 'TH')) {
              anchorCell = e.target;
            }
          });

          // Function to set cursor at the end of the cell
          function setCursorToEnd(cell) {
            setTimeout(() => { // Delay to ensure the cell is focused and editable
              const range = document.createRange();
              range.selectNodeContents(cell);
              range.collapse(false); // Move cursor to the end
              const sel = window.getSelection();
              sel.removeAllRanges();
              sel.addRange(range);
            }, 10); // 10ms delay
          }

          // Start editing a cell
          function editCell(cell) {
            if (editingCell === cell) return;
            if (editingCell) {
              editingCell.blur();
            }
            originalCellValue = cell.innerText;
            editingCell = cell;
            cell.classList.add('editing');
            cell.setAttribute('contenteditable', 'true');
            cell.focus();
            setCursorToEnd(cell); // Set cursor at the end
          }

          // Handle blur event to stop editing
          table.addEventListener('blur', (e) => {
            if (!editingCell) return;
            if (e.target === editingCell) {
              const row = parseInt(editingCell.getAttribute('data-row'));
              const col = parseInt(editingCell.getAttribute('data-col'));
              const value = editingCell.innerText;
              editingCell.removeAttribute('contenteditable');
              editingCell.classList.remove('editing');
              editingCell = null;
              vscode.postMessage({
                type: 'editCell',
                row: row,
                col: col,
                value: value
              });
            }
          }, true);

          // Keyboard events
          table.addEventListener('keydown', (e) => {
            if (editingCell && ((e.ctrlKey || e.metaKey) && e.key === 's')) {
              e.preventDefault();
              editingCell.blur();
              vscode.postMessage({ type: 'save' });
            }

            if (editingCell && e.key === 'Enter') {
              e.preventDefault();
              const row = parseInt(editingCell.getAttribute('data-row'));
              const col = parseInt(editingCell.getAttribute('data-col'));
              editingCell.blur();

              // After committing with Enter, move focus down one cell
              const nextRow = row + 1;
              const nextCell = table.querySelector(\`td[data-row="\${nextRow}"][data-col="\${col}"]\`);
              if (nextCell) {
                editCell(nextCell);
              }
            }

            if (editingCell && e.key === 'Tab') {
              e.preventDefault();
              const row = parseInt(editingCell.getAttribute('data-row'));
              const col = parseInt(editingCell.getAttribute('data-col'));
              editingCell.blur();

              // Move focus to the cell to the right
              const nextCol = col + 1;
              const nextCell = table.querySelector(\`td[data-row="\${row}"][data-col="\${nextCol}"]\`);
              if (nextCell) {
                editCell(nextCell);
              }
            }

            if (editingCell && e.key === 'Escape') {
              e.preventDefault();
              editingCell.innerText = originalCellValue;
              editingCell.blur();
            }

            // Copy selection with Ctrl+C
            if ((e.ctrlKey || e.metaKey) && e.key === 'c' && currentSelection.length > 0) {
              e.preventDefault();
              copySelectionToClipboard();
            }
          });

          // Implement copy selection to clipboard
          function copySelectionToClipboard() {
            if (currentSelection.length === 0) return;
            const coords = currentSelection.map(cell => getCellCoords(cell));
            const minRow = Math.min(...coords.map(c => c.row));
            const maxRow = Math.max(...coords.map(c => c.row));
            const minCol = Math.min(...coords.map(c => c.col));
            const maxCol = Math.max(...coords.map(c => c.col));

            let csv = '';
            for (let r = minRow; r <= maxRow; r++) {
              let rowVals = [];
              for (let c = minCol; c <= maxCol; c++) {
                const cell = table.querySelector((r === 0 ? 'th' : 'td')+\`[data-row="\${r}"][data-col="\${c}"]\`);
                rowVals.push((cell && cell.innerText) || '');
              }
              csv += rowVals.join(',') + '\\n';
            }

            // Send to extension for reliable copy
            vscode.postMessage({ type: 'copyToClipboard', text: csv.trimEnd() });
          }

          window.addEventListener('message', event => {
            const message = event.data;
            switch (message.type) {
              case 'updateCell':
                isUpdating = true;
                const { row, col, value } = message;
                const cell = table.querySelector('td[data-row="' + row + '"][data-col="' + col + '"]');
                if (cell) {
                  cell.innerText = value;
                }
                isUpdating = false;
                break;
            }
          });
        </script>
      </body>
      </html>
    `;
  }

  private parseCsv(text: string): string[][] {
    console.log('CSV: Parsing CSV');
    const lines = text.split(/\r?\n/);
    const data = lines.map(line => this.parseCsvLine(line));
    return data;
  }

  private parseCsvLine(line: string): string[] {
    const cells: string[] = [];
    let currentCell = '';
    let inQuotes = false;
    let escaped = false;

    for (let i = 0; i < line.length; i++) {
        const char = line[i];

        if (escaped) {
            currentCell += char;
            escaped = false;
        } else if (char === '"') {
            if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
                currentCell += '"';
                i++; // Skip the next quote
            } else {
                inQuotes = !inQuotes;
            }
        } else if (char === ',' && !inQuotes) {
            cells.push(currentCell);
            currentCell = '';
        } else if (char === '\\' && inQuotes) { // Handle escape character inside quotes
          escaped = true;
        } else {
            currentCell += char;
        }
    }
    cells.push(currentCell);
    return cells;
  }

  private computeColumnWidths(data: string[][]): number[] {
    console.log('CSV: Computing column widths');
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
}

function getNonce() {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
