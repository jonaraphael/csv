import assert from 'assert';
import Papa from 'papaparse';
import { describe, it } from 'node:test';
import { createEditorHarness, createWebviewDom } from './edit-integrity-harness';
const { CsvEditorProvider } = require('../CsvEditorProvider') as typeof import('../CsvEditorProvider');
const filter = [{ column: 1, operator: 'equals', value: 'keep' }];
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

describe('Full-source filtered view operations', () => {
  it('filters beyond the initial source chunk and shows conspicuous removable active predicates', async () => {
    const source = [['Name', 'State'], ...Array.from({ length: 2004 }, (_, row) => [`row${row}`, row === 1500 || row === 1998 ? 'keep' : 'drop'])];
    const { host, view } = await fixture({ rows: source });
    try {
      assert.strictEqual(view.cell(1501, 0).textContent, 'row1500');
      assert.strictEqual(view.cell(1999, 0).textContent, 'row1998');
      assert.strictEqual(view.cell(1999, -1).textContent, '1999');
      assert.strictEqual(view.cell(1, 0), null);
      assert.ok(view.window.document.getElementById('filterStatus').textContent.includes('2 of 2004 rows'));
      assert.ok(view.window.document.querySelector('[data-clear-filter="1"]'));
      assert.ok(view.window.document.getElementById('clearAllFilters'));
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
      await host.receive(request);
      const response = host.messages.slice().reverse().find((message: any) => message.type === 'chunkData');
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

  it('persists configured filters, escapes filter text, and clears all through the visible control', async () => {
    const { host, view } = await fixture({ filters: [] });
    try {
      host.filterChoice = { label: 'Equals', operator: 'equals' };
      host.filterInput = '</button><script>bad()</script>';
      await host.receive({ type: 'configureColumnFilter', column: 0 });
      await refresh(host, view);
      assert.deepStrictEqual(CsvEditorProvider.getColumnFiltersForUri(host.context as any, host.document.uri as any), [{ column: 0, operator: 'equals', value: host.filterInput }]);
      assert.ok(host.panel.webview.html.includes('&lt;/button&gt;&lt;script&gt;'));
      const next = createWebviewDom(host.panel.webview.html);
      try {
        next.window.document.getElementById('clearAllFilters').click();
        await host.receive(next.messages.find((message: any) => message.type === 'clearAllFilters'));
        await refresh(host, next);
        assert.deepStrictEqual(CsvEditorProvider.getColumnFiltersForUri(host.context as any, host.document.uri as any), []);
        assert.ok(!host.panel.webview.html.includes('id="filterStatus"'));
        assert.deepStrictEqual(host.rows(), rows);
      } finally { next.close(); }
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
      assert.ok(view.messages.some((message: any) => message.type === 'clearAllFilters'));
    } finally { view.close(); }
  });

  it('keeps cancelled or oversized filter edits unchanged and isolates saved conditions per URI', async () => {
    const { host, view } = await fixture();
    try {
      const saved = () => CsvEditorProvider.getColumnFiltersForUri(host.context as any, host.document.uri as any);
      await host.receive({ type: 'configureColumnFilter', column: 1 });
      assert.deepStrictEqual(saved(), filter);
      host.filterChoice = { label: 'Contains', operator: 'contains' };
      await host.receive({ type: 'configureColumnFilter', column: 1 });
      host.filterInput = 'x'.repeat(4097);
      await host.receive({ type: 'configureColumnFilter', column: 1 });
      assert.deepStrictEqual(saved(), filter);
      assert.ok(!host.messages.some((message: any) => message.type === 'prepareViewRefresh'));
      const other = { toString: () => 'file:///other.csv' } as any;
      assert.deepStrictEqual(CsvEditorProvider.getColumnFiltersForUri(host.context as any, other), []);
      await CsvEditorProvider.setColumnFiltersForUri(host.context as any, other, [{ column: 0, operator: 'empty', value: '' }]);
      await host.receive({ type: 'clearAllFilters' });
      assert.deepStrictEqual(saved(), []);
      assert.deepStrictEqual(CsvEditorProvider.getColumnFiltersForUri(host.context as any, other), [{ column: 0, operator: 'empty', value: '' }]);
    } finally { view.close(); }
  });

  it('removes one predicate through its chip and commits a live multiline draft before refresh', async () => {
    const conditions = [...filter, { column: 0, operator: 'notEmpty', value: '' }];
    const { host, view } = await fixture({ filters: conditions });
    try {
      const cell = view.cell(1, 0);
      view.start(cell);
      cell.textContent = 'unsaved\nmultiline draft';
      view.window.document.querySelector('[data-clear-filter="0"]').click();
      await host.receive(view.messages.find((message: any) => message.type === 'clearColumnFilter'));
      await refresh(host, view);
      assert.strictEqual(host.rows()[1][0], 'unsaved\nmultiline draft');
      assert.deepStrictEqual(host.rows()[2], ['hidden', 'drop']);
      assert.deepStrictEqual(CsvEditorProvider.getColumnFiltersForUri(host.context as any, host.document.uri as any), filter);
      const next = createWebviewDom(host.panel.webview.html);
      try { assert.strictEqual(next.cell(1, 0).textContent, 'unsaved\nmultiline draft'); } finally { next.close(); }
    } finally { view.close(); }
  });

});
