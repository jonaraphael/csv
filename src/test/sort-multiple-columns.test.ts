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

describe('Chained column sort', () => {
  it('uses criteria in priority order', () => {
    const rows = [
      ['group', 'score', 'name'],
      ['B', '2', 'beta'],
      ['A', '1', 'alpha'],
      ['B', '4', 'delta'],
      ['A', '3', 'gamma']
    ];

    const sorted = CsvEditorProvider.__test.sortByColumns(
      rows,
      [
        { index: 0, ascending: true },
        { index: 1, ascending: false }
      ],
      true,
      0
    );

    assert.deepStrictEqual(sorted, [
      ['group', 'score', 'name'],
      ['A', '3', 'gamma'],
      ['A', '1', 'alpha'],
      ['B', '4', 'delta'],
      ['B', '2', 'beta']
    ]);
  });

  it('continues to later criteria only for equal values', () => {
    const rows = [
      ['A', 'same', 'z'],
      ['A', 'same', 'a'],
      ['A', 'other', 'm']
    ];

    const sorted = CsvEditorProvider.__test.sortByColumns(
      rows,
      [
        { index: 0, ascending: true },
        { index: 1, ascending: true },
        { index: 2, ascending: true }
      ],
      false,
      0
    );

    assert.deepStrictEqual(sorted, [
      ['A', 'other', 'm'],
      ['A', 'same', 'a'],
      ['A', 'same', 'z']
    ]);
  });

  it('removes a criterion without retaining its previous tie ordering', () => {
    const baseline = [
      ['A', '1'],
      ['A', '3'],
      ['B', '2'],
      ['B', '4']
    ];
    const withSecondary = CsvEditorProvider.__test.sortByColumns(
      baseline,
      [
        { index: 0, ascending: true },
        { index: 1, ascending: false }
      ],
      false,
      0
    );
    assert.deepStrictEqual(withSecondary, [
      ['A', '3'],
      ['A', '1'],
      ['B', '4'],
      ['B', '2']
    ]);

    const withoutSecondary = CsvEditorProvider.__test.sortByColumns(
      baseline,
      [{ index: 0, ascending: true }],
      false,
      0
    );
    assert.deepStrictEqual(withoutSecondary, baseline);
  });

  it('keeps empty values last for descending criteria', () => {
    const rows = [
      ['A', '2'],
      ['', '9'],
      ['C', '1'],
      ['B', '3']
    ];
    const sorted = CsvEditorProvider.__test.sortByColumns(
      rows,
      [{ index: 0, ascending: false }],
      false,
      0
    );
    assert.deepStrictEqual(sorted.map(row => row[0]), ['C', 'B', 'A', '']);
  });
});
