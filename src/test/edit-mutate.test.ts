import assert from 'assert';
import { describe, it } from 'node:test';
import Module from 'module';

// Stub 'vscode' before importing provider
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

describe('Edit mutate invariants', () => {
  it('does not promote virtual row on empty edit', () => {
    const res = CsvEditorProvider.__test.mutateDataForEdit([], 0, 0, '');
    assert.deepStrictEqual(res.data, []);
    assert.strictEqual(res.createdRow, false);
  });

  it('does not promote virtual cell on empty edit into new column', () => {
    const init = [['a']];
    const res = CsvEditorProvider.__test.mutateDataForEdit(init.map(r => [...r]), 0, 2, '');
    assert.deepStrictEqual(res.data, [['a']]);
    assert.strictEqual(res.createdCol, false);
  });

  it('non-empty edit expands rows and columns as needed', () => {
    const a = CsvEditorProvider.__test.mutateDataForEdit([], 0, 0, 'x');
    assert.deepStrictEqual(a.data, [['x']]);
    assert.strictEqual(a.createdRow, true);
    assert.strictEqual(a.createdCol, true);

    const b = CsvEditorProvider.__test.mutateDataForEdit([['a']], 0, 2, 'v');
    assert.deepStrictEqual(b.data, [['a', '', 'v']]);
    assert.strictEqual(b.createdCol, true);
  });

  it('trims trailing empty rows when editing last row', () => {
    const init = [['a'], ['']];
    const res = CsvEditorProvider.__test.mutateDataForEdit(init.map(r => [...r]), 1, 0, '');
    assert.deepStrictEqual(res.data, [['a']]);
    assert.strictEqual(res.trimmed, true);
  });
});

