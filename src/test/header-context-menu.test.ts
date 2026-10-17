import assert from 'assert';
import { describe, it } from 'node:test';
import { createEditorHarness, createWebviewDom } from './edit-integrity-harness';
const { CsvEditorProvider } = require('../CsvEditorProvider') as typeof import('../CsvEditorProvider');

type Host = Awaited<ReturnType<typeof createEditorHarness>>;
type View = ReturnType<typeof createWebviewDom>;
const rows = [['Name', 'Value'], ['one', 'two'], ['three', 'four']];
const settle = () => new Promise(resolve => setTimeout(resolve, 20));

function openMenu(view: View, row: number, column: number) {
  const target = view.cell(row, column);
  assert.ok(target);
  target.dispatchEvent(new view.window.MouseEvent('mousedown', { button: 2, bubbles: true, cancelable: true }));
  target.dispatchEvent(new view.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  return Array.from(view.window.document.querySelectorAll('#contextMenu div')) as any[];
}

function chooseHeader(view: View, row: number, column: number, enabled: boolean) {
  const label = enabled ? 'Use first row as header' : 'Treat first row as data';
  const item = openMenu(view, row, column).find(element => element.textContent === label);
  assert.ok(item, label);
  item.click();
  const message = view.messages.slice().reverse().find((item: any) => item.type === 'setHeader');
  assert.strictEqual(message.enabled, enabled);
  return message;
}

async function finishRefresh(host: Host, view: View, start = 0) {
  const prepare = host.messages.slice(start).reverse().find((message: any) => message.type === 'prepareViewRefresh');
  if (prepare) {
    const begin = view.messages.length;
    view.window.dispatchEvent(new view.window.MessageEvent('message', { data: prepare }));
    for (const message of view.messages.slice(begin)) { await host.receive(message); }
  }
  await settle();
}

async function applyHeader(host: Host, view: View, message: unknown) {
  const start = host.messages.length;
  await host.receive(message);
  await finishRefresh(host, view, start);
}

describe('File header context action', () => {
  for (const separator of [',', '\t']) {
    for (const header of [false, true]) {
      it(`toggles the file header from either first-row column (${JSON.stringify(separator)}, header ${header})`, async () => {
        for (const column of [0, 1]) {
          const host = await createEditorHarness({ rows, separator, header });
          const view = createWebviewDom(host.panel.webview.html);
          const source = host.document.getText();
          const version = host.document.version;
          try {
            await applyHeader(host, view, chooseHeader(view, 0, column, !header));
            const next = createWebviewDom(host.panel.webview.html);
            try {
              assert.strictEqual(!!next.window.document.querySelector('thead'), !header);
              const reverse = header ? 'Use first row as header' : 'Treat first row as data';
              assert.ok(openMenu(next, 0, column).some(item => item.textContent === reverse));
            } finally { next.close(); }
            assert.strictEqual(host.document.getText(), source);
            assert.strictEqual(host.document.version, version);
          } finally { view.close(); }
        }
      });
    }
  }

  it('uses the effective detected state rather than the stored fallback', async () => {
    const host = await createEditorHarness({ rows, header: true });
    const initial = createWebviewDom(host.panel.webview.html);
    const controller = CsvEditorProvider.getActiveProvider()!;
    const context = (controller as any).context;
    try {
      await context.workspaceState.update(CsvEditorProvider.headerKey, {});
      controller.refresh();
      await finishRefresh(host, initial);
      const view = createWebviewDom(host.panel.webview.html);
      try {
        assert.strictEqual(view.window.document.querySelector('thead'), null);
        await applyHeader(host, view, chooseHeader(view, 0, 1, true));
        assert.strictEqual(CsvEditorProvider.getHeaderForUri(context, host.document.uri as any), true);
        assert.strictEqual(CsvEditorProvider.hasHeaderOverride(context, host.document.uri as any), true);
        const next = createWebviewDom(host.panel.webview.html);
        try { assert.ok(next.window.document.querySelector('thead')); } finally { next.close(); }
      } finally { view.close(); }
    } finally { initial.close(); }
  });

  it('targets the owning file even when another CSV editor becomes active', async () => {
    const host = await createEditorHarness({ rows, header: true });
    const view = createWebviewDom(host.panel.webview.html);
    const other = await createEditorHarness({ rows, separator: '\t', header: true });
    try {
      await applyHeader(host, view, chooseHeader(view, 0, 1, false));
      const next = createWebviewDom(host.panel.webview.html);
      const untouched = createWebviewDom(other.panel.webview.html);
      try {
        assert.strictEqual(next.window.document.querySelector('thead'), null);
        assert.ok(untouched.window.document.querySelector('thead'));
      } finally { next.close(); untouched.close(); }
    } finally { view.close(); }
  });

  it('rejects non-boolean header messages without changing the setting or view', async () => {
    const host = await createEditorHarness({ rows, header: true });
    const html = host.panel.webview.html;
    for (const enabled of [undefined, null, 'false', 0, 1, {}]) {
      await host.receive({ type: 'setHeader', enabled });
    }
    await settle();
    assert.strictEqual(host.panel.webview.html, html);
    assert.deepStrictEqual(host.rows(), rows);
  });

  it('persists the clicked anchor and scroll, including a header after hidden metadata', async () => {
    const host = await createEditorHarness({ rows: [['metadata', ''], ...rows], header: false });
    const initial = createWebviewDom(host.panel.webview.html);
    const controller = CsvEditorProvider.getActiveProvider()!;
    const context = (controller as any).context;
    try {
      await CsvEditorProvider.setHiddenRowsForUri(context, host.document.uri as any, 1);
      controller.refresh();
      await finishRefresh(host, initial);
      const view = createWebviewDom(host.panel.webview.html);
      try {
        const container = view.window.document.querySelector('.table-container');
        container.scrollLeft = 40;
        container.scrollTop = 120;
        await applyHeader(host, view, chooseHeader(view, 1, 1, true));
        const saved = view.window.acquireVsCodeApi().getState();
        assert.strictEqual(saved.anchorRow, 1);
        assert.strictEqual(saved.anchorCol, 1);
        assert.strictEqual(saved.scrollX, 40);
        assert.strictEqual(saved.scrollY, 120);
        const next = createWebviewDom(host.panel.webview.html);
        try {
          next.window.acquireVsCodeApi().setState(saved);
          next.window.dispatchEvent(new next.window.Event('focus'));
          await settle();
          assert.strictEqual(next.cell(1, 1).tagName, 'TH');
          assert.ok(next.cell(1, 1).classList.contains('selected'));
          assert.strictEqual(next.window.document.querySelector('.table-container').scrollTop, 120);
          assert.strictEqual(next.cell(0, 0), null);
        } finally { next.close(); }
        assert.deepStrictEqual(host.rows(), [['metadata', ''], ...rows]);
      } finally { view.close(); }
    } finally { initial.close(); }
  });

  it('can switch off an empty file header preference even without a rendered header', async () => {
    const host = await createEditorHarness({ rows: [], header: true });
    const view = createWebviewDom(host.panel.webview.html);
    try {
      assert.strictEqual(view.window.document.querySelector('thead'), null);
      await applyHeader(host, view, chooseHeader(view, 0, 0, false));
      const next = createWebviewDom(host.panel.webview.html);
      try {
        assert.ok(openMenu(next, 0, 0).some(item => item.textContent === 'Use first row as header'));
      } finally { next.close(); }
      assert.strictEqual(host.document.getText(), '');
    } finally { view.close(); }
  });

  it('keeps the first displayed row actionable when hidden metadata exceeds the file length', async () => {
    const host = await createEditorHarness({ rows, header: true });
    const initial = createWebviewDom(host.panel.webview.html);
    const controller = CsvEditorProvider.getActiveProvider()!;
    const context = (controller as any).context;
    try {
      await CsvEditorProvider.setHiddenRowsForUri(context, host.document.uri as any, 10);
      controller.refresh();
      await finishRefresh(host, initial);
      const view = createWebviewDom(host.panel.webview.html);
      try {
        await applyHeader(host, view, chooseHeader(view, rows.length, 0, false));
        assert.strictEqual(CsvEditorProvider.getHeaderForUri(context, host.document.uri as any), false);
        assert.deepStrictEqual(host.rows(), rows);
      } finally { view.close(); }
    } finally { initial.close(); }
  });

  it('only offers the header action on first-row cells, with headers on or off', async () => {
    for (const header of [true, false]) {
      const host = await createEditorHarness({ rows, header });
      const view = createWebviewDom(host.panel.webview.html);
      try {
        const label = header ? 'Treat first row as data' : 'Use first row as header';
        for (const column of [0, 1]) {
          assert.ok(openMenu(view, 0, column).some(item => item.textContent === label));
        }
        for (const [row, column] of [[1, 0], [1, -1], [2, 1], [3, 1]]) {
          const items = openMenu(view, row, column);
          assert.ok(!items.some(item => item.textContent === label));
          assert.ok(items.some(item => item.textContent === 'Copy'), 'later cells retain normal context actions');
        }
      } finally { view.close(); }
    }
  });
});
