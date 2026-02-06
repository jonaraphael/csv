import assert from 'assert';
import { describe, it } from 'node:test';
import Module from 'module';

const originalRequire = Module.prototype.require;
Module.prototype.require = function (id: string) {
  if (id === 'vscode') {
    return {} as any;
  }
  return originalRequire.apply(this, arguments as any);
};

import { CsvEditorProvider } from '../CsvEditorProvider';

describe('Reorder behavior', () => {
  it('reorders selected columns relative to unselected columns', () => {
    const order = CsvEditorProvider.__test.reorderIndexOrder(6, [1, 2], 5);
    assert.deepStrictEqual(order, [0, 3, 4, 1, 2, 5]);
  });

  it('moves selected columns to the beginning when dropped before first column', () => {
    const order = CsvEditorProvider.__test.reorderIndexOrder(6, [2, 3], 0);
    assert.deepStrictEqual(order, [2, 3, 0, 1, 4, 5]);
  });

  it('keeps order unchanged when dropping before the selected block itself', () => {
    const order = CsvEditorProvider.__test.reorderIndexOrder(5, [2, 3], 2);
    assert.deepStrictEqual(order, [0, 1, 2, 3, 4]);
  });

  it('normalizes duplicate and out-of-range indices', () => {
    const order = CsvEditorProvider.__test.reorderIndexOrder(5, [3, 3, -1, 99, 1], 5);
    assert.deepStrictEqual(order, [0, 2, 4, 1, 3]);
  });

  it('reorders rows by absolute row index', () => {
    const rows = [['r0'], ['r1'], ['r2'], ['r3'], ['r4']];
    const reordered = CsvEditorProvider.__test.reorderRows(rows, [1, 2], 4);
    assert.deepStrictEqual(reordered, [['r0'], ['r3'], ['r1'], ['r2'], ['r4']]);
  });

  it('reorders columns across all rows consistently', () => {
    const rows = [
      ['A', 'B', 'C', 'D'],
      ['1', '2', '3', '4']
    ];
    const reordered = CsvEditorProvider.__test.reorderColumns(rows, [1, 2], 4);
    assert.deepStrictEqual(reordered, [
      ['A', 'D', 'B', 'C'],
      ['1', '4', '2', '3']
    ]);
  });
});
