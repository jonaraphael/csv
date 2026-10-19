import { parseFilterNumber } from './filter-values';

export type NumericSelection =
  | { kind: 'cells'; minRow: number; maxRow: number; minCol: number; maxCol: number }
  | { kind: 'rows'; minRow: number; maxRow: number }
  | { kind: 'columns'; minCol: number; maxCol: number }
  | { kind: 'all' };

export interface SelectionStatistics {
  sum: number;
  average: number;
  count: number;
}

/** Validate the compact selection message before using its bounds. */
export function parseNumericSelection(raw: unknown): NumericSelection | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { return undefined; }
  const value = raw as Record<string, unknown>;
  const validRange = (min: unknown, max: unknown): boolean =>
    typeof min === 'number' && typeof max === 'number' && Number.isSafeInteger(min) && Number.isSafeInteger(max) && min >= 0 && max >= min;
  if (value.kind === 'all') { return { kind: 'all' }; }
  if (value.kind === 'cells' || value.kind === 'rows') {
    if (!validRange(value.minRow, value.maxRow)) { return undefined; }
    if (value.kind === 'rows') { return { kind: 'rows', minRow: value.minRow as number, maxRow: value.maxRow as number }; }
  }
  if ((value.kind === 'cells' || value.kind === 'columns') && validRange(value.minCol, value.maxCol)) {
    const columns = { minCol: value.minCol as number, maxCol: value.maxCol as number };
    return value.kind === 'columns' ? { kind: 'columns', ...columns }
      : { kind: 'cells', minRow: value.minRow as number, maxRow: value.maxRow as number, ...columns };
  }
  return undefined;
}

/** Aggregate source values, including unloaded rows, within the displayed selection. */
export function computeSelectionStatistics(
  data: readonly (readonly string[])[],
  selection: NumericSelection,
  firstDataRow: number,
  visibleRowIds?: readonly number[]
): SelectionStatistics {
  const minRow = Math.max(firstDataRow, 'minRow' in selection ? selection.minRow : 0);
  const maxRow = Math.min(data.length - 1, 'maxRow' in selection ? selection.maxRow : data.length - 1);
  const minCol = 'minCol' in selection ? selection.minCol : 0;
  const maxCol = 'maxCol' in selection ? selection.maxCol : Infinity;
  let count = 0, sum = 0, correction = 0, scale = 0;
  const addRow = (rowId: number) => {
    if (rowId < minRow || rowId > maxRow) { return; }
    const row = data[rowId];
    for (let col = minCol; col <= Math.min(maxCol, row.length - 1); col++) {
      const value = parseFilterNumber(row[col]);
      if (value === undefined) { continue; }
      count++;
      // Scale before compensated summation so intermediate totals cannot overflow.
      // This also keeps the average finite when a valid sum exceeds Number.MAX_VALUE.
      const magnitude = Math.abs(value);
      if (magnitude > scale) {
        const ratio = scale / magnitude;
        sum *= ratio;
        correction *= ratio;
        scale = magnitude;
      }
      const normalized = scale ? value / scale : 0;
      const next = sum + normalized;
      correction += Math.abs(sum) >= Math.abs(normalized) ? (sum - next) + normalized : (normalized - next) + sum;
      sum = next;
    }
  };
  if (visibleRowIds) {
    for (const rowId of visibleRowIds) { addRow(rowId); }
  } else {
    for (let rowId = minRow; rowId <= maxRow; rowId++) { addRow(rowId); }
  }
  const total = sum + correction;
  return { sum: total * scale, average: count ? (total / count) * scale : 0, count };
}

export function formatSelectionStatistics(stats: SelectionStatistics): string {
  const format = (value: number) => {
    if (!Number.isFinite(value)) { return 'Overflow'; }
    return Number.isSafeInteger(value) ? String(value) : String(Number(value.toPrecision(15)));
  };
  return `Sum: ${format(stats.sum)}  Average: ${format(stats.average)}  Count: ${stats.count}`;
}
