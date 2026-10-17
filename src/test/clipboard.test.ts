import assert from 'assert';
import { describe, it } from 'node:test';
import Papa from 'papaparse';
import { parseClipboardMatrix, serializeClipboardMatrix } from '../clipboard';

// Independent expectations exercise the same codec used by the extension host.
describe('Clipboard matrix fidelity', () => {
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
