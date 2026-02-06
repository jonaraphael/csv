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

  it('formatCellContent linkifies allowed URLs when enabled', () => {
    const format = CsvEditorProvider.__test.formatCellContent;
    const html = format('See https://example.com?a=1&b=2 and mailto:user@example.com', true);
    assert.ok(html.includes('class="csv-link"'));
    assert.ok(html.includes('data-href="https://example.com?a=1&amp;b=2"'));
    assert.ok(html.includes('data-href="mailto:user@example.com"'));
    assert.ok(html.includes('https://example.com?a=1&amp;b=2'));
  });

  it('formatCellContent linkifies www.*.* links like Google Sheets', () => {
    const format = CsvEditorProvider.__test.formatCellContent;
    const html = format('Visit www.google.com, then continue.', true);
    assert.ok(html.includes('class="csv-link"'));
    assert.ok(html.includes('data-href="https://www.google.com"'));
    assert.ok(html.includes('>www.google.com</span>,'));
  });

  it('formatCellContent leaves URLs as plain text when linkify is disabled', () => {
    const format = CsvEditorProvider.__test.formatCellContent;
    const html = format('https://example.com?a=1&b=2', false);
    assert.ok(!html.includes('class="csv-link"'));
    assert.strictEqual(html, 'https://example.com?a=1&amp;b=2');
  });

  it('formatCellContent leaves www links as plain text when linkify is disabled', () => {
    const format = CsvEditorProvider.__test.formatCellContent;
    const html = format('www.google.com', false);
    assert.ok(!html.includes('class="csv-link"'));
    assert.strictEqual(html, 'www.google.com');
  });

  it('external link allowlist accepts only supported URL schemes', () => {
    const allowed = CsvEditorProvider.__test.isAllowedExternalUrl;
    assert.strictEqual(allowed('https://example.com'), true);
    assert.strictEqual(allowed('http://example.com'), true);
    assert.strictEqual(allowed('ftp://example.com/file.txt'), true);
    assert.strictEqual(allowed('mailto:user@example.com'), true);
    assert.strictEqual(allowed('javascript:alert(1)'), false);
    assert.strictEqual(allowed('data:text/plain,hello'), false);
    assert.strictEqual(allowed('file:///tmp/x.csv'), false);
    assert.strictEqual(allowed(''), false);
  });

  it('large file prompt helper honors threshold and disabled limit', () => {
    const shouldPrompt = CsvEditorProvider.__test.shouldPromptForLargeFile;
    const mb = 1024 * 1024;
    assert.strictEqual(shouldPrompt(10 * mb, 10), false);
    assert.strictEqual(shouldPrompt(10 * mb + 1, 10), true);
    assert.strictEqual(shouldPrompt(50 * mb, 0), false);
    assert.strictEqual(shouldPrompt(50 * mb, -1), false);
    assert.strictEqual(shouldPrompt(50 * mb, Number.NaN), false);
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

  it('getColumnColor supports an opt-in cool palette', () => {
    const getColor = CsvEditorProvider.__test.getColumnColor;
    const def = getColor('string', false, 0, 'default');
    const cool = getColor('string', false, 0, 'cool');
    assert.match(cool, /^#[0-9a-fA-F]{6}$/);
    assert.notStrictEqual(def, cool);
  });

  it('getColumnColor supports an opt-in warm palette', () => {
    const getColor = CsvEditorProvider.__test.getColumnColor;
    const def = getColor('string', false, 0, 'default');
    const warm = getColor('string', false, 0, 'warm');
    assert.match(warm, /^#[0-9a-fA-F]{6}$/);
    assert.notStrictEqual(def, warm);
  });

  it('resolves effective column color mode for diff contexts', () => {
    const resolveMode = CsvEditorProvider.__test.resolveEffectiveColumnColorMode;
    assert.strictEqual(resolveMode('type', false, true), 'type');
    assert.strictEqual(resolveMode('theme', false, true), 'theme');
    assert.strictEqual(resolveMode('type', true, true), 'theme');
    assert.strictEqual(resolveMode('theme', true, true), 'theme');
    assert.strictEqual(resolveMode('type', true, false), 'type');
    assert.strictEqual(resolveMode('invalid', false, false), 'type');
  });

  it('computes paste plan to fill rectangular selection for single-cell clipboard value', () => {
    const plan = CsvEditorProvider.__test.computePastePlan(
      [['X']],
      5,
      6,
      { minRow: 1, maxRow: 2, minCol: 3, maxCol: 4, rectangular: true }
    );
    assert.deepStrictEqual(plan, {
      startRow: 1,
      startCol: 3,
      endRow: 2,
      endCol: 4,
      fillSelection: true
    });
  });

  it('applies matrix paste and expands data when needed', () => {
    const data = [['a']];
    const result = CsvEditorProvider.__test.applyPasteMatrixToData(
      data,
      [['x', 'y'], ['z', 'w']],
      0,
      1
    );
    assert.strictEqual(result.changed, true);
    assert.strictEqual(result.structuralChange, true);
    assert.strictEqual(result.plan.fillSelection, false);
    assert.deepStrictEqual(data, [
      ['a', 'x', 'y'],
      ['', 'z', 'w']
    ]);
  });

  it('fills selected rectangle when pasting a single-cell value', () => {
    const data = [
      ['a', 'b'],
      ['c', 'd']
    ];
    const result = CsvEditorProvider.__test.applyPasteMatrixToData(
      data,
      [['q']],
      0,
      0,
      { minRow: 0, maxRow: 1, minCol: 0, maxCol: 1, rectangular: true }
    );
    assert.strictEqual(result.changed, true);
    assert.strictEqual(result.structuralChange, false);
    assert.strictEqual(result.plan.fillSelection, true);
    assert.deepStrictEqual(data, [
      ['q', 'q'],
      ['q', 'q']
    ]);
  });

  it('hslToHex converts known colors', () => {
    const hslToHex = CsvEditorProvider.__test.hslToHex;
    assert.strictEqual(hslToHex(0, 100, 50), '#ff0000');   // red
    assert.strictEqual(hslToHex(120, 100, 50), '#00ff00'); // green
    assert.strictEqual(hslToHex(240, 100, 50), '#0000ff'); // blue
  });
});
