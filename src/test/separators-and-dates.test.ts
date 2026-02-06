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

describe('Separators and date edge cases', () => {
  it('inherits separator from file type and respects overrides', () => {
    const eff = CsvEditorProvider.__test.getEffectiveSeparator;
    // Default CSV -> ','
    assert.strictEqual(eff('/tmp/sample.csv', undefined), ',');
    // Default TSV -> '\t'
    assert.strictEqual(eff('/tmp/sample.tsv', undefined), '\t');
    // Default TAB -> '\t'
    assert.strictEqual(eff('/tmp/sample.tab', undefined), '\t');
    // Default PSV -> '|'
    assert.strictEqual(eff('/tmp/sample.psv', undefined), '|');
    // Override wins regardless of extension
    assert.strictEqual(eff('/tmp/sample.csv', ';'), ';');
    assert.strictEqual(eff('/tmp/sample.tsv', ';'), ';');
    assert.strictEqual(eff('/tmp/sample.tab', ';'), ';');
    assert.strictEqual(eff('/tmp/sample.psv', ';'), ';');
  });

  it('supports extension/default/auto separator modes', () => {
    const eff = CsvEditorProvider.__test.getEffectiveSeparator;

    // default mode always uses csv.defaultSeparator
    assert.strictEqual(
      eff('/tmp/sample.tsv', undefined, { mode: 'default', defaultSeparator: ';' }),
      ';'
    );

    // extension mode uses mapping overrides
    assert.strictEqual(
      eff('/tmp/sample.data', undefined, {
        mode: 'extension',
        defaultSeparator: ',',
        byExtension: { '.data': '|', '.csv': ';' }
      }),
      '|'
    );

    // auto mode detects separators from content regardless of extension
    assert.strictEqual(
      eff('/tmp/sample.csv', undefined, {
        mode: 'auto',
        text: 'a|b|c\n1|2|3\n4|5|6'
      }),
      '|'
    );

    // auto mode should favor the delimiter present in the header row
    assert.strictEqual(
      eff('/tmp/sample.csv', undefined, {
        mode: 'auto',
        text: 'a;b;c\n1,23;4,56;7,89\n2,11;3,33;4,44'
      }),
      ';'
    );

    // auto mode falls back safely when content is ambiguous
    assert.strictEqual(
      eff('/tmp/sample.tsv', undefined, {
        mode: 'auto',
        text: 'single-value-line'
      }),
      '\t'
    );
  });

  it('isDate handles offsets, time components, and rejects bogus values', () => {
    const isDate = CsvEditorProvider.__test.isDate;
    // ISO with time
    assert.strictEqual(isDate('2024-01-02T03:04:05Z'), true);
    assert.strictEqual(isDate('2024-01-02 03:04'), true);
    assert.strictEqual(isDate('2024-01-02T03:04:05+02:00'), true);
    assert.strictEqual(isDate('2024/01/02'), true);
    // Bogus / ambiguous values
    assert.strictEqual(isDate('2024-13-40'), false);
    assert.strictEqual(isDate('0000-00-00'), false);
    assert.strictEqual(isDate('1/2/2024'), false); // not yyyy/mm/dd
    assert.strictEqual(isDate('20240102'), false);
    assert.strictEqual(isDate('42'), false);
  });
});
