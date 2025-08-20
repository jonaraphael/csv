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

describe('Sorting excludes virtual trailing row', () => {
  it('does not include trailing empty row in sort', () => {
    // Last row represents a virtual UI row (all empty)
    const rows: string[][] = [
      ['b', '2'],
      ['a', '1'],
      ['',  '']
    ];
    const out = CsvEditorProvider.__test.sortByColumn(rows, /*index*/0, /*ascending*/true, /*treatHeader*/ false, /*hiddenRows*/ 0);
    // Out should be exactly the two data rows sorted; no empty trailing row in data
    assert.deepStrictEqual(out, [ ['a','1'], ['b','2'] ]);
  });
});

