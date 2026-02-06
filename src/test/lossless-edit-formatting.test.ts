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

describe('Lossless edit formatting', () => {
  it('preserves untouched quotes and trailing spaces when editing a different cell', () => {
    const input = '"id","value","note"\r\n"1","FOOBAR / 0 ","keep"\r\n';
    const output = CsvEditorProvider.__test.applyFieldUpdatesPreservingFormat(input, ',', [
      { row: 1, col: 2, value: 'changed' }
    ]);
    assert.strictEqual(output, '"id","value","note"\r\n"1","FOOBAR / 0 ","changed"\r\n');
  });

  it('keeps quoted style for edited quoted fields', () => {
    const input = '"a","b"\n"left","right"\n';
    const output = CsvEditorProvider.__test.applyFieldUpdatesPreservingFormat(input, ',', [
      { row: 1, col: 1, value: 'updated' }
    ]);
    assert.strictEqual(output, '"a","b"\n"left","updated"\n');
  });

  it('supports multiple updates with non-comma separators', () => {
    const input = '"a"|b|c\n"x"|y|z\n';
    const output = CsvEditorProvider.__test.applyFieldUpdatesPreservingFormat(input, '|', [
      { row: 0, col: 1, value: 'B' },
      { row: 1, col: 2, value: 'Z' }
    ]);
    assert.strictEqual(output, '"a"|B|c\n"x"|y|Z\n');
  });

  it('returns undefined when any target field is out of range', () => {
    const input = 'a,b\n1,2\n';
    const output = CsvEditorProvider.__test.applyFieldUpdatesPreservingFormat(input, ',', [
      { row: 4, col: 0, value: 'x' }
    ]);
    assert.strictEqual(output, undefined);
  });
});
