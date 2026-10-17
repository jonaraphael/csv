import assert from 'assert';
import { describe, it } from 'node:test';
import { RE2JS } from 're2js';
import {
  ColumnFilter, ColumnFilterOperator, FilterDataType, compileColumnFilters,
  getFilterOperatorChoices, normalizeColumnFilters, rowMatchesFilters, visibleSourceRows,
  remapColumnFilters, validateColumnFilterInput, MAX_COLUMN_FILTERS, MAX_FILTER_VALUE_LENGTH
} from '../column-filters';

const filter = (operator: ColumnFilterOperator, value: string, dataType?: FilterDataType): ColumnFilter => ({ column: 0, operator, value, ...(dataType === undefined ? {} : { dataType }) });

function matchingValues(values: string[], predicate: ColumnFilter): string[] {
  const matches = compileColumnFilters([predicate]);
  return values.filter(value => matches([value]));
}

describe('Column filter predicates and identities', () => {
  it('combines case-insensitive text predicates and exact empty-cell predicates', () => {
    assert.ok(rowMatchesFilters(['Alpha Beta', 'YES', ''], [{ column: 0, operator: 'contains', value: 'BETA' }, { column: 1, operator: 'equals', value: 'yes' }, { column: 2, operator: 'empty', value: '' }]));
    assert.ok(!rowMatchesFilters(['Alpha', 'yes', ''], [filter('contains', 'beta')]));
    assert.ok(rowMatchesFilters([], [{ column: 2, operator: 'empty', value: '' }]));
    assert.ok(!rowMatchesFilters([''], [filter('notEmpty', '')]));
    assert.ok(rowMatchesFilters([' '], [filter('notEmpty', '')]));
  });

  it('negates contains and equality without trimming or interpreting text as patterns', () => {
    const values = ['Alpha Beta', 'ALPHA', 'alpha ', '', '<a.*>'];
    assert.deepStrictEqual(matchingValues(values, filter('notContains', 'ALPHA')), ['', '<a.*>']);
    assert.deepStrictEqual(matchingValues(values, filter('notEquals', 'alpha')), ['Alpha Beta', 'alpha ', '', '<a.*>']);
    assert.deepStrictEqual(matchingValues(values, filter('contains', '<a.*>')), ['<a.*>']);
    assert.ok(rowMatchesFilters([], [filter('notEquals', 'alpha')]));
    assert.deepStrictEqual(matchingValues(values, filter('notContains', '')), []);
    assert.deepStrictEqual(matchingValues(values, filter('contains', '')), values);
  });

  it('retains literal text and empty predicates for every inferred data type', () => {
    for (const type of ['string', 'number', 'date', 'boolean'] as const) {
      assert.deepStrictEqual(matchingValues(['USD 1,000', 'usd 2', '1,000'], filter('contains', 'USD', type)), ['USD 1,000', 'usd 2']);
      assert.ok(rowMatchesFilters(['not a scalar'], [filter('notContains', 'USD', type)]));
      assert.ok(rowMatchesFilters([], [filter('empty', '', type)]));
      assert.ok(rowMatchesFilters([' '], [filter('notEmpty', '', type)]));
    }
  });

  it('compares numeric equivalents rather than their formatting', () => {
    const values = ['1000', '1,000.00', '1e3', '1001', '1,00', '', '  ', 'NaN'];
    assert.deepStrictEqual(matchingValues(values, filter('equals', '1,000', 'number')), ['1000', '1,000.00', '1e3']);
    assert.deepStrictEqual(matchingValues(values, filter('notEquals', '1e3', 'number')), ['1001']);
    assert.deepStrictEqual(matchingValues(['-0', '0', '0.0', '1'], filter('equals', '0', 'number')), ['-0', '0', '0.0']);
    assert.deepStrictEqual(matchingValues(['1000', '1,000.00'], filter('equals', '1000')), ['1000']);
  });

  it('preserves exact numeric identity and order beyond floating-point precision', () => {
    const values = ['9007199254740992', '9007199254740993', '9,007,199,254,740,993', '9.007199254740993e15', '9007199254740994', '', 'invalid'];
    assert.deepStrictEqual(matchingValues(values, filter('equals', '9007199254740993', 'number')), values.slice(1, 4));
    assert.deepStrictEqual(matchingValues(values, filter('notEquals', '9007199254740993', 'number')), [values[0], values[4]]);
    assert.deepStrictEqual(matchingValues(values, filter('greaterThan', '9007199254740992', 'number')), values.slice(1, 5));
    assert.deepStrictEqual(matchingValues(values, filter('lessThan', '9007199254740993', 'number')), [values[0]]);
    assert.deepStrictEqual(matchingValues(['0.10000000000000000001', '0.1', '0.09999999999999999999'], filter('greaterThan', '0.1', 'number')), ['0.10000000000000000001']);
    assert.deepStrictEqual(matchingValues(['-9007199254740993', '-9007199254740992'], filter('lessThan', '-9007199254740992', 'number')), ['-9007199254740993']);
    assert.deepStrictEqual(matchingValues(['1e-1000', '0', '-1e-1000'], filter('equals', '0', 'number')), ['0']);
  });

  it('applies all numeric boundaries and excludes invalid or blank cells', () => {
    const values = ['9', '10', '1e1', '11', '', 'not numeric', 'Infinity'];
    const expected: Array<[ColumnFilterOperator, string[]]> = [
      ['greaterThan', ['11']], ['greaterThanOrEqual', ['10', '1e1', '11']],
      ['lessThan', ['9']], ['lessThanOrEqual', ['9', '10', '1e1']]
    ];
    for (const [operator, result] of expected) {
      assert.deepStrictEqual(matchingValues(values, filter(operator, '10', 'number')), result, operator);
    }
  });

  it('compares date instants consistently across timezone and date-only formats', () => {
    const values = ['2024-01-02', '2024-01-02T00:00:00Z', '2024-01-01T19:00:00-05:00', '2024-01-03', '2024-02-30', ''];
    assert.deepStrictEqual(matchingValues(values, filter('equals', '2024-01-02', 'date')), values.slice(0, 3));
    assert.deepStrictEqual(matchingValues(values, filter('notEquals', '2024-01-02', 'date')), ['2024-01-03']);
    assert.deepStrictEqual(matchingValues(values, filter('greaterThan', '2024-01-02', 'date')), ['2024-01-03']);
    assert.deepStrictEqual(matchingValues(values, filter('greaterThanOrEqual', '2024-01-02', 'date')), values.slice(0, 4));
    assert.deepStrictEqual(matchingValues(values, filter('lessThan', '2024-01-03', 'date')), values.slice(0, 3));
    assert.deepStrictEqual(matchingValues(values, filter('lessThanOrEqual', '2024-01-02', 'date')), values.slice(0, 3));
  });

  it('compares sub-millisecond date fractions without collapsing nearby instants', () => {
    const values = ['2024-01-01T00:00:00.0001Z', '2024-01-01T00:00:00.0002Z', '2023-12-31T19:00:00.000200-05:00', '2024-01-01T00:00:00.001Z', '', 'not a date'];
    const query = '2024-01-01T00:00:00.0002Z';
    const expected: Array<[ColumnFilterOperator, string[]]> = [
      ['equals', values.slice(1, 3)], ['notEquals', [values[0], values[3]]],
      ['greaterThan', [values[3]]], ['greaterThanOrEqual', values.slice(1, 4)],
      ['lessThan', [values[0]]], ['lessThanOrEqual', values.slice(0, 3)]
    ];
    for (const [operator, result] of expected) {
      assert.deepStrictEqual(matchingValues(values, filter(operator, query, 'date')), result, operator);
    }
    assert.ok(!rowMatchesFilters([], [filter('notEquals', query, 'date')]));
    const data = [['metadata'], ['Timestamp'], ...values.map(value => [value])];
    assert.deepStrictEqual(visibleSourceRows(data, 1, true, [filter('equals', query, 'date')]), [1, 3, 4]);
  });

  it('retains nanosecond equality across trailing zeros and equivalent timezone offsets', () => {
    const values = ['2024-01-01T00:00:00.123456788Z', '2024-01-01T00:00:00.123456789Z', '2024-01-01T00:00:00.123456789000Z', '2024-01-01T01:00:00.123456789+01:00', '2024-01-01T00:00:00.123456790Z'];
    const query = values[1];
    assert.strictEqual(validateColumnFilterInput('equals', query, 'date'), undefined);
    assert.deepStrictEqual(matchingValues(values, filter('equals', query, 'date')), values.slice(1, 4));
    assert.deepStrictEqual(matchingValues(values, filter('notEquals', query, 'date')), [values[0], values[4]]);
    assert.deepStrictEqual(matchingValues(values, filter('lessThan', query, 'date')), [values[0]]);
    assert.deepStrictEqual(matchingValues(values, filter('greaterThan', query, 'date')), [values[4]]);
  });

  it('orders exact pre-epoch fractions across the zero epoch and equivalent zones', () => {
    const values = ['1969-12-31T23:59:59.9991Z', '1969-12-31T23:59:59.9999Z', '1969-12-31T18:59:59.999900-05:00', '1970-01-01T00:00:00Z', '1970-01-01T00:00:00.0001Z'];
    const query = values[1];
    assert.deepStrictEqual(matchingValues(values, filter('equals', query, 'date')), values.slice(1, 3));
    assert.deepStrictEqual(matchingValues(values, filter('lessThan', query, 'date')), [values[0]]);
    assert.deepStrictEqual(matchingValues(values, filter('greaterThan', query, 'date')), values.slice(3));
    assert.deepStrictEqual(matchingValues(values, filter('lessThan', values[3], 'date')), values.slice(0, 3));
    assert.deepStrictEqual(matchingValues(['1969-12-31T23:59:59.0001Z', '1969-12-31T23:59:59.0002Z'], filter('lessThan', '1969-12-31T23:59:59.0002Z', 'date')), ['1969-12-31T23:59:59.0001Z']);
  });

  it('handles both boolean thresholds without treating false as an invalid parse', () => {
    const values = ['true', 'TRUE', 'false', 'FALSE', '', 'unknown'];
    assert.deepStrictEqual(matchingValues(values, filter('equals', 'true', 'boolean')), ['true', 'TRUE']);
    assert.deepStrictEqual(matchingValues(values, filter('equals', 'false', 'boolean')), ['false', 'FALSE']);
    assert.deepStrictEqual(matchingValues(values, filter('notEquals', 'FALSE', 'boolean')), ['true', 'TRUE']);
    assert.ok(!rowMatchesFilters([], [filter('notEquals', 'true', 'boolean')]));
  });

  it('rejects invalid query scalars and unsupported ordered data types', () => {
    for (const type of ['number', 'date', 'boolean'] as const) {
      for (const operator of ['equals', 'notEquals'] as const) {
        for (const value of ['', '  ', 'not a scalar']) {
          assert.match(validateColumnFilterInput(operator, value, type) ?? '', /valid/);
          assert.deepStrictEqual(matchingValues(['0', 'false', '2024-01-02', 'other', ''], filter(operator, value, type)), []);
        }
      }
    }
    for (const type of ['string', 'boolean'] as const) {
      assert.match(validateColumnFilterInput('greaterThan', '1', type) ?? '', /number or date/);
      assert.ok(!rowMatchesFilters(['2'], [filter('greaterThan', '1', type)]));
    }
    assert.strictEqual(validateColumnFilterInput('equals', ''), undefined);
    assert.strictEqual(validateColumnFilterInput('contains', ''), undefined);
    assert.match(validateColumnFilterInput('contains', 'x'.repeat(MAX_FILTER_VALUE_LENGTH + 1)) ?? '', /4096/);
  });

  it('offers all universal operators and ordered comparisons only for numbers and dates', () => {
    const universal = ['contains', 'notContains', 'regex', 'equals', 'notEquals', 'empty', 'notEmpty'];
    for (const type of ['string', 'boolean'] as const) {
      assert.deepStrictEqual(getFilterOperatorChoices(type).map(choice => choice.operator), universal);
    }
    const ordered = ['greaterThan', 'greaterThanOrEqual', 'lessThan', 'lessThanOrEqual'];
    for (const type of ['number', 'date'] as const) {
      const choices = getFilterOperatorChoices(type);
      assert.deepStrictEqual(choices.map(choice => choice.operator), [...universal.slice(0, 5), ...ordered, ...universal.slice(5)]);
      assert.ok(choices.every(choice => choice.label.length > 0));
    }
  });

  it('keeps absolute row identities, a real header, and excludes hidden preambles', () => {
    const data = [['metadata'], ['Header'], ['keep'], ['drop'], ['KEEP']];
    const filters = [filter('equals', 'keep')];
    assert.deepStrictEqual(visibleSourceRows(data, 1, true, filters), [1, 2, 4]);
    assert.deepStrictEqual(visibleSourceRows(data, 1, false, filters), [2, 4]);
    assert.deepStrictEqual(visibleSourceRows(data, 100, true, filters), []);
  });

  it('retains absolute identities for typed filters across metadata, header-off, and ragged rows', () => {
    const data = [['metadata'], ['ID', 'amount'], ['first', '10'], ['ragged'], ['second', '1e1'], ['third', '11'], ['invalid', 'oops']];
    const original = JSON.stringify(data);
    const filters = [{ column: 1, operator: 'notEquals' as const, value: '10', dataType: 'number' as const }];
    assert.deepStrictEqual(visibleSourceRows(data, 1, true, filters), [1, 5]);
    assert.deepStrictEqual(visibleSourceRows(data, 1, false, filters), [5]);
    assert.strictEqual(JSON.stringify(data), original);
  });

  it('normalizes bounded structural state while retaining invalid query text to fail closed', () => {
    const invalidQuery = { column: 0, operator: 'equals', value: 'invalid number', dataType: 'number' };
    const normalized = normalizeColumnFilters([
      { column: 1, operator: 'equals', value: 'before', dataType: 'boolean' }, { column: 1, operator: 'contains', value: '<literal.*>' },
      { column: -1, operator: 'empty', value: '' }, { column: 0, operator: 'unknown', value: 'x' },
      { column: 2, operator: 'equals', value: '1', dataType: 'unknown' },
      { column: 2, operator: 'contains', value: 'a'.repeat(MAX_FILTER_VALUE_LENGTH + 1) }, invalidQuery
    ], 3);
    assert.deepStrictEqual(normalized, [{ column: 1, operator: 'equals', value: 'before', dataType: 'boolean' }, { column: 1, operator: 'contains', value: '<literal.*>' }, invalidQuery]);
    assert.deepStrictEqual(visibleSourceRows([['metadata'], ['Header'], ['invalid number'], ['1']], 1, true, normalized), [1]);
    assert.strictEqual(normalizeColumnFilters(Array.from({ length: MAX_COLUMN_FILTERS + 10 }, (_, column) => ({ column, operator: 'empty', value: '' }))).length, MAX_COLUMN_FILTERS);
    assert.deepStrictEqual(normalizeColumnFilters(null), []);
    assert.deepStrictEqual(normalizeColumnFilters([{ column: 3, operator: 'empty', value: '' }], 3), []);
    assert.ok(!compileColumnFilters(Array.from({ length: MAX_COLUMN_FILTERS + 1 }, () => filter('contains', '')))(['anything']));
  });

  it('retains every same-column AND condition through persistence and structural remapping', () => {
    const conditions: ColumnFilter[] = [
      filter('greaterThan', '2', 'number'),
      { column: 1, operator: 'equals', value: 'keep' },
      filter('lessThan', '10', 'number'),
      filter('notEquals', '5', 'number')
    ];
    assert.deepStrictEqual(normalizeColumnFilters(conditions), conditions, 'condition order and duplicate columns survive storage');
    const source = [['Amount', 'State'], ['2', 'keep'], ['3', 'keep'], ['5', 'keep'], ['9', 'keep'], ['10', 'keep'], ['7', 'drop']];
    assert.deepStrictEqual(visibleSourceRows(source, 0, true, normalizeColumnFilters(conditions)), [0, 2, 4]);
    assert.deepStrictEqual(remapColumnFilters(conditions, [-1, 1, 0]), conditions.map(item => ({ ...item, column: item.column === 0 ? 2 : 1 })));
    assert.deepStrictEqual(remapColumnFilters(conditions, [1]), [{ column: 0, operator: 'equals', value: 'keep' }]);
    const withoutMiddleBound = conditions.filter((_item, index) => index !== 2);
    assert.deepStrictEqual(visibleSourceRows(source, 0, true, withoutMiddleBound), [0, 2, 4, 5]);
    const contradictions = [filter('contains', 'a'), filter('notContains', 'a')];
    assert.deepStrictEqual(visibleSourceRows([['Header'], ['alpha'], ['beta'], ['']], 0, true, contradictions), [0]);
  });

  it('moves and duplicates typed predicates with their columns and removes deleted ones', () => {
    const filters = [filter('greaterThanOrEqual', '1,000', 'number'), { column: 2, operator: 'empty' as const, value: '' }];
    assert.deepStrictEqual(remapColumnFilters(filters, [2, -1, 0, 1, 0]), [
      { column: 2, operator: 'greaterThanOrEqual', value: '1,000', dataType: 'number' },
      { column: 4, operator: 'greaterThanOrEqual', value: '1,000', dataType: 'number' }, { column: 0, operator: 'empty', value: '' }
    ]);
    assert.deepStrictEqual(remapColumnFilters(filters, [1, 2]), [{ column: 1, operator: 'empty', value: '' }]);
  });
});

describe('Bounded RE2 column filters', () => {
  it('searches case-insensitively by default and supports explicit case, multiline, and dotall flags', () => {
    assert.deepStrictEqual(matchingValues(['Alpha', 'ALPHA', 'beta alpha'], filter('regex', '^alpha$')), ['Alpha', 'ALPHA']);
    assert.deepStrictEqual(matchingValues(['alpha', 'ALPHA'], filter('regex', '/^alpha$/')), ['alpha']);
    assert.deepStrictEqual(matchingValues(['alpha', 'ALPHA'], filter('regex', '/^alpha$/i')), ['alpha', 'ALPHA']);
    assert.ok(rowMatchesFilters(['first\nsecond'], [filter('regex', '/^second$/m')]));
    assert.ok(rowMatchesFilters(['a\nb'], [filter('regex', '/a.b/s')]));
    assert.ok(rowMatchesFilters(['FIRST\nA\nB'], [filter('regex', '/^a.b$/ims')]));
    assert.strictEqual(validateColumnFilterInput('regex', ''), undefined);
    assert.ok(rowMatchesFilters([''], [filter('regex', '')]));
  });

  it('distinguishes escaped delimiters, slashes in character classes, and plain path patterns', () => {
    assert.ok(rowMatchesFilters(['A/B'], [filter('regex', '/^a\\/b$/i')]));
    assert.ok(rowMatchesFilters(['a/b'], [filter('regex', '/^a[/]b$/')]));
    assert.ok(rowMatchesFilters(['/path'], [filter('regex', '/path')]));
    assert.ok(!rowMatchesFilters(['path'], [filter('regex', '/path')]));
    assert.ok(rowMatchesFilters(['a\\'], [filter('regex', '/^a\\\\$/')]));
  });

  it('rejects unsupported flags, lookarounds, backreferences, and malformed patterns with useful validation', () => {
    for (const query of ['/a/g', '/a/ii', '/a/x', '(?=a)', '(a)\\1', '[']) {
      assert.match(validateColumnFilterInput('regex', query) ?? '', /RE2 regular expression/);
      assert.deepStrictEqual(matchingValues(['a', 'aa', 'anything', ''], filter('regex', query)), []);
    }
    const persisted = normalizeColumnFilters([filter('regex', '(?=a)')]);
    assert.strictEqual(persisted.length, 1);
    assert.deepStrictEqual(visibleSourceRows([['header'], ['a'], ['aa']], 0, true, persisted), [0]);
  });

  it('compiles patterns once per full-source pass and reuses them for every cell', () => {
    const originalCompile = RE2JS.compile;
    let count = 0;
    RE2JS.compile = function(pattern: string, flags?: number): RE2JS {
      count++;
      return originalCompile.call(this, pattern, flags);
    };
    try {
      const rows = Array.from({ length: 2000 }, (_, index) => [`row ${index}`, index % 2 ? 'KEEP' : 'drop']);
      const filters = [filter('regex', '^row [0-9]+$'), { column: 1, operator: 'regex' as const, value: '^keep$' }];
      const ids = visibleSourceRows(rows, 0, false, filters);
      assert.strictEqual(count, 2);
      assert.strictEqual(ids.length, 1000);
      assert.strictEqual(ids[0], 1);
      assert.strictEqual(ids[ids.length - 1], 1999);
      const matches = compileColumnFilters(filters);
      assert.strictEqual(count, 4);
      assert.ok(matches(['row 1', 'KEEP']));
      assert.ok(!matches(['row 2', 'drop']));
      assert.strictEqual(count, 4);
    } finally {
      RE2JS.compile = originalCompile;
    }
  });

  it('handles a nested repetition with a long failing cell through the linear-time engine', () => {
    const matches = compileColumnFilters([filter('regex', '(a+)+$')]);
    assert.ok(!matches(['a'.repeat(100000) + '!']));
    assert.ok(matches(['a'.repeat(100000)]));
  });
});
