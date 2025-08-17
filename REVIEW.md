Repository Review and Prioritized Recommendations

Scope: VS Code custom editor for CSV/TSV (`csv.editor`). This document captures prioritized recommendations, their rationale, and current status.

Highest Priority (P0)
- Preserve CSV correctness on edit: Always rebuild CSV with Papa when editing a single cell to keep quoting/escaping intact. Status: done.
- Remove dead command wiring: `csv.changeIgnoreRows` was contributed but unimplemented. Removed from `package.json` and README. Status: done.
- Provide referenced language configuration: `language-configuration.json` referenced but missing. Added minimal file to satisfy the contribution. Status: done.
- Use current delimiter for copy: Copy-to-clipboard used comma regardless of settings/TSV. Now copies with the active delimiter. Status: done.
- Harden virtual scrolling: Guard IntersectionObserver wiring when there is no initial row (empty/new docs). Status: done.
- Tighten CSP: Replace `style-src 'unsafe-inline'` with a nonce-based policy matching the inline style tag. Status: done.

High Priority (P1)
- README accuracy: Align sorting instructions with actual UX (context menu on header). Status: done.
- Dependency/types cleanup: Remove unused `@types/mocha` and `mocha` from tsconfig types since tests use `node:test`. Status: done.
- Remove built artifact from repo: Dropped tracked `.vsix`. Status: done.

Medium Priority (P2)
- Sorting UX: Optional click-to-sort on header with visual indicator; currently available via context menu.
- Keydown handler consolidation: Merge overlapping Escape handlers to reduce duplication.
- Param clarity: Avoid parameter reassignment in `generateHtmlContent` (now using a local `headerFlag`). Status: done.

Notes and Rationale
- Data integrity is paramount: CSV quoting/escaping can’t be reliably manipulated via line-slice editing; Papa ensures correctness.
- UI consistency and discoverability: Updated README and ensured copy semantics align with user-chosen delimiter.
- Security posture: CSP narrowed to nonce-based for styles and scripts; content remains escaped before injection.

Local Verification
- Lint/tests were not executed in this environment due to sandbox limitations. Locally run:
  - `npm run lint`
  - `npm run compile`
  - `npm test`

Suggested Next Steps
- Consider adding tests for: `getSeparator()` TSV default behavior and copy delimiter usage.
- Optionally implement click-to-sort and add a test for numeric vs. locale string ordering.

