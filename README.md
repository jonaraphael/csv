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
- **Robust Data Handling:** Leveraging the power of [Papa Parse](https://www.papaparse.com/), the extension handles complex CSV structures, special characters, and various data types gracefully.
- **Theme-Optimized Interface:** Whether you prefer light or dark mode, CSV automatically adapts its styles for an optimal viewing experience.

---

## Features

- **Interactive Editing:** Two modes — type to start a quick edit, or press Enter/double‑click for detail edit. Saves on blur.
- **Smart Resizing:** Automatic calculation of column widths for improved readability.
- **Dynamic Color Coding:** Visual cues based on data type help you quickly identify numbers, dates, booleans, and more (with opt‑in cool palette and theme-foreground mode settings).
- **Sticky Headers:** Keep column titles in view as you scroll through large datasets.
- **Enhanced Keyboard Navigation:** Navigate cells with arrows and Tab/Shift+Tab; quick edits can commit with arrow keys; `Ctrl/Cmd + A` selects all; `Ctrl/Cmd + C` copies selection.
- **Advanced Multi-Cell Selection:** Easily select and copy blocks of data, then paste them elsewhere as properly formatted CSV.
- **Add/Delete Columns:** Right-click any cell to add a column left or right, or remove the selected column.
- **Add/Delete Rows:** Insert above/below or remove the selected row via context menu.
- **Edit Empty CSVs:** Create or open an empty CSV file and start typing immediately.
- **Column Sorting:** Right-click a header and choose A–Z or Z–A.
- **Custom Font Selection:** Choose a font from a dropdown or inherit VS Code's default.
- **Find & Replace Overlay:** Built-in find/replace bar with match options (case, whole-word, regex), keyboard navigation, and single/all replace actions across the full file (including chunked rows).
- **Multiline Cell Display:** Cells with embedded newlines render as wrapped multi-line content (with preserved line breaks and matching row height).
- **Clickable Links:** URLs in cells are automatically detected and displayed as clickable links. Ctrl/Cmd+click to open them in your browser.
- **Preserved CSV Integrity:** All modifications respect CSV formatting—no unwanted extra characters or formatting issues.
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
- **Find & Replace:** Press `Ctrl/Cmd + F` to open Find, or `Ctrl/Cmd + H` to open Find + Replace.

---

## Commands

Open the Command Palette and search for:

- `CSV: Toggle Extension On/Off` (`csv.toggleExtension`)
- `CSV: Toggle First Row as Header` (`csv.toggleHeader`)
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
- `csv.fontFamily` (string, default empty): Override font family; falls back to `editor.fontFamily`.
- `csv.cellPadding` (number, default `4`): Vertical cell padding in pixels.
- `csv.columnColorMode` (string, default `type`): `type` keeps CSV’s type-based column colors; `theme` uses your theme foreground color for all columns.
- `csv.columnColorPalette` (string, default `default`): Type-color palette when `csv.columnColorMode` is `type`. `cool` biases colors toward greens/blues; `warm` biases colors toward oranges/reds.
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
- Hide first N rows (default `0`) — `CSV: Hide First N Rows`

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
- Global:
  - Copy selection: `Ctrl/Cmd + C`
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

## Support

Have questions, suggestions, or encountered an issue?
- Open an issue on [GitHub](https://github.com/jonaraphael/csv/issues) and let us know how we can help!

---

## License

This extension is licensed under the [MIT License](LICENSE).
