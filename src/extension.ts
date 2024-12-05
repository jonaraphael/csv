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


  private static readonly colorPalette: string[] = [
    '#1f77b4', // Blue
    '#ff7f0e', // Orange
    '#2ca02c', // Green
    '#d62728', // Red
    '#9467bd', // Purple
    '#8c564b', // Brown
    '#e377c2', // Pink
    '#7f7f7f', // Gray
    '#bcbd22', // Olive
    '#17becf'  // Cyan
  ];

  // Store a reference to the current webview panel
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
      enableScripts: true, // Enable scripts in the webview
    };

    // Initial render
    this.updateWebviewContent(document, webviewPanel.webview);

    // Listen for messages from the webview
    webviewPanel.webview.onDidReceiveMessage(e => {
      switch (e.type) {
        case 'editCell':
          this.updateDocument(document, e.row, e.col, e.value);
          return;
      }
    });

    // Listen for document changes
	const changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument(e => {
		if (e.document.uri.toString() === document.uri.toString()) {
		  if (this.isUpdatingDocument) {
			// Skip updating the webview content when we are the source of the change
			return;
		  }
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
      // If the column doesn't exist, append empty cells
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
      // Send a message back to the webview to update the specific cell without re-rendering
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

    // Determine the current theme (light or dark)
    const isDark = this.getIsDarkTheme();
    const nonce = getNonce();

    // Parse CSV and generate HTML table
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
              background-color: #1e1e1e; 
              color: ${isDark ? '#d4d4d4' : '#000000'}; 
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

    const colors = this.assignColorsToColumns(data[0].length, isDark);
    console.log(`CSV: Assigned colors: ${colors}`);

    // Generate HTML table
    let tableHtml = '<table>';
    
    // Generate header row
    const header = data[0];
    tableHtml += '<thead><tr>';
    for (let i = 0; i < header.length; i++) {
      const cell = header[i];
      const width = columnWidths[i];
      const color = colors[i % colors.length];
      tableHtml += `<th style="min-width: ${width}ch; background-color: #1e1e1e; color: ${color}; text-align: left;" contenteditable="true" data-col="${i}">${cell}</th>`;
    }
    tableHtml += '</tr></thead>';

    // Generate body rows
    tableHtml += '<tbody>';
    for (let rowIndex = 1; rowIndex < data.length; rowIndex++) {
      const row = data[rowIndex];
      tableHtml += '<tr>';
      for (let i = 0; i < row.length; i++) {
        const cell = row[i];
        const width = columnWidths[i];
        const color = colors[i % colors.length];
        tableHtml += `<td tabindex="0" style="min-width: ${width}ch; color: ${color}; text-align: left;" contenteditable="true" data-row="${rowIndex}" data-col="${i}">${cell}</td>`;
      }
      tableHtml += '</tr>';
    }
    tableHtml += '</tbody>';

    tableHtml += '</table>';

    // Return full HTML with scripts to handle editing and navigation
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
            background-color: #1e1e1e; 
            color: ${isDark ? '#d4d4d4' : '#000000'}; 
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
            border: 1px solid #555; /* Mid-tone grey gridlines */
            overflow: hidden; 
            cursor: text;
          }
          th { 
            position: sticky; 
            top: 0; 
            z-index: 2; /* Ensure the header stays above other cells */
            background-color: #1e1e1e; /* Set based on theme */
          }
        </style>
      </head>
      <body>
        <div class="table-container">
          ${tableHtml}
        </div>
        <script nonce="${nonce}">
          const vscode = acquireVsCodeApi();

          // Flag to prevent multiple updates
          let isUpdating = false;

          document.querySelectorAll('td[contenteditable="true"]').forEach(cell => {
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
			cell.addEventListener('click', () => {
			  cell.focus();
			  });
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

          /**
           * Function to navigate to the next or previous cell.
           * @param currentCell The current cell element.
           * @param isShift Whether the Shift key is pressed (for reverse navigation).
           */
			function navigateToNextCell(currentCell, isShift) {
				const row = parseInt(currentCell.getAttribute('data-row'));
				const col = parseInt(currentCell.getAttribute('data-col'));
				const table = currentCell.closest('table');
				let targetRow = row;
				let targetCol = col + (isShift ? -1 : 1);

				const maxRow = table.querySelectorAll('tbody tr').length;
				const maxCol = table.querySelectorAll('thead th').length - 1;

				if (targetCol < 0) {
					targetCol = maxCol;
					targetRow = row - 1 >= 1 ? row - 1 : maxRow;
				} else if (targetCol > maxCol) {
					targetCol = 0;
					targetRow = row + 1 <= maxRow ? row + 1 : 1;
				}

				const targetCell = table.querySelector('td[data-row="' + targetRow + '"][data-col="' + targetCol + '"]');
				if (targetCell) {
					targetCell.focus();
					// Optionally select the cell's content
					document.execCommand('selectAll', false, null);
				}
			}

          // Listen for messages from the extension to update cells
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

  private getIsDarkTheme(): boolean {
    const config = vscode.workspace.getConfiguration('workbench');
    const colorTheme = config.get<string>('colorTheme') || 'Default Dark+';
    return colorTheme.toLowerCase().includes('dark');
  }

  private assignColorsToColumns(numColumns: number, isDark: boolean): string[] {
    console.log('CSV: Assigning colors to columns based on theme');
    const lightPalette: string[] = [
      '#1f77b4', // Blue
      '#ff7f0e', // Orange
      '#2ca02c', // Green
      '#d62728', // Red
      '#9467bd', // Purple
      '#8c564b', // Brown
      '#e377c2', // Pink
      '#7f7f7f', // Gray
      '#bcbd22', // Olive
      '#17becf'  // Cyan
    ];

    const darkPalette: string[] = [
      '#1f77b4', // Blue
      '#ff7f0e', // Orange
      '#2ca02c', // Green
      '#d62728', // Red
      '#9467bd', // Purple
      '#8c564b', // Brown
      '#e377c2', // Pink
      '#7f7f7f', // Gray
      '#bcbd22', // Olive
      '#17becf'  // Cyan
    ];

    const palette = isDark ? darkPalette : lightPalette;

    const colors = [];
    for (let i = 0; i < numColumns; i++) {
      const color = palette[i % palette.length];
      colors.push(color);
    }
    console.log(`CSV: Column colors: ${colors}`);
    return colors;
  }

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
          // Escaped quote
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

/**
 * Generates a nonce for Content Security Policy
 */
function getNonce() {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
