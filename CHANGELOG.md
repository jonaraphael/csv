# Changelog

All notable changes to the "CSV" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.4.0] - Unreleased

Integration candidate; final contents remain subject to review. No release has been published.

- Added: Context actions for first-row header state and serial-index visibility, using the existing per-file preferences.
- Added: Inline column filters that update matching rows as you type, with multiple AND conditions (including on the same column), inferred number/date comparisons, Does Not Contain, regular expressions, per-file persistence, and full-source saves.
- Added: Frozen leading rows and columns, plus a configurable default for hidden metadata rows.
- Added: Bounded, paginated read-only preview for large saved UTF-8 files.
- Added: Table/text switching and untitled CSV/TSV editing with explicit Save As support.
- Added: Explicit read-only comparison of two files as tables.
- Fixed: The table/text toolbar action appears in supported text files and replaces saved-file views while retaining unsaved edits.
- Fixed: Edit/save ordering and pending multiline edits across editor changes.
- Fixed: Dark high contrast uses the existing dark datatype palette; accessibility styling is limited to high-contrast themes and preserves the selected palette and color mode.
- Fixed: Precise column resize boundaries, editable centers in narrow columns, and drag widths that follow the pointer.
- Fixed: Context menus keep their natural width, open toward available space, and remain scrollable in small editor panes.
- Fixed: Frozen rows fill every collapsed divider seam with the divider color so scrolling text cannot peek between pinned rows or above them.
- Fixed: Cmd/Ctrl+Shift+Arrow extends the current cell, row, or column selection while retaining its starting anchor.
- Fixed: Held arrow navigation keeps the active cell or range endpoint visible on each display frame, including beneath frozen panes and filter controls.
- Fixed: Clipboard actions, delimiter fidelity, and CSV quote/line-ending preservation during data mutations.
- Improved: Multiline-aware column sizing, remembered manual widths, and encoding guidance.
- Documentation: Privacy and data handling, including remote workspaces and saved filter conditions.

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
