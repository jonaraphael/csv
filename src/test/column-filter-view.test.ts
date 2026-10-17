import assert from 'assert';
import Papa from 'papaparse';
import { describe, it } from 'node:test';
import { createEditorHarness, createWebviewDom } from './edit-integrity-harness';
const { CsvEditorProvider } = require('../CsvEditorProvider') as typeof import('../CsvEditorProvider');
const filter = [{ column: 1, operator: 'equals', value: 'keep' }];
type Host = Awaited<ReturnType<typeof createEditorHarness>>;
type View = ReturnType<typeof createWebviewDom>;
const rows = [['Name', 'State'], ['one', 'keep'], ['hidden', 'drop'], ['three', 'KEEP']];

async function fixture(options: Parameters<typeof createEditorHarness>[0] = {}) {
  const host = await createEditorHarness({ rows, filters: filter, ...options });
  const view = createWebviewDom(host.panel.webview.html);
  return { host, view };
}
async function refresh(host: Awaited<ReturnType<typeof createEditorHarness>>, view: ReturnType<typeof createWebviewDom>) {
  const prepare = host.messages.slice().reverse().find((message: any) => message.type === 'prepareViewRefresh');
  assert.ok(prepare);
  const start = view.messages.length;
  view.window.dispatchEvent(new view.window.MessageEvent('message', { data: prepare }));
  for (const message of view.messages.slice(start)) { await host.receive(message); }
}

async function submitFilters(host: Host, view: View, filters: any[]) {
  const originalHtml = host.panel.webview.html;
  const table = view.window.document.querySelector('table');
  const start = view.messages.length;
  for (const remove of Array.from(view.window.document.querySelectorAll('[data-remove-filter]')) as any[]) { remove.click(); }
  for (const condition of filters) {
    view.window.csvColumnFilters.add(condition.column);
    const controls = Array.from(view.window.document.querySelectorAll('.column-filter-row')) as any[];
    const row = controls[controls.length - 1];
    const operator = row.querySelector('[data-filter-operator]');
    operator.value = condition.operator;
    operator.dispatchEvent(new view.window.Event('change', { bubbles: true }));
    const value = row.querySelector('[data-filter-value]');
    if (value) {
      value.value = condition.value;
      value.dispatchEvent(new view.window.Event('input', { bubbles: true }));
    }
  }
  await settleControls(host, view, start);
  const request = view.messages.slice(start).filter((message: any) => message.type === 'updateColumnFilters').pop();
  assert.ok(request, 'Inline controls submit one current filter snapshot');
  const result = host.messages.filter((message: any) => message.type === 'columnFiltersResult' && message.revision === request.revision).pop();
  assert.ok(result, 'Every live snapshot receives its matching revision result');
  assert.strictEqual(host.panel.webview.html, originalHtml, 'Live filter changes must not replace the entire webview');
  assert.strictEqual(view.window.document.querySelector('table'), table, 'Delegated table listeners keep their original table');
  return result;
}

async function settleControls(host: Host, view: View, start = 0) {
  await new Promise(resolve => view.window.setTimeout(resolve, 140));
  let clientCursor = start;
  let hostCursor = host.messages.length;
  while (clientCursor < view.messages.length) {
    const message = view.messages[clientCursor++];
    await host.receive(message);
    for (const reply of host.messages.slice(hostCursor)) {
      view.window.dispatchEvent(new view.window.MessageEvent('message', { data: reply }));
    }
    hostCursor = host.messages.length;
  }
}

describe('Full-source filtered view operations', () => {
  it('filters beyond the initial source chunk and shows editable independent conditions', async () => {
    const source = [['Name', 'State'], ...Array.from({ length: 2004 }, (_, row) => [`row${row}`, row === 1500 || row === 1998 ? 'keep' : 'drop'])];
    const { host, view } = await fixture({ rows: source });
    try {
      assert.strictEqual(view.cell(1501, 0).textContent, 'row1500');
      assert.strictEqual(view.cell(1999, 0).textContent, 'row1998');
      assert.strictEqual(view.cell(1999, -1).textContent, '1999');
      assert.strictEqual(view.cell(1, 0), null);
      assert.ok(view.window.document.getElementById('filterStatus').textContent.includes('2 of 2004 rows'));
      assert.strictEqual(view.window.document.querySelectorAll('.column-filter-row').length, 1);
      assert.strictEqual(view.window.document.querySelector('[data-filter-value]').value, 'keep');
      assert.ok(view.window.document.querySelector('[data-remove-filter]'));
      assert.ok(view.window.document.getElementById('clearAllFilters'));
      assert.ok(view.window.document.getElementById('addColumnFilter'));
      assert.strictEqual(view.cell(0, 1).getAttribute('data-filter-column'), 'active');
      assert.deepStrictEqual(host.rows(), source);
    } finally { view.close(); }
  });

  it('keeps original absolute IDs in remote filtered chunks', async () => {
    const source = [['Name', 'State'], ...Array.from({ length: 3000 }, (_, row) => [`row${row}`, row % 2 === 0 ? 'keep' : 'drop'])];
    const { host, view } = await fixture({ rows: source });
    try {
      assert.ok(view.cell(1999, 0));
      assert.strictEqual(view.cell(2001, 0), null);
      view.window.__csvLoadNextChunk();
      const request = view.messages.slice().reverse().find((message: any) => message.type === 'requestChunk');
      assert.strictEqual(request.filterEpoch, 0);
      assert.strictEqual(request.session, JSON.parse(view.window.document.getElementById('__csvFilters').textContent).session);
      await host.receive(request);
      const response = host.messages.slice().reverse().find((message: any) => message.type === 'chunkData');
      assert.strictEqual(response.filterEpoch, 0);
      assert.strictEqual(response.session, request.session);
      view.window.dispatchEvent(new view.window.MessageEvent('message', { data: response }));
      view.window.__csvLoadNextChunk();
      assert.strictEqual(view.cell(2001, 0).textContent, 'row2000');
      assert.strictEqual(view.cell(2001, -1).textContent, '2001');
      assert.strictEqual(view.cell(2002, 0), null);
    } finally { view.close(); }
  });

  it('copies and cuts only selected visible source rows across gaps', async () => {
    const { host, view } = await fixture();
    try {
      view.window.editingTestApi.selectRange({ row: 1, col: 0 }, { row: 3, col: 1 });
      view.cell(1, 0).dispatchEvent(new view.window.Event('copy', { bubbles: true, cancelable: true }));
      const copy = view.messages.find((message: any) => message.type === 'copyCells');
      assert.deepStrictEqual(Array.from(copy.rowIds), [1, 3]);
      await host.receive(copy);
      assert.deepStrictEqual(Papa.parse(host.clipboardText).data, [['one', 'keep'], ['three', 'KEEP']]);
      await host.receive({ ...copy, cut: true });
      assert.deepStrictEqual(host.rows(), [['Name', 'State'], ['', ''], ['hidden', 'drop'], ['', '']]);
    } finally { view.close(); }
  });

  it('pastes a matrix across visible rows and appends at the physical end without touching hidden rows', async () => {
    const { host, view } = await fixture();
    try {
      await host.receive({ type: 'pasteCells', text: 'first\nsecond\nappended', anchorRow: 1, anchorCol: 0 });
      assert.deepStrictEqual(host.rows(), [['Name', 'State'], ['first', 'keep'], ['hidden', 'drop'], ['second', 'KEEP'], ['appended']]);
      await host.document.save();
      assert.deepStrictEqual(Papa.parse(host.diskText).data, host.rows());
    } finally { view.close(); }
  });

  it('fills only visible cells in a selected rectangle, leaving hidden records intact', async () => {
    const { host, view } = await fixture();
    try {
      view.window.editingTestApi.selectRange({ row: 1, col: 0 }, { row: 3, col: 1 });
      const event = new view.window.Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', { value: { getData: () => 'filled' } });
      view.cell(1, 0).dispatchEvent(event);
      const paste = view.messages.find((message: any) => message.type === 'pasteCells');
      assert.strictEqual(paste.selection.rectangular, true);
      await host.receive(paste);
      assert.deepStrictEqual(host.rows(), [['Name', 'State'], ['filled', 'filled'], ['hidden', 'drop'], ['filled', 'filled']]);
    } finally { view.close(); }
  });

  it('finds and replaces only matching rows while preserving preambles and hidden values', async () => {
    const source = [['metadata', 'keep'], ['Name', 'State'], ['needle one', 'keep'], ['needle hidden', 'drop'], ['needle two', 'KEEP']];
    const { host, view } = await fixture({ rows: source, hiddenRows: 1 });
    try {
      await host.receive({ type: 'findMatches', requestId: 1, query: 'needle', options: {} });
      const found = host.messages.slice().reverse().find((message: any) => message.type === 'findMatchesResult');
      assert.deepStrictEqual(found.matches.map((match: any) => match.row), [2, 4]);
      await host.receive({ type: 'replaceCells', replacements: found.matches.map((match: any) => ({ row: match.row, col: match.col, value: 'replaced' })) });
      assert.deepStrictEqual(host.rows(), [['metadata', 'keep'], ['Name', 'State'], ['replaced', 'keep'], ['needle hidden', 'drop'], ['replaced', 'KEEP']]);
    } finally { view.close(); }
  });

  it('sorts matching slots and reorders/deletes by absolute source indices', async () => {
    const source = [['Name', 'State'], ['z', 'keep'], ['hidden', 'drop'], ['a', 'KEEP']];
    const { host, view } = await fixture({ rows: source });
    try {
      await host.receive({ type: 'sortColumn', index: 0, ascending: true });
      assert.deepStrictEqual(host.rows(), [['Name', 'State'], ['a', 'KEEP'], ['hidden', 'drop'], ['z', 'keep']]);
      await host.receive({ type: 'reorderRows', indices: [3], beforeIndex: 1 });
      assert.deepStrictEqual(host.rows(), [['Name', 'State'], ['z', 'keep'], ['a', 'KEEP'], ['hidden', 'drop']]);
      await host.receive({ type: 'deleteRows', indices: [1, 2] });
      assert.deepStrictEqual(host.rows(), [['Name', 'State'], ['hidden', 'drop']]);
    } finally { view.close(); }
  });

  it('moves filters with inserted/reordered columns and clears a deleted column predicate', async () => {
    const { host, view } = await fixture();
    try {
      const getFilters = () => CsvEditorProvider.getColumnFiltersForUri(host.context as any, host.document.uri as any);
      await host.receive({ type: 'insertColumn', index: 0 });
      assert.strictEqual(getFilters()[0].column, 2);
      await host.receive({ type: 'reorderColumns', indices: [2], beforeIndex: 0 });
      assert.strictEqual(getFilters()[0].column, 0);
      await host.receive({ type: 'deleteColumn', index: 0 });
      assert.deepStrictEqual(getFilters(), []);
      assert.ok(host.rows().some(row => row.includes('hidden')));
    } finally { view.close(); }
  });

  it('navigates/selects visible rows and freezes visible leading rows with a toolbar inset', async () => {
    const { view } = await fixture({ frozenRows: 3, frozenColumns: 1 });
    try {
      view.window.editingTestApi.setSingleSelection(view.cell(1, 0));
      view.key('ArrowDown');
      assert.strictEqual(view.window.document.activeElement, view.cell(3, 0));
      view.key('ArrowUp', { shiftKey: true });
      assert.strictEqual(view.window.document.querySelectorAll('td.selected[data-col="0"]').length, 2);
      const status = view.window.document.getElementById('filterStatus');
      status.getBoundingClientRect = () => ({ height: 20 });
      for (const row of Array.from(view.window.document.querySelectorAll('tr')) as any[]) { row.getBoundingClientRect = () => ({ height: 30 }); }
      // JSDOM drops border shorthand containing a CSS variable; model the browser's 1px border.
      view.window.document.querySelector('th, td').style.borderTopWidth = '1px';
      view.window.csvFrozenPanes.layout();
      assert.strictEqual(view.cell(0, 0).style.top, '19.5px');
      assert.strictEqual(view.cell(1, 0).style.top, '49.5px');
      assert.strictEqual(view.cell(3, 0).style.top, '79.5px');
      assert.ok(!view.cell(4, 0).classList.contains('csv-frozen-row'));
    } finally { view.close(); }
  });

  it('handles zero matches with headers off and keeps the append row at the full-source end', async () => {
    const { host, view } = await fixture({ header: false, filters: [{ column: 1, operator: 'equals', value: 'absent' }], frozenRows: 10 });
    try {
      assert.strictEqual(view.window.document.querySelectorAll('tbody tr').length, 1);
      assert.ok(view.cell(4, 0));
      view.window.csvFrozenPanes.layout();
      assert.ok(!view.cell(4, 0).classList.contains('csv-frozen-row'));
      await host.receive({ type: 'pasteCells', text: 'new', anchorRow: 4, anchorCol: 0 });
      assert.deepStrictEqual(host.rows().slice(0, 4), rows);
      assert.strictEqual(host.rows()[4][0], 'new');
    } finally { view.close(); }
  });

  it('persists live filter text safely and clears all without replacing the editor', async () => {
    const { host, view } = await fixture({ filters: [] });
    try {
      const input = '</button><script>bad()</script>';
      const conditions = [{ column: 0, operator: 'equals', value: input }];
      const result = await submitFilters(host, view, conditions);
      assert.ok(!result.error && !result.errors?.length);
      assert.deepStrictEqual(CsvEditorProvider.getColumnFiltersForUri(host.context as any, host.document.uri as any), conditions);
      assert.strictEqual(view.window.document.querySelector('[data-filter-value]').value, input);
      assert.strictEqual(view.window.document.querySelectorAll('#filterStatus script').length, 0);
      const start = view.messages.length;
      view.window.document.getElementById('clearAllFilters').click();
      await settleControls(host, view, start);
      assert.deepStrictEqual(CsvEditorProvider.getColumnFiltersForUri(host.context as any, host.document.uri as any), []);
      assert.ok(view.window.document.getElementById('filterStatus').hidden);
      assert.deepStrictEqual(host.rows(), rows);
      assert.strictEqual(host.quickPickCalls.length, 0);
      assert.strictEqual(host.inputBoxCalls.length, 0);
    } finally { view.close(); }
  });

  it('re-evaluates an edited filter value using the safe commit-before-refresh path', async () => {
    const { host, view } = await fixture();
    try {
      await host.receive({ type: 'editCell', row: 1, col: 1, value: 'drop' });
      await refresh(host, view);
      assert.ok(!host.panel.webview.html.includes('data-row="1"'));
      assert.strictEqual(host.rows()[1][1], 'drop');
      assert.deepStrictEqual(host.rows()[2], ['hidden', 'drop']);
    } finally { view.close(); }
  });
  it('preserves exact metadata and hidden record formatting during filtered paste, fill and sort', async () => {
    const text = '"metadata","preserve"\r\nName,"State"\r\n"z","keep"\r\nNaN,"drop"\r\n"a",KEEP\r\n';
    const { host, view } = await fixture({ text, hiddenRows: 1 });
    try {
      await host.receive({ type: 'pasteCells', text: 'changed', anchorRow: 2, anchorCol: 0 });
      assert.strictEqual(host.document.getText(), '"metadata","preserve"\r\nName,"State"\r\n"changed","keep"\r\nNaN,"drop"\r\n"a",KEEP\r\n');
      await host.receive({ type: 'sortColumn', index: 0, ascending: true });
      assert.strictEqual(host.document.getText(), '"metadata","preserve"\r\nName,"State"\r\n"a",KEEP\r\nNaN,"drop"\r\n"changed","keep"\r\n');
      await host.receive({ type: 'pasteCells', text: 'new,keep', anchorRow: 5, anchorCol: 0 });
      assert.ok(host.document.getText().startsWith('"metadata","preserve"\r\nName,"State"\r\n"a",KEEP\r\nNaN,"drop"\r\n"changed","keep"\r\n'));
      await host.receive({ type: 'pasteCells', text: 'filled', anchorRow: 2, anchorCol: 0, selection: { minRow: 2, maxRow: 4, minCol: 0, maxCol: 0, rectangular: true } });
      assert.ok(host.document.getText().includes('NaN,"drop"\r\n'));
      assert.ok(host.document.getText().startsWith('"metadata","preserve"\r\nName,"State"\r\n'));
    } finally { view.close(); }
  });

  it('preserves raw tokens for hidden records during filtered row/column structural actions', async () => {
    const text = '"Name","State"\n"one","keep"\nhidden,"drop"\n"three",KEEP\n';
    const { host, view } = await fixture({ text });
    try {
      await host.receive({ type: 'deleteRows', indices: [1, 3] });
      assert.strictEqual(host.document.getText(), '"Name","State"\nhidden,"drop"\n');
      await host.receive({ type: 'insertColumns', index: 0, count: 2 });
      assert.ok(host.document.getText().includes(',,hidden,"drop"\n'));
      await host.receive({ type: 'deleteColumns', indices: [0, 1] });
      assert.strictEqual(host.document.getText(), '"Name","State"\nhidden,"drop"\n');
    } finally { view.close(); }
  });

  it('retains quoted tabs/newlines in filtered TSV clipboard and paste flows', async () => {
    const source = [['Name', 'State'], ['tab\tand\nnewline', 'keep'], ['hidden', 'drop'], ['three', 'keep']];
    const { host, view } = await fixture({ rows: source, separator: '\t' });
    try {
      view.window.editingTestApi.setSingleSelection(view.cell(1, 0));
      view.cell(1, 0).dispatchEvent(new view.window.Event('copy', { bubbles: true, cancelable: true }));
      await host.receive(view.messages.find((message: any) => message.type === 'copyCells'));
      await host.receive({ type: 'pasteCells', text: host.clipboardText, anchorRow: 3, anchorCol: 0 });
      assert.strictEqual(host.rows()[3][0], 'tab\tand\nnewline');
      assert.deepStrictEqual(host.rows()[2], ['hidden', 'drop']);
    } finally { view.close(); }
  });

  it('leaves filter-bar keyboard activation native and tab navigation follows visible rows', async () => {
    const { view } = await fixture();
    try {
      view.window.editingTestApi.setSingleSelection(view.cell(1, 1));
      view.key('Tab');
      assert.strictEqual(view.window.document.activeElement, view.cell(3, 0));
      view.key('Tab', { shiftKey: true });
      assert.strictEqual(view.window.document.activeElement, view.cell(1, 1));
      const clear = view.window.document.getElementById('clearAllFilters');
      clear.focus();
      const event = new view.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
      clear.dispatchEvent(event);
      assert.strictEqual(event.defaultPrevented, false);
      assert.strictEqual(view.window.document.querySelector('[contenteditable="true"]'), null);
      clear.click();
      await new Promise(resolve => view.window.setTimeout(resolve, 140));
      assert.ok(view.messages.some((message: any) => message.type === 'updateColumnFilters' && message.filters.length === 0));
    } finally { view.close(); }
  });

  it('rejects oversized live snapshots atomically and isolates saved conditions per URI', async () => {
    const { host, view } = await fixture();
    try {
      const saved = () => CsvEditorProvider.getColumnFiltersForUri(host.context as any, host.document.uri as any);
      const beforeRows = view.window.document.querySelector('table').innerHTML;
      await host.receive({ type: 'updateColumnFilters', session: JSON.parse(view.window.document.getElementById('__csvFilters').textContent).session, revision: 1, filters: [{ column: 1, operator: 'contains', value: 'x'.repeat(4097) }] });
      const invalid = host.messages.find((message: any) => message.type === 'columnFiltersResult' && message.revision === 1);
      assert.ok(invalid);
      assert.ok(invalid.error || invalid.errors?.length);
      assert.strictEqual(invalid.filters?.[0]?.value ?? filter[0].value, filter[0].value);
      assert.deepStrictEqual(saved(), filter);
      assert.strictEqual(view.window.document.querySelector('table').innerHTML, beforeRows);
      assert.ok(!host.messages.some((message: any) => message.type === 'prepareViewRefresh'));
      const other = { toString: () => 'file:///other.csv' } as any;
      assert.deepStrictEqual(CsvEditorProvider.getColumnFiltersForUri(host.context as any, other), []);
      await CsvEditorProvider.setColumnFiltersForUri(host.context as any, other, [{ column: 0, operator: 'empty', value: '' }]);
      await host.receive({ type: 'updateColumnFilters', session: JSON.parse(view.window.document.getElementById('__csvFilters').textContent).session, revision: 2, filters: [] });
      assert.deepStrictEqual(saved(), []);
      assert.deepStrictEqual(CsvEditorProvider.getColumnFiltersForUri(host.context as any, other), [{ column: 0, operator: 'empty', value: '' }]);
    } finally { view.close(); }
  });

  it('removes only one same-column AND condition and commits a multiline draft before live refresh', async () => {
    const conditions = [...filter, { column: 0, operator: 'notEmpty', value: '' }, { column: 1, operator: 'notEquals', value: 'drop' }];
    const { host, view } = await fixture({ filters: conditions });
    try {
      const cell = view.cell(1, 0);
      view.start(cell);
      cell.textContent = 'unsaved\nmultiline draft';
      const start = view.messages.length;
      view.window.document.querySelectorAll('[data-remove-filter]')[2].click();
      await settleControls(host, view, start);
      assert.strictEqual(host.rows()[1][0], 'unsaved\nmultiline draft');
      assert.deepStrictEqual(host.rows()[2], ['hidden', 'drop']);
      assert.deepStrictEqual(CsvEditorProvider.getColumnFiltersForUri(host.context as any, host.document.uri as any), conditions.slice(0, 2));
      assert.strictEqual(view.window.document.querySelectorAll('.column-filter-row').length, 2);
      assert.strictEqual(view.cell(1, 0).textContent, 'unsaved\nmultiline draft');
      assert.strictEqual(host.diskText.includes('unsaved'), false, 'Changing filters never saves a file');
    } finally { view.close(); }
  });

  it('aligns the last valid result when an older success was ignored before a newer invalid draft', async () => {
    const { host, view } = await fixture({ filters: [] });
    try {
      const table = view.window.document.querySelector('table');
      const originalHtml = host.panel.webview.html;
      view.window.csvColumnFilters.add(0);
      const input = view.window.document.querySelector('[data-filter-value]');
      const operator = view.window.document.querySelector('[data-filter-operator]');
      input.value = 'one';
      input.dispatchEvent(new view.window.Event('input', { bubbles: true }));
      await new Promise(resolve => view.window.setTimeout(resolve, 140));
      const validRequest = view.messages.filter((message: any) => message.type === 'updateColumnFilters').pop();
      await host.receive(validRequest);
      const success = host.messages.filter((message: any) => message.type === 'columnFiltersResult' && message.revision === validRequest.revision).pop();
      assert.ok(success.tableHtml);

      operator.value = 'regex';
      operator.dispatchEvent(new view.window.Event('change', { bubbles: true }));
      input.value = '[';
      input.dispatchEvent(new view.window.Event('input', { bubbles: true }));
      await new Promise(resolve => view.window.setTimeout(resolve, 140));
      const invalidRequest = view.messages.filter((message: any) => message.type === 'updateColumnFilters').pop();
      assert.ok(invalidRequest.revision > validRequest.revision);
      view.window.dispatchEvent(new view.window.MessageEvent('message', { data: success }));
      assert.ok(view.cell(3, 0), 'The older success must not update a newer local draft');
      await host.receive(invalidRequest);
      const invalid = host.messages.filter((message: any) => message.type === 'columnFiltersResult' && message.revision === invalidRequest.revision).pop();
      assert.ok(invalid.error || invalid.errors?.length);
      assert.strictEqual(invalid.filterEpoch, success.filterEpoch);
      view.window.dispatchEvent(new view.window.MessageEvent('message', { data: invalid }));
      assert.strictEqual(view.cell(1, 0).textContent, 'one');
      assert.strictEqual(view.cell(3, 0), null, 'The latest invalid reply aligns the last accepted visible result');
      assert.strictEqual(view.window.document.querySelector('[data-filter-value]'), input);
      assert.strictEqual(input.value, '[');
      assert.strictEqual(input.getAttribute('aria-invalid'), 'true');
      assert.deepStrictEqual(CsvEditorProvider.getColumnFiltersForUri(host.context as any, host.document.uri as any), [{ column: 0, operator: 'contains', value: 'one' }]);
      assert.strictEqual(view.window.document.querySelector('table'), table);
      assert.strictEqual(host.panel.webview.html, originalHtml);
      assert.deepStrictEqual(host.rows(), rows);
    } finally { view.close(); }
  });

  it('keeps literal whitespace as an independent same-column AND text condition', async () => {
    const source = [['Name', 'State'], ['two words', 'keep'], ['twowords', 'keep'], ['another', 'drop']];
    const { host, view } = await fixture({ rows: source, filters: [] });
    try {
      const conditions = [{ column: 0, operator: 'contains', value: 'two' }, { column: 0, operator: 'contains', value: ' ' }];
      const result = await submitFilters(host, view, conditions);
      assert.ok(!result.error && !result.errors?.length);
      assert.deepStrictEqual(CsvEditorProvider.getColumnFiltersForUri(host.context as any, host.document.uri as any), conditions);
      assert.strictEqual(view.cell(1, 0).textContent, 'two words');
      assert.strictEqual(view.cell(2, 0), null);
      assert.strictEqual(view.window.document.querySelectorAll('.column-filter-row').length, 2);
      assert.strictEqual(view.window.document.querySelectorAll('[data-filter-value]')[1].value, ' ');
      assert.deepStrictEqual(host.rows(), source);
    } finally { view.close(); }
  });

  it('retains both same-column predicates through column insert, reorder and delete', async () => {
    const conditions = [filter[0], { column: 1, operator: 'notEquals', value: 'drop' }, { column: 0, operator: 'notEmpty', value: '' }];
    const { host, view } = await fixture({ filters: conditions });
    try {
      const saved = () => CsvEditorProvider.getColumnFiltersForUri(host.context as any, host.document.uri as any);
      await host.receive({ type: 'insertColumn', index: 0 });
      assert.deepStrictEqual(saved().map(condition => condition.column), [2, 2, 1]);
      await host.receive({ type: 'reorderColumns', indices: [2], beforeIndex: 0 });
      assert.deepStrictEqual(saved().map(condition => condition.column), [0, 0, 2]);
      await host.receive({ type: 'deleteColumn', index: 0 });
      assert.deepStrictEqual(saved(), [{ column: 1, operator: 'notEmpty', value: '' }]);
      assert.ok(host.rows().some(row => row.includes('hidden')));
    } finally { view.close(); }
  });

});
