import assert from 'assert';
import { describe, it } from 'node:test';
import Papa from 'papaparse';
import { createEditorHarness } from './edit-integrity-harness';

describe('Structural edits preserve CSV source conventions', () => {
  it('appends a pasted row using the body column quote convention without rewriting prior rows', async () => {
    const text = 'id,label,note\r\n1,"alpha",""\r\n2,"beta",""\r\n';
    const host = await createEditorHarness({ text });
    await host.receive({ type: 'pasteCells', text: '3,gamma,plain', anchorRow: 3, anchorCol: 0 });
    assert.strictEqual(host.document.getText(), `${text}3,"gamma","plain"\r\n`);
  });

  it('extends a row with pasted columns while keeping untouched tokens and CRLF records', async () => {
    const text = 'a,"b"\r\n"left","right"\r\nend,last';
    const host = await createEditorHarness({ text });
    await host.receive({ type: 'pasteCells', text: 'extra', anchorRow: 1, anchorCol: 2 });
    assert.strictEqual(host.document.getText(), 'a,"b"\r\n"left","right",extra\r\nend,last');
  });

  it('moves raw column fields including explicitly quoted and unquoted empty fields', async () => {
    const host = await createEditorHarness({ text: '"id",name,"tail"\r\n"1","alpha",""\r\n"2",beta,\r\n' });
    await host.receive({ type: 'reorderColumns', indices: [1], beforeIndex: 0 });
    assert.strictEqual(host.document.getText(), 'name,"id","tail"\r\n"alpha","1",""\r\nbeta,"2",\r\n');
  });

  it('moves rows without normalizing their raw quoting', async () => {
    const host = await createEditorHarness({ text: 'h,v\n"1",a\n2,"b"\n' });
    await host.receive({ type: 'reorderRows', indices: [2], beforeIndex: 1 });
    assert.strictEqual(host.document.getText(), 'h,v\n2,"b"\n"1",a\n');
  });

  it('preserves a UTF-8 BOM when editing a quoted first field or appending data', async () => {
    const host = await createEditorHarness({ text: '\uFEFF"a",b\n"one",two\n' });
    await host.receive({ type: 'editCell', row: 0, col: 0, value: 'header' });
    assert.strictEqual(host.document.getText(), '\uFEFF"header",b\n"one",two\n');
    await host.receive({ type: 'pasteCells', text: 'next,last', anchorRow: 2, anchorCol: 0 });
    assert.strictEqual(host.document.getText(), '\uFEFF"header",b\n"one",two\n"next",last\n');
  });

  it('keeps trailing empty source records and escaped multiline values', async () => {
    const text = 'id,"text"\n1,"line 1\nline ""2"""\n\n';
    const host = await createEditorHarness({ text });
    await host.receive({ type: 'pasteCells', text: '2,"another\nline"', anchorRow: 2, anchorCol: 0 });
    assert.strictEqual(host.document.getText(), 'id,"text"\n1,"line 1\nline ""2"""\n2,"another\nline"\n');
  });

  it('appends a typed value in the virtual row without normalizing prior fields', async () => {
    const text = 'id,"text"\n1,"alpha"\n';
    const host = await createEditorHarness({ text });
    await host.receive({ type: 'editCell', row: 2, col: 0, value: '2' });
    assert.strictEqual(host.document.getText(), `${text}2`);
  });

  it('fills an existing empty record once instead of duplicating it after the paste', async () => {
    const host = await createEditorHarness({ text: 'id,"text"\n1,"alpha"\n,' });
    await host.receive({ type: 'pasteCells', text: '2,beta', anchorRow: 2, anchorCol: 0 });
    assert.deepStrictEqual(host.rows(), [['id', 'text'], ['1', 'alpha'], ['2', 'beta']]);
    assert.ok(host.document.getText().startsWith('id,"text"\n1,"alpha"\n'));
  });

  for (const separator of [',', '\t']) {
    it(`round-trips ragged rows with delimiters, quotes and newlines after reordering (${JSON.stringify(separator)})`, async () => {
      const data = [['id', 'text', 'last'], ['1', `inside${separator}value`, ''], ['2', 'two\nlines', 'tail'], ['3', '"quoted"']];
      const text = Papa.unparse(data, { delimiter: separator, quotes: true, newline: '\n' });
      const host = await createEditorHarness({ text, separator });
      await host.receive({ type: 'reorderColumns', indices: [2], beforeIndex: 0 });
      assert.deepStrictEqual(host.rows(), [['last', 'id', 'text'], ['', '1', `inside${separator}value`], ['tail', '2', 'two\nlines'], ['', '3', '"quoted"']]);
      assert.ok(host.document.getText().includes(`"tail"${separator}"2"${separator}"two\nlines"`));
    });
  }
});
