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
- **Add/Delete Rows:** Insert above/below or remove the selected row via context menu.
- **Edit Empty CSVs:** Create or open an empty CSV file and start typing immediately.
- **Column Sorting:** Right-click a header and choose A–Z or Z–A.
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

## Commands

Open the Command Palette and search for:

- `CSV: Toggle Extension On/Off` (`csv.toggleExtension`)
- `CSV: Toggle First Row as Header` (`csv.toggleHeader`)
- `CSV: Toggle Serial Index Column` (`csv.toggleSerialIndex`)
- `CSV: Change CSV Separator` (`csv.changeSeparator`)
- `CSV: Change Font Family` (`csv.changeFontFamily`)
  

## Settings

Configure in the Settings UI or `settings.json`:

- `csv.enabled` (boolean, default `true`): Enable/disable the custom editor.
- `csv.treatFirstRowAsHeader` (boolean, default `true`): Treat the first row as a header.
- `csv.addSerialIndex` (boolean, default `false`): Show a serial index column.
- `csv.separator` (string, default `","`): Delimiter for parsing and saving.
- `csv.fontFamily` (string, default empty): Override font family; falls back to `editor.fontFamily`.
- `csv.cellPadding` (number, default `4`): Vertical cell padding in pixels.

Note: “Ignore First Rows” is a command-driven, per-file option stored by the extension.

---

## Release Notes

### v1.1.3
- Added: TSV file support with automatic tab delimiter.

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
