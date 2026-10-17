import Papa from 'papaparse';

const clipboardDelimiterCandidates = ['\t', ',', ';', '|'];

export function serializeClipboardMatrix(matrix: string[][], delimiter: string): string {
  const escapedCharacters = [delimiter, ...clipboardDelimiterCandidates, '"', '\r', '\n', '\uFEFF'];
  // Keep ordinary text plain. Complex ranges retain consistent CSV quoting so
  // paste auto-detection preserves their cell boundaries and explicit blanks.
  const quoteAll = matrix.some(row => row.some(value =>
    value === '' || value.startsWith(' ') || value.endsWith(' ') ||
    escapedCharacters.some(character => value.includes(character))
  ));
  return Papa.unparse(matrix, { delimiter, quotes: quoteAll, newline: '\r\n' });
}

export function parseClipboardMatrix(text: string, fallbackDelimiter: string): string[][] {
  if (!text) {
    return [];
  }
  const parsed = Papa.parse<string[]>(text, {
    dynamicTyping: false,
    delimiter: '',
    delimitersToGuess: [fallbackDelimiter, ...clipboardDelimiterCandidates].filter((value, index, all) => all.indexOf(value) === index)
  });
  const matrix = parsed.data.map(row => row.map(value => String(value ?? '')));
  // A terminal record separator creates one parser sentinel, not an extra record.
  // Preserve explicit blank records, including quoted empty fields.
  if (/[\r\n]$/.test(text) && matrix.length > 1 && matrix[matrix.length - 1].length === 1 && matrix[matrix.length - 1][0] === '') {
    matrix.pop();
  }
  const width = matrix.reduce((max, row) => Math.max(max, row.length), 0);
  return matrix.map(row => [...row, ...Array(width - row.length).fill('')]);
}
