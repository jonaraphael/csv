import assert from 'assert';
import { describe, it } from 'node:test';
import { createEditorHarness, createWebviewDom } from './edit-integrity-harness';

describe('Multiline editing preserves text', () => {
  for (const separator of [',', '\t']) {
    for (const header of [true, false]) {
      it(`keeps repeated Shift+Enter lines on blur (${JSON.stringify(separator)}, header ${header})`, async () => {
        const host = await createEditorHarness({ separator, header });
        const view = createWebviewDom(host.panel.webview.html);
        try {
          const cell = view.cell();
          view.start(cell);
          for (const line of ['second', 'third', 'fourth']) {
            view.key('Enter', { shiftKey: true });
            view.type(line);
          }
          cell.blur();
          const edit = view.messages.find(message => message.type === 'editCell');
          assert.strictEqual(edit.value, 'one\nsecond\nthird\nfourth');
          assert.strictEqual(cell.querySelector('[data-csv-newline-sentinel]'), null);
          await host.receive(edit);
          assert.deepStrictEqual(host.rows(), [['name', 'value'], ['one\nsecond\nthird\nfourth', 'two']]);
        } finally {
          view.close();
        }
      });
    }
  }

  it('inserts exactly one break in the middle and at the end after reopening an edit', async () => {
    const host = await createEditorHarness({ rows: [['name'], ['first\nlast']] });
    const view = createWebviewDom(host.panel.webview.html);
    try {
      const cell = view.cell();
      view.start(cell);
      view.caret(cell.firstChild, 5);
      view.key('Enter', { shiftKey: true });
      cell.blur();
      view.start(cell);
      view.key('Enter', { shiftKey: true });
      view.type('final');
      cell.blur();
      assert.strictEqual(view.messages.filter(message => message.type === 'editCell').at(-1)?.value, 'first\n\nlast\nfinal');
    } finally {
      view.close();
    }
  });

  it('starts Shift+Enter from selection without a delayed caret moving after the placeholder', async () => {
    const host = await createEditorHarness();
    const view = createWebviewDom(host.panel.webview.html);
    try {
      const cell = view.cell();
      view.window.editingTestApi.setSingleSelection(cell);
      view.key('Enter', { shiftKey: true });
      await new Promise(resolve => setTimeout(resolve, 20));
      const selection = view.window.getSelection();
      assert.strictEqual(selection.anchorNode, cell);
      assert.strictEqual(cell.childNodes[selection.anchorOffset].nodeName, 'BR');
      view.type('second');
      cell.blur();
      assert.strictEqual(view.messages.find(message => message.type === 'editCell').value, 'one\nsecond');
    } finally {
      view.close();
    }
  });

  it('commits the full multiline value before a save message', async () => {
    const host = await createEditorHarness();
    const view = createWebviewDom(host.panel.webview.html);
    try {
      view.start(view.cell());
      view.key('Enter', { shiftKey: true });
      view.type('second');
      view.key('s', { ctrlKey: true });
      const operations = view.messages.filter(message => message.type === 'editCell' || message.type === 'save');
      assert.deepStrictEqual(operations.map(message => message.type), ['editCell', 'save']);
      await Promise.all(operations.map(message => host.receive(message)));
      assert.strictEqual(host.diskText, host.document.getText());
      assert.strictEqual(host.rows()[1][0], 'one\nsecond');
    } finally {
      view.close();
    }
  });

  it('does not replace an active edit with an earlier update acknowledgment', async () => {
    const host = await createEditorHarness();
    const view = createWebviewDom(host.panel.webview.html);
    try {
      const cell = view.cell();
      view.start(cell);
      view.type(' changed');
      view.window.dispatchEvent(new view.window.MessageEvent('message', { data: {
        type: 'updateCell', row: 1, col: 0, value: 'old', rendered: 'old'
      } }));
      cell.blur();
      assert.strictEqual(view.messages.find(message => message.type === 'editCell').value, 'one changed');
    } finally {
      view.close();
    }
  });

  for (const leave of ['window blur', 'hidden document']) {
    it(`commits an active multiline edit on ${leave}`, async () => {
      const host = await createEditorHarness();
      const view = createWebviewDom(host.panel.webview.html);
      try {
        view.start(view.cell());
        view.key('Enter', { shiftKey: true });
        view.type('second');
        if (leave === 'window blur') {
          view.window.dispatchEvent(new view.window.Event('blur'));
        } else {
          Object.defineProperty(view.window.document, 'visibilityState', { value: 'hidden' });
          view.window.document.dispatchEvent(new view.window.Event('visibilitychange'));
        }
        assert.strictEqual(view.messages.find(message => message.type === 'editCell').value, 'one\nsecond');
      } finally {
        view.close();
      }
    });
  }

  it('restores the original multiline value when cancelling an edit', async () => {
    const host = await createEditorHarness({ rows: [['name'], ['first\nlast']] });
    const view = createWebviewDom(host.panel.webview.html);
    try {
      view.start(view.cell());
      view.type(' changed');
      view.key('Escape');
      assert.strictEqual(view.messages.find(message => message.type === 'editCell').value, 'first\nlast');
    } finally {
      view.close();
    }
  });
});

describe('Document operations use current unsaved contents', () => {
  it('native Save waits for a pending blur edit', async () => {
    const host = await createEditorHarness();
    host.deferEdits();
    const edit = host.receive({ type: 'editCell', row: 1, col: 0, value: 'one\nsecond' });
    await new Promise(resolve => setImmediate(resolve));
    const save = host.document.save();
    host.releaseEdit();
    await Promise.all([edit, save]);
    assert.ok(host.diskText.includes('second'));
  });

  it('waits for a pending edit before saving and applying the next edit', async () => {
    const host = await createEditorHarness();
    host.deferEdits();
    const edit = host.receive({ type: 'editCell', row: 1, col: 0, value: 'one\nsecond' });
    const save = host.receive({ type: 'save' });
    const nextEdit = host.receive({ type: 'editCell', row: 1, col: 1, value: 'next' });
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(host.pendingEdits, 1);
    assert.ok(!host.diskText.includes('second'));
    host.releaseEdit();
    await edit;
    await save;
    assert.ok(host.diskText.includes('second'));
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(host.pendingEdits, 1);
    host.releaseEdit();
    await nextEdit;
    assert.deepStrictEqual(host.rows(), [['name', 'value'], ['one\nsecond', 'next']]);
  });

  for (const separator of [',', '\t']) {
    for (const header of [true, false]) {
      it(`inserts rows after a pending multiline edit (${JSON.stringify(separator)}, header ${header})`, async () => {
        const host = await createEditorHarness({ separator, header });
        const edit = host.receive({ type: 'editCell', row: 1, col: 0, value: 'one\nsecond' });
        const insert = host.receive({ type: 'insertRow', index: 2 });
        const fill = host.receive({ type: 'editCell', row: 2, col: 0, value: 'new' });
        await Promise.all([edit, insert, fill]);
        assert.deepStrictEqual(host.rows(), [['name', 'value'], ['one\nsecond', 'two'], ['new', '']]);
      });
    }
  }

  it('rebuilds a hidden remote webview from dirty contents and supplies current later chunks', async () => {
    const rows = [['name', 'value'], ...Array.from({ length: 1100 }, (_, index) => [`row-${index}`, 'old'])];
    const host = await createEditorHarness({ rows, remote: true });
    const originalHtml = host.panel.webview.html;
    await host.receive({ type: 'editCell', row: 1, col: 0, value: 'unsaved-first' });
    await host.receive({ type: 'editCell', row: 1050, col: 1, value: 'unsaved-later' });
    assert.strictEqual(host.panel.webview.html, originalHtml);
    await host.view(false, false);
    await host.view(true, true);
    assert.ok(host.panel.webview.html.includes('unsaved-first'));
    assert.ok(!host.diskText.includes('unsaved'));
    await host.receive({ type: 'requestChunk', start: 1001, requestId: 1 });
    assert.ok(host.messages.find(message => message.type === 'chunkData').html.includes('unsaved-later'));
  });

  it('keeps one virtual row and ignores an empty edit on it after multiline editing', async () => {
    const host = await createEditorHarness();
    await host.receive({ type: 'editCell', row: 1, col: 0, value: 'one\nsecond' });
    await host.receive({ type: 'editCell', row: 2, col: 0, value: '' });
    await host.view(false, false);
    await host.view(true, true);
    assert.deepStrictEqual(host.rows(), [['name', 'value'], ['one\nsecond', 'two']]);
    const view = createWebviewDom(host.panel.webview.html);
    try {
      const dataRows = view.window.document.querySelectorAll('tbody tr');
      assert.strictEqual(dataRows.length, 2);
      assert.strictEqual(view.cell(2, 0).textContent, '');
      assert.strictEqual(view.cell(3, 0), null);
    } finally {
      view.close();
    }
  });
});
