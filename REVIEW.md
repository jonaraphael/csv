Repository Review and Prioritized Recommendations

Scope: VS Code custom editor for CSV/TSV (`csv.editor`). This document tracks active priorities and critical follow‑ups. Completed items have been removed for clarity.

Priorities

P0 (Critical)
- Virtual row/cell invariants: Maintain exactly one virtual empty row at the bottom; render virtual empty cells so every row shows up to the widest column. Do not promote virtuals to real rows/columns on empty blur. Add tests for Enter/Tab/Arrow flows at the bottom boundary and for chunked views.
- Batch operations correctness: Verify multi‑row/column Add/Delete perform the exact counts and preserve indices (delete bottom→top/right→left). Add tests.
- Encoding UX: Current flow uses the built‑in “Change Encoding” picker and returns to the CSV editor. Consider persisting a per‑URI encoding (via workspaceState) to auto‑restore on reopen when no workspace is present.

P1 (High)
- State persistence: Ensure scroll + selection restore across config changes and chunk loads; add targeted tests (including very large files and header on/off).
- Selection semantics: Preserve selection on right‑click; Shift+Click ranges on headers and serial index; add tests for row/column/rectangular cases.
- Copy fidelity: Confirm delimiter, quoting, and skipped serial index column for whole‑row copies; add tests.

P2 (Medium)
- CSP tightening: Replace `style-src 'unsafe-inline'` with nonce‑only styles (we already nonce the tag; remove the policy’s unsafe‑inline if feasible without regressions).
- Keydown handler consolidation: Reduce duplicate Escape/Arrow handlers and centralize navigation + edit‑mode logic.
- Performance: Review `computeColumnWidths` and chunk append for very wide/long files; consider incremental width measurement or sampling.
- Visual affordance: Optional subtle styling for virtual cells/row to make “ready‑to‑edit” state clearer.

Notes
- Papa Parse remains the ground‑truth for read/write to preserve CSV quoting/escaping.
- UI flows now include: dual edit modes (quick/detail), persistent selection/scroll, virtual cells/rows, multi‑selection batch ops, and native encoding picker.

Local Verification
- Run locally:
  - `npm run lint`
  - `npm run compile`
  - `npm test`
