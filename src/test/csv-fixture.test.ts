import assert from 'assert';
import { describe, it } from 'node:test';
import fs from 'fs';
import path from 'path';
import Papa from 'papaparse';
import Module from 'module';

// Provide a minimal vscode stub for utilities that inspect theme kind
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

describe('CSV fixture: super_example.csv', () => {
  const csvPath = path.join(process.cwd(), 'src', 'test', 'super_example.csv');
  const text = fs.readFileSync(csvPath, 'utf8');
  const parsed = Papa.parse<string[]>(text, { dynamicTyping: false, delimiter: ',' });
  const rows = parsed.data as string[][];

  it('parses the expected header and body sizes', () => {
    assert.ok(rows.length > 1000, 'expected > 1000 rows');
    const headerIdx = rows.findIndex(r => (r[0] || '').trim() === 'Hero');
    assert.ok(headerIdx > 0, 'expected header after meta rows');
    assert.strictEqual((rows[headerIdx] || []).length, 12, 'expected 12 columns');
    const bodyRows = rows.slice(headerIdx + 1);
    assert.ok(bodyRows.length >= 1000, 'expected >= 1000 body rows for chunking');
  });

  it('infers column types correctly from body', () => {
    const headerIdx = rows.findIndex(r => (r[0] || '').trim() === 'Hero');
    const body = rows.slice(headerIdx + 1);
    const numCols = body.reduce((max, r) => Math.max(max, r.length), 0);
    const cols: string[][] = Array.from({ length: numCols }, (_, i) => body.map(r => r[i] || ''));
    const estimate = CsvEditorProvider.__test.estimateColumnDataType;
    const types = cols.map(c => estimate(c));
    assert.deepStrictEqual(types.slice(0, 12), [
      'string',   // Hero
      'string',   // Sidekick (some empty)
      'boolean',  // CanFly
      'boolean',  // HasCape
      'date',     // FirstSeen
      'date',     // LastSeen
      'integer',  // Rescues
      'integer',  // Disasters
      'float',    // Power
      'float',    // Speed
      'empty',    // Note
      'empty'     // Spare
    ]);
  });

  it('header heuristic respects hiddenRows and overrides', () => {
    // With 3 meta rows hidden, the next row is the column header
    const treat = CsvEditorProvider.__test.getEffectiveHeader(rows, 3);
    assert.strictEqual(treat, true);
    // An explicit override should be honored
    const forcedFalse = CsvEditorProvider.__test.getEffectiveHeader(rows, 3, false);
    assert.strictEqual(forcedFalse, false);
    const forcedTrue = CsvEditorProvider.__test.getEffectiveHeader(rows, 3, true);
    assert.strictEqual(forcedTrue, true);
  });

  it('chunking metadata reflects large dataset (CHUNK_SIZE=1000)', () => {
    const meta = CsvEditorProvider.__test.generateTableChunksMeta(rows, /*treatHeader*/ true, /*addSerialIndex*/ true, /*hiddenRows*/ 3);
    // Expect one chunk for rows beyond 1000 plus one final virtual-row chunk
    assert.strictEqual(meta.chunkCount, 2);
    assert.ok(meta.hasTable);
  });

  it('chunking chunkCount remains stable across hiddenRows when still > CHUNK_SIZE', () => {
    // With different hiddenRows, as long as visible data rows exceed 1000, chunk count remains 2
    const meta0 = CsvEditorProvider.__test.generateTableChunksMeta(rows, true, true, 0);
    const meta2 = CsvEditorProvider.__test.generateTableChunksMeta(rows, true, true, 2);
    const meta5 = CsvEditorProvider.__test.generateTableChunksMeta(rows, true, true, 5);
    assert.strictEqual(meta0.chunkCount, 2);
    assert.strictEqual(meta2.chunkCount, 2);
    assert.strictEqual(meta5.chunkCount, 2);
  });

  it('engages chunking with or without header', () => {
    const withHeader = CsvEditorProvider.__test.generateTableChunksMeta(rows, true, true, 3);
    const noHeader   = CsvEditorProvider.__test.generateTableChunksMeta(rows, false, true, 3);
    assert.strictEqual(withHeader.chunkCount, 2);
    assert.strictEqual(noHeader.chunkCount, 2);
  });

  it('computeColumnWidths matches independent calculation', () => {
    const headerIdx = rows.findIndex(r => (r[0] || '').trim() === 'Hero');
    const visible = rows.slice(headerIdx); // include header + body
    const expected = (() => {
      const n = visible.reduce((max, r) => Math.max(max, r.length), 0);
      const arr = Array(n).fill(0);
      for (const r of visible) {
        for (let i = 0; i < n; i++) {
          arr[i] = Math.max(arr[i], (r[i] || '').length);
        }
      }
      return arr;
    })();
    const widths = CsvEditorProvider.__test.computeColumnWidths(visible);
    assert.deepStrictEqual(widths, expected);
  });
});
