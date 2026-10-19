# CSV

**Find the rows that matter. Make the fix. Stay in VS Code.**

A data export, a test fixture, a lookup table: sometimes you just need to check a few values and fix them. CSV gives you an editable table in the same workspace as your code, with visual filters, selection totals, and cell-by-cell comparisons. Open the file, work on the data, and save.

CSV, TSV, TAB & PSV · No account required

![CSV table with aligned columns, datatype colors, and multiline notes in a dark theme](images/marketplace-dark.png)

## Why choose CSV?

Choose CSV when your next step is to **inspect and fix the data in place**.

| If you currently use: | What CSV will add for you:      |
| --- | --- |
| **Editing raw CSV in VS Code** | Work with cells, rows, and columns directly. Paste a block, move a column, or edit a multiline value while CSV handles the separators and escaping. |
| **[Rainbow CSV](https://marketplace.visualstudio.com/items?itemName=mechatroner.rainbow-csv)** for colored columns and SQL-like queries | Use a visual grid with point-and-click filters, range editing, and selection totals. Narrow down a dataset and correct the matching cells without writing a query. |
| **[Edit CSV](https://marketplace.visualstudio.com/items?itemName=janisdd.vscode-edit-csv)** for a grid with an Apply workflow | Cell edits commit directly to the VS Code document, source edits refresh the table, and Ctrl/Cmd+S saves. Switch between table and text as the task changes. |

## Find the few rows that need attention

An export has thousands of rows; you need the overdue orders, missing IDs, or unusually large amounts. Right-click a column, choose **Filter this column**, and build the conditions visually. Results update as you type. Combine text, number, date, and empty-cell conditions across columns, or use a regular expression when you need one.

Filters search the full editable document, including rows beyond the screen. Copy the matches, fill a selected range, or use Find and Replace to clean them up. **Filtering keeps the other rows in your file**, and range operations on the filtered view leave nonmatching rows intact.

![CSV narrowing a table with two live column filters combined with AND](images/marketplace-filters.png)

## Make one correction or clean up a whole range

Click a cell and type. Tab to the next one. Paste a block of data, fill a rectangle with one value, or drag selected rows and columns into the order you need. Right-click to insert, delete, or sort.

For long notes, double-click to edit the full value and use Shift+Enter for line breaks. CSV handles quoted separators and multiline cells, so you can concentrate on the content. Familiar copy, cut, paste, Find, and Replace shortcuts work in the table.

## Check totals without writing a formula

Select numeric cells and read **Sum, Average, and Count** in the VS Code status bar. Check a column total, compare a group of values, or sanity-check a filtered export without opening a spreadsheet or writing a script.

Totals follow your selection and committed edits. With filters active, they include only matching data rows; whole-column selections also include matching rows beyond the screen. Count is the number of selected numeric cells, with text, blanks, and headers excluded.

## Keep your changes easy to review

A small data fix should be easy to spot in version control. CSV preserves unchanged field quoting and existing line endings, so surrounding formatting stays intact. Datatype detection helps with colors and filters while stored values remain text: an ID such as `00123` keeps its leading zeros.

Use the title-bar switch to inspect or edit the same document as raw text, then return to the table. Pending changes stay unsaved until you save, or VS Code autosave saves committed edits.

Need to compare two exports? Select them in Explorer and choose **CSV: Compare Files as Table**. See changed cells side by side, navigate between changes, and keep both panes aligned as you scroll. This read-only comparison is a separate command; use VS Code's text diff for native Git/PR review. [Comparison details and size limits](docs/user-guide.md#compare-two-files-as-tables).

## Keep context as you scroll

Freeze the identifier columns and leading rows you need to keep in sight. Resize columns, toggle word wrap for long notes, or hide leading metadata without deleting it. CSV remembers per-file preferences such as column widths, frozen panes, and filters so you can return to the same working view.

Datatype colors, table zoom, and support for light, dark, and high-contrast themes help you read the data comfortably. [See the light theme](images/marketplace-light.png).

## Try it on your next export

1. **[Install CSV by ReprEng](https://marketplace.visualstudio.com/items?itemName=ReprEng.csv)** from the VS Code Marketplace, or search for `ReprEng.csv` in Extensions.
2. **Open a `.csv`, `.tsv`, `.tab`, or `.psv` file.** It opens as a table unless you have chosen another editor association. If needed, right-click the editor tab and choose **Reopen Editor With… → CSV**.
3. **Make a change and press Ctrl/Cmd+S.** Click a cell and type, or right-click a column to filter first. Escape cancels the active cell draft.

Working from scratch? Create an untitled document and choose CSV or TSV as its language mode to start a table before saving. Need a different delimiter? Run **CSV: Change CSV Separator**.

CSV supports VS Code 1.70+. Switching saved files between table and text requires 1.100+, or 1.120+ when there are unsaved changes. [Editing and compatibility details](docs/user-guide.md#open-and-edit-a-file).

## Your files stay in your workspace

CSV requires no account or upload service and has no extension-specific analytics client. Processing runs in your VS Code environment, including the remote extension host when you use a remote workspace. [Privacy and data handling](PRIVACY.md).

For a very large saved file, use **CSV: Open Large File Preview (Read-only)** from Explorer to inspect it a page at a time. The preview reads bounded blocks of host-local UTF-8 files; normal editing loads the full document. [Preview capabilities and limits](docs/user-guide.md#large-file-preview).

**Ready to make your next CSV fix in place? [Install CSV](https://marketplace.visualstudio.com/items?itemName=ReprEng.csv).**

## Help and reference

[User guide](docs/user-guide.md) · [Keyboard shortcuts](docs/user-guide.md#keyboard-and-mouse-reference) · [Commands](docs/user-guide.md#commands) · [Settings](docs/user-guide.md#settings) · [Changelog](CHANGELOG.md) · [Report an issue](https://github.com/jonaraphael/csv/issues)

For local development and verification, see the [development notes](docs/user-guide.md#privacy-and-development) and [repository priorities](REVIEW.md).
