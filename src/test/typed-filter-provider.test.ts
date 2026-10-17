import assert from 'assert';
import { describe, it } from 'node:test';
import { createEditorHarness, createWebviewDom, flushViewCommits } from './edit-integrity-harness';
const { CsvEditorProvider } = require('../CsvEditorProvider') as typeof import('../CsvEditorProvider');
const { JSDOM } = require('jsdom');

type Host = Awaited<ReturnType<typeof createEditorHarness>>;
const sharedOperators = ['contains', 'notContains', 'regex', 'equals', 'notEquals', 'empty', 'notEmpty'];
const orderedOperators = ['greaterThan', 'greaterThanOrEqual', 'lessThan', 'lessThanOrEqual'];
const saved = (host: Host) => CsvEditorProvider.getColumnFiltersForUri(host.context as any, host.document.uri as any);
function metadata(host: Host): any {
  const dom = new JSDOM(host.panel.webview.html);
  try { return JSON.parse(dom.window.document.getElementById('__csvFilters').textContent); }
  finally { dom.window.close(); }
}
function rowIds(html: string): number[] {
  const dom = new JSDOM(html);
  try { return Array.from(dom.window.document.querySelectorAll('tbody tr')).map((row: any) => Number(row.querySelector('[data-row]').dataset.row)); }
  finally { dom.window.close(); }
}
async function update(host: Host, revision: number, filters: unknown, session = metadata(host).session) {
  const start = host.messages.length;
  await host.receive({ type: 'updateColumnFilters', revision, filters, session });
  return host.messages.slice(start).find(message => message.type === 'columnFiltersResult');
}

describe('Inline typed filter provider', () => {
  for (const separator of [',', '\t']) {
    it(`provides full-source inferred columns and operators without native popups (${JSON.stringify(separator)})`, async () => {
      const host = await createEditorHarness({ rows: [['Text', 'Amount', 'When', 'Enabled'], ['hello', '2', '2026-01-01', 'yes'], ['world', '10.5', '2026-02-01', 'OFF']], separator });
      const initial = metadata(host);
      assert.strictEqual(initial.revision, 0);
      assert.ok(typeof initial.session === 'string' && initial.session.length > 0);
      assert.ok(initial.maxFilters > 0);
      for (const [column, type] of ['string', 'number', 'date', 'boolean'].entries()) {
        const info = initial.columns[column];
        assert.strictEqual(info.column, column);
        assert.strictEqual(info.dataType, type);
        assert.ok(info.label);
        for (const operator of sharedOperators) { assert.ok(info.operators.some((item: any) => item.operator === operator)); }
        for (const operator of orderedOperators) {
          assert.strictEqual(info.operators.some((item: any) => item.operator === operator), type === 'number' || type === 'date');
        }
      }
      const dom = new JSDOM(host.panel.webview.html);
      try {
        const region = dom.window.document.getElementById('filterStatus');
        assert.strictEqual(region.getAttribute('aria-label'), 'Column filters');
        assert.strictEqual(region.getAttribute('role'), null, 'interactive filter region is not a live status container');
        assert.strictEqual(region.childElementCount, 0, 'the UI module owns input DOM');
        assert.strictEqual(region.hidden, true);
        const scripts = Array.from(dom.window.document.querySelectorAll('script[src]')).map((script: any) => script.src);
        assert.ok(scripts.findIndex((src: any) => src.endsWith('/column-filters.js')) < scripts.findIndex((src: any) => src.endsWith('/main.js')));
      } finally { dom.window.close(); }
      assert.deepStrictEqual(saved(host), []);
      assert.strictEqual(host.quickPickCalls.length, 0);
      assert.strictEqual(host.inputBoxCalls.length, 0);
      assert.strictEqual(host.document.version, 1);
    });
  }

  it('infers from original body rows excluding metadata/header, regardless of other filters', async () => {
    const rows = [['metadata', 'ignored'], ['Amount', 'Group'], ['2', 'show'], ['not numeric', 'hide']];
    const host = await createEditorHarness({ rows, header: true, hiddenRows: 1, filters: [{ column: 1, operator: 'equals', value: 'show' }] });
    const initial = metadata(host);
    assert.strictEqual(initial.columns[0].dataType, 'string');
    assert.ok(!initial.columns[0].operators.some((item: any) => item.operator === 'greaterThan'));
    const result = await update(host, 1, []);
    assert.deepStrictEqual(result.columns, initial.columns);
    assert.strictEqual(result.firstVisibleRow, 1);
    assert.strictEqual(result.totalRows, 2);
    const numeric = await createEditorHarness({ rows: [['not numeric metadata'], ['Amount'], ['2'], ['10.5']], hiddenRows: 1 });
    assert.strictEqual(metadata(numeric).columns[0].dataType, 'number');
  });

  it('promotes complete mixed-format date cells only for filters and respects header-off/automatic header semantics', async () => {
    const values = ['2026-01-01', 'February 1, 2026 12:00 UTC', '03/01/2026'];
    const host = await createEditorHarness({ rows: [['When'], ...values.map(value => [value]), ['']] });
    assert.strictEqual(metadata(host).columns[0].dataType, 'date');
    assert.strictEqual(CsvEditorProvider.__test.isDate('1/2/2024'), false);
    assert.strictEqual(CsvEditorProvider.__test.estimateColumnDataType(values), 'string');
    const noHeader = await createEditorHarness({ rows: [['Amount'], ['2'], ['10']], header: false });
    assert.strictEqual(metadata(noHeader).columns[0].dataType, 'string');
    await noHeader.context.workspaceState.update(CsvEditorProvider.headerKey, {});
    assert.strictEqual((await update(noHeader, 1, [])).columns[0].dataType, 'number');
    for (const value of ['2026', '12345678', 'not a date']) {
      const plain = await createEditorHarness({ rows: [['Value'], [value]] });
      assert.notStrictEqual(metadata(plain).columns[0].dataType, 'date');
    }
  });

  for (const separator of [',', '\t']) {
    it(`persists independent same-column AND predicates and returns source IDs without replacing HTML (${JSON.stringify(separator)})`, async () => {
      const host = await createEditorHarness({ rows: [['Amount', 'Name'], ['2', 'low'], ['10', 'equal'], ['15', 'high'], ['25', 'over']], separator });
      const source = host.document.getText(), disk = host.diskText, html = host.panel.webview.html;
      const predicates = [{ column: 0, operator: 'greaterThanOrEqual', value: '1e1', dataType: 'string' }, { column: 0, operator: 'lessThan', value: '20', dataType: 'boolean' }];
      const result = await update(host, 1, predicates);
      assert.strictEqual(result.error, undefined);
      assert.strictEqual(result.errors, undefined);
      assert.strictEqual(result.filterEpoch, 1);
      assert.strictEqual(result.session, metadata(host).session);
      assert.deepStrictEqual(rowIds(result.tableHtml), [2, 3, 5]);
      assert.deepStrictEqual(result.visibleRowIds, [0, 2, 3, 5]);
      assert.strictEqual(result.matchedRows, 2);
      assert.strictEqual(result.totalRows, 4);
      assert.ok(typeof result.colorCss === 'string');
      assert.deepStrictEqual(saved(host), predicates.map(filter => ({ ...filter, dataType: 'number' })), 'server inference overrides forged valid type hints');
      const removed = await update(host, 2, [predicates[1]]);
      assert.deepStrictEqual(rowIds(removed.tableHtml), [1, 2, 3, 5]);
      assert.strictEqual(saved(host).length, 1, 'removing one condition retains the other same-column condition');
      assert.strictEqual(host.panel.webview.html, html, 'live filtering never replaces the webview');
      assert.strictEqual(host.document.getText(), source);
      assert.strictEqual(host.diskText, disk);
      assert.strictEqual(host.document.version, 1);
      assert.strictEqual(host.quickPickCalls.length + host.inputBoxCalls.length, 0);
    });
  }

  it('uses typed equality, inequality, boolean vocabulary and broad explicit dates', async () => {
    const numeric = await createEditorHarness({ rows: [['Amount', 'Name'], ['10', 'one'], ['10.0', 'two'], ['', 'blank'], ['20', 'other']] });
    const inequality = await update(numeric, 1, [{ column: 0, operator: 'notEquals', value: '10' }]);
    assert.deepStrictEqual(rowIds(inequality.tableHtml), [4, 5]);
    assert.strictEqual(saved(numeric)[0].dataType, 'number');
    const host = await createEditorHarness({ rows: [['When', 'Enabled'], ['2026-02-01T12:00Z', 'yes'], ['2026-02-02T12:00Z', 'OFF'], ['2026-01-31T12:00Z', 'true']] });
    const result = await update(host, 1, [{ column: 1, operator: 'equals', value: 'ON' }, { column: 0, operator: 'greaterThanOrEqual', value: 'February 1, 2026 12:00 UTC' }]);
    assert.deepStrictEqual(rowIds(result.tableHtml), [1, 4]);
    assert.deepStrictEqual(saved(host).map(filter => filter.dataType), ['boolean', 'date']);
  });

  it('keeps text operators untyped, retains literal spaces and omits only zero-length draft values', async () => {
    const host = await createEditorHarness({ rows: [['Value', 'Name'], ['two words', 'a'], ['single', 'b']] });
    const space = await update(host, 1, [{ column: 0, operator: 'contains', value: ' ', dataType: 'number' }]);
    assert.deepStrictEqual(rowIds(space.tableHtml), [1, 3]);
    assert.deepStrictEqual(saved(host), [{ column: 0, operator: 'contains', value: ' ' }]);
    const blank = await update(host, 2, [{ column: 0, operator: 'equals', value: '' }]);
    assert.deepStrictEqual(blank.filters, []);
    assert.deepStrictEqual(saved(host), []);
    const numeric = await createEditorHarness({ rows: [['Amount'], ['2'], ['10']] });
    for (const [index, operator] of ['contains', 'notContains', 'regex', 'empty', 'notEmpty'].entries()) {
      const result = await update(numeric, index + 1, [{ column: 0, operator, value: operator === 'empty' || operator === 'notEmpty' ? '' : '2', dataType: 'number' }]);
      assert.ok(!result.errors);
      assert.ok(!Object.prototype.hasOwnProperty.call(saved(numeric)[0], 'dataType'));
    }
    assert.ok((await update(numeric, 6, [{ column: 0, operator: 'greaterThan', value: ' ' }])).errors);
  });

  it('rejects the entire invalid snapshot and returns the current accepted epoch/render for stale-success recovery', async () => {
    const host = await createEditorHarness({ rows: [['Amount'], ['2'], ['10']] });
    const accepted = await update(host, 1, [{ column: 0, operator: 'greaterThan', value: '3' }]);
    const previous = saved(host), source = host.document.getText(), html = host.panel.webview.html;
    for (const [index, bad] of [
      [{ column: 0, operator: 'greaterThan', value: '10junk' }],
      [{ column: 0, operator: 'equals', value: 'Infinity' }],
      [{ column: 0, operator: 'regex', value: '[' }],
      [{ column: 0, operator: 'notEmpty', value: '' }, { column: 0, operator: 'regex', value: '[' }],
      [{ column: 0, operator: 'regex', value: '(?=one)' }],
      [{ column: 0, operator: 'regex', value: '/one/g' }],
      [{ column: 0, operator: 'contains', value: 'x'.repeat(4097) }],
      [{ column: '0', operator: 'contains', value: '2' }],
      [{ column: 0, operator: 'unknown', value: '2' }],
      [{ column: 0, operator: 'equals', value: '2', dataType: {} }],
      [{ column: 0, operator: 'equals', value: '2', extra: true }],
      [null], {}, Array.from({ length: metadata(host).maxFilters + 1 }, () => ({ column: 0, operator: 'notEmpty', value: '' }))
    ].entries()) {
      const result = await update(host, index + 2, bad);
      assert.ok(result.error || result.errors?.length);
      assert.strictEqual(result.filterEpoch, 1);
      assert.strictEqual(result.tableHtml, accepted.tableHtml);
      assert.deepStrictEqual(result.filters, previous);
      assert.deepStrictEqual(saved(host), previous);
      assert.strictEqual(host.panel.webview.html, html);
      assert.strictEqual(host.document.getText(), source);
      assert.strictEqual(host.document.version, 1);
    }
  });

  it('escapes raw metadata strings and preserves invalid saved queries for inline correction', async () => {
    const label = '</script><img src=x onerror=alert(1)> & "Name"';
    const host = await createEditorHarness({ rows: [[label], ['one']], filters: [{ column: 0, operator: 'regex', value: '[' }] });
    const initial = metadata(host);
    assert.strictEqual(initial.columns[0].label, label);
    assert.strictEqual(initial.filters[0].value, '[');
    const dom = new JSDOM(host.panel.webview.html);
    try {
      assert.strictEqual(dom.window.document.querySelector('img'), null);
      assert.strictEqual(dom.window.document.querySelectorAll('#__csvFilters').length, 1);
      assert.deepStrictEqual(rowIds(host.panel.webview.html), [2]);
    } finally { dom.window.close(); }
  });

  it('coalesces queued revisions after preceding document edits and keeps the newest source text unsaved', async () => {
    const host = await createEditorHarness({ rows: [['Amount', 'Note'], ['2', 'one'], ['10', 'two']] });
    host.deferEdits();
    const pendingEdit = host.receive({ type: 'editCell', row: 1, col: 1, value: 'unposted\nmultiline' });
    await new Promise(resolve => setImmediate(resolve));
    const session = metadata(host).session;
    const old = host.receive({ type: 'updateColumnFilters', revision: 1, session, filters: [{ column: 0, operator: 'greaterThan', value: '0' }] });
    const newest = host.receive({ type: 'updateColumnFilters', revision: 2, session, filters: [{ column: 0, operator: 'greaterThan', value: '5' }] });
    host.releaseEdit();
    await Promise.all([pendingEdit, old, newest]);
    const replies = host.messages.filter(message => message.type === 'columnFiltersResult');
    assert.deepStrictEqual(replies.map(message => message.revision), [2]);
    assert.deepStrictEqual(rowIds(replies[0].tableHtml), [2, 3]);
    assert.strictEqual(host.rows()[1][1], 'unposted\nmultiline');
    assert.ok(!host.diskText.includes('multiline'));
  });

  it('rolls back a superseded preference write before validating the newest snapshot', async () => {
    const host = await createEditorHarness({ rows: [['Amount'], ['2'], ['10']] });
    const state = host.context.workspaceState;
    const originalUpdate = state.update.bind(state);
    let release = () => {};
    let held = false;
    state.update = async (key, value) => {
      if (key === CsvEditorProvider.columnFiltersKey && !held) {
        held = true;
        await new Promise<void>(resolve => { release = resolve; });
      }
      await originalUpdate(key, value);
    };
    const session = metadata(host).session;
    const old = host.receive({ type: 'updateColumnFilters', revision: 1, session, filters: [{ column: 0, operator: 'greaterThan', value: '3' }] });
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(held);
    const newest = host.receive({ type: 'updateColumnFilters', revision: 2, session, filters: [{ column: 0, operator: 'regex', value: '[' }] });
    release();
    await Promise.all([old, newest]);
    assert.deepStrictEqual(saved(host), []);
    const replies = host.messages.filter(message => message.type === 'columnFiltersResult');
    assert.deepStrictEqual(replies.map(message => message.revision), [2]);
    assert.ok(replies[0].errors);
    assert.strictEqual(replies[0].filterEpoch, 0);
    assert.deepStrictEqual(rowIds(replies[0].tableHtml), [1, 2, 3]);
  });

  it('does not relabel an old-session asynchronous storage error as a new-view response', async () => {
    const host = await createEditorHarness({ rows: [['Amount'], ['2'], ['10']] });
    const state = host.context.workspaceState;
    const originalUpdate = state.update.bind(state);
    let reject = () => {};
    state.update = async () => new Promise<void>((_resolve, fail) => { reject = () => fail(new Error('test storage rejection')); });
    const oldSession = metadata(host).session;
    const pending = host.receive({ type: 'updateColumnFilters', revision: 1, session: oldSession, filters: [{ column: 0, operator: 'greaterThan', value: '3' }] });
    await new Promise(resolve => setImmediate(resolve));
    CsvEditorProvider.getActiveProvider()!.refresh();
    await new Promise(resolve => setTimeout(resolve, 20));
    const fresh = metadata(host);
    assert.notStrictEqual(fresh.session, oldSession);
    reject();
    await pending;
    assert.ok(!host.messages.some(message => message.type === 'columnFiltersResult'));
    state.update = originalUpdate;
    const accepted = await update(host, 1, [], fresh.session);
    assert.strictEqual(accepted.session, fresh.session);
    assert.strictEqual(accepted.filterEpoch, 1);
  });

  it('rejects redraw after false or thrown WorkspaceEdit and accepts a successful retry of that cell', async () => {
    for (const failure of ['false', 'throw']) {
      const host = await createEditorHarness({ rows: [['Amount', 'Note'], ['2', 'one'], ['10', 'two']] });
      const apply = host.applyEdit;
      host.applyEdit = async () => { if (failure === 'throw') { throw new Error('test edit rejection'); } return false; };
      await host.receive({ type: 'editCell', row: 1, col: 1, value: 'unapplied draft' });
      const blocked = await update(host, 1, [{ column: 0, operator: 'greaterThan', value: '0' }]);
      assert.ok(blocked.error.includes('failed cell edit'));
      assert.strictEqual(blocked.filterEpoch, 0);
      assert.deepStrictEqual(saved(host), []);
      host.applyEdit = apply;
      await host.receive({ type: 'editCell', row: 1, col: 1, value: 'retry draft' });
      const view = createWebviewDom(host.panel.webview.html);
      try { await flushViewCommits(host, view); }
      finally { view.close(); }
      const result = await update(host, 2, [{ column: 0, operator: 'greaterThan', value: '0' }]);
      assert.strictEqual(result.error, undefined);
      assert.strictEqual(result.filterEpoch, 2);
      assert.strictEqual(host.rows()[1][1], 'retry draft');
    }
  });

  it('scopes chunks and revisions to the accepted epoch and current webview session', async () => {
    const host = await createEditorHarness({ rows: [['Name'], ...Array.from({ length: 1001 }, (_, index) => [`row${index}`])], remote: true });
    const initial = metadata(host), html = host.panel.webview.html;
    const accepted = await update(host, 1, [{ column: 0, operator: 'notEmpty', value: '' }]);
    const cursor = host.messages.length;
    for (const request of [{ filterEpoch: 0, session: initial.session }, { filterEpoch: 1, session: 'old-view' }, { session: initial.session }]) {
      await host.receive({ type: 'requestChunk', start: 1000, requestId: 'old', ...request });
    }
    assert.strictEqual(host.messages.length, cursor, 'stale/malformed chunk requests cannot append an obsolete result');
    await host.receive({ type: 'requestChunk', start: 1000, requestId: 'current', filterEpoch: 1, session: initial.session });
    const chunk = host.messages.at(-1)!;
    assert.strictEqual(chunk.filterEpoch, accepted.filterEpoch);
    assert.strictEqual(chunk.session, initial.session);
    assert.ok(chunk.html.includes('data-row="1001"'));
    await host.view(false, false); await host.view(true, true);
    const next = metadata(host);
    assert.notStrictEqual(next.session, initial.session);
    assert.strictEqual(next.revision, 0);
    const afterRefresh = host.messages.length;
    await update(host, 100, [], initial.session);
    assert.strictEqual(host.messages.length, afterRefresh);
    const reset = await update(host, 1, [], next.session);
    assert.strictEqual(reset.filterEpoch, 1);
    assert.strictEqual(reset.session, next.session);
    assert.notStrictEqual(host.panel.webview.html, html, 'only the unrelated full refresh replaces HTML');
  });
});


describe('Volatile inline filter draft handoff', () => {
  function draftFor(host: Host, rows = [{ column: 0, operator: 'contains', value: 'volatile draft' }]): any {
    const initial = metadata(host);
    return {
      session: initial.session,
      filterColumnsRevision: initial.filterColumnsRevision,
      columns: initial.columns.map((column: any) => ({ column: column.column, label: column.label })),
      rows
    };
  }
  async function acknowledge(host: Host, filterDraft: unknown, session = metadata(host).session) {
    await host.receive({ type: 'viewRefreshReady', session, filterDraft });
    return metadata(host);
  }

  for (const separator of [',', '\t']) {
    it(`carries blank/invalid rows and caret once without storing drafts or changing source (${JSON.stringify(separator)})`, async () => {
      const host = await createEditorHarness({ rows: [['Name'], ['one'], ['two']], separator, filters: [{ column: 0, operator: 'contains', value: 'one' }] });
      const previous = JSON.stringify(host.context.workspaceState.values);
      const source = host.document.getText();
      const draft = draftFor(host, [{ column: 0, operator: 'regex', value: 'volatile-[' }, { column: 0, operator: 'contains', value: '' }]);
      draft.focus = { row: 0, field: 'value', selectionStart: 1, selectionEnd: 4, selectionDirection: 'backward' };
      const next = await acknowledge(host, draft);
      assert.deepStrictEqual(next.filterDraft, draft);
      assert.notStrictEqual(next.session, draft.session);
      assert.strictEqual(next.filterColumnsRevision, draft.filterColumnsRevision);
      assert.strictEqual(JSON.stringify(host.context.workspaceState.values), previous);
      assert.strictEqual(host.document.getText(), source);
      assert.strictEqual(host.diskText, source);
      assert.strictEqual(host.document.version, 1);
      assert.strictEqual((await acknowledge(host, undefined)).filterDraft, undefined, 'a later refresh does not replay the consumed draft');
    });
  }

  it('renews a queued ACK for current-session typing and ignores stale-session activity', async () => {
    for (const stale of [false, true]) {
      const host = await createEditorHarness({ rows: [['Name'], ['one']], filters: [{ column: 0, operator: 'contains', value: 'one' }] });
      const controller = CsvEditorProvider.getActiveProvider() as any;
      let release = () => {};
      const gate = new Promise<void>(resolve => { release = resolve; });
      const blocked = controller.enqueueOperation(() => gate) as Promise<void>;
      try {
        await new Promise(resolve => setImmediate(resolve));
        const original = host.panel.webview.html;
        const draft = draftFor(host, [{ column: 0, operator: 'contains', value: 'one' }]);
        controller.refreshViewSafely();
        const request = host.messages.filter(message => message.type === 'prepareViewRefresh').at(-1)!;
        const cursor = host.messages.length;
        const acknowledging = host.receive({ type: 'viewRefreshReady', session: draft.session, requestId: request.requestId, filterDraft: draft });
        await host.receive({ type: 'filterDraftChanged', session: stale ? 'previous-view' : draft.session });
        assert.strictEqual(host.panel.webview.html, original);
        release();
        await Promise.all([blocked, acknowledging]);
        const renewed = host.messages.slice(cursor).find(message => message.type === 'prepareViewRefresh');
        if (stale) {
          assert.strictEqual(renewed, undefined, 'old-view activity cannot renew a current ACK');
          assert.strictEqual(metadata(host).filterDraft.rows[0].value, 'one');
        } else {
          assert.ok(renewed, 'typing received while an ACK waits must request a newer snapshot');
          assert.strictEqual(host.panel.webview.html, original, 'the stale snapshot cannot replace the live view');
          draft.rows[0].value = 'one m';
          await host.receive({ type: 'viewRefreshReady', session: draft.session, requestId: renewed.requestId, filterDraft: draft });
          assert.strictEqual(metadata(host).filterDraft.rows[0].value, 'one m');
        }
        assert.strictEqual(host.document.version, 1);
        assert.strictEqual(host.document.getText(), host.diskText);
      } finally { release(); }
    }
  });

  it('roundtrips only validated true IME markers without saving unfinished text', async () => {
    const host = await createEditorHarness({ rows: [['Name'], ['one']], filters: [{ column: 0, operator: 'contains', value: 'one' }] });
    const stored = JSON.stringify(host.context.workspaceState.values);
    const draft = draftFor(host);
    draft.rows = [{ column: 0, operator: 'contains', value: 'unfinished IME', composing: true }, { column: 0, operator: 'regex', value: '[', composing: false }];
    const next = await acknowledge(host, draft);
    assert.deepStrictEqual(next.filterDraft.rows, [{ column: 0, operator: 'contains', value: 'unfinished IME', composing: true }, { column: 0, operator: 'regex', value: '[' }]);
    assert.strictEqual(JSON.stringify(host.context.workspaceState.values), stored);
    assert.strictEqual(host.document.getText(), host.diskText);
    for (const marker of ['true', 1, null, {}]) {
      const invalid = draftFor(host);
      invalid.rows[0].composing = marker;
      assert.strictEqual((await acknowledge(host, invalid)).filterDraft, undefined);
      assert.strictEqual(JSON.stringify(host.context.workspaceState.values), stored);
    }
  });

  it('retains current intent after a newer valid filter was accepted in the same session', async () => {
    const host = await createEditorHarness({ rows: [['Name'], ['one'], ['two']], filters: [{ column: 0, operator: 'contains', value: 'one' }] });
    const draft = draftFor(host, [{ column: 0, operator: 'contains', value: 'ch' }]);
    draft.focus = { row: 0, field: 'value', selectionStart: 1, selectionEnd: 2, selectionDirection: 'none' };
    const accepted = await update(host, 1, [{ column: 0, operator: 'contains', value: 'two' }]);
    assert.strictEqual(accepted.filterEpoch, 1);
    const refreshed = await acknowledge(host, draft);
    assert.strictEqual(refreshed.filters[0].value, 'two', 'last accepted conditions remain persisted');
    assert.strictEqual(refreshed.filterDraft.rows[0].value, 'ch', 'an undelivered response cannot replace the newer raw draft');
    assert.deepStrictEqual(refreshed.filterDraft.focus, draft.focus);
  });

  it('carries a pending Clear all as an empty draft without prematurely changing preferences', async () => {
    const host = await createEditorHarness({ rows: [['Name'], ['one']], filters: [{ column: 0, operator: 'contains', value: 'one' }] });
    const cleared = draftFor(host, []);
    const next = await acknowledge(host, cleared);
    assert.deepStrictEqual(next.filterDraft.rows, []);
    assert.strictEqual(saved(host).length, 1);
    await update(host, 1, [], next.session);
    assert.deepStrictEqual(saved(host), []);
    assert.strictEqual(host.document.getText(), host.diskText);
  });

  it('rejects malformed, oversized and stale draft state without persisting any draft data', async () => {
    const host = await createEditorHarness({ rows: [['Name'], ['one']] });
    const malformed: Array<(draft: any) => void> = [
      draft => { draft.session = 'previous-view'; },
      draft => { delete draft.filterColumnsRevision; },
      draft => { draft.filterColumnsRevision += 1; },
      draft => { draft.rows = {}; },
      draft => { draft.rows = Array.from({ length: metadata(host).maxFilters + 1 }, () => ({ column: 0, operator: 'contains', value: '' })); },
      draft => { draft.rows[0].column = 1; },
      draft => { draft.rows[0].column = '0'; },
      draft => { draft.rows[0].operator = 'unknown'; },
      draft => { draft.rows[0].value = 'x'.repeat(4097); },
      draft => { draft.columns[0].label = 'another column'; },
      draft => { draft.columns = []; },
      draft => { draft.focus = { row: 1, field: 'value' }; },
      draft => { draft.focus = { row: 0, field: 'unknown' }; },
      draft => { draft.focus = { row: 0, field: 'value', selectionStart: 0, selectionEnd: 100, selectionDirection: 'none' }; },
      draft => { draft.focus = { row: 0, field: 'value', selectionStart: 2, selectionEnd: 1, selectionDirection: 'none' }; },
      draft => { draft.focus = { row: 0, field: 'value', selectionStart: 0, selectionEnd: 1, selectionDirection: 'unknown' }; }
    ];
    const stored = JSON.stringify(host.context.workspaceState.values);
    for (const mutate of malformed) {
      const draft = draftFor(host);
      mutate(draft);
      assert.strictEqual((await acknowledge(host, draft)).filterDraft, undefined);
      assert.strictEqual(JSON.stringify(host.context.workspaceState.values), stored);
    }
    const oldSession = metadata(host).session;
    await acknowledge(host, undefined);
    const html = host.panel.webview.html;
    await acknowledge(host, draftFor(host), oldSession);
    assert.strictEqual(host.panel.webview.html, html, 'an old ACK cannot refresh the new view');
  });

  it('invalidates duplicate-label column reordering while preserving no-op mapping revisions', async () => {
    const host = await createEditorHarness({ rows: [['Same', 'Same'], ['left', 'right']] });
    const initial = metadata(host), stale = draftFor(host);
    assert.strictEqual(initial.filterColumnsRevision, 0);
    await host.receive({ type: 'reorderColumns', indices: [0], beforeIndex: 1 });
    assert.strictEqual(metadata(host).filterColumnsRevision, initial.filterColumnsRevision);
    await host.receive({ type: 'reorderColumns', indices: [0], beforeIndex: 2 });
    const reordered = metadata(host);
    assert.deepStrictEqual(reordered.columns.map((column: any) => column.label), ['Same', 'Same']);
    assert.strictEqual(reordered.filterColumnsRevision, initial.filterColumnsRevision + 1);
    assert.deepStrictEqual(host.rows()[1], ['right', 'left']);
    stale.session = reordered.session;
    assert.strictEqual((await acknowledge(host, stale)).filterDraft, undefined, 'identical labels do not authorize a draft from the old column mapping');
    await host.receive({ type: 'insertColumn', index: 1 });
    const inserted = metadata(host);
    assert.strictEqual(inserted.filterColumnsRevision, reordered.filterColumnsRevision + 1);
    await host.receive({ type: 'deleteColumn', index: 1 });
    assert.strictEqual(metadata(host).filterColumnsRevision, inserted.filterColumnsRevision + 1);
  });

  it('drops drafts when column labels change or the rendered owner URI has rebound', async () => {
    const host = await createEditorHarness({ rows: [['Name'], ['one']] });
    const renamedDraft = draftFor(host);
    await host.receive({ type: 'editCell', row: 0, col: 0, value: 'Renamed' });
    assert.strictEqual((await acknowledge(host, renamedDraft)).filterDraft, undefined, 'changed semantic labels invalidate the old draft');
    const reboundDraft = draftFor(host);
    const OldUri = host.document.uri.constructor as new (path: string) => typeof host.document.uri;
    host.document.uri = new OldUri('/test/rebound.csv');
    const rebound = await acknowledge(host, reboundDraft);
    assert.strictEqual(rebound.filterDraft, undefined, 'a session belongs to its original URI even when the live owner changes before ACK');
    assert.strictEqual(host.rows()[0][0], 'Renamed');
    assert.ok(!host.diskText.includes('Renamed'));
  });
});
