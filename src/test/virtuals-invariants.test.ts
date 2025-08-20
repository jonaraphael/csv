import assert from 'assert';
import { describe, it } from 'node:test';
import Module from 'module';

// Stub 'vscode' theme checks
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

describe('Virtual row and cell invariants', () => {
  it('non-chunked: renders exactly one virtual row matching widest column', () => {
    const data = [
      ['a'],
      ['b', 'c', 'd']
    ];
    const { tableHtml, chunks } = CsvEditorProvider.__test.generateTableAndChunksRaw(data, /*treatHeader*/ false, /*addSerialIndex*/ false, /*hiddenRows*/ 0);
    // Should not use chunks for non-chunked data
    assert.strictEqual(chunks.length, 0);

    // Virtual row absolute index = offset (0) + nonHeaderRows.length (2)
    const virtualAbs = 2;
    // Expect a cell for each column up to widest (3)
    for (let c = 0; c < 3; c++) {
      const needle = `data-row="${virtualAbs}" data-col="${c}"`;
      assert.ok(tableHtml.includes(needle), `expected virtual cell presence: ${needle}`);
    }
    // And ensure there is no unexpected next column
    assert.ok(!tableHtml.includes(`data-row="${virtualAbs}" data-col="3"`));
  });

  it('chunked: appends one final chunk containing the virtual row', () => {
    const rows: string[][] = Array.from({ length: 1500 }, (_, i) => [String(i+1), 'x', 'y']);
    const { tableHtml, chunks } = CsvEditorProvider.__test.generateTableAndChunksRaw(rows, /*treatHeader*/ false, /*addSerialIndex*/ false, /*hiddenRows*/ 0);
    // Initial table should not include the virtual row when chunked
    assert.ok(!tableHtml.includes('data-row="1500"'));
    // Two chunks: 500 remaining rows + 1 virtual row chunk
    assert.strictEqual(chunks.length, 2);
    const last = chunks[chunks.length - 1];
    // Virtual absolute row index equals number of data rows (startAbs = 0)
    const virtualAbs = 1500;
    for (let c = 0; c < 3; c++) {
      const needle = `data-row="${virtualAbs}" data-col="${c}"`;
      assert.ok(last.includes(needle), `expected virtual cell in chunk: ${needle}`);
    }
  });
});

