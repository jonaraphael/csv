import * as vscode from 'vscode';
import { HtmlView } from './renderer';
import * as CSV from './csv';

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

    let parsedCsv = this.getCsv(document);

    this.updateWebviewContent(parsedCsv, webviewPanel.webview);

    webviewPanel.webview.onDidReceiveMessage(async e => {
      switch (e.type) {
        case 'editCell':
          this.updateDocument(document, parsedCsv, e.row, e.col, e.value);
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

        parsedCsv = this.getCsv(document); // fetch the latest content from source

        clearTimeout(updateTimeout);
        updateTimeout = setTimeout(() => {
          console.log('CSV: Document changed externally, updating webview');
          this.updateWebviewContent(parsedCsv, webviewPanel.webview);
        }, 250);
      }
    });

    webviewPanel.onDidDispose(() => {
      console.log('CSV: Webview disposed');
      changeDocumentSubscription.dispose();
      this.currentWebviewPanel = undefined;
    });
  }

  private getCsv(document: vscode.TextDocument) {
    const text = document.getText();
    const parsedCsv = CSV.parse(text);

    return parsedCsv;
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

  private async updateDocument(document: vscode.TextDocument, parsedCsv: string[][], row: number, col: number, value: string) {
    this.isUpdatingDocument = true;

    const edit = new vscode.WorkspaceEdit();

    while (parsedCsv.length <= row) {
      parsedCsv.push([]);
    }

    const parsed = parsedCsv[row];

    while (parsed.length <= col) {
      parsed.push('');
    }

    parsed[col] = value;

    const newCsv = CSV.stringify(parsedCsv);

    edit.createFile(document.uri, {
      contents: new TextEncoder().encode(newCsv),
      overwrite: true
    })

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

  private updateWebviewContent(parsedCsv: string[][], webview: vscode.Webview) {
    console.log('CSV: Updating webview content');

    try {
      const html = this.getHtmlForWebview(parsedCsv);
      webview.html = html;
      console.log('CSV: Webview content updated');
    } catch (error) {
      console.error('CSV: Error updating webview content', error);
    }
  }


  private getHtmlForWebview(parsedCsv: string[][]): string {
    console.log('CSV: Generating HTML for webview');

    const isDark = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark;

    const data = parsedCsv;
    console.log(`CSV: Parsed CSV data with ${data.length} rows`);

    const config = vscode.workspace.getConfiguration('editor');
    const fontFamily = config.get<string>('fontFamily') || "monospace"; // just to be sure that its a valid font family
    console.log(`CSV: Setting system font "${fontFamily}"`)

    return new HtmlView(parsedCsv, isDark, fontFamily).getHtml();
  }

}
