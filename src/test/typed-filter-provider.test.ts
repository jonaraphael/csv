import assert from 'assert';
import { describe, it } from 'node:test';
import { createEditorHarness, createWebviewDom } from './edit-integrity-harness';
const { CsvEditorProvider } = require('../CsvEditorProvider') as typeof import('../CsvEditorProvider');

type Host = Awaited<ReturnType<typeof createEditorHarness>>;
type View = ReturnType<typeof createWebviewDom>;
const sharedOperators = ['contains', 'notContains', 'regex', 'equals', 'notEquals', 'empty', 'notEmpty'];
const orderedOperators = ['greaterThan', 'greaterThanOrEqual', 'lessThan', 'lessThanOrEqual'];
const saved = (host: Host) => CsvEditorProvider.getColumnFiltersForUri(host.context as any, host.document.uri as any);
const settle = () => new Promise(resolve => setTimeout(resolve, 20));

async function finishRefresh(host: Host, view: View, start = 0) {
  let cursor = start;
  for (let guard = 0; guard < 5; guard++) {
    const pending = host.messages.slice(cursor).filter((message: any) => message.type === 'prepareViewRefresh');
    cursor = host.messages.length;
    if (!pending.length) { break; }
    for (const message of pending) {
      const begin = view.messages.length;
      view.window.dispatchEvent(new view.window.MessageEvent('message', { data: message }));
      for (const response of view.messages.slice(begin)) { await host.receive(response); }
    }
  }
  await settle();
}

function choose(host: Host, operator: string, value?: string) {
  host.filterChoice = (items: any[]) => items.find(item => item.operator === operator);
  host.filterInput = value;
}

function sourceRows(view: View) {
  return Array.from(view.window.document.querySelectorAll('tbody tr')).map((row: any) => Number(row.querySelector('[data-row]').getAttribute('data-row')));
}

describe('Typed column filter provider', () => {
  for (const separator of [',', '\t']) {
    it(`offers inferred operators from original body values (${JSON.stringify(separator)})`, async () => {
      const host = await createEditorHarness({ rows: [['Text', 'Amount', 'When', 'Enabled'], ['hello', '2', '2026-01-01', 'yes'], ['world', '10.5', '2026-02-01', 'OFF']], separator });
      for (const [column, type] of ['text', 'number', 'date', 'boolean'].entries()) {
        await host.receive({ type: 'configureColumnFilter', column });
        const call = host.quickPickCalls.at(-1)!;
        assert.ok(call.options.placeHolder.includes(`inferred ${type}`));
        for (const operator of sharedOperators) { assert.ok(call.items.some(item => item.operator === operator)); }
        for (const operator of orderedOperators) {
          assert.strictEqual(call.items.some(item => item.operator === operator), type === 'number' || type === 'date');
        }
      }
      assert.strictEqual(host.inputBoxCalls.length, 0, 'cancelling the operator picker does not ask for a threshold');
      assert.deepStrictEqual(saved(host), []);
      assert.strictEqual(host.document.version, 1);
    });
  }

  it('ignores metadata and the effective header but includes nonmatching original rows in inference', async () => {
    const rows = [['metadata', 'ignored'], ['Amount', 'Group'], ['2', 'show'], ['not numeric', 'hide']];
    const host = await createEditorHarness({ rows, header: true, hiddenRows: 1, filters: [{ column: 1, operator: 'equals', value: 'show' }] });
    await host.receive({ type: 'configureColumnFilter', column: 0 });
    assert.ok(host.quickPickCalls.at(-1)!.options.placeHolder.includes('inferred text'));
    assert.ok(!host.quickPickCalls.at(-1)!.items.some(item => item.operator === 'greaterThan'));
    await CsvEditorProvider.setColumnFiltersForUri(host.context as any, host.document.uri as any, []);
    await host.receive({ type: 'configureColumnFilter', column: 0 });
    assert.deepStrictEqual(host.quickPickCalls[0].items, host.quickPickCalls[1].items);
    const numeric = await createEditorHarness({ rows: [['not numeric metadata'], ['Amount'], ['2'], ['10.5']], header: true, hiddenRows: 1 });
    await numeric.receive({ type: 'configureColumnFilter', column: 0 });
    assert.ok(numeric.quickPickCalls.at(-1)!.options.placeHolder.includes('inferred number'));
  });

  it('recognizes complete mixed-format date cells for filters without changing legacy inference or colors', async () => {
    const values = ['2026-01-01', 'February 1, 2026 12:00 UTC', '03/01/2026'];
    const host = await createEditorHarness({ rows: [['When', 'State'], ...values.map(value => [value, 'keep']), ['', 'keep']], filters: [{ column: 1, operator: 'equals', value: 'keep' }] });
    const view = createWebviewDom(host.panel.webview.html);
    try {
      const html = host.panel.webview.html;
      const colors = Array.from(view.window.document.querySelectorAll('[data-col="0"]')).map((cell: any) => cell.style.color);
      assert.strictEqual(CsvEditorProvider.__test.isDate('1/2/2024'), false);
      assert.strictEqual(CsvEditorProvider.__test.estimateColumnDataType(values), 'string');
      await host.receive({ type: 'configureColumnFilter', column: 0 });
      assert.ok(host.quickPickCalls.at(-1)!.options.placeHolder.includes('inferred date'));
      assert.ok(host.quickPickCalls.at(-1)!.items.some(item => item.operator === 'greaterThan'));
      assert.strictEqual(host.panel.webview.html, html);
      assert.deepStrictEqual(Array.from(view.window.document.querySelectorAll('[data-col="0"]')).map((cell: any) => cell.style.color), colors);
      assert.strictEqual(CsvEditorProvider.__test.isDate('1/2/2024'), false);
    } finally { view.close(); }
    for (const value of ['2026', '12345678', 'not a date']) {
      const plain = await createEditorHarness({ rows: [['Value'], [value]] });
      await plain.receive({ type: 'configureColumnFilter', column: 0 });
      assert.ok(!plain.quickPickCalls.at(-1)!.options.placeHolder.includes('inferred date'));
    }
  });

  it('respects headers off and the existing automatic header decision', async () => {
    const data = [['Amount'], ['2'], ['10']];
    const noHeader = await createEditorHarness({ rows: data, header: false });
    await noHeader.receive({ type: 'configureColumnFilter', column: 0 });
    assert.ok(noHeader.quickPickCalls.at(-1)!.options.placeHolder.includes('inferred text'));
    const auto = await createEditorHarness({ rows: data });
    await auto.context.workspaceState.update(CsvEditorProvider.headerKey, {});
    await auto.receive({ type: 'configureColumnFilter', column: 0 });
    assert.ok(auto.quickPickCalls.at(-1)!.options.placeHolder.includes('inferred number'));
  });

  for (const separator of [',', '\t']) {
    it(`persists numeric comparisons and renders human labels with original row IDs (${JSON.stringify(separator)})`, async () => {
      const data = [['Amount', 'Name'], ['2', 'low'], ['10', 'equal'], ['15', 'high']];
      const host = await createEditorHarness({ rows: data, separator });
      const view = createWebviewDom(host.panel.webview.html);
      const source = host.document.getText(), disk = host.diskText;
      try {
        choose(host, 'greaterThanOrEqual', '1e1');
        await host.receive({ type: 'configureColumnFilter', column: 0 });
        assert.deepStrictEqual(saved(host), [{ column: 0, operator: 'greaterThanOrEqual', value: '1e1', dataType: 'number' }]);
        assert.strictEqual(host.inputBoxCalls.at(-1).validateInput('10junk')?.includes('number'), true);
        await finishRefresh(host, view);
        const next = createWebviewDom(host.panel.webview.html);
        try {
          assert.deepStrictEqual(sourceRows(next), [2, 3, 4]);
          const status = next.window.document.getElementById('filterStatus');
          assert.ok(status.textContent.includes('2 of 3 rows'));
          assert.ok(status.textContent.includes('Greater Than or Equal "1e1"'));
          assert.ok(!status.textContent.includes('greaterThanOrEqual'));
        } finally { next.close(); }
        assert.strictEqual(host.document.getText(), source);
        assert.strictEqual(host.document.version, 1);
        assert.strictEqual(host.diskText, disk);
      } finally { view.close(); }
    });
  }

  it('uses numeric equality rather than text equality and leaves blanks unmatched for typed inequality', async () => {
    const host = await createEditorHarness({ rows: [['Amount', 'Name'], ['10', 'one'], ['10.0', 'two'], ['', 'blank'], ['20', 'other']] });
    const view = createWebviewDom(host.panel.webview.html);
    try {
      choose(host, 'notEquals', '10');
      await host.receive({ type: 'configureColumnFilter', column: 0 });
      await finishRefresh(host, view);
      const next = createWebviewDom(host.panel.webview.html);
      try { assert.deepStrictEqual(sourceRows(next), [4, 5]); } finally { next.close(); }
      assert.strictEqual(saved(host)[0].dataType, 'number');
    } finally { view.close(); }
  });

  it('uses typed boolean vocabulary and broad explicit date queries without changing column inference', async () => {
    const host = await createEditorHarness({ rows: [['When', 'Enabled'], ['2026-02-01T12:00Z', 'yes'], ['2026-02-02T12:00Z', 'OFF'], ['2026-01-31T12:00Z', 'true']] });
    const view = createWebviewDom(host.panel.webview.html);
    try {
      choose(host, 'equals', 'ON');
      await host.receive({ type: 'configureColumnFilter', column: 1 });
      assert.strictEqual(saved(host)[0].dataType, 'boolean');
      choose(host, 'greaterThanOrEqual', 'February 1, 2026 12:00 UTC');
      await host.receive({ type: 'configureColumnFilter', column: 0 });
      assert.strictEqual(saved(host)[0].dataType, 'date');
      await finishRefresh(host, view);
      const next = createWebviewDom(host.panel.webview.html);
      try { assert.deepStrictEqual(sourceRows(next), [1, 4]); } finally { next.close(); }
      assert.ok(host.inputBoxCalls.at(-1).prompt.includes('UTC'));
    } finally { view.close(); }
  });

  it('keeps text operators untyped even on inferred numeric columns', async () => {
    const host = await createEditorHarness({ rows: [['Amount'], ['2'], ['10']] });
    for (const [operator, value] of [['contains', '2'], ['notContains', '2'], ['regex', '^1'], ['empty', ''], ['notEmpty', '']]) {
      choose(host, operator, value);
      await host.receive({ type: 'configureColumnFilter', column: 0 });
      assert.strictEqual(saved(host)[0].operator, operator);
      assert.ok(!Object.prototype.hasOwnProperty.call(saved(host)[0], 'dataType'));
    }
    const text = await createEditorHarness({ rows: [['Name'], ['ONE'], ['two']] });
    choose(text, 'notEquals', 'one');
    await text.receive({ type: 'configureColumnFilter', column: 0 });
    assert.ok(!Object.prototype.hasOwnProperty.call(saved(text)[0], 'dataType'));
  });

  it('rechecks invalid thresholds and regex after input returns, preserving the previous filter and source', async () => {
    for (const [rows, operator, input] of [
      [[['Amount'], ['2'], ['10']], 'greaterThan', '10junk'],
      [[['Amount'], ['2'], ['10']], 'equals', 'Infinity'],
      [[['Amount'], ['2'], ['10']], 'lessThan', ''],
      [[['When'], ['2026-01-01'], ['2026-02-01']], 'equals', '2026-02-30'],
      [[['Enabled'], ['yes'], ['no']], 'equals', 'maybe'],
      [[['Name'], ['one'], ['two']], 'regex', '['],
      [[['Name'], ['one'], ['two']], 'regex', '(?=one)'],
      [[['Name'], ['one'], ['two']], 'regex', '/one/g'],
      [[['Name'], ['one'], ['two']], 'contains', 'x'.repeat(4097)]
    ] as const) {
      const previous = [{ column: 0, operator: 'contains', value: 'one' }];
      const host = await createEditorHarness({ rows: rows.map(row => [...row]), filters: previous });
      const source = host.document.getText(), html = host.panel.webview.html;
      choose(host, operator, input);
      await host.receive({ type: 'configureColumnFilter', column: 0 });
      assert.strictEqual(typeof host.inputBoxCalls.at(-1).validateInput(input), 'string');
      assert.deepStrictEqual(saved(host), previous);
      assert.strictEqual(host.panel.webview.html, html);
      assert.ok(!host.messages.some(message => message.type === 'prepareViewRefresh'));
      assert.strictEqual(host.document.getText(), source);
      assert.strictEqual(host.document.version, 1);
    }
  });

  it('leaves the previous condition unchanged when the operator or threshold picker is cancelled', async () => {
    const previous = [{ column: 0, operator: 'equals', value: '2', dataType: 'number' }];
    const host = await createEditorHarness({ rows: [['Amount'], ['2'], ['10']], filters: previous });
    await host.receive({ type: 'configureColumnFilter', column: 0 });
    choose(host, 'greaterThan', undefined);
    await host.receive({ type: 'configureColumnFilter', column: 0 });
    assert.deepStrictEqual(saved(host), previous);
    assert.ok(!host.messages.some(message => message.type === 'prepareViewRefresh'));
    assert.strictEqual(host.document.version, 1);
  });

  it('escapes human regex labels and keeps invalid persisted conditions visible and removable', async () => {
    for (const value of ['<script>', '[']) {
      const host = await createEditorHarness({ rows: [['<Name>'], ['one'], ['<script>']], filters: [{ column: 0, operator: 'regex', value }] });
      const view = createWebviewDom(host.panel.webview.html);
      try {
        const status = view.window.document.getElementById('filterStatus');
        assert.ok(status.textContent.includes(`Regular Expression ${JSON.stringify(value)}`));
        assert.strictEqual(status.querySelector('script'), null);
        assert.ok(host.panel.webview.html.includes('&lt;Name&gt;'));
        assert.deepStrictEqual(sourceRows(view), value === '[' ? [3] : [2, 3]);
        status.querySelector('[data-clear-filter]').click();
        await host.receive(view.messages.find(message => message.type === 'clearColumnFilter'));
        await finishRefresh(host, view);
        assert.deepStrictEqual(saved(host), []);
      } finally { view.close(); }
    }
  });

  it('commits an unposted multiline draft before a newly configured typed predicate refreshes the view', async () => {
    const host = await createEditorHarness({ rows: [['Amount', 'Note'], ['2', 'one'], ['10', 'two']] });
    const view = createWebviewDom(host.panel.webview.html);
    try {
      view.start(view.cell(1, 1));
      view.type('unposted\nmultiline');
      choose(host, 'greaterThanOrEqual', '2');
      await host.receive({ type: 'configureColumnFilter', column: 0 });
      assert.strictEqual(host.rows()[1][1], 'one');
      await finishRefresh(host, view);
      assert.ok(host.rows()[1][1].includes('multiline'));
      assert.ok(!host.diskText.includes('multiline'));
      assert.strictEqual(saved(host)[0].dataType, 'number');
      const next = createWebviewDom(host.panel.webview.html);
      try { assert.ok(next.cell(1, 1).textContent.includes('multiline')); } finally { next.close(); }
    } finally { view.close(); }
  });
});
