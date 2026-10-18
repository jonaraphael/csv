# Changelog

## [1.5.1] - Unreleased

- Add an icon-only word-wrap action beside the editor title bar’s table/text switch. Default each file to single-line cutoff at the automatic width cap, with Enable/Disable Word Wrap shown on hover. Preserve selection, viewport visibility, live drafts and manual sizes; copying and saving retain complete values.
- Keep fractional column borders resizable without widening the grab area.

## [1.4.2] - 2026-10-17

This release combines the editing, navigation, and table tools developed since the public 1.3 release.

### Editing and file integrity

- Preserve multiline drafts through repeated line breaks, blur, saves, tab changes, and table/text switches. Failed edits remain available for retry or explicit discard.
- Preserve existing CSV quoting and line endings during cell edits, structural paste, and row/column moves. Copy and Cut quote each value only when necessary, retain real empty fields, and exclude the extra append row.
- Add saved-file table/text replacement with unsaved-edit preservation and explicit Save As support for untitled CSV/TSV tables that retain their native owner.
- Keep native Find in Files destinations in text after an explicit local-file Text choice, including restart and Off/On. Restore only owned routing preferences on return to Table and preserve intervening user choices.
- Preserve the active document through multi-file Off/On changes. Serialize native handoffs and request a fresh acknowledgment for cell or filter activity made while waiting.
- Improve encoding guidance without guessing or silently changing the source encoding.

### Table navigation and views

- Add contextual first-row header and serial-index actions, frozen leading rows/columns, remembered manual widths, and a configurable default for hidden leading metadata.
- Fix column resize hit testing at fractional borders and frozen seams, retain usable narrow-column centers, and make dragged widths follow the pointer. Automatic sizing accounts for multiline values.
- Show selection immediately on mouse-down. Support a second separate header click for header-only selection, anchored Ctrl/Cmd+Shift+Arrow ranges, and viewport following during held-arrow navigation.
- Keep modified native Find/Replace shortcuts outside the table overlay. Position context menus using available viewport space, with scrolling in small panes.
- Paint frozen-row divider seams without changing row geometry. Preserve the chosen datatype palette or theme foreground mode across light, dark, and high-contrast themes.

### Filtering, preview, and comparison

- Add inline live column filters with multiple AND conditions, including repeated conditions on one column; inferred number/date/boolean comparisons; Does Not Contain; and RE2 regular expressions. Preserve input focus, invalid drafts, source row identities, and the full source when saving.
- Add a bounded, paginated read-only preview for large saved UTF-8 files. The direct Explorer/command path avoids opening a full text document first; malformed or oversized records produce errors instead of truncation.
- Add explicit read-only table comparison with record alignment, changed-cell highlighting, synchronized panes, change navigation, and bounded display/alignment work. Native Git/PR custom-editor diff remains a separate limitation.
- Document privacy and data handling, including remote extension hosts, clipboard/link actions, diagnostic logs, and saved filter values.

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
