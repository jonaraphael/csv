import Papa from 'papaparse';

const clipboardDelimiterCandidates = ['\t', ',', ';', '|'];

export function serializeClipboardMatrix(matrix: string[][], delimiter: string): string {
  const escapedCharacters = [delimiter, ...clipboardDelimiterCandidates, '"', '\r', '\n', '\uFEFF'];
  // Quote each value independently: a complex neighbor must not wrap plain text.
  return Papa.unparse(matrix, {
    delimiter,
    quotes: value => value === '' || value.startsWith(' ') || value.endsWith(' ') ||
      escapedCharacters.some(character => value.includes(character)),
    newline: '\r\n'
  });
}

// Papa's candidate parsers can mistake separators inside a later quoted field
// for delimiters when the first field is unquoted. Remove candidates that occur
// only inside complete quoted fields, then leave parsing/scoring to Papa.
function clipboardDelimitersOutsideQuotes(text: string, candidates: string[]): string[] {
  const tokens = [...candidates].sort((a, b) => b.length - a.length);
  const found = new Set<string>();
  let quoted = new Set<string>();
  let inQuotes = false;
  let fieldStart = true;
  const at = (index: number) => tokens.find(token => text.startsWith(token, index));
  for (let i = 0; i < text.length;) {
    const character = text[i];
    if (inQuotes) {
      if (character === '"') {
        if (text[i + 1] === '"') { i += 2; continue; }
        const next = text[i + 1];
        if (next !== undefined && next !== '\r' && next !== '\n' && !at(i + 1)) {
          // An incomplete/malformed quoted prefix is ordinary external text.
          for (const token of quoted) { found.add(token); }
        }
        inQuotes = false;
        quoted = new Set();
        fieldStart = false;
        i++;
      } else {
        const token = at(i);
        if (token) { quoted.add(token); i += token.length; }
        else { i++; }
      }
      continue;
    }
    if (character === '"' && fieldStart) {
      inQuotes = true;
      i++;
      continue;
    }
    const token = at(i);
    if (token) {
      found.add(token);
      fieldStart = true;
      i += token.length;
    } else {
      fieldStart = character === '\r' || character === '\n';
      i++;
    }
  }
  // Do not hide genuine separators behind an unterminated literal quote.
  if (inQuotes) { for (const token of quoted) { found.add(token); } }
  return candidates.filter(candidate => found.has(candidate));
}

export function parseClipboardMatrix(text: string, fallbackDelimiter: string): string[][] {
  if (!text) {
    return [];
  }
  const candidates = [fallbackDelimiter, ...clipboardDelimiterCandidates].filter((value, index, all) => value.length > 0 && all.indexOf(value) === index);
  const available = clipboardDelimitersOutsideQuotes(text, candidates);
  const parsed = Papa.parse<string[]>(text, {
    dynamicTyping: false,
    delimiter: available.length > 1 ? '' : available[0] || fallbackDelimiter,
    delimitersToGuess: available
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
