import { promises as fs } from 'fs';
import { TextDecoder } from 'util';
import Papa from 'papaparse';

export const previewLimits = {
  readBytes: 64 * 1024,
  pageBytes: 512 * 1024,
  recordBytes: 256 * 1024,
  pageCells: 20000,
  columns: 1000,
  history: 32
};

export type CsvPreviewPage = {
  rows: string[][];
  offset: number;
  nextOffset: number;
  done: boolean;
  version: string;
  bytesRead: number;
};

export type CsvPreviewReadOptions = {
  delimiter: string;
  offset?: number;
  maxRows?: number;
  expectedVersion?: string;
  cancelled?: () => boolean;
  // Smaller read buffers make boundary handling deterministic in unit tests.
  readBytes?: number;
};

function version(stat: { dev: number; ino: number; size: number; mtimeMs: number }): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
}

export async function readCsvPreviewPage(filePath: string, options: CsvPreviewReadOptions): Promise<CsvPreviewPage> {
  if (options.delimiter.length !== 1 || options.delimiter.charCodeAt(0) > 127 || /[\r\n"\0]/.test(options.delimiter)) {
    throw new Error('Large File Preview requires a single ASCII separator. Set a separator override or use the editable CSV view.');
  }
  const checkCancelled = () => {
    if (options.cancelled?.()) {
      throw new Error('Large File Preview was cancelled.');
    }
  };
  checkCancelled();
  const handle = await fs.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error('Large File Preview can only read regular files.');
    }
    const fileVersion = version(stat);
    if (options.expectedVersion && options.expectedVersion !== fileVersion) {
      throw new Error('The file changed. Choose Back to Start to reload it.');
    }
    const offset = options.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > stat.size) {
      throw new Error('Invalid preview position. Choose Back to Start.');
    }
    const requestedRows = Math.trunc(Number(options.maxRows ?? 1000));
    const maxRows = Number.isFinite(requestedRows) ? Math.min(10000, Math.max(1, requestedRows)) : 1000;
    const readSize = Math.min(previewLimits.readBytes, Math.max(1, Math.trunc(options.readBytes ?? previewLimits.readBytes)));
    const readBuffer = Buffer.alloc(readSize);
    const recordBuffer = Buffer.alloc(previewLimits.recordBytes);
    const rows: string[][] = [];
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    const delimiter = options.delimiter.charCodeAt(0);
    let position = offset;
    let recordStart = offset;
    let recordLength = 0;
    let recordFields = 1;
    let usedBytes = 0;
    let usedCells = 0;
    let bytesRead = 0;
    let state: 'start' | 'plain' | 'quoted' | 'closed' = 'start';
    let pendingCr = false;
    let stopped = false;
    let nextOffset = offset;

    if (offset === 0) {
      const signature = Buffer.alloc(3);
      const first = await handle.read(signature, 0, 3, 0);
      bytesRead += first.bytesRead;
      if ((signature[0] === 0xFF && signature[1] === 0xFE) || (signature[0] === 0xFE && signature[1] === 0xFF)) {
        throw new Error('Large File Preview supports UTF-8 files only. Use the normal editor and Reopen with Encoding for this file.');
      }
      if (first.bytesRead === 3 && signature.equals(Buffer.from([0xEF, 0xBB, 0xBF]))) {
        position = recordStart = 3;
      }
    }

    const finishRecord = (end: number, terminatorBytes: number) => {
      if (usedBytes + recordLength > previewLimits.pageBytes && rows.length > 0) {
        stopped = true;
        nextOffset = recordStart;
        return;
      }
      let text: string;
      try {
        text = decoder.decode(recordBuffer.subarray(0, recordLength - terminatorBytes));
      } catch {
        throw new Error('Large File Preview supports valid UTF-8 only. Reopen the original file with its source encoding in the normal editor.');
      }
      if (text.includes('\0')) {
        throw new Error('The file contains NUL bytes. Large File Preview supports UTF-8 text files only.');
      }
      // Prefix an empty field so Papa does not strip an intentional U+FEFF at
      // the start of a later record when parsing records independently.
      const parsed = Papa.parse<string[]>(`${options.delimiter}${text}`, { delimiter: options.delimiter, dynamicTyping: false });
      if (parsed.errors.some(error => error.type === 'Quotes') || parsed.data.length !== 1) {
        throw new Error(`Malformed CSV record at byte ${recordStart}. No partial record was displayed.`);
      }
      const row = parsed.data[0].slice(1);
      if (row.length > previewLimits.columns) {
        throw new Error(`A record exceeds the ${previewLimits.columns}-column preview limit. No fields were truncated.`);
      }
      if (usedCells + row.length > previewLimits.pageCells && rows.length > 0) {
        stopped = true;
        nextOffset = recordStart;
        return;
      }
      rows.push(row);
      usedBytes += recordLength;
      usedCells += row.length;
      nextOffset = recordStart = end;
      recordLength = 0;
      recordFields = 1;
      state = 'start';
      pendingCr = false;
      stopped = rows.length >= maxRows || usedBytes >= previewLimits.pageBytes || usedCells >= previewLimits.pageCells;
    };

    while (!stopped && position < stat.size) {
      checkCancelled();
      const read = await handle.read(readBuffer, 0, readBuffer.length, position);
      bytesRead += read.bytesRead;
      if (read.bytesRead === 0) {
        break;
      }
      for (let index = 0; index < read.bytesRead && !stopped; index++) {
        const byte = readBuffer[index];
        if (pendingCr && byte !== 10) {
          finishRecord(position, 1);
          if (stopped) {
            break;
          }
        }
        if (recordLength >= recordBuffer.length) {
          throw new Error(`A record exceeds the ${previewLimits.recordBytes / 1024} KiB preview limit. No partial record was displayed.`);
        }
        recordBuffer[recordLength++] = byte;
        position++;
        if (pendingCr) {
          finishRecord(position, 2);
        } else if (state === 'quoted') {
          if (byte === 34) {
            state = 'closed';
          }
        } else if (state === 'closed' && byte === 34) {
          state = 'quoted';
        } else if (byte === 13) {
          pendingCr = true;
        } else if (byte === 10) {
          finishRecord(position, 1);
        } else if (byte === delimiter) {
          recordFields++;
          if (recordFields > previewLimits.columns) {
            throw new Error(`A record exceeds the ${previewLimits.columns}-column preview limit. No fields were truncated.`);
          }
          state = 'start';
        } else if (state === 'start' && byte === 34) {
          state = 'quoted';
        } else if (state === 'closed') {
          if (byte !== 32 && byte !== 9) {
            throw new Error(`Malformed quoted field at byte ${position - 1}. No partial record was displayed.`);
          }
        } else {
          state = 'plain';
        }
      }
    }
    if (!stopped && recordLength > 0) {
      if (state === 'quoted') {
        throw new Error(`Unterminated quoted record at byte ${recordStart}. No partial record was displayed.`);
      }
      finishRecord(position, pendingCr ? 1 : 0);
    }
    if (rows.length === 0) {
      nextOffset = position;
    }
    checkCancelled();
    if (version(await fs.stat(filePath)) !== fileVersion || version(await handle.stat()) !== fileVersion) {
      throw new Error('The file changed while reading. Choose Back to Start to reload it.');
    }
    return { rows, offset, nextOffset, done: nextOffset >= stat.size, version: fileVersion, bytesRead };
  } finally {
    await handle.close();
  }
}

export type PreviewPosition = { offset: number; record: number };

export class PreviewHistory {
  private positions: PreviewPosition[] = [{ offset: 0, record: 0 }];
  private index = 0;
  get current(): PreviewPosition { return this.positions[this.index]; }
  get canGoBack(): boolean { return this.index > 0; }
  get size(): number { return this.positions.length; }
  reset(): void { this.positions = [{ offset: 0, record: 0 }]; this.index = 0; }
  previous(): void { if (this.canGoBack) { this.index--; } }
  next(position: PreviewPosition): void {
    this.positions.splice(this.index + 1);
    this.positions.push(position);
    if (this.positions.length > previewLimits.history) {
      this.positions.shift();
    }
    this.index = this.positions.length - 1;
  }
}
