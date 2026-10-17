export type ColumnFilterOperator = 'contains' | 'equals' | 'empty' | 'notEmpty';
export type ColumnFilter = { column: number; operator: ColumnFilterOperator; value: string };
export const MAX_FILTER_VALUE_LENGTH = 4096;
export const MAX_COLUMN_FILTERS = 256;
const operators = new Set<ColumnFilterOperator>(['contains', 'equals', 'empty', 'notEmpty']);

export function normalizeColumnFilters(raw: unknown, columnCount = Infinity): ColumnFilter[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const byColumn = new Map<number, ColumnFilter>();
  for (const item of raw.slice(0, MAX_COLUMN_FILTERS)) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const { column, operator, value } = item as Partial<ColumnFilter>;
    if (typeof column !== 'number' || !Number.isSafeInteger(column) || column < 0 || column >= columnCount || !operators.has(operator as ColumnFilterOperator) || typeof value !== 'string' || value.length > MAX_FILTER_VALUE_LENGTH) {
      continue;
    }
    byColumn.set(column, { column, operator: operator!, value });
  }
  return [...byColumn.values()].sort((a, b) => a.column - b.column);
}

export function rowMatchesFilters(row: string[], filters: ColumnFilter[]): boolean {
  return filters.every(filter => {
    const value = String(row[filter.column] ?? '');
    if (filter.operator === 'empty') {
      return value === '';
    }
    if (filter.operator === 'notEmpty') {
      return value !== '';
    }
    const text = value.toLowerCase();
    const query = filter.value.toLowerCase();
    return filter.operator === 'equals' ? text === query : text.includes(query);
  });
}

export function visibleSourceRows(data: string[][], hiddenRows: number, header: boolean, filters: ColumnFilter[]): number[] {
  const start = Math.min(Math.max(0, hiddenRows), data.length);
  const rows: number[] = [];
  for (let row = start; row < data.length; row++) {
    if ((header && row === start) || rowMatchesFilters(data[row], filters)) {
      rows.push(row);
    }
  }
  return rows;
}

// new column index -> original index; -1 denotes an inserted empty column.
export function remapColumnFilters(filters: ColumnFilter[], columnOrder: number[]): ColumnFilter[] {
  return columnOrder.flatMap((oldColumn, column) => {
    const filter = filters.find(item => item.column === oldColumn);
    return filter ? [{ ...filter, column }] : [];
  });
}
