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

- **Interactive Editing:** Double-click any cell to edit, with automatic save on blur.
- **Smart Resizing:** Automatic calculation of column widths for improved readability.
- **Dynamic Color Coding:** Visual cues based on data type help you quickly identify numbers, dates, booleans, and more.
- **Sticky Headers:** Keep column titles in view as you scroll through large datasets.
- **Enhanced Keyboard Navigation:** Navigate cells with Tab/Shift+Tab and use keyboard shortcuts for quick editing, saving, selection, and full-table `Ctrl/Cmd + A` select-all.
- **Advanced Multi-Cell Selection:** Easily select and copy blocks of data, then paste them elsewhere as properly formatted CSV.
- **Add/Delete Columns:** Right-click any cell to add a column left or right, or remove the selected column.
- **Edit Empty CSVs:** Create or open an empty CSV file and start typing immediately.
- **Column Sorting:** Click column headers to sort ascending or descending.
- **Custom Font Selection:** Choose a font from a dropdown or inherit VS Code's default.
- **Find & Highlight:** Built-in find widget helps you search for text within your CSV with real-time highlighting and navigation through matches.
- **Preserved CSV Integrity:** All modifications respect CSV formatting—no unwanted extra characters or formatting issues.
- **Optimized for Performance:** Designed for medium-sized datasets, ensuring a smooth editing experience without compromising on functionality.
- **Large File Support:** Loads big CSVs in chunks so even large datasets open quickly.
- **TSV Support:** `.tsv` files are recognized automatically and use tabs as the default separator.

---

## Compatibility

This extension is built for VS Code **1.70.0** and later. It has been tested with
Cursor (built on VS Code 1.99) and the latest VS Code releases (1.102).

## Getting Started

### 1. Install the Extension

- Open Visual Studio Code.
- Go to the Extensions view (`Ctrl+Shift+X` or `Cmd+Shift+X` on macOS).
- Search for **CSV** and click **Install**.

### 2. Open a CSV or TSV File

- Open any `.csv` or `.tsv` file in VS Code.
- The file will automatically load, presenting your data in an interactive grid view.

### 3. Edit and Navigate

- **Click to Edit:** Double-click any cell to edit its content. Simply press `Enter` or click outside the cell to save.
- **Keyboard Navigation:** Use `Tab`/`Shift+Tab` to move horizontally between cells. Navigation also wraps to the next or previous row as needed.
- **Multi-Cell Selection:** Click and drag or use `Shift + Click` to select multiple cells, then copy them as CSV using `Ctrl/Cmd + C`.
- **Find & Highlight:** Press `Ctrl/Cmd + F` to activate the find widget and quickly locate data within your CSV.

---

## Planned Improvements

- **Row Insertion/Deletion:** Quickly add or remove rows without leaving the editor (coming soon).

---

## Release Notes

### v1.1.2
- **Fixed:** fontFamily

### v1.1.0
- **New:** Column sorting by clicking header labels.
- **Added:** Font selection dropdown that honors VS Code font settings.
- **Added:** Ability to create and edit empty CSV files.
- **Improved:** Large CSV files load in 1000-row chunks for better performance.
- **Enhanced:** `Ctrl/Cmd + A` now selects all cells in the grid.
- **Fixed:** Correct row indexing when the header row is disabled.
- **Improved:** Safer rendering for cells containing HTML-like text.

### v1.0.6
- **New:** Multi-cell selection with intuitive `Shift + Click` support.
- **Enhanced:** Clipboard integration for copying selected cells as clean, CSV-formatted text.
- **Improved:** Navigation and editing, including better handling of special characters like quotes and commas.
- **Added:** Advanced column type detection with dynamic color-coded highlighting.
- **Refined:** Update mechanism for external document changes without interrupting your workflow.
- **Configurable:** Added `csv.cellPadding` setting to adjust table cell padding.

### v1.0.2
- **Improved:** Seamless activation of editing mode on double-click.
- **Fixed:** `Tab` and `Shift + Tab` navigation issues, ensuring smooth cell-to-cell movement.
- **Updated:** Sticky header styling now consistently matches the active theme.

### v1.0.0
- **Initial Release:** Introduced a full-featured CSV with interactive cell editing, smart column sizing, and adaptive theme support.

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

---

## Support

Have questions, suggestions, or encountered an issue?
- Open an issue on [GitHub](https://github.com/jonaraphael/csv/issues) and let us know how we can help!

---

## License

This extension is licensed under the [MIT License](LICENSE).
