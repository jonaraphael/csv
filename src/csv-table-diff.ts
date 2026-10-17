import Papa from 'papaparse';

export const comparisonLimits = {
  sourceBytes: 10 * 1024 * 1024,
  textBytes: 5 * 1024 * 1024,
  rows: 10000,
  cells: 100000,
  columns: 1000,
  cellChars: 64 * 1024,
  recordChars: 256 * 1024,
  alignmentCells: 1000000,
  replacementCells: 1000000,
  alignmentDepth: 20,
  pageRows: 200,
  pageCells: 20000,
  pageChars: 512 * 1024
};

export type ComparedRecord = {
  original?: number;
  modified?: number;
  kind: 'equal' | 'changed' | 'added' | 'removed';
  changedColumns: number[];
};
export type CsvTableDiff = {
  originalRows: string[][];
  modifiedRows: string[][];
  records: ComparedRecord[];
  approximate: boolean;
  added: number;
  removed: number;
  changed: number;
};

export function parseComparisonRows(text: string, delimiter: string): string[][] {
  if (Buffer.byteLength(text, 'utf8') > comparisonLimits.textBytes) {
    throw new Error('Table comparison supports at most 5 MiB of decoded text per file. Use a text diff for larger files.');
  }
  const parsed = Papa.parse<string[]>(text, { delimiter, dynamicTyping: false });
  if (parsed.errors.some(error => error.type === 'Quotes')) {
    throw new Error('The input contains malformed quoted CSV. Correct it before comparing as a table.');
  }
  const rows = parsed.data;
  if (/[\r\n]$/.test(text) && rows.length && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === '') {
    rows.pop(); // Papa's EOF marker is not an additional logical record.
  }
  if (rows.length > comparisonLimits.rows) {
    throw new Error('Table comparison supports at most 10,000 records per file. Use a text diff for larger files.');
  }
  let cells = 0;
  for (const row of rows) {
    cells += row.length;
    if (row.length > comparisonLimits.columns || cells > comparisonLimits.cells) {
      throw new Error('Table comparison supports at most 1,000 columns and 100,000 cells per file. No fields were truncated.');
    }
    if (row.some(value => value.length > comparisonLimits.cellChars) || row.reduce((sum, value) => sum + value.length, 0) > comparisonLimits.recordChars) {
      throw new Error('A value or record exceeds the table comparison display limit. No content was truncated.');
    }
  }
  return rows;
}

export function compareCsvRows(originalRows: string[][], modifiedRows: string[][]): CsvTableDiff {
  const original = originalRows.map(row => JSON.stringify(row));
  const modified = modifiedRows.map(row => JSON.stringify(row));
  const matches: Array<[number, number]> = [];
  let budget = comparisonLimits.alignmentCells;
  let approximate = false;

  const uniqueAnchors = (a0: number, a1: number, b0: number, b1: number): Array<[number, number]> => {
    const indices = (values: string[], start: number, end: number) => {
      const map = new Map<string, number>();
      for (let index = start; index < end; index++) {
        map.set(values[index], map.has(values[index]) ? -1 : index);
      }
      return map;
    };
    const left = indices(original, a0, a1);
    const right = indices(modified, b0, b1);
    const candidates: Array<[number, number]> = [];
    for (let index = a0; index < a1; index++) {
      const other = right.get(original[index]);
      if (left.get(original[index]) === index && other !== undefined && other >= 0) {
        candidates.push([index, other]);
      }
    }
    const tails: number[] = [];
    const predecessors = Array(candidates.length).fill(-1);
    for (let index = 0; index < candidates.length; index++) {
      let low = 0, high = tails.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (candidates[tails[middle]][1] < candidates[index][1]) { low = middle + 1; } else { high = middle; }
      }
      predecessors[index] = low > 0 ? tails[low - 1] : -1;
      tails[low] = index;
    }
    const anchors: Array<[number, number]> = [];
    for (let index = tails.length ? tails[tails.length - 1] : -1; index >= 0; index = predecessors[index]) {
      anchors.push(candidates[index]);
    }
    return anchors.reverse();
  };

  const align = (a0: number, a1: number, b0: number, b1: number, depth: number): void => {
    while (a0 < a1 && b0 < b1 && original[a0] === modified[b0]) {
      matches.push([a0++, b0++]);
    }
    const suffix: Array<[number, number]> = [];
    while (a0 < a1 && b0 < b1 && original[a1 - 1] === modified[b1 - 1]) {
      suffix.push([--a1, --b1]);
    }
    if (a0 < a1 && b0 < b1) {
      const height = a1 - a0, width = b1 - b0;
      const cost = (height + 1) * (width + 1);
      if (cost <= budget) {
        budget -= cost;
        const stride = width + 1;
        const lengths = new Uint16Array(cost);
        for (let a = height - 1; a >= 0; a--) {
          for (let b = width - 1; b >= 0; b--) {
            lengths[a * stride + b] = original[a0 + a] === modified[b0 + b]
              ? lengths[(a + 1) * stride + b + 1] + 1
              : Math.max(lengths[(a + 1) * stride + b], lengths[a * stride + b + 1]);
          }
        }
        let a = 0, b = 0;
        while (a < height && b < width) {
          if (original[a0 + a] === modified[b0 + b]) { matches.push([a0 + a++, b0 + b++]); }
          else if (lengths[(a + 1) * stride + b] >= lengths[a * stride + b + 1]) { a++; }
          else { b++; }
        }
      } else if (depth < comparisonLimits.alignmentDepth) {
        const anchors = uniqueAnchors(a0, a1, b0, b1);
        if (!anchors.length) {
          approximate = true;
        } else {
          for (const [a, b] of anchors) {
            align(a0, a, b0, b, depth + 1);
            matches.push([a, b]);
            a0 = a + 1; b0 = b + 1;
          }
          align(a0, a1, b0, b1, depth + 1);
        }
      } else {
        approximate = true;
      }
    }
    matches.push(...suffix.reverse());
  };
  align(0, original.length, 0, modified.length, 0);

  const result: CsvTableDiff = { originalRows, modifiedRows, records: [], approximate, added: 0, removed: 0, changed: 0 };
  const append = (a: number | undefined, b: number | undefined) => {
    const before = a === undefined ? undefined : originalRows[a];
    const after = b === undefined ? undefined : modifiedRows[b];
    const changedColumns: number[] = [];
    for (let col = 0; col < Math.max(before?.length ?? 0, after?.length ?? 0); col++) {
      if (!before || !after || col >= before.length || col >= after.length || before[col] !== after[col]) {
        changedColumns.push(col);
      }
    }
    const kind = a === undefined ? 'added' : b === undefined ? 'removed' : changedColumns.length ? 'changed' : 'equal';
    result.records.push({ original: a, modified: b, kind, changedColumns });
    if (kind !== 'equal') { result[kind]++; }
  };
  let replacementBudget = comparisonLimits.replacementCells;
  const appendGap = (a0: number, a1: number, b0: number, b1: number) => {
    const height = a1 - a0, width = b1 - b0;
    const columns = Math.max(1, ...originalRows.slice(a0, a1).map(row => row.length), ...modifiedRows.slice(b0, b1).map(row => row.length));
    const work = height * width * columns;
    if (height && width && work <= replacementBudget && (height + 1) * (width + 1) <= comparisonLimits.replacementCells) {
      replacementBudget -= work;
      const stride = width + 1;
      const costs = new Float64Array((height + 1) * stride);
      const choices = new Uint8Array(height * width);
      for (let a = 0; a <= height; a++) { costs[a * stride + width] = height - a; }
      for (let b = 0; b <= width; b++) { costs[height * stride + b] = width - b; }
      for (let a = height - 1; a >= 0; a--) {
        for (let b = width - 1; b >= 0; b--) {
          const before = originalRows[a0 + a], after = modifiedRows[b0 + b];
          let equal = 0;
          for (let col = 0; col < Math.min(before.length, after.length); col++) {
            if (before[col] === after[col]) { equal++; }
          }
          // Shared fields favor pairing a modified record over an adjacent insertion/deletion.
          const replace = 2 * (1 - equal / Math.max(1, before.length, after.length)) + costs[(a + 1) * stride + b + 1];
          const remove = 1 + costs[(a + 1) * stride + b];
          const add = 1 + costs[a * stride + b + 1];
          const choice = replace <= remove && replace <= add ? 0 : remove <= add ? 1 : 2;
          choices[a * width + b] = choice;
          costs[a * stride + b] = choice === 0 ? replace : choice === 1 ? remove : add;
        }
      }
      let a = 0, b = 0;
      while (a < height || b < width) {
        const choice = a === height ? 2 : b === width ? 1 : choices[a * width + b];
        if (choice === 0) { append(a0 + a++, b0 + b++); }
        else if (choice === 1) { append(a0 + a++, undefined); }
        else { append(undefined, b0 + b++); }
      }
    } else {
      if (height && width) { result.approximate = true; }
      for (let index = 0; index < Math.max(height, width); index++) {
        append(a0 + index < a1 ? a0 + index : undefined, b0 + index < b1 ? b0 + index : undefined);
      }
    }
  };
  let a = 0, b = 0;
  for (const [nextA, nextB] of [...matches, [original.length, modified.length]]) {
    appendGap(a, nextA, b, nextB);
    if (nextA < original.length && nextB < modified.length) { append(nextA, nextB); }
    a = nextA + 1; b = nextB + 1;
  }
  return result;
}

export function comparisonPages(diff: CsvTableDiff): Array<{ start: number; end: number }> {
  const pages: Array<{ start: number; end: number }> = [];
  let start = 0, cells = 0, chars = 0;
  for (let index = 0; index < diff.records.length; index++) {
    const record = diff.records[index];
    const before = record.original === undefined ? [] : diff.originalRows[record.original];
    const after = record.modified === undefined ? [] : diff.modifiedRows[record.modified];
    const nextCells = Math.max(before.length, after.length) * 2 + 2;
    const nextChars = [...before, ...after].reduce((sum, value) => sum + value.length, 0);
    if (index > start && (index - start >= comparisonLimits.pageRows || cells + nextCells > comparisonLimits.pageCells || chars + nextChars > comparisonLimits.pageChars)) {
      pages.push({ start, end: index }); start = index; cells = 0; chars = 0;
    }
    cells += nextCells; chars += nextChars;
  }
  pages.push({ start, end: diff.records.length });
  return pages;
}
