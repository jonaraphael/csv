import assert from 'assert';
import { describe, it } from 'node:test';
import Module from 'module';

// Stub 'vscode' before importing provider (theme checks only)
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

describe('Sort preserves empty cells (no nan)', () => {
  it('sorting by col 0 keeps empty strings in col 1', () => {
    const rows: string[][] = [
      ['b', ''],
      ['a', 'x'],
      ['c', '']
    ];
    const out = CsvEditorProvider.__test.sortByColumn(rows, /*index*/0, /*ascending*/true, /*treatHeader*/ false, /*hiddenRows*/ 0);
    // Expect order: a, b, c and column 1 empties remain ''
    assert.deepStrictEqual(out.map(r => r[0]), ['a','b','c']);
    assert.deepStrictEqual(out.map(r => r[1]), ['x','', '']);
    // Ensure no literal 'nan' leak
    assert.ok(!out.flat().some(v => (v || '').toLowerCase() === 'nan'));
  });
});

