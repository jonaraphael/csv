# Changelog

All notable changes to the "CSV" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
