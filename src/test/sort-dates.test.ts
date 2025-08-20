import assert from 'assert';
import { describe, it } from 'node:test';
import Module from 'module';

// Stub 'vscode' prior to loading provider (theme checks)
const originalRequire = Module.prototype.require;
Module.prototype.require = function (id: string) {
  if (id === 'vscode') {
    return {
      window: { activeColorTheme: { kind: 1 } },
      ColorThemeKind: { Dark: 1 }
    } as any;
  }
  return originalRequire.apply(this, arguments as any);
};

import { CsvEditorProvider } from '../CsvEditorProvider';

describe('Date column sort', () => {
  it('sorts ISO yyyy-mm-dd ascending and descending', () => {
    const input = [
      ['2017-02-18'],
      ['2017-12-04'],
      ['2017-02-10'],
      ['2017-04-16'],
      ['2017-06-22'],
      ['2017-04-08'],
      ['2017-06-14'],
      ['2017-08-20']
    ];

    const asc = CsvEditorProvider.__test.sortByColumn(input, 0, true, false, 0).map(r => r[0]);
    assert.deepStrictEqual(asc, [
      '2017-02-10',
      '2017-02-18',
      '2017-04-08',
      '2017-04-16',
      '2017-06-14',
      '2017-06-22',
      '2017-08-20',
      '2017-12-04'
    ]);

    const desc = CsvEditorProvider.__test.sortByColumn(input, 0, false, false, 0).map(r => r[0]);
    assert.deepStrictEqual(desc, [
      '2017-12-04',
      '2017-08-20',
      '2017-06-22',
      '2017-06-14',
      '2017-04-16',
      '2017-04-08',
      '2017-02-18',
      '2017-02-10'
    ]);
  });

  it('treats empty dates as last in ascending', () => {
    const input = [ ['2017-01-01'], [''], ['2017-01-03'] ];
    const asc = CsvEditorProvider.__test.sortByColumn(input, 0, true, false, 0).map(r => r[0]);
    assert.deepStrictEqual(asc, ['2017-01-01', '2017-01-03', '']);
  });
});

