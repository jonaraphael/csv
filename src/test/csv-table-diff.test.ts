import assert from 'assert';
import { describe, it } from 'node:test';
import { compareCsvRows, comparisonLimits, comparisonPages, parseComparisonRows } from '../csv-table-diff';

describe('CSV table difference model', () => {
  it('aligns inserted/deleted records and isolates changed fields around multiline values', () => {
    const original = parseComparisonRows('id,value\r\n1,"one\r\ntwo"\r\n2,old\r\n3,remove\r\n4,same\r\n', ',');
    const modified = parseComparisonRows('id,value\n0,added\n1,"one\r\ntwo"\n2,new\n4,same\n', ',');
    const diff = compareCsvRows(original, modified);
    assert.deepStrictEqual(diff.records.map(record => [record.original, record.modified, record.kind]), [
      [0, 0, 'equal'], [undefined, 1, 'added'], [1, 2, 'equal'], [2, 3, 'changed'], [3, undefined, 'removed'], [4, 4, 'equal']
    ]);
    assert.deepStrictEqual(diff.records[3].changedColumns, [1]);
    assert.deepStrictEqual([diff.added, diff.removed, diff.changed, diff.approximate], [1, 1, 1, false]);
  });

  it('aligns a modified record with shared fields after an adjacent deletion', () => {
    const diff = compareCsvRows([['gone', 'old'], ['id', 'before']], [['id', 'after']]);
    assert.deepStrictEqual(diff.records.map(record => [record.original, record.modified, record.kind]), [
      [0, undefined, 'removed'], [1, 0, 'changed']
    ]);
    assert.deepStrictEqual(diff.records[1].changedColumns, [1]);
  });

  it('distinguishes a missing field from an empty field, without counting quote/terminator style', () => {
    const diff = compareCsvRows(parseComparisonRows('"a",b\r\nx\r\n', ','), parseComparisonRows('a,b\nx,\n', ','));
    assert.strictEqual(diff.records[0].kind, 'equal');
    assert.deepStrictEqual(diff.records[1].changedColumns, [1]);
    assert.strictEqual(diff.changed, 1);
    assert.deepStrictEqual(parseComparisonRows('a\n\n', ','), [['a'], ['']]);
  });

  for (const delimiter of [',', '\t', '|']) {
    it(`parses ${JSON.stringify(delimiter)} fields with doubled quotes, BOM and multiline Unicode`, () => {
      const rows = parseComparisonRows(`\ufeffname${delimiter}value\r\n"é\n🙂"${delimiter}"a""b"\r\n`, delimiter);
      assert.deepStrictEqual(rows, [['name', 'value'], ['é\n🙂', 'a"b']]);
    });
  }

  it('preserves every source record in order with duplicates and empty sides', () => {
    const inputs = [[], [['']], [['a'], ['a'], ['b']], [['a'], ['b'], ['a']], [['x', ''], ['y']]];
    for (const original of inputs) {
      for (const modified of inputs) {
        const diff = compareCsvRows(original, modified);
        assert.deepStrictEqual(diff.records.flatMap(record => record.original === undefined ? [] : [record.original]), original.map((_, index) => index));
        assert.deepStrictEqual(diff.records.flatMap(record => record.modified === undefined ? [] : [record.modified]), modified.map((_, index) => index));
      }
    }
  });

  it('bounds large alignment work and explicitly reports positional sections', () => {
    const original = Array.from({ length: comparisonLimits.rows }, (_, index) => [`old-${index}`]);
    const modified = Array.from({ length: comparisonLimits.rows }, (_, index) => [`new-${index}`]);
    const diff = compareCsvRows(original, modified);
    assert.strictEqual(diff.approximate, true);
    assert.strictEqual(diff.records.length, comparisonLimits.rows);
    assert.strictEqual(diff.changed, comparisonLimits.rows);
    assert.deepStrictEqual(diff.records.at(-1)?.changedColumns, [0]);
  });

  it('uses unique unchanged anchors on large inputs with additions', () => {
    const original = Array.from({ length: 1500 }, (_, index) => [String(index)]);
    const modified = [['first'], ...original.map(row => [...row]), ['last']];
    modified[750] = ['changed'];
    const diff = compareCsvRows(original, modified);
    assert.strictEqual(diff.added, 2);
    assert.strictEqual(diff.changed, 1);
    assert.strictEqual(diff.removed, 0);
    assert.strictEqual(diff.records.find(record => record.original === 1499)?.modified, 1500);
  });

  it('rejects malformed and oversized values, records, rows, cells and decoded input without truncation', () => {
    assert.throws(() => parseComparisonRows('"unfinished', ','), /malformed/);
    assert.throws(() => parseComparisonRows('a'.repeat(comparisonLimits.cellChars + 1), ','), /display limit/);
    assert.throws(() => parseComparisonRows(Array(6).fill('x'.repeat(50000)).join(','), ','), /display limit/);
    assert.throws(() => parseComparisonRows(Array(comparisonLimits.rows + 1).fill('x').join('\n'), ','), /10,000/);
    assert.throws(() => parseComparisonRows(Array(1001).fill('x').join(','), ','), /1,000/);
    assert.throws(() => parseComparisonRows(Array(101).fill(Array(1000).fill('x').join(',')).join('\n'), ','), /100,000/);
    assert.throws(() => parseComparisonRows('é'.repeat(comparisonLimits.textBytes / 2 + 1), ','), /5 MiB/);
  });

  it('pages within row, rendered body-cell and text bounds', () => {
    for (const rows of [Array.from({ length: 501 }, () => ['a']), Array.from({ length: 30 }, () => Array(1000).fill('x')), Array.from({ length: 30 }, () => ['x'.repeat(60000)])]) {
      const diff = compareCsvRows(rows, rows);
      const pages = comparisonPages(diff);
      assert.ok(pages.length > 1);
      assert.strictEqual(pages[0].start, 0);
      assert.strictEqual(pages.at(-1)?.end, rows.length);
      for (const page of pages) {
        const slice = rows.slice(page.start, page.end);
        assert.ok(slice.length <= comparisonLimits.pageRows);
        assert.ok(slice.reduce((sum, row) => sum + row.length * 2 + 2, 0) <= comparisonLimits.pageCells);
        assert.ok(slice.reduce((sum, row) => sum + row.join('').length * 2, 0) <= comparisonLimits.pageChars);
      }
    }
  });
});
