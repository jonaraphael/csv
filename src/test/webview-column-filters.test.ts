import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createEditorHarness, createWebviewDom } from './edit-integrity-harness';

const wait = () => new Promise(resolve => setTimeout(resolve, 130));
const rows = [['Name', 'Score'], ['alpha', '10'], ['beta', '20'], ['alphabet', '30']];
const fixture = async (options: Parameters<typeof createEditorHarness>[0] = {}) => {
  const host = await createEditorHarness({ rows, ...options });
  const view = createWebviewDom(host.panel.webview.html);
  await new Promise(resolve => setTimeout(resolve, 20));
  const document = view.window.document;
  const conditions = () => Array.from(document.querySelectorAll('.column-filter-row')) as any[];
  const input = (row = 0) => conditions()[row].querySelector('[data-filter-value]') as any;
  const change = (element: any, value: string, event = 'input') => {
    element.value = value;
    element.dispatchEvent(new view.window.Event(event, { bubbles: true }));
  };
  const add = (column = 0) => {
    const cell = view.cell(1, column);
    cell.dispatchEvent(new view.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 100, clientY: 40 }));
    const action = Array.from(document.querySelectorAll('#contextMenu div')).find((item: any) => item.textContent === 'Filter this column…') as any;
    assert.ok(action);
    action.click();
    return input(conditions().length - 1);
  };
  let cursor = 0;
  const submit = async () => {
    await wait();
    const pending = view.messages.slice(cursor);
    cursor = view.messages.length;
    for (const message of pending) {
      if (['editCell', 'updateColumnFilters', 'findMatches', 'filterDraftChanged'].includes(message.type)) {
        await host.receive(message);
      }
    }
    const request = pending.filter(message => message.type === 'updateColumnFilters').slice(-1)[0];
    assert.ok(request, 'the inline controls submit one latest full snapshot');
    const result = host.messages.filter(message => message.type === 'columnFiltersResult' && message.revision === request.revision).slice(-1)[0];
    assert.ok(result, 'the host replies to the live snapshot');
    return { request, result };
  };
  const deliver = (result: any) => view.window.dispatchEvent(new view.window.MessageEvent('message', { data: result }));
  const apply = async () => { const sent = await submit(); deliver(sent.result); return sent; };
  return { host, view, document, conditions, input, change, add, submit, deliver, apply };
};

// These execute the shipped module and main script against the real provider.
describe('Inline column filters', () => {
  it('puts filtering before clipboard actions and adds independent same-column AND conditions', async () => {
    const f = await fixture();
    try {
      const first = f.add();
      const menu = f.document.querySelector('#contextMenu');
      assert.strictEqual(menu.firstElementChild.textContent, 'Filter this column…');
      f.change(first, 'alpha');
      await f.apply();
      const second = f.add();
      f.change(second, 'bet');
      const { request } = await f.apply();
      assert.strictEqual(request.filters.length, 2);
      assert.deepStrictEqual(Array.from(request.filters, (filter: any) => filter.column), [0, 0]);
      assert.ok(f.conditions()[1].textContent.includes('AND'));
      assert.ok(f.view.cell(3, 0));
      assert.strictEqual(f.view.cell(1, 0), null);
      assert.strictEqual(f.view.cell(2, 0), null);
      assert.strictEqual(f.host.quickPickCalls.length, 0);
      assert.strictEqual(f.host.inputBoxCalls.length, 0);
      assert.strictEqual(f.host.document.getText(), f.host.diskText);
    } finally { f.view.close(); }
  });

  it('keeps input identity, focus, selection and literal spaces through live results; blank drafts expand the table', async () => {
    const f = await fixture();
    try {
      const input = f.add();
      f.change(input, 'alpha');
      input.setSelectionRange(2, 4);
      const table = f.document.querySelector('table');
      await f.apply();
      assert.strictEqual(f.document.querySelector('table'), table);
      assert.strictEqual(f.input(), input);
      assert.strictEqual(f.document.activeElement, input);
      assert.deepStrictEqual([input.selectionStart, input.selectionEnd], [2, 4]);
      f.change(input, ' ');
      const spaced = await f.apply();
      assert.strictEqual(spaced.request.filters[0].value, ' ');
      f.change(input, '');
      const cleared = await f.apply();
      assert.strictEqual(cleared.request.filters.length, 0);
      assert.strictEqual(f.conditions().length, 1, 'empty draft stays editable');
      assert.ok(f.view.cell(1, 0));
      assert.ok(f.view.cell(2, 0));
      assert.ok(f.view.cell(3, 0));
      assert.strictEqual(table.getAttribute('aria-busy'), 'false');
    } finally { f.view.close(); }
  });

  it('ignores replies immediately after typing and aligns last-valid epoch on the latest invalid query', async () => {
    const f = await fixture();
    try {
      const input = f.add();
      f.change(input, 'alpha');
      const first = await f.submit();
      const operator = f.conditions()[0].querySelector('[data-filter-operator]');
      f.change(operator, 'regex', 'change');
      f.change(input, '(');
      f.deliver(first.result);
      assert.ok(f.view.cell(2, 0), 'stale success cannot repaint during a newer debounce');
      const invalid = await f.submit();
      assert.ok(invalid.result.errors.length);
      f.deliver(invalid.result);
      assert.strictEqual(f.input(), input);
      assert.strictEqual(input.value, '(');
      assert.strictEqual(input.getAttribute('aria-invalid'), 'true');
      assert.ok(f.conditions()[0].querySelector('.column-filter-error').textContent);
      assert.ok(f.document.querySelector('[data-filter-error]').textContent.includes('Showing the last valid results.'));
      assert.strictEqual(f.view.cell(2, 0), null, 'latest error aligns the last valid table accepted by the host');
      assert.ok(f.view.cell(1, 0));
      assert.strictEqual(f.document.querySelector('table').getAttribute('aria-busy'), 'false');
      f.change(input, 'beta');
      const valid = await f.submit();
      f.deliver(invalid.result);
      assert.strictEqual(input.getAttribute('aria-invalid'), null, 'stale errors cannot attach to new text');
      f.deliver(valid.result);
      assert.ok(f.view.cell(2, 0));
      assert.strictEqual(f.view.cell(1, 0), null);
    } finally { f.view.close(); }
  });

  it('does not submit partial IME composition or replace the composing input with older results', async () => {
    const f = await fixture();
    try {
      const input = f.add();
      const beforeTyping = f.view.messages.length;
      f.change(input, 'a');
      const immediate = f.view.messages.slice(beforeTyping);
      assert.strictEqual(immediate[0]?.type, 'filterDraftChanged', 'typing reports activity synchronously before debounce');
      assert.strictEqual(typeof immediate[0]?.session, 'string');
      assert.strictEqual(immediate.some(message => message.type === 'updateColumnFilters'), false);
      const first = await f.submit();
      const beforeComposition = f.view.messages.length;
      input.dispatchEvent(new f.view.window.CompositionEvent('compositionstart', { bubbles: true }));
      assert.strictEqual(f.view.messages[beforeComposition]?.type, 'filterDraftChanged', 'composition start reports activity immediately');
      f.change(input, 'アルファ');
      assert.strictEqual(f.view.messages[beforeComposition + 1]?.type, 'filterDraftChanged', 'each composing input reports its own activity');
      const count = f.view.messages.filter(message => message.type === 'updateColumnFilters').length;
      await wait();
      assert.strictEqual(f.view.messages.filter(message => message.type === 'updateColumnFilters').length, count);
      f.deliver(first.result);
      assert.strictEqual(f.input(), input);
      assert.strictEqual(input.value, 'アルファ');
      assert.ok(f.view.cell(2, 0));
      input.dispatchEvent(new f.view.window.CompositionEvent('compositionend', { bubbles: true }));
      const complete = await f.apply();
      assert.strictEqual(complete.request.filters[0].value, 'アルファ');
      assert.strictEqual(f.document.activeElement, input);
    } finally { f.view.close(); }
  });

  it('keeps filter keyboard and clipboard events native, including Escape, and blocks grid mutations while pending', async () => {
    const f = await fixture();
    try {
      const selected = f.view.cell(1, 0);
      f.view.window.editingTestApi.setSingleSelection(selected);
      const input = f.add();
      await f.apply();
      const selection = Array.from(f.document.querySelectorAll('td.selected, th.selected'));
      for (const key of ['ArrowDown', 'Escape', 'a', 'c', 'x', 'v', 'f', '+']) {
        const event = new f.view.window.KeyboardEvent('keydown', { key, metaKey: key.length === 1, bubbles: true, cancelable: true });
        input.dispatchEvent(event);
        assert.strictEqual(event.defaultPrevented, false, `${key} stays native in a filter input`);
      }
      for (const type of ['copy', 'cut', 'paste']) {
        const event = new f.view.window.Event(type, { bubbles: true, cancelable: true });
        input.dispatchEvent(event);
        assert.strictEqual(event.defaultPrevented, false);
      }
      assert.deepStrictEqual(Array.from(f.document.querySelectorAll('td.selected, th.selected')), selection);
      const staleDelete = Array.from(f.document.querySelectorAll('#contextMenu div')).find((item: any) => item.textContent === 'Delete ROW') as any;
      f.change(input, 'alpha');
      const deletes = f.view.messages.filter(message => message.type === 'deleteRow').length;
      staleDelete.click();
      assert.strictEqual(f.view.messages.filter(message => message.type === 'deleteRow').length, deletes, 'stale menu callbacks cannot bypass the pending table gate');
      f.deliver({ type: 'pasteApplied', startRow: 1, startCol: 0, endRow: 1, endCol: 0 });
      f.deliver({ type: 'focus' });
      assert.strictEqual(f.document.activeElement, input, 'late grid messages cannot steal filter focus');
      const cell = f.view.cell(1, 0);
      const click = new f.view.window.MouseEvent('dblclick', { bubbles: true, cancelable: true });
      cell.dispatchEvent(click);
      assert.strictEqual(click.defaultPrevented, true);
      assert.strictEqual(cell.hasAttribute('contenteditable'), false);
      const cut = new f.view.window.Event('cut', { bubbles: true, cancelable: true });
      cell.dispatchEvent(cut);
      assert.strictEqual(cut.defaultPrevented, true);
      await f.apply();
    } finally { f.view.close(); }
  });

  it('commits an unposted live edit before submitting the first filter snapshot', async () => {
    const f = await fixture();
    try {
      const input = f.add();
      await f.apply();
      const cell = f.view.cell(1, 0);
      f.view.start(cell);
      cell.textContent = 'changed alpha';
      f.change(input, 'changed');
      const { request } = await f.apply();
      const editIndex = f.view.messages.findIndex(message => message.type === 'editCell');
      const filterIndex = f.view.messages.findIndex(message => message === request);
      assert.ok(editIndex >= 0 && editIndex < filterIndex);
      assert.strictEqual(f.host.rows()[1][0], 'changed alpha');
      assert.strictEqual(f.view.cell(1, 0).textContent, 'changed alpha');
      assert.strictEqual(f.view.cell(2, 0), null);
    } finally { f.view.close(); }
  });

  it('switches operators/types inline, keeps unary conditions active, and removes conditions independently', async () => {
    const f = await fixture();
    try {
      f.add(1);
      const row = f.conditions()[0];
      const operator = row.querySelector('[data-filter-operator]');
      assert.ok(Array.from(operator.options).some((option: any) => option.value === 'greaterThan'));
      f.change(operator, 'greaterThan', 'change');
      f.change(f.input(), '15');
      const numeric = await f.apply();
      assert.strictEqual(numeric.request.filters[0].dataType, 'number');
      assert.strictEqual(f.view.cell(1, 0), null);
      f.document.querySelector('#addColumnFilter').click();
      const second = f.conditions()[1];
      f.change(second.querySelector('[data-filter-column]'), '0', 'change');
      f.change(second.querySelector('[data-filter-operator]'), 'notEmpty', 'change');
      const unary = await f.apply();
      assert.strictEqual(unary.request.filters.length, 2);
      assert.strictEqual(second.querySelector('[data-filter-value]').hidden, true);
      row.querySelector('[data-remove-filter]').click();
      const removed = await f.apply();
      assert.strictEqual(removed.request.filters.length, 1);
      assert.strictEqual(removed.request.filters[0].operator, 'notEmpty');
      f.document.querySelector('#clearAllFilters').click();
      await f.apply();
      assert.strictEqual(f.conditions().length, 0);
      assert.strictEqual(f.document.querySelector('#filterStatus').hidden, true);
    } finally { f.view.close(); }
  });

  it('rejects stale remote chunks after filters change and can load new chunks after an initially unchunked view', async () => {
    const f = await fixture({ remote: true });
    try {
      const input = f.add();
      f.change(input, 'alpha');
      const current = await f.submit();
      const response = { ...current.result, chunksJson: '[]', nextChunkStart: 2, hasRemoteChunks: true };
      f.deliver(response);
      const before = f.document.querySelector('tbody').innerHTML;
      f.deliver({ type: 'chunkData', session: current.result.session, filterEpoch: 0, requestId: 1, start: 0, html: '<tr><td data-row="777" data-col="0">old</td></tr>', done: true });
      assert.strictEqual(f.document.querySelector('tbody').innerHTML, before);
      f.view.window.__csvLoadNextChunk();
      const request = f.view.messages.filter(message => message.type === 'requestChunk').slice(-1)[0];
      assert.strictEqual(request.filterEpoch, current.result.filterEpoch);
      f.deliver({ type: 'chunkData', session: current.result.session, filterEpoch: current.result.filterEpoch, requestId: request.requestId, start: 2, html: '<tr><td data-row="888" data-col="0">new</td></tr>', done: true });
      f.view.window.__csvLoadNextChunk();
      assert.ok(f.view.cell(888, 0));
      assert.strictEqual(f.view.cell(777, 0), null);
    } finally { f.view.close(); }
  });

  it('handles more source row IDs than the JavaScript argument limit and rejects another session', async () => {
    const f = await fixture();
    try {
      f.change(f.add(), 'alpha');
      const sent = await f.submit();
      const order = Array.from({ length: 160000 }, (_value, index) => index);
      f.deliver({ ...sent.result, session: 'an-older-webview', visibleRowIds: order });
      assert.ok(f.view.cell(2, 0), 'another full view cannot affect the current table');
      f.deliver({ ...sent.result, visibleRowIds: order, realRowCount: 160000 });
      const stored = JSON.parse(f.document.querySelector('#csv-root').dataset.roworder);
      assert.strictEqual(stored.length, 160000);
      assert.strictEqual(stored[159999], 159999);
      assert.strictEqual(f.document.querySelector('table').getAttribute('aria-busy'), 'false');
    } finally { f.view.close(); }
  });

  it('updates inferred metadata without changing an unsupported operator or replacing its focused input', async () => {
    const f = await fixture();
    try {
      const input = f.add(1);
      const row = f.conditions()[0];
      f.change(row.querySelector('[data-filter-operator]'), 'greaterThan', 'change');
      f.change(input, '15');
      input.setSelectionRange(1, 2);
      const sent = await f.submit();
      const columns = sent.result.columns.map((column: any) => column.column === 1 ? {
        ...column, dataType: 'string', operators: column.operators.filter((choice: any) => !choice.operator.startsWith('greater') && !choice.operator.startsWith('less'))
      } : column);
      f.deliver({ ...sent.result, columns });
      assert.strictEqual(f.input(), input);
      assert.strictEqual(f.document.activeElement, input);
      assert.deepStrictEqual([input.selectionStart, input.selectionEnd], [1, 2]);
      const operator = row.querySelector('[data-filter-operator]');
      assert.strictEqual(operator.value, 'greaterThan', 'the displayed query remains the actual condition');
      assert.ok(operator.selectedOptions[0].textContent.includes('unsupported'));
      assert.ok(row.querySelector('.column-filter-error').textContent);
      assert.strictEqual(row.querySelector('.column-filter-type').textContent, 'text');
      f.change(operator, 'contains', 'change');
      await f.apply();
      assert.strictEqual(operator.value, 'contains');
      assert.strictEqual(input.getAttribute('aria-invalid'), null);
    } finally { f.view.close(); }
  });

  it('preserves CSV/TSV source row identities, metadata and frozen-row order after partial refresh', async () => {
    for (const separator of [',', '\t']) {
      const source = [['metadata', 'untouched'], ...rows];
      const f = await fixture({ separator, rows: source, hiddenRows: 1, frozenRows: 2, frozenColumns: 1 });
      try {
        const input = f.add();
        f.change(input, 'alpha');
        const table = f.document.querySelector('table');
        await f.apply();
        assert.strictEqual(f.document.querySelector('table'), table);
        assert.ok(f.view.cell(1, 0), 'the source header remains');
        assert.ok(f.view.cell(2, 0));
        assert.ok(f.view.cell(4, 0));
        assert.strictEqual(f.view.cell(0, 0), null);
        assert.strictEqual(f.view.cell(3, 0), null);
        f.view.window.csvFrozenPanes.layout();
        assert.ok(f.view.cell(2, 0).classList.contains('csv-frozen-row'));
        assert.ok(!f.view.cell(4, 0).classList.contains('csv-frozen-row'));
        assert.strictEqual(f.host.document.getText(), f.host.diskText);
        const order = JSON.parse(f.document.querySelector('#csv-root').dataset.roworder);
        assert.deepStrictEqual(order, [1, 2, 4, 5]);
      } finally { f.view.close(); }
    }
  });
  it('hands off blank and invalid raw drafts, focus and caret without persisting their text', async () => {
    const f = await fixture({ filters: [{ column: 0, operator: 'contains', value: 'alpha' }] });
    let restored: ReturnType<typeof createWebviewDom> | undefined;
    try {
      const input = f.input();
      f.change(f.conditions()[0].querySelector('[data-filter-operator]'), 'regex', 'change');
      f.change(input, 'volatile-invalid-[');
      f.document.querySelector('#addColumnFilter').click();
      input.focus();
      input.setSelectionRange(2, 8, 'backward');
      f.deliver({ type: 'prepareViewRefresh' });
      const ack = f.view.messages.filter(message => message.type === 'viewRefreshReady').slice(-1)[0];
      assert.strictEqual(ack.session, ack.filterDraft.session);
      assert.deepStrictEqual(Array.from(ack.filterDraft.rows, (row: any) => row.value), ['volatile-invalid-[', '']);
      assert.deepStrictEqual(JSON.parse(JSON.stringify(ack.filterDraft.focus)), { row: 0, field: 'value', selectionStart: 2, selectionEnd: 8, selectionDirection: 'backward' });
      assert.ok(!JSON.stringify(f.view.state()).includes('volatile-invalid-['));
      assert.ok(!JSON.stringify(f.host.context.workspaceState.values).includes('volatile-invalid-['));
      await f.host.receive(ack);
      restored = createWebviewDom(f.host.panel.webview.html);
      await new Promise(resolve => setTimeout(resolve, 20));
      const inputs = Array.from(restored.window.document.querySelectorAll('[data-filter-value]')) as any[];
      assert.strictEqual(inputs.length, 2);
      assert.strictEqual(inputs[0].value, 'volatile-invalid-[');
      assert.strictEqual(inputs[1].value, '');
      assert.strictEqual(restored.window.document.activeElement, inputs[0]);
      assert.deepStrictEqual([inputs[0].selectionStart, inputs[0].selectionEnd, inputs[0].selectionDirection], [2, 8, 'backward']);
      await wait();
      const retry = restored.messages.filter(message => message.type === 'updateColumnFilters').slice(-1)[0];
      assert.ok(retry);
      assert.notStrictEqual(retry.session, ack.session);
      assert.strictEqual(retry.filters.length, 1, 'blank condition remains a local draft');
      assert.strictEqual(retry.filters[0].value, 'volatile-invalid-[');
      await f.host.receive(retry);
      const result = f.host.messages.filter(message => message.type === 'columnFiltersResult' && message.session === retry.session).slice(-1)[0];
      restored.window.dispatchEvent(new restored.window.MessageEvent('message', { data: result }));
      assert.strictEqual(inputs[0].getAttribute('aria-invalid'), 'true');
      assert.ok(!JSON.stringify(f.host.context.workspaceState.values).includes('volatile-invalid-['));
      assert.ok(!JSON.stringify(restored.state()).includes('volatile-invalid-['));
    } finally { restored?.close(); f.view.close(); }
  });

  it('keeps the latest raw query when a deferred membership edit refreshes after a newer host filter was accepted', async () => {
    const f = await fixture({ rows: [['Name', 'Score'], ['one', '10'], ['two', '20']], filters: [{ column: 0, operator: 'contains', value: 'one' }] });
    let restored: ReturnType<typeof createWebviewDom> | undefined;
    try {
      f.host.deferEdits();
      const cell = f.view.cell(1, 0);
      f.view.start(cell);
      cell.textContent = 'changed';
      const input = f.input();
      f.change(input, 'ch');
      input.focus();
      input.setSelectionRange(1, 2);
      const edit = f.view.messages.find(message => message.type === 'editCell');
      const writing = f.host.receive(edit);
      await new Promise(resolve => setImmediate(resolve));
      assert.strictEqual(f.host.pendingEdits, 1);
      await wait();
      const request = f.view.messages.filter(message => message.type === 'updateColumnFilters').slice(-1)[0];
      const filtering = f.host.receive(request);
      f.host.releaseEdit();
      await writing;
      await filtering;
      const prepare = f.host.messages.filter(message => message.type === 'prepareViewRefresh').slice(-1)[0];
      assert.ok(prepare, 'changing filter membership requests a safe full view refresh');
      // Do not deliver the already-accepted result: the visible module still has
      // the old applied view while its raw query is newer.
      f.deliver(prepare);
      const ack = f.view.messages.filter(message => message.type === 'viewRefreshReady').slice(-1)[0];
      await f.host.receive(ack);
      restored = createWebviewDom(f.host.panel.webview.html);
      await new Promise(resolve => setTimeout(resolve, 20));
      const restoredInput = restored.window.document.querySelector('[data-filter-value]');
      assert.strictEqual(restoredInput.value, 'ch');
      assert.strictEqual(restored.window.document.activeElement, restoredInput);
      assert.deepStrictEqual([restoredInput.selectionStart, restoredInput.selectionEnd], [1, 2]);
      await wait();
      const retry = restored.messages.filter(message => message.type === 'updateColumnFilters').slice(-1)[0];
      assert.notStrictEqual(retry.session, request.session);
      assert.strictEqual(retry.filters[0].value, 'ch');
      await f.host.receive(retry);
      const result = f.host.messages.filter(message => message.type === 'columnFiltersResult' && message.session === retry.session).slice(-1)[0];
      restored.window.dispatchEvent(new restored.window.MessageEvent('message', { data: result }));
      assert.strictEqual(restored.cell(1, 0).textContent, 'changed');
      assert.strictEqual(f.host.rows()[1][0], 'changed');
      assert.strictEqual(f.host.diskText.includes('changed'), false);
      assert.strictEqual(restoredInput.value, 'ch');
    } finally { restored?.close(); f.view.close(); }
  });

  it('restores interrupted IME text without submitting it or blocking the last-valid grid until that condition is completed', async () => {
    for (const completion of ['input', 'compositionend']) {
      const f = await fixture({ filters: [{ column: 0, operator: 'contains', value: 'alpha' }] });
      let restored: ReturnType<typeof createWebviewDom> | undefined;
      try {
        const input = f.input();
        input.focus();
        input.dispatchEvent(new f.view.window.CompositionEvent('compositionstart', { bubbles: true }));
        f.change(input, '未確定');
        f.deliver({ type: 'prepareViewRefresh' });
        const ack = f.view.messages.filter(message => message.type === 'viewRefreshReady').slice(-1)[0];
        assert.strictEqual(ack.filterDraft.rows[0].composing, true);
        await f.host.receive(ack);
        restored = createWebviewDom(f.host.panel.webview.html);
        await wait();
        const document = restored.window.document;
        const incomplete = document.querySelector('[data-filter-value]');
        assert.strictEqual(incomplete.value, '未確定');
        assert.strictEqual(restored.messages.filter(message => message.type === 'updateColumnFilters').length, 0);
        assert.strictEqual(document.querySelector('table').hasAttribute('inert'), false);
        assert.strictEqual(document.querySelector('table').getAttribute('aria-busy'), 'false');
        assert.ok(document.querySelector('.column-filter-error').textContent.includes('Finish editing'));
        assert.ok(restored.cell(1, 0));
        assert.ok(!restored.cell(2, 0), 'the current last-valid alpha filter remains displayed');
        document.querySelector('#addColumnFilter').click();
        const other = Array.from(document.querySelectorAll('[data-filter-value]'))[1] as any;
        other.value = 'a';
        other.dispatchEvent(new restored.window.Event('input', { bubbles: true }));
        await wait();
        assert.strictEqual(restored.messages.filter(message => message.type === 'updateColumnFilters').length, 0, 'editing another AND condition cannot commit interrupted composition');
        assert.strictEqual(document.querySelector('table').hasAttribute('inert'), false);
        assert.strictEqual(restored.window.csvColumnFilters.captureDraft().rows[0].composing, true);
        incomplete.focus();
        incomplete.value = 'alpha';
        incomplete.dispatchEvent(completion === 'input'
          ? new restored.window.Event('input', { bubbles: true })
          : new restored.window.CompositionEvent('compositionend', { bubbles: true }));
        await wait();
        const request = restored.messages.filter(message => message.type === 'updateColumnFilters').slice(-1)[0];
        assert.ok(request, 'explicitly completing the interrupted condition resumes live filtering');
        assert.strictEqual(request.filters.length, 2);
        assert.strictEqual(request.filters[0].value, 'alpha');
        assert.strictEqual('composing' in request.filters[0], false, 'the volatile marker is never a persisted ColumnFilter');
        await f.host.receive(request);
        const result = f.host.messages.filter(message => message.type === 'columnFiltersResult' && message.session === request.session).slice(-1)[0];
        restored.window.dispatchEvent(new restored.window.MessageEvent('message', { data: result }));
        assert.strictEqual(document.querySelector('table').getAttribute('aria-busy'), 'false');
        assert.strictEqual(restored.window.csvColumnFilters.captureDraft().rows[0].composing, undefined);
        assert.ok(!JSON.stringify(f.host.context.workspaceState.values).includes('未確定'));
      } finally { restored?.close(); f.view.close(); }
    }
  });

});
