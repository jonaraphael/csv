import assert from 'assert';
import { describe, it } from 'node:test';
import Papa from 'papaparse';
import { parseClipboardMatrix, serializeClipboardMatrix } from '../clipboard';

// Independent expectations exercise the same codec used by the extension host.
describe('Clipboard matrix fidelity', () => {
  it('copies ordinary single-cell strings as plain text for Search and other text inputs', () => {
    for (const value of ['hello', 'hello world', 'SKU-123', '00123', 'https://example.test/path?query=one&other=two']) {
      assert.strictEqual(serializeClipboardMatrix([[value]], ','), value);
      assert.strictEqual(serializeClipboardMatrix([[value]], '\t'), value);
    }
  });

  it('does not add quotes to ordinary fields in a copied range', () => {
    const matrix = [['name', 'value'], ['alpha', '42']];
    assert.strictEqual(serializeClipboardMatrix(matrix, ','), 'name,value\r\nalpha,42');
    assert.strictEqual(serializeClipboardMatrix(matrix, '\t'), 'name\tvalue\r\nalpha\t42');
  });

  it('retains consistent escaping for complex ranges', () => {
    assert.strictEqual(
      serializeClipboardMatrix([['hello', 'with,comma', 'say "hi"', 'line\nvalue']], ','),
      '"hello","with,comma","say ""hi""","line\nvalue"'
    );
  });

  it('keeps alternate separators inside one copied cell during automatic paste detection', () => {
    for (const delimiter of [',', '\t', '|', ';', '^']) {
      for (const value of ['with,comma', 'with\ttab', 'with;semicolon', 'with|pipe']) {
        assert.deepStrictEqual(parseClipboardMatrix(serializeClipboardMatrix([[value]], delimiter), delimiter), [[value]]);
      }
    }
  });

  it('does not guess separators from inside later quoted fields in a copied range', () => {
    for (const delimiter of [',', '\t', '|', ';', '^']) {
      for (const value of ['a,b,c', 'a\tb\tc', 'a;;b', 'a||b']) {
        const matrix = [['hello', value], ['ordinary text', value]];
        const copied = serializeClipboardMatrix(matrix, delimiter);
        assert.deepStrictEqual(Papa.parse(copied, { delimiter }).data, matrix);
        assert.deepStrictEqual(parseClipboardMatrix(copied, delimiter), matrix);
      }
    }
  });

  it('preserves mixed punctuation when copying between CSV and TSV documents', () => {
    const matrix = [['a"b', 'a^b'], ['trailing ', ',;|\t']];
    for (const sourceDelimiter of [',', '\t']) {
      const copied = serializeClipboardMatrix(matrix, sourceDelimiter);
      for (const targetDelimiter of [',', '\t']) {
        assert.deepStrictEqual(parseClipboardMatrix(copied, targetDelimiter), matrix);
      }
    }
  });

  it('preserves blank records at the end of a single copied column', () => {
    const matrix = [['hello'], [''], ['']];
    assert.deepStrictEqual(parseClipboardMatrix(serializeClipboardMatrix(matrix, ','), ','), matrix);
  });

  for (const delimiter of [',', '\t', '|', ';', '^']) {
    it(`preserves cell and record boundaries with delimiter ${JSON.stringify(delimiter)}`, () => {
      const matrix = [
        ['comma,value', 'line one\nline two', 'a "literal" quote', ''],
        ['tab\tvalue', 'windows\r\nnewline', '  whitespace  ', ''],
        ['', '', '', '']
      ];
      const text = serializeClipboardMatrix(matrix, delimiter);
      assert.deepStrictEqual(Papa.parse(text, { delimiter }).data, matrix);
      assert.deepStrictEqual(parseClipboardMatrix(text, delimiter), matrix);
    });
  }

  it('keeps each special value in a single cell', () => {
    for (const value of ['comma,value', 'line\nvalue', '"literal"', '  ', '\t', '\r\n']) {
      assert.deepStrictEqual(parseClipboardMatrix(serializeClipboardMatrix([[value]], ','), ','), [[value]]);
    }
  });

  it('preserves one empty cell and rows made entirely of empty cells', () => {
    for (const matrix of [[['']], [[''], ['']], [['', ''], ['', '']]]) {
      assert.deepStrictEqual(parseClipboardMatrix(serializeClipboardMatrix(matrix, '\t'), '\t'), matrix);
    }
  });

  it('accepts external spreadsheet TSV in a CSV document', () => {
    assert.deepStrictEqual(parseClipboardMatrix('one\t"two\nlines"\t\r\nthree\tfour\t\r\n', ','), [
      ['one', 'two\nlines', ''], ['three', 'four', '']
    ]);
  });

  it('removes a terminal parser sentinel while preserving intentional empty records', () => {
    assert.deepStrictEqual(parseClipboardMatrix('one,two\n,,\n', ','), [['one', 'two', ''], ['', '', '']]);
    assert.deepStrictEqual(parseClipboardMatrix('one\n""\n', ','), [['one'], ['']]);
    assert.deepStrictEqual(parseClipboardMatrix('"\n"', ','), [['\n']]);
    assert.deepStrictEqual(parseClipboardMatrix('', ','), []);
  });
});
