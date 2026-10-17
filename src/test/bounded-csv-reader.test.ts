import assert from 'assert';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { describe, it } from 'node:test';
import Papa from 'papaparse';
import { previewLimits, PreviewHistory, readCsvPreviewPage } from '../bounded-csv-reader';

async function fixture(value: string | Buffer, run: (file: string) => Promise<void>) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'csv-bounded-'));
  const file = path.join(directory, 'source.csv');
  try {
    await fs.writeFile(file, value);
    await run(file);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

describe('Bounded CSV reader', () => {
  for (const delimiter of [',', '\t', '|']) {
    for (const readBytes of [1, 2, 3, 7, 64]) {
      it(`preserves UTF-8, CRLF and quoted boundaries with ${JSON.stringify(delimiter)} / ${readBytes}-byte reads`, async () => {
        const data = [['name', 'value'], ['éä😀', `inside${delimiter}field`], ['two\r\nlines', 'a"b'], ['\uFEFFintentional', 'end']];
        const source = '\uFEFF' + Papa.unparse(data, { delimiter, newline: '\r\n' }) + '\r\n';
        await fixture(source, async file => {
          const actual: string[][] = [];
          let offset = 0;
          let fileVersion: string | undefined;
          let done = false;
          while (!done) {
            const page = await readCsvPreviewPage(file, { delimiter, offset, readBytes, maxRows: 1, expectedVersion: fileVersion });
            actual.push(...page.rows);
            assert.ok(page.nextOffset > offset);
            offset = page.nextOffset;
            fileVersion = page.version;
            done = page.done;
          }
          assert.deepStrictEqual(actual, data);
          assert.strictEqual(offset, Buffer.byteLength(source));
        });
      });
    }
  }

  for (const source of ['', '\uFEFF', '\n', '\r\n', 'a,b\r', 'a,b\nc,d', 'a,b\n\n']) {
    it(`handles EOF and empty records in ${JSON.stringify(source)}`, async () => {
      await fixture(source, async file => {
        const page = await readCsvPreviewPage(file, { delimiter: ',', readBytes: 1 });
        const expected = source === '' || source === '\uFEFF' ? []
          : source === '\n' || source === '\r\n' ? [['']]
          : source === 'a,b\nc,d' ? [['a', 'b'], ['c', 'd']]
          : source === 'a,b\n\n' ? [['a', 'b'], ['']]
          : [['a', 'b']];
        assert.deepStrictEqual(page.rows, expected);
        assert.ok(page.done);
      });
    });
  }

  it('reads only a bounded prefix and never a whole large file', async () => {
    const source = 'alpha,beta\n'.repeat(200000);
    await fixture(source, async file => {
      const page = await readCsvPreviewPage(file, { delimiter: ',', maxRows: 1000 });
      assert.strictEqual(page.rows.length, 1000);
      assert.ok(!page.done);
      assert.ok(page.bytesRead <= previewLimits.readBytes + 3);
      assert.ok(page.bytesRead < Buffer.byteLength(source) / 10);
    });
  });

  it('caps source bytes and cells independently of the requested row count', async () => {
    const source = `${'x'.repeat(200000)}\n`.repeat(4);
    await fixture(source, async file => {
      const page = await readCsvPreviewPage(file, { delimiter: ',', maxRows: 10000 });
      assert.strictEqual(page.rows.length, 2);
      assert.strictEqual(page.nextOffset, 400002);
      assert.ok(page.bytesRead <= previewLimits.pageBytes + previewLimits.recordBytes + previewLimits.readBytes + 3);
    });
    await fixture(`${Array(1000).fill('x').join(',')}\n`.repeat(30), async file => {
      const page = await readCsvPreviewPage(file, { delimiter: ',', maxRows: 10000 });
      assert.strictEqual(page.rows.length, 20);
      assert.strictEqual(page.rows.flat().length, previewLimits.pageCells);
      assert.ok(!page.done);
    });
  });

  for (const [source, error] of [
    ['a,"unfinished\n', /Unterminated quoted record/],
    ['a,"closed"junk\n', /Malformed quoted field/],
    ['x'.repeat(previewLimits.recordBytes + 1), /No partial record was displayed/],
    [Array(1001).fill('x').join(','), /No fields were truncated/]
  ] as const) {
    it(`rejects malformed/oversized input visibly (${error.source})`, async () => {
      await fixture(source, file => assert.rejects(readCsvPreviewPage(file, { delimiter: ',' }), error));
    });
  }

  it('rejects non-UTF8, UTF16 BOMs, NULs and unsupported separators without guessing', async () => {
    for (const bytes of [Buffer.from([0x84, 10]), Buffer.from([0xFF, 0xFE, 97, 0]), Buffer.from('a\0b')]) {
      await fixture(bytes, file => assert.rejects(readCsvPreviewPage(file, { delimiter: ',' }), /UTF-8/));
    }
    await fixture('a,b', file => assert.rejects(readCsvPreviewPage(file, { delimiter: '||' }), /single ASCII separator/));
  });

  it('detects source changes between pages', async () => {
    await fixture('a,b\n1,2\n', async file => {
      const first = await readCsvPreviewPage(file, { delimiter: ',', maxRows: 1 });
      await fs.appendFile(file, '3,4\n');
      await assert.rejects(readCsvPreviewPage(file, { delimiter: ',', offset: first.nextOffset, expectedVersion: first.version }), /file changed/);
    });
  });

  it('closes the file descriptor after success, cancellation and malformed records', async () => {
    const originalOpen = fs.open;
    const handles: Array<{ closed: number }> = [];
    (fs as any).open = async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      const state = { closed: 0 };
      handles.push(state);
      return new Proxy(handle, {
        get(target, key) {
          if (key === 'close') {
            return async () => { state.closed++; await target.close(); };
          }
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        }
      });
    };
    try {
      await fixture('a,b\n1,2\n', async file => {
        await readCsvPreviewPage(file, { delimiter: ',' });
        let checks = 0;
        await assert.rejects(readCsvPreviewPage(file, { delimiter: ',', readBytes: 1, cancelled: () => ++checks > 2 }), /cancelled/);
      });
      await fixture('"unfinished', file => assert.rejects(readCsvPreviewPage(file, { delimiter: ',' }), /Unterminated/));
      assert.deepStrictEqual(handles.map(handle => handle.closed), [1, 1, 1]);
    } finally {
      fs.open = originalOpen;
    }
  });

  it('retains only a bounded navigation history', () => {
    const history = new PreviewHistory();
    for (let index = 1; index < 1000; index++) {
      history.next({ offset: index * 100, record: index });
    }
    assert.strictEqual(history.size, previewLimits.history);
    let previous = 0;
    while (history.canGoBack) { history.previous(); previous++; }
    assert.strictEqual(previous, previewLimits.history - 1);
    history.reset();
    assert.deepStrictEqual(history.current, { offset: 0, record: 0 });
    assert.strictEqual(history.size, 1);
  });
});
