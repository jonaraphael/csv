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

    webviewPanel.webview.onDidReceiveMessage(e => {
      switch (e.type) {
        case 'editCell':
          this.updateDocument(document, e.row, e.col, e.value);
          return;
      }
    });

    const changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument(e => {
      if (e.document.uri.toString() === document.uri.toString()) {
        if (this.isUpdatingDocument) return;
        console.log('CSV: Document changed externally, updating webview');
        this.updateWebviewContent(document, webviewPanel.webview);
      }
    });

    webviewPanel.onDidDispose(() => {
      console.log('CSV: Webview disposed');
      changeDocumentSubscription.dispose();
      this.currentWebviewPanel = undefined;
    });
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
      if (cell.includes('"') || cell.includes(',') || cell.includes('\n')) {
        return `"${cell.replace(/"/g, '""')}"`;
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

  private getHtmlForWebview(webview: vscode.Webview, text: string): string {
    console.log('CSV: Generating HTML for webview');

    // Use the official VSCode API to detect theme instead of configuration
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

    const colors = isDark ? this.darkPalette : this.lightPalette;

    let tableHtml = '<table>';
    const header = data[0];
    tableHtml += '<thead><tr>';
    for (let i = 0; i < header.length; i++) {
      const width = columnWidths[i];
      const color = colors[i % colors.length];
      tableHtml += `<th style="min-width: ${width}ch; border: 1px solid #555; background-color: ${isDark ? '#1e1e1e' : '#ffffff'}; color: ${color};" contenteditable="true" data-row="0" data-col="${i}">${header[i]}</th>`;
    }
    tableHtml += '</tr></thead>';

    tableHtml += '<tbody>';
    for (let rowIndex = 1; rowIndex < data.length; rowIndex++) {
      const row = data[rowIndex];
      tableHtml += '<tr>';
      for (let i = 0; i < row.length; i++) {
        const width = columnWidths[i];
        const color = colors[i % colors.length];
        tableHtml += `<td tabindex="0" style="min-width: ${width}ch; border: 1px solid #555; color: ${color};" contenteditable="true" data-row="${rowIndex}" data-col="${i}">${row[i]}</td>`;
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
            cursor: text;
          }
          th { 
            position: sticky; 
            top: 0; 
            z-index: 2;
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

          document.querySelectorAll('th[contenteditable="true"], td[contenteditable="true"]').forEach(cell => {
            cell.addEventListener('blur', () => {
              if (isUpdating) return;
              const row = parseInt(cell.getAttribute('data-row'));
              const col = parseInt(cell.getAttribute('data-col'));
              const value = cell.innerText;
              vscode.postMessage({
                type: 'editCell',
                row: row,
                col: col,
                value: value
              });
            });

            cell.addEventListener('click', () => {
              cell.focus();
            });

            cell.addEventListener('keydown', (e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                cell.blur();
              } else if (e.key === 'Tab') {
                e.preventDefault();
                e.stopPropagation();
                navigateToNextCell(cell, e.shiftKey);
              }
            });
          });

          function navigateToNextCell(currentCell, isShift) {
            const row = parseInt(currentCell.getAttribute('data-row'));
            const col = parseInt(currentCell.getAttribute('data-col'));
            const table = currentCell.closest('table');
            let targetRow = row;
            let targetCol = col + (isShift ? -1 : 1);

            const maxDataRows = table.querySelectorAll('tbody tr').length;  
            const maxCol = table.querySelectorAll('thead th').length - 1;

            if (targetCol < 0) {
              targetCol = maxCol;
              targetRow = row - 1 >= 0 ? row - 1 : maxDataRows;
            } else if (targetCol > maxCol) {
              targetCol = 0;
              targetRow = row + 1 <= maxDataRows ? row + 1 : 0;
            }

            const cellSelector = targetRow === 0 ? 'th' : 'td';
            const targetCell = table.querySelector(cellSelector + '[data-row="' + targetRow + '"][data-col="' + targetCol + '"]');

            if (targetCell) {
              targetCell.focus();
              document.execCommand('selectAll', false, null);
            }
          }

          window.addEventListener('message', event => {
            const message = event.data;
            switch (message.type) {
              case 'updateCell':
                isUpdating = true;
                const { row, col, value } = message;
                const cell = document.querySelector('td[data-row="' + row + '"][data-col="' + col + '"]');
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

  private lightPalette: string[] = [
    '#243F62','#5D429F','#631A1A','#6A4A25','#266096','#695C5D','#6A4A25','#744042','#191F69','#81477A','#5B1B1B','#723333','#4D5C2C','#243F5F','#723333','#631A1A','#723F29','#191F69','#631A1A','#695C5D','#7F4B25','#191F69','#703568','#5B1B1B','#754820','#52325A','#4B3A65','#7034A8','#793C30','#59543C'
  ];

  private darkPalette: string[] = [
    '#577282','#8F737C','#A9AB9B','#5CABA8','#8D7B73','#A9AB73','#8F767B','#5CABA8','#A9ABA8','#AB7373','#8CABA8','#5C7BAB','#AB7373','#8C747B','#97AB8A','#5CABA8','#8C747B','#8D7B73','#B77B7A','#5CABA8','#A9ACA8','#B1AA7A','#B1AC7A','#616C61','#9491A4','#B27C7B','#9C7C71','#8C8B61'  
  ];

  private parseCsv(text: string): string[][] {
    console.log('CSV: Parsing CSV');
    const lines = text.split(/\r?\n/);
    const data = lines.map(line => this.parseCsvLine(line));
    return data;
  }

  private parseCsvLine(line: string): string[] {
    const cells = [];
    let currentCell = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line.charAt(i);

      if (char === '"') {
        if (inQuotes && i + 1 < line.length && line.charAt(i + 1) === '"') {
          currentCell += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        cells.push(currentCell);
        currentCell = '';
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
