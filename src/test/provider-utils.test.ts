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

// Helper to access private methods via type casting
function getPrivate<T>(obj: any, name: string): T {
  return obj[name] as T;
}

describe('CsvEditorProvider utility methods', () => {
  const provider = new CsvEditorProvider({} as any);

  it('computeColumnWidths returns max length per column', () => {
    const data = [
      ['a', 'bb', 'ccc'],
      ['dddd', 'ee', 'f']
    ];
    const compute = getPrivate<(d: string[][]) => number[]>(provider, 'computeColumnWidths').bind(provider);
    const widths = compute(data);
    assert.deepStrictEqual(widths, [4, 2, 3]);
  });

  it('isDate correctly identifies date strings', () => {
    const isDate = getPrivate<(v: string) => boolean>(provider, 'isDate').bind(provider);
    assert.strictEqual(isDate('2024-01-02'), true);
    assert.strictEqual(isDate('not-a-date'), false);
  });

  it('estimateColumnDataType detects common types', () => {
    const estimate = getPrivate<(c: string[]) => string>(provider, 'estimateColumnDataType').bind(provider);
    assert.strictEqual(estimate(['true', 'FALSE']), 'boolean');
    assert.strictEqual(estimate(['1', '0', '0', '1']), 'boolean');
    assert.strictEqual(estimate(['t', 'F', 'T', 'f']), 'boolean');
    assert.strictEqual(estimate(['yes', 'No', 'Y', 'n']), 'boolean');
    assert.strictEqual(estimate(['on', 'OFF']), 'boolean');
    assert.strictEqual(estimate(['2020-01-01', '1999-12-31']), 'date');
    assert.strictEqual(estimate(['0x1', '0x2']), 'integer');
    assert.strictEqual(estimate(['1.2e0', '3.4e0']), 'float');
    assert.strictEqual(estimate(['', '']), 'empty');
    assert.strictEqual(estimate(['hello', '1a']), 'string');
  });

  it('getColumnColor returns hex colors', () => {
    const getColor = getPrivate<(t: string, dark: boolean, i: number) => string>(provider, 'getColumnColor').bind(provider);
    assert.strictEqual(getColor('empty', true, 0), '#BBB');
    assert.strictEqual(getColor('empty', false, 0), '#444');
    const hex = getColor('boolean', true, 2);
    assert.match(hex, /^#[0-9a-fA-F]{6}$/);
  });

  it('hslToHex converts known colors', () => {
    const hslToHex = getPrivate<(h:number,s:number,l:number)=>string>(provider, 'hslToHex').bind(provider);
    assert.strictEqual(hslToHex(0, 100, 50), '#ff0000');   // red
    assert.strictEqual(hslToHex(120, 100, 50), '#00ff00'); // green
    assert.strictEqual(hslToHex(240, 100, 50), '#0000ff'); // blue
  });
});
