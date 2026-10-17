import { RE2JS } from 're2js';
import { FilterDataType, compileFilterDateComparison, compileFilterNumberComparison, parseFilterBoolean } from './filter-values';

export type { FilterDataType } from './filter-values';
export type ColumnFilterOperator = 'contains' | 'notContains' | 'regex' | 'equals' | 'notEquals' | 'greaterThan' | 'greaterThanOrEqual' | 'lessThan' | 'lessThanOrEqual' | 'empty' | 'notEmpty';
export type ColumnFilter = { column: number; operator: ColumnFilterOperator; value: string; dataType?: FilterDataType };
export type ColumnFilterOperatorChoice = { operator: ColumnFilterOperator; label: string };
export type CompiledColumnFilters = (row: readonly string[]) => boolean;
export const MAX_FILTER_VALUE_LENGTH = 4096;
export const MAX_COLUMN_FILTERS = 256;

const operatorChoices: readonly ColumnFilterOperatorChoice[] = [
  { operator: 'contains', label: 'Contains' },
  { operator: 'notContains', label: 'Does Not Contain' },
  { operator: 'regex', label: 'Regular Expression' },
  { operator: 'equals', label: 'Equals' },
  { operator: 'notEquals', label: 'Does Not Equal' },
  { operator: 'greaterThan', label: 'Greater Than' },
  { operator: 'greaterThanOrEqual', label: 'Greater Than or Equal' },
  { operator: 'lessThan', label: 'Less Than' },
  { operator: 'lessThanOrEqual', label: 'Less Than or Equal' },
  { operator: 'empty', label: 'Is Empty' },
  { operator: 'notEmpty', label: 'Is Not Empty' }
];
const operators = new Set(operatorChoices.map(choice => choice.operator));
const dataTypes = new Set<FilterDataType>(['string', 'number', 'date', 'boolean']);
const orderedOperators = new Set<ColumnFilterOperator>(['greaterThan', 'greaterThanOrEqual', 'lessThan', 'lessThanOrEqual']);

export function getFilterOperatorChoices(dataType: FilterDataType): readonly ColumnFilterOperatorChoice[] {
  return operatorChoices.filter(choice => !orderedOperators.has(choice.operator) || dataType === 'number' || dataType === 'date');
}

function compileFilterRegex(value: string): RE2JS {
  let pattern = value;
  let flags = RE2JS.CASE_INSENSITIVE;
  if (value.startsWith('/')) {
    let closingSlash = -1;
    for (let i = value.length - 1; i > 0; i--) {
      if (value[i] !== '/') {
        continue;
      }
      let backslashes = 0;
      for (let j = i - 1; j >= 0 && value[j] === '\\'; j--) {
        backslashes++;
      }
      if (backslashes % 2 === 0) {
        closingSlash = i;
        break;
      }
    }
    if (closingSlash > 0) {
      pattern = value.slice(1, closingSlash);
      flags = 0;
      const seen = new Set<string>();
      for (const flag of value.slice(closingSlash + 1)) {
        if (seen.has(flag) || (flag !== 'i' && flag !== 'm' && flag !== 's')) {
          throw new Error('Only the i, m, and s flags are supported, without duplicates.');
        }
        seen.add(flag);
        flags |= flag === 'i' ? RE2JS.CASE_INSENSITIVE : flag === 'm' ? RE2JS.MULTILINE : RE2JS.DOTALL;
      }
    }
  }
  return RE2JS.compile(pattern, flags);
}

function compileValuePredicate(operator: ColumnFilterOperator, query: string, dataType: FilterDataType): (value: string) => boolean {
  if (operator === 'empty') {
    return value => value === '';
  }
  if (operator === 'notEmpty') {
    return value => value !== '';
  }
  if (operator === 'regex') {
    const regex = compileFilterRegex(query);
    return value => regex.matcher(value).find();
  }
  if (operator === 'contains' || operator === 'notContains') {
    const lowerQuery = query.toLowerCase();
    return operator === 'contains' ? value => value.toLowerCase().includes(lowerQuery) : value => !value.toLowerCase().includes(lowerQuery);
  }
  if (orderedOperators.has(operator) && dataType !== 'number' && dataType !== 'date') {
    throw new Error('Ordered comparisons require a number or date column.');
  }
  if (dataType === 'string') {
    const lowerQuery = query.toLowerCase();
    return operator === 'equals' ? value => value.toLowerCase() === lowerQuery : value => value.toLowerCase() !== lowerQuery;
  }
  if (dataType === 'number' || dataType === 'date') {
    const compare = dataType === 'number' ? compileFilterNumberComparison(query) : compileFilterDateComparison(query);
    if (!compare) {
      throw new Error(`Enter a valid ${dataType} value.`);
    }
    return value => {
      const comparison = compare(value);
      if (comparison === undefined) {
        return false;
      }
      switch (operator) {
        case 'equals': return comparison === 0;
        case 'notEquals': return comparison !== 0;
        case 'greaterThan': return comparison > 0;
        case 'greaterThanOrEqual': return comparison >= 0;
        case 'lessThan': return comparison < 0;
        case 'lessThanOrEqual': return comparison <= 0;
        default: return false;
      }
    };
  }
  const threshold = parseFilterBoolean(query);
  if (threshold === undefined) {
    throw new Error(`Enter a valid ${dataType} value.`);
  }
  return value => {
    const scalar = parseFilterBoolean(value);
    if (scalar === undefined) {
      return false;
    }
    return operator === 'equals' ? scalar === threshold : scalar !== threshold;
  };
}

export function validateColumnFilterInput(operator: ColumnFilterOperator, value: string, dataType: FilterDataType = 'string'): string | undefined {
  if (!operators.has(operator) || !dataTypes.has(dataType)) {
    return 'Choose a valid filter operator and data type.';
  }
  if (typeof value !== 'string' || value.length > MAX_FILTER_VALUE_LENGTH) {
    return `Filter values must contain at most ${MAX_FILTER_VALUE_LENGTH} characters.`;
  }
  try {
    compileValuePredicate(operator, value, dataType);
    return undefined;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return operator === 'regex' ? `Enter a valid RE2 regular expression: ${detail}` : detail;
  }
}

export function formatColumnFilter(filter: ColumnFilter): string {
  const label = operatorChoices.find(choice => choice.operator === filter.operator)?.label ?? 'Invalid Filter';
  return filter.operator === 'empty' || filter.operator === 'notEmpty' ? label : `${label} ${JSON.stringify(filter.value)}`;
}

export function normalizeColumnFilters(raw: unknown, columnCount = Infinity): ColumnFilter[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const byColumn = new Map<number, ColumnFilter>();
  for (const item of raw.slice(0, MAX_COLUMN_FILTERS)) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const { column, operator, value, dataType } = item as Partial<ColumnFilter>;
    if (typeof column !== 'number' || !Number.isSafeInteger(column) || column < 0 || column >= columnCount || !operators.has(operator as ColumnFilterOperator) || typeof value !== 'string' || value.length > MAX_FILTER_VALUE_LENGTH || (dataType !== undefined && !dataTypes.has(dataType))) {
      continue;
    }
    // Invalid query syntax remains visible and removable; compilation fails closed.
    byColumn.set(column, { column, operator: operator!, value, ...(dataType === undefined ? {} : { dataType }) });
  }
  return [...byColumn.values()].sort((a, b) => a.column - b.column);
}

export function compileColumnFilters(filters: readonly ColumnFilter[]): CompiledColumnFilters {
  if (filters.length > MAX_COLUMN_FILTERS) {
    return () => false;
  }
  try {
    const predicates = filters.map(filter => {
      const dataType = filter.dataType ?? 'string';
      if (!Number.isSafeInteger(filter.column) || filter.column < 0 || !operators.has(filter.operator) || !dataTypes.has(dataType) || typeof filter.value !== 'string' || filter.value.length > MAX_FILTER_VALUE_LENGTH) {
        throw new Error('Invalid column filter.');
      }
      const matches = compileValuePredicate(filter.operator, filter.value, dataType);
      return (row: readonly string[]) => matches(String(row[filter.column] ?? ''));
    });
    return row => predicates.every(matches => matches(row));
  } catch {
    return () => false;
  }
}

export function rowMatchesFilters(row: readonly string[], filters: readonly ColumnFilter[]): boolean {
  return compileColumnFilters(filters)(row);
}

export function visibleSourceRows(data: readonly string[][], hiddenRows: number, header: boolean, filters: readonly ColumnFilter[]): number[] {
  const start = Math.min(Math.max(0, hiddenRows), data.length);
  const rows: number[] = [];
  const matches = compileColumnFilters(filters);
  for (let row = start; row < data.length; row++) {
    if ((header && row === start) || matches(data[row])) {
      rows.push(row);
    }
  }
  return rows;
}

// new column index -> original index; -1 denotes an inserted empty column.
export function remapColumnFilters(filters: readonly ColumnFilter[], columnOrder: readonly number[]): ColumnFilter[] {
  return columnOrder.flatMap((oldColumn, column) => {
    const filter = filters.find(item => item.column === oldColumn);
    return filter ? [{ ...filter, column }] : [];
  });
}
