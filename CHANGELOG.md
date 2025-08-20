# Changelog

All notable changes to the "CSV" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.1] - 2025-08-20
- Fixed: Scrolling freeze at 1000 rows when header was enabled by making chunking consistent across modes and using a safe JSON transport to the webview.
- Fixed: Phantom virtual row indices caused by EOF newlines; now trims trailing empty rows and uses stable counts for the final virtual row.
- Fixed: View jumping back to ~1000 after blur/save when editing later chunks by loading additional chunks before restoring scroll.
- Tests: Added fixture-based tests for separators, dates, header heuristics, and chunking variations.
- Internal: More robust chunk loader with IntersectionObserver + scroll fallback.

## [1.2.0] - 2025-08-17
- Added: Dual editing modes — quick edit (type to start; arrow keys save and move) and detail edit (Enter/double‑click; caret left/right; Up/Down jump to start/end).
- Added: Virtual bottom row always present; virtual cells extend short rows; empty edits no longer create real rows/columns.
- Added: Persistent scroll + selection across tab switches and config refreshes, including chunked views.
- Added: Shift+Click ranges for headers (columns) and serial index (rows); right‑click preserves selection.
- Added: Batch actions for multi‑selection (Add/Delete X Rows/Columns) with stable index order.
- Added: Delete/Backspace clears selected cells; copy uses active delimiter and skips serial index.
- Added: “CSV: Change File Encoding” using VS Code’s native encoding picker and seamless return to CSV view.
- Improved: Enabling the extension upgrades open CSV/TSV tabs immediately; disabling reverts instantly.

## [1.1.3] - 2025-06-11
- Added: TSV file support with automatic tab delimiter.

## [1.1.2] - 2025-06-11
- Fixed: fontFamily

## [1.1.0] - 2025-06-11
- New: Row Insertion/Deletion.
- New: Column sorting by clicking header labels.
- Added: Font selection dropdown honoring VS Code fonts.
- Added: Editing of empty CSV files.
- Improved: Large files load in 1000-row chunks.
- Enhanced: `Ctrl/Cmd + A` selects the entire table.
- Fixed: Row indexing when the header row is disabled.
- Improved: Safer rendering for HTML-like content.

## [1.0.6] - 2024-05-20
- New: Multi-cell selection with intuitive `Shift + Click` support.
- Enhanced: Clipboard integration for copying selected cells as clean, CSV-formatted text.
- Improved: Navigation and editing, including better handling of special characters like quotes and commas.
- Added: Advanced column type detection with dynamic color-coded highlighting.
- Refined: Update mechanism for external document changes without interrupting your workflow.

## [1.0.2] - 2024-02-15
- Improved: Seamless activation of editing mode on double-click.
- Fixed: `Tab` and `Shift + Tab` navigation issues, ensuring smooth cell-to-cell movement.
- Updated: Sticky header styling now consistently matches the active theme.

## [1.0.0] - 2023-12-01
- Initial release with interactive cell editing, smart column sizing, and adaptive theme support.
