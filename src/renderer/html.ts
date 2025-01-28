import * as CsvHelpers from './helpers';
import { getNonce, htmlElement } from './utils';

// @ts-expect-error
import cssContent from './assets/style.css?raw';
// @ts-expect-error
import jsContent from './assets/script.js?raw';

export class HtmlView {

    private readonly nonce: string;
    private readonly columnWidths: number[];
    private readonly columnColors: string[];

    constructor(
        private readonly parsedCsv: string[][],
        private readonly isDark: boolean,
        private readonly fontFamily: string = "monospace"
    ) {
        this.nonce = getNonce();

        this.columnWidths = CsvHelpers.computeColumnWidths(this.parsedCsv);

        const columnData = CsvHelpers.transpose(this.parsedCsv.slice(1)); // skip headers for transpose
        const columnTypes = columnData.map(col => CsvHelpers.estimateColumnDataType(col));

        this.columnColors = columnTypes.map((type, index) => CsvHelpers.getColumnColor(type, this.isDark, index));
    }

    public getHtml() {
        if (this.parsedCsv.length === 0 || this.parsedCsv[0].length === 0) {
            return `
                <!DOCTYPE html>
                <html>
                <head>
                    <meta charset="UTF-8">
                    <title>CSV</title>
                    <style>
                        body { 
                            font-family: ${this.fontFamily};
                            padding: 10px; 
                        }
                    </style>
                </head>
                <body>
                    <p>No data found in CSV.</p>
                </body>
                </html>
            `
        }

        return this.createHtml();
    }

    private createHeader() {
        const header = this.parsedCsv[0];

        let tableHead = "";
        for (let i = 0; i < header.length; i++) {
            const width = Math.min(this.columnWidths[i], 100);
            const color = this.columnColors[i];

            tableHead += htmlElement(
                "th",
                header[i],
                {
                    "min-width": `${width}ch`,
                    "max-width": "100ch",
                    "border": "1px solid #555",
                    "background-color": this.isDark ? '#1e1e1e' : '#ffffff',
                    "color": color,
                    "overflow": "hidden",
                    "white-space": "nowrap",
                    "text-overflow": "ellipsis",
                },
                {
                    "data-row": "0",
                    "data-col": `${i}`
                },
            )
        }

        tableHead = htmlElement("thead", htmlElement("tr", tableHead));
        return tableHead;
    }

    private createBody() {
        let tableBody = "";

        for (let rowIndex = 1; rowIndex < this.parsedCsv.length; rowIndex++) {
            const row = this.parsedCsv[rowIndex];

            let tableRow = ""
            for (let i = 0; i < row.length; i++) {
                const width = Math.min(this.columnWidths[i], 100);
                const color = this.columnColors[i];

                tableRow += htmlElement(
                    "td",
                    row[i],
                    {
                        "min-width": `${width}ch`,
                        "max-width": "100ch",
                        "border": "1px solid #555",
                        "color": color,
                        "overflow": "hidden",
                        "white-space": "pre-line",
                        "text-overflow": "ellipsis",
                    },
                    {
                        "data-row": `${rowIndex}`,
                        "data-col": `${i}`,
                        "tabindex": "0"
                    },
                )
            }

            tableBody += htmlElement("tr", tableRow);
        }
        tableBody = htmlElement("tbody", tableBody);

        return tableBody;
    }

    private createTable() {
        const thead = this.createHeader();
        const tbody = this.createBody();

        return htmlElement("table", `${thead}${tbody}`);
    }

    private createHtml() {
        const tableHtml = this.createTable();

        return `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${this.nonce}';">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>CSV</title>
            <style nonce="${this.nonce}">
                :root {
                    --csv-font-family: ${this.fontFamily};
                    --csv-bg-color: ${this.isDark ? '#333333' : '#cce0ff'};
                }
            </style>
            <style nonce="${this.nonce}">
                ${cssContent}
            </style>
        </head>
        <body>
            <div class="table-container">
                ${tableHtml}
            </div>
            <script nonce="${this.nonce}">
                ${jsContent}
            </script>
        </body>
      </html>
        `.trim();
    }
}

