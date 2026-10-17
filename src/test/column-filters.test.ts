import assert from 'assert';
import { describe, it } from 'node:test';
import { normalizeColumnFilters, rowMatchesFilters, visibleSourceRows, remapColumnFilters, MAX_COLUMN_FILTERS, MAX_FILTER_VALUE_LENGTH } from '../column-filters';

describe('Column filter predicates and identities', () => {
  it('combines case-insensitive text predicates and exact empty-cell predicates', () => {
    assert.ok(rowMatchesFilters(['Alpha Beta', 'YES', ''], [{ column: 0, operator: 'contains', value: 'BETA' }, { column: 1, operator: 'equals', value: 'yes' }, { column: 2, operator: 'empty', value: '' }]));
    assert.ok(!rowMatchesFilters(['Alpha', 'yes', ''], [{ column: 0, operator: 'contains', value: 'beta' }]));
    assert.ok(rowMatchesFilters([], [{ column: 2, operator: 'empty', value: '' }]));
    assert.ok(!rowMatchesFilters([''], [{ column: 0, operator: 'notEmpty', value: '' }]));
    assert.ok(rowMatchesFilters([' '], [{ column: 0, operator: 'notEmpty', value: '' }]));
  });

  it('keeps absolute row identities, a real header, and excludes hidden preambles', () => {
    const data = [['metadata'], ['Header'], ['keep'], ['drop'], ['KEEP']];
    const filters = [{ column: 0, operator: 'equals' as const, value: 'keep' }];
    assert.deepStrictEqual(visibleSourceRows(data, 1, true, filters), [1, 2, 4]);
    assert.deepStrictEqual(visibleSourceRows(data, 1, false, filters), [2, 4]);
    assert.deepStrictEqual(visibleSourceRows(data, 100, true, filters), []);
  });

  it('normalizes bounded state without evaluating regex or accepting invalid predicates', () => {
    const normalized = normalizeColumnFilters([
      { column: 1, operator: 'equals', value: 'before' }, { column: 1, operator: 'contains', value: '<literal.*>' },
      { column: -1, operator: 'empty', value: '' }, { column: 0, operator: 'regex', value: '(a+)+' },
      { column: 2, operator: 'contains', value: 'a'.repeat(MAX_FILTER_VALUE_LENGTH + 1) }
    ], 3);
    assert.deepStrictEqual(normalized, [{ column: 1, operator: 'contains', value: '<literal.*>' }]);
    assert.strictEqual(normalizeColumnFilters(Array.from({ length: MAX_COLUMN_FILTERS + 10 }, (_, column) => ({ column, operator: 'empty', value: '' }))).length, MAX_COLUMN_FILTERS);
    assert.deepStrictEqual(normalizeColumnFilters(null), []);
  });

  it('moves predicates with their column and removes predicates for deleted columns', () => {
    const filters = [{ column: 0, operator: 'equals' as const, value: 'x' }, { column: 2, operator: 'empty' as const, value: '' }];
    assert.deepStrictEqual(remapColumnFilters(filters, [2, -1, 0, 1]), [{ column: 0, operator: 'empty', value: '' }, { column: 2, operator: 'equals', value: 'x' }]);
    assert.deepStrictEqual(remapColumnFilters(filters, [1, 2]), [{ column: 1, operator: 'empty', value: '' }]);
  });
});
