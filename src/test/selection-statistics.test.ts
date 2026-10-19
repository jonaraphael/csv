import assert from 'assert';
import { describe, it } from 'node:test';
import { computeSelectionStatistics, formatSelectionStatistics, parseNumericSelection } from '../selection-statistics';

describe('Numeric selection statistics', () => {
  it('counts finite numeric values, including zero, independently of column type', () => {
    const data = [['0', ' -2.5 ', '.5', '1e2', '1,000', "2'000", '3\u202f000', '4 000'],
      ['', ' ', 'text', '12px', '$20', '20%', 'NaN', 'Infinity', '0x10', '12,34', '1e309']];
    const stats = computeSelectionStatistics(data, { kind: 'all' }, 0);
    assert.strictEqual(formatSelectionStatistics(stats), 'Sum: 10098  Average: 1262.25  Count: 8');
  });

  it('respects row/column bounds, hidden metadata, numeric headers, filters, and ragged rows', () => {
    const data = [['999'], ['2026', '99'], ['2', '3'], ['100', '200'], ['4'], ['6', '7']];
    const visibleRows = [1, 2, 4, 5, 6];
    assert.strictEqual(formatSelectionStatistics(computeSelectionStatistics(data, { kind: 'all' }, 2, visibleRows)),
      'Sum: 22  Average: 4.4  Count: 5');
    assert.strictEqual(formatSelectionStatistics(computeSelectionStatistics(data, { kind: 'columns', minCol: 1, maxCol: 1 }, 2, visibleRows)),
      'Sum: 10  Average: 5  Count: 2');
    assert.strictEqual(formatSelectionStatistics(computeSelectionStatistics(data, { kind: 'rows', minRow: 2, maxRow: 4 }, 2, visibleRows)),
      'Sum: 9  Average: 3  Count: 3');
    assert.strictEqual(formatSelectionStatistics(computeSelectionStatistics(data, { kind: 'cells', minRow: 2, maxRow: 4, minCol: 0, maxCol: 0 }, 2, visibleRows)),
      'Sum: 6  Average: 3  Count: 2');
    assert.deepStrictEqual(computeSelectionStatistics(data, { kind: 'rows', minRow: 6, maxRow: Number.MAX_SAFE_INTEGER }, 2),
      { sum: 0, average: 0, count: 0 });
  });

  it('formats decimal sums cleanly and preserves cancellation and very small values', () => {
    const stats = (values: string[]) => computeSelectionStatistics([values], { kind: 'all' }, 0);
    assert.strictEqual(formatSelectionStatistics(stats(['0.1', '0.2'])), 'Sum: 0.3  Average: 0.15  Count: 2');
    assert.strictEqual(stats(['1e16', '1', '-1e16']).sum, 1);
    assert.strictEqual(stats(['1e-20']).average, 1e-20);
    assert.strictEqual(formatSelectionStatistics(stats(['9007199254740991'])),
      'Sum: 9007199254740991  Average: 9007199254740991  Count: 1');
    assert.strictEqual(formatSelectionStatistics(stats(['-0', '0'])), 'Sum: 0  Average: 0  Count: 2');
    assert.strictEqual(formatSelectionStatistics(stats(['1e308', '1e308'])), 'Sum: Overflow  Average: 1e+308  Count: 2');
    assert.strictEqual(stats(['1e308', '1e308', '-1e308']).sum, 1e308);
  });

  it('rejects malformed selection messages and clamps valid large bounds to the data', () => {
    for (const raw of [null, [], 'all', { kind: 'unknown' }, { kind: 'rows', minRow: 2, maxRow: 1 },
      { kind: 'cells', minCol: 0, maxCol: 1 }, { kind: 'columns', minCol: -1, maxCol: 0 },
      { kind: 'columns', minCol: 0, maxCol: Infinity }, { kind: 'rows', minRow: '0', maxRow: 1 }]) {
      assert.strictEqual(parseNumericSelection(raw), undefined);
    }
    const selection = parseNumericSelection({ kind: 'cells', minRow: 0, maxRow: Number.MAX_SAFE_INTEGER, minCol: 0, maxCol: Number.MAX_SAFE_INTEGER });
    assert.ok(selection);
    assert.deepStrictEqual(computeSelectionStatistics([['2']], selection!, 0), { sum: 2, average: 2, count: 1 });
  });
});
