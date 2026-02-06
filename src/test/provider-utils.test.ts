import assert from 'assert';
import { describe, it } from 'node:test';
import Module from 'module';

// Stub the 'vscode' module used by extension.ts so it can be imported in a
// regular Node environment. Only the utilities are tested here so an empty
// object is sufficient.
const originalRequire = Module.prototype.require;
Module.prototype.require = function (id: string) {
  if (id === 'vscode') {
    return {} as any;
  }
  return originalRequire.apply(this, arguments as any);
};

import { CsvEditorProvider } from '../CsvEditorProvider';

describe('CsvEditorProvider utility methods', () => {

  it('computeColumnWidths returns max length per column', () => {
    const data = [
      ['a', 'bb', 'ccc'],
      ['dddd', 'ee', 'f']
    ];
    const widths = CsvEditorProvider.__test.computeColumnWidths(data);
    assert.deepStrictEqual(widths, [4, 2, 3]);
  });

  it('handles very large row counts without stack overflow', () => {
    const rows: string[][] = Array.from({ length: 70000 }, (_, i) => [String(i)]);

    assert.doesNotThrow(() => {
      CsvEditorProvider.__test.computeColumnWidths(rows);
    });
    assert.doesNotThrow(() => {
      CsvEditorProvider.__test.getEffectiveHeader(rows, 0);
    });
  });

  it('isDate correctly identifies date strings', () => {
    const isDate = CsvEditorProvider.__test.isDate;
    assert.strictEqual(isDate('2024-01-02'), true);
    assert.strictEqual(isDate('not-a-date'), false);
    assert.strictEqual(isDate('1003'), false);
    assert.strictEqual(isDate('2024'), false);
    assert.strictEqual(isDate('2024/01/02'), true);
  });

  it('estimateColumnDataType detects common types', () => {
    const estimate = CsvEditorProvider.__test.estimateColumnDataType;
    assert.strictEqual(estimate(['true', 'FALSE']), 'boolean');
    assert.strictEqual(estimate(['1', '0', '0', '1']), 'boolean');
    assert.strictEqual(estimate(['t', 'F', 'T', 'f']), 'boolean');
    assert.strictEqual(estimate(['yes', 'No', 'Y', 'n']), 'boolean');
    assert.strictEqual(estimate(['on', 'OFF']), 'boolean');
    assert.strictEqual(estimate(['2020-01-01', '1999-12-31']), 'date');
    assert.strictEqual(estimate(['0x1', '0x2']), 'integer');
    assert.strictEqual(estimate(['1003', '42', '0']), 'integer');
    assert.strictEqual(estimate(['1.2e0', '3.4e0']), 'float');
    assert.strictEqual(estimate(['', '']), 'empty');
    assert.strictEqual(estimate(['hello', '1a']), 'string');
  });

  it('getColumnColor returns hex colors', () => {
    const getColor = CsvEditorProvider.__test.getColumnColor;
    assert.strictEqual(getColor('empty', true, 0), '#BBB');
    assert.strictEqual(getColor('empty', false, 0), '#444');
    const hex = getColor('boolean', true, 2);
    assert.match(hex, /^#[0-9a-fA-F]{6}$/);
  });

  it('hslToHex converts known colors', () => {
    const hslToHex = CsvEditorProvider.__test.hslToHex;
    assert.strictEqual(hslToHex(0, 100, 50), '#ff0000');   // red
    assert.strictEqual(hslToHex(120, 100, 50), '#00ff00'); // green
    assert.strictEqual(hslToHex(240, 100, 50), '#0000ff'); // blue
  });
});
