# **CSV**

Experience a whole new way to work with CSV files right inside VS Code. CSV transforms your CSV files into an interactive, spreadsheet-like experience—making it effortless to view, edit, and navigate your data with precision and speed.

---

## Screenshots

![Dark Theme Screenshot](images/Screenshot_dark.png)
![Light Theme Screenshot](images/Screenshot_light.png)

---

## Why CSV?

Working with CSV files shouldn’t be a chore. With CSV, you get:

- **Direct In-Place Editing:** Click on any cell to edit its content seamlessly. Your changes can be saved immediately to the CSV file, ensuring data integrity without extra steps.
- **Smart Column Sizing & Dynamic Color Coding:** Columns automatically adjust to fit content while being visually distinguished by data type. Whether it’s boolean, date, integer, float, or text, each column gets its own adaptive color that adjusts for light and dark themes.
- **Sticky Headers & Fluid Navigation:** Keep your header row always visible as you scroll. Effortlessly move through cells using intuitive keyboard shortcuts like `Tab`, `Shift + Tab`, and arrow keys—just like a full-featured spreadsheet.
- **Efficient Multi-Cell Selection & Clipboard Integration:** Select a range of cells with click-and-drag and copy them as well-formatted CSV data using `Ctrl/Cmd + C`.
- **Clipboard Actions:** Use Ctrl/Cmd + C or X, or right-click a selection and choose Copy or Cut, to copy properly quoted data to the system clipboard. Right-click Paste inserts clipboard data into the grid. Ordinary cell text is copied without surrounding quotes. CSV escaping still preserves separators, line breaks, literal quotes, surrounding whitespace, and empty cells. Clipboard shortcuts in Find, Replace, and cell text edits keep their normal text-editing behavior.
- **Grid Paste Support:** Paste copied ranges directly into the selected cell/range with `Ctrl/Cmd + V` in selection mode.
- **Robust Data Handling:** Leveraging the power of [Papa Parse](https://www.papaparse.com/), the extension handles complex CSV structures, special characters, and various data types gracefully.
- **Theme-Optimized Interface:** CSV adapts to light, dark, and high-contrast themes. High-contrast themes use your theme’s foreground colors for cells, selection, Find/Replace, and menus automatically.

---

## Features

- **Interactive Editing:** Two modes — type to start a quick edit, or press Enter/double‑click for detail edit. Changes commit to the document when focus leaves the cell or CSV view; unsaved changes remain visible when you switch tabs.
- **Smart Resizing:** Automatic widths follow the longest line in multiline cells. Drag close to a column boundary to resize; the narrow grab area leaves small columns selectable. Widths are remembered per file across closing and reopening. Double-click a column boundary to restore automatic sizing. Resizing also works with the header row hidden.
- **Dynamic Color Coding:** Visual cues based on data type help you quickly identify numbers, dates, booleans, and more (with opt‑in cool palette and theme-foreground mode settings).
- **Frozen Rows and Columns:** Keep any number of leading visible rows and data columns in view. Right-click a cell to freeze through its row/column or unfreeze; counts are remembered per file. Frozen rows use measured heights, including multiline cells and zoom, and cover the top edge so scrolling text cannot bleed above them. The serial index stays visible alongside frozen data columns.
- **Enhanced Keyboard Navigation:** Navigate cells with arrows and Tab/Shift+Tab; quick edits can commit with arrow keys; `Ctrl/Cmd + A` selects all; `Ctrl/Cmd + C` copies selection.
- **Advanced Multi-Cell Selection:** Easily select and copy blocks of data, then paste them elsewhere as properly formatted CSV.
- **Add/Delete Columns:** Right-click any cell to add a column left or right, or remove the selected column.
- **Add/Delete Rows:** Insert above/below or remove the selected row via context menu.
- **Edit Empty CSVs:** Create or open an empty CSV file and start typing immediately.
- **Column Sorting:** Right-click a header and choose A–Z or Z–A. With filters active, sorting rearranges matching rows within their source positions and leaves hidden rows in place.
- **Column Filters:** Right-click a column and choose Filter this column. Every column offers Contains, Does Not Contain, Regular Expression, Equals, Does Not Equal, Is Empty and Is Not Empty. Number and date columns also offer >, >=, < and <= comparisons. The picker shows the inferred type from the original body rows, excluding headers and hidden metadata; other filters do not change it. For filters, a text column whose nonblank cells all contain supported dates also offers date comparisons, without changing column colors. The active-filter bar shows readable conditions, matching/total counts, removable conditions and Clear all filters. Filters search the full file, retain source row numbers and are remembered per file.
- **Custom Font Controls:** Choose a font family and optional font-size override, or inherit VS Code defaults.
- **In-View Zoom:** Use `Ctrl/Cmd + Mouse Wheel` or `Ctrl/Cmd + +/-/0` to zoom the CSV view without changing global editor zoom.
- **Find & Replace Overlay:** Built-in find/replace bar with match options (case, whole-word, regex), keyboard navigation, and single/all replace actions across the full file (including chunked rows), or the matching rows while column filters are active.
- **Multiline Cell Display:** Cells with embedded newlines render as wrapped multi-line content (with preserved line breaks and matching row height).
- **Clickable Links:** URLs in cells are automatically detected and displayed as clickable links. Ctrl/Cmd+click to open them in your browser.
- **Preserved CSV Integrity:** Cell edits, expanding grid pastes, and row/column moves preserve existing field quoting and line endings. Appended values follow the existing column quote style when the column uses one consistently.
- **Optimized for Performance:** Designed for medium-sized datasets, ensuring a smooth editing experience without compromising on functionality.
- **Large File Support:** Loads big CSVs in chunks so even large datasets open quickly.
- **CSV/TSV/TAB/PSV Support:** `.csv`, `.tsv`, `.tab`, and `.psv` files are recognized automatically. Defaults: comma for CSV, tab for TSV/TAB, pipe for PSV.

---

## Compatibility

This extension is built for VS Code **1.70.0** and later. It has been tested with
Cursor (built on VS Code 1.99) and the latest VS Code releases (1.102).

## Getting Started

### 1. Install the Extension

- Open Visual Studio Code.
- Go to the Extensions view (`Ctrl+Shift+X` or `Cmd+Shift+X` on macOS).
- Search for **CSV** and click **Install**.

### 2. Open a CSV, TSV, TAB, or PSV File

- Open any `.csv`, `.tsv`, `.tab`, or `.psv` file in VS Code.
- The file will automatically load, presenting your data in an interactive grid view.

### 3. Edit and Navigate

- **Edit Modes:**
  - Quick edit: start typing any character to edit the selected cell immediately. Press any Arrow key to save and move the selection to the next cell in that direction.
  - Detail edit: press `Enter` on a selected cell or double‑click to enter a focused edit. Arrow Left/Right move the text caret; Arrow Up goes to start; Arrow Down goes to end. Click outside the cell (or blur) to save.
- **Keyboard Navigation:** Use Arrow keys to move between cells when not editing. Use `Tab`/`Shift+Tab` to move horizontally (wrapping across rows as needed).
- **Multi-Cell Selection:** Click and drag or use `Shift + Click` to select multiple cells, then copy them as CSV using `Ctrl/Cmd + C`.
- **Find & Replace:** Press `Ctrl/Cmd + F` to open Find, or `Ctrl/Cmd + H` to open Find + Replace. With filters active, Find and Replace All operate on the visible filtered table (including its header); hidden metadata and nonmatching rows are excluded.

Filter comparisons use the column's inferred type. Text matching ignores case. Numbers compare finite decimal/scientific values, including consistently grouped thousands. Boolean equality accepts `true/false`, `t/f`, `yes/no`, `y/n`, `on/off` and `1/0`. Date queries accept explicit numeric dates and English month names, optional times and timezone offsets; date-only or timezone-less values use UTC. Ambiguous numeric dates default to month/day/year (`03/04/2026` means March 4); a leading day above 12 is unambiguous (`13/04/2026` means April 13). Use an ISO date or an explicit month name to avoid ambiguity. Supported timestamps compare exactly, including sub-millisecond fractional seconds. Blank or invalid cell values do not match typed comparisons, including Does Not Equal; use Is Empty to find empty cells. Invalid or cancelled input leaves the previous condition unchanged.

Regular Expression uses [RE2 syntax](https://github.com/google/re2/wiki/Syntax). Plain patterns ignore case; `/pattern/flags` accepts `i`, `m` and `s`, and explicit flags override that default (`/pattern/` is case-sensitive). Lookaround and backreferences are unsupported and rejected by input validation.

---

## Commands

Open the Command Palette and search for:

- `CSV: Toggle Extension On/Off` (`csv.toggleExtension`)
- `CSV: Toggle First Row as Header` (`csv.toggleHeader`)
- `CSV: Freeze Leading Rows` (`csv.changeFrozenRows`)
- `CSV: Freeze Leading Columns` (`csv.changeFrozenColumns`)
- `CSV: Toggle Serial Index Column` (`csv.toggleSerialIndex`)
- `CSV: Change CSV Separator` (`csv.changeSeparator`)
- `CSV: Reset CSV Separator (Inherit)` (`csv.resetSeparator`)
- `CSV: Change Font Family` (`csv.changeFontFamily`)
- `CSV: Hide First N Rows` (`csv.changeIgnoreRows`)
- `CSV: Change File Encoding` (`csv.changeEncoding`)
- `CSV: Toggle Clickable Links` (`csv.toggleClickableLinks`)
  

## Settings

Global (Settings UI or `settings.json`):

- `csv.enabled` (boolean, default `true`): Enable/disable the custom editor.
- `csv.defaultIgnoreRows` (integer, default `0`): Default number of leading metadata rows to hide. Set it globally or for a workspace/folder. `CSV: Hide First N Rows` overrides it per file; enter `0` to show all rows or leave the input blank to reset that file to the configured default. Hidden rows remain in the saved file.
- `csv.fontFamily` (string, default empty): Override font family; falls back to `editor.fontFamily`.
- `csv.fontSize` (number, default `0`): Override font size in px; set to `0` to inherit `editor.fontSize`.
- `csv.mouseWheelZoom` (boolean, default `true`): Enable `Ctrl/Cmd + Mouse Wheel` zooming in the CSV editor.
- `csv.mouseWheelZoomInvert` (boolean, default `false`): Invert the `Ctrl/Cmd + Mouse Wheel` zoom direction.
- `csv.cellPadding` (number, default `4`): Vertical cell padding in pixels.
- `csv.columnColorMode` (string, default `type`): `type` keeps CSV’s type-based column colors; `theme` uses your theme foreground color for all columns.
- `csv.columnColorPalette` (string, default `default`): Type-color palette when `csv.columnColorMode` is `type`. `cool` biases colors toward greens/blues; `warm` biases colors toward oranges/reds.
- `csv.diffUseThemeForeground` (boolean, default `true`): In compare/diff views, use theme foreground color so diff highlighting remains readable.
- `csv.clickableLinks` (boolean, default `true`): Make URLs in cells clickable. Ctrl/Cmd+click to open links.
- `csv.showTrailingEmptyRow` (boolean, default `true`): Show the extra empty row at the end of the table. Turn this off to hide that visual append row.
- `csv.separatorMode` (string, default `extension`): Separator selection mode when no per-file override exists. `extension` uses extension mapping, `auto` detects from content first, `default` always uses `csv.defaultSeparator`.
- `csv.defaultSeparator` (string, default `,`): Fallback separator. Use `\\t` in `settings.json` for tabs.
- `csv.separatorByExtension` (object): Extension-to-separator mapping (defaults include `.csv`→`,`, `.tsv`/`.tab`→tab, `.psv`→`|`).
- `csv.maxFileSizeMB` (number, default `10`): Soft limit for opening files in CSV view. If exceeded, CSV prompts: `Cancel`, `Continue This Time`, or `Ignore Forever` (sets this setting to `0`).
- Per-file encoding: use `CSV: Change File Encoding` to set a file's encoding (e.g., `utf8`, `utf16le`, `windows1250`, `gbk`). The extension will reopen the file using the chosen encoding.

Per-file (stored by the extension; set via commands):

- First row as header (default `true`) — `CSV: Toggle First Row as Header`
- Serial index column (default `true`) — `CSV: Toggle Serial Index Column`
- CSV separator override — `CSV: Change CSV Separator` (or clear it with `CSV: Reset CSV Separator (Inherit)`)
- Hide first N rows (inherits `csv.defaultIgnoreRows`) — `CSV: Hide First N Rows`. An explicit `0` overrides a nonzero default; blank input clears the per-file override.
- Column filter conditions — set from a column’s context menu and remove from the active-filter bar. Conditions, including any entered CSV text, are stored in VS Code workspace state on the extension host (which may be remote). Clear all filters removes the saved conditions for that file. No CSV rows are removed by filtering.
- Frozen leading visible rows/columns — `CSV: Freeze Leading Rows` / `CSV: Freeze Leading Columns`. Enter `0` to unfreeze that axis. The default keeps the first header row frozen; with headers off, no rows freeze until requested. Hidden metadata rows do not count; the virtual append row is never frozen as a leading row.

---

## Editing Modes and Shortcuts

- Quick edit:
  - Start: type any character (not Enter) on a selected cell.
  - Save and move: press Arrow Up/Down/Left/Right to save and select the adjacent cell; does not re-enter edit.
- Detail edit:
  - Start: press `Enter` on a selected cell or double‑click a cell.
  - Caret navigation: Arrow Left/Right move one character; Arrow Up moves caret to start; Arrow Down moves caret to end.
  - New line in cell: `Shift + Enter` inserts a line break inside the current cell.
  - Exit/save: click outside the cell or move focus to commit changes.
  - Save the file: `Ctrl/Cmd + S` commits the active cell before saving, including all inserted line breaks.
- Global:
  - Copy selection: `Ctrl/Cmd + C`
  - Paste selection: `Ctrl/Cmd + V` (selection mode). Pasting a single value into a selected rectangle fills that rectangle. With filters active, copying/cutting and filling affect visible selected rows; matrix paste advances through matching rows and appends at the physical end when needed. Nonmatching rows remain intact, and saving always includes the full source file.
  - Zoom in/out/reset: `Ctrl/Cmd + +`, `Ctrl/Cmd + -`, `Ctrl/Cmd + 0` (also `Ctrl/Cmd + Mouse Wheel`)
  - Find: `Ctrl/Cmd + F`
  - Replace: `Ctrl/Cmd + H`
  - Next/Previous match: `F3` / `Shift + F3` (also `Enter` / `Shift + Enter` in the Find box)
  - Select all: `Ctrl/Cmd + A`

---

## Release Notes

### v1.2.1
- Fix scrolling freeze at ~1000 rows when header is enabled by unifying chunking behavior and safely transporting chunks to the webview.
- Trim trailing empty lines to avoid phantom last rows; correct final virtual row numbering.
- Preserve scroll position after edits/saves in later chunks by loading enough chunks before restoring scroll.
- Add tests for separators (CSV/TSV overrides), strict date parsing, header heuristics, and chunking stability.

### v1.2.0
- Edit modes: Quick edit (type to start; arrows save and move) and Detail edit (Enter/double‑click; arrows move caret, Up/Down jump to start/end).
- Virtual rows and cells: Always shows one extra empty row at the bottom; short rows display empty editable cells up to the widest column. Empty edits do not create real rows/columns.
- State persistence: Keeps scroll position and selection across tab switches and configuration refreshes, including large files with chunked rendering.
- Selection improvements: Shift+Click on headers selects column ranges; Shift+Click on the serial index selects row ranges; right‑click preserves current selection.
- Batch actions: Context menu adapts to multi‑selection (Add/Delete X Rows/Columns) and performs exact counts in a single operation.
- Delete to clear: Press Delete/Backspace to clear contents of selected cells (skips serial index column).
- Copy fidelity: Copies with the active delimiter and skips the serial index column for full‑row copies.
- Encoding: New command “CSV: Change File Encoding” integrates VS Code’s encoding picker and returns to the CSV view.
- Enable/disable UX: Toggling the extension on instantly upgrades open CSV/TSV tabs to this view; toggling off reverts immediately to the default view.

See full history in `CHANGELOG.md`.

---

## Development

Clone the repository and run the following commands:

```bash
npm install
npm run lint
npm test
```

To create a VS Code extension package, run:

```bash
npm run package
```

To compile without running tests:

```bash
npm run compile
```

---

## Privacy

CSV processes files through VS Code and bundled libraries, with no extension-specific upload service or telemetry client. Remote workspaces, clipboard operations, links, diagnostic logs, and editor-managed backups have additional data-handling implications. See [Privacy and data handling](PRIVACY.md) for the verified behavior and scope.

---

## Support

Have questions, suggestions, or encountered an issue?
- Open an issue on [GitHub](https://github.com/jonaraphael/csv/issues) and let us know how we can help!

---

## License

This extension is licensed under the [MIT License](LICENSE).
