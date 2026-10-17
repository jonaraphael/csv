import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { describe, it } from 'node:test';
import { createEditorHarness, createWebviewDom, flushViewCommits } from './edit-integrity-harness';
const { CsvEditorProvider } = require('../CsvEditorProvider') as typeof import('../CsvEditorProvider');
const { JSDOM } = require('jsdom');

type Host = Awaited<ReturnType<typeof createEditorHarness>>;
type View = ReturnType<typeof createWebviewDom>;
const waitForInput = () => new Promise(resolve => setTimeout(resolve, 130));
const saved = (host: Host) => CsvEditorProvider.getColumnFiltersForUri(host.context as any, host.document.uri as any);
function deliver(view: View, message: any) {
  view.window.dispatchEvent(new view.window.MessageEvent('message', { data: message }));
}
function change(view: View, input: any, value: string) {
  input.focus();
  input.value = value;
  input.dispatchEvent(new view.window.Event('input', { bubbles: true }));
}
function menu(view: View, cell: any): any[] {
  cell.dispatchEvent(new view.window.MouseEvent('mousedown', { button: 2, bubbles: true, cancelable: true }));
  cell.dispatchEvent(new view.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 100, clientY: 40 }));
  return Array.from(view.window.document.querySelectorAll('#contextMenu div'));
}
async function applyBlankDraft(host: Host, view: View) {
  const cursor = view.messages.length;
  view.window.csvColumnFilters.add(0);
  await waitForInput();
  const request = view.messages.slice(cursor).find(message => message.type === 'updateColumnFilters');
  assert.ok(request);
  const before = host.messages.length;
  await host.receive(request);
  const result = host.messages.slice(before).find(message => message.type === 'columnFiltersResult');
  assert.ok(result);
  deliver(view, result);
  return result;
}

describe('Inline filters with integrated draft and view state', () => {
  for (const failure of ['false', 'throw'] as const) {
    for (const recovery of ['retry', 'discard'] as const) {
      it(`retains a delayed ${failure} cell draft and old predicates until ${recovery}`, async () => {
        for (const separator of [',', '\t']) {
          const previous = [{ column: 0, operator: 'contains', value: 'one' }];
          const host = await createEditorHarness({ separator, rows: [['Name', 'Note'], ['one', 'original'], ['two', 'other']], filters: previous });
          let view = createWebviewDom(host.panel.webview.html);
          try {
            const table = view.window.document.querySelector('table');
            const cell = view.cell(1, 1);
            const input = view.window.document.querySelector('[data-filter-value]');
            const html = host.panel.webview.html, disk = host.diskText;
            const cursor = view.messages.length;
            const draft = 'pending first\nsecond line';
            view.start(cell);
            cell.textContent = draft;
            const originalApply = host.applyEdit;
            let rejectEdit = () => {};
            let applying = false;
            host.applyEdit = async () => new Promise<boolean>((resolve, reject) => {
              applying = true;
              rejectEdit = () => failure === 'false' ? resolve(false) : reject(new Error('delayed integration edit failure'));
            });
            change(view, input, 'o');
            await waitForInput();
            const outgoing = view.messages.slice(cursor).filter(message => ['cellEditStarted', 'editCell', 'updateColumnFilters'].includes(message.type));
            assert.ok(outgoing.findIndex(message => message.type === 'editCell') < outgoing.findIndex(message => message.type === 'updateColumnFilters'));
            const pending = outgoing.map(message => host.receive(message));
            await new Promise(resolve => setImmediate(resolve));
            assert.ok(applying, 'the actual queued WorkspaceEdit is still awaiting completion');
            assert.ok(!host.messages.some(message => message.type === 'columnFiltersResult'));
            assert.strictEqual(view.window.document.querySelector('table'), table);
            assert.strictEqual(cell.textContent, draft);
            assert.strictEqual(host.rows()[1][1], 'original');
            rejectEdit();
            await Promise.all(pending);
            const blocked = host.messages.find(message => message.type === 'columnFiltersResult');
            assert.ok(blocked?.error, 'the existing failed-draft guard rejects a partial redraw');
            for (const message of host.messages.filter(message => ['editCellFailed', 'columnFiltersResult'].includes(message.type))) { deliver(view, message); }
            assert.strictEqual(view.window.document.querySelector('table'), table);
            assert.strictEqual(view.cell(1, 1), cell);
            assert.strictEqual(cell.textContent, draft);
            assert.strictEqual(host.rows()[1][1], 'original');
            assert.deepStrictEqual(saved(host), previous);
            assert.strictEqual(host.panel.webview.html, html);
            assert.strictEqual(host.diskText, disk);
            assert.strictEqual(table.getAttribute('aria-busy'), 'false');
            host.applyEdit = originalApply;
            const retryCursor = view.messages.length;
            const hostCursor = host.messages.length;
            view.start(cell);
            if (recovery === 'discard') { view.key('Escape'); }
            else { cell.blur(); }
            const recoveryMessages = view.messages.slice(retryCursor);
            assert.ok(recoveryMessages.some(message => message.type === (recovery === 'discard' ? 'discardCellDraft' : 'editCell')));
            await Promise.all(recoveryMessages.map(message => host.receive(message)));
            for (const message of host.messages.slice(hostCursor).filter(message => message.type === 'updateCell')) { deliver(view, message); }
            await flushViewCommits(host, view);
            assert.strictEqual(host.rows()[1][1], recovery === 'retry' ? draft : 'original');
            assert.strictEqual(host.diskText, disk, 'filter recovery never saves the document');
            assert.deepStrictEqual(saved(host), previous);
            view.close();
            view = createWebviewDom(host.panel.webview.html);
            const freshInput = view.window.document.querySelector('[data-filter-value]');
            const nextCursor = view.messages.length;
            change(view, freshInput, 'o');
            await waitForInput();
            const request = view.messages.slice(nextCursor).find(message => message.type === 'updateColumnFilters');
            assert.ok(request);
            const responses = host.messages.length;
            await host.receive(request);
            const accepted = host.messages.slice(responses).find(message => message.type === 'columnFiltersResult');
            assert.ok(accepted && !accepted.error && !accepted.errors?.length);
            deliver(view, accepted);
            assert.deepStrictEqual(saved(host), [{ column: 0, operator: 'contains', value: 'o' }]);
            assert.ok(view.cell(2, 0), 'both matching source rows appear only after recovery');
            assert.strictEqual(view.cell(1, 1).textContent, recovery === 'retry' ? draft : 'original');
            assert.strictEqual(host.diskText, disk);
          } finally { view.close(); host.dispose(); }
        }
      });
    }
  }

  for (const separator of [',', '\t']) {
    for (const hidden of [false, true]) {
      it(`preserves an explicit header preference without THEAD across live redraws (${JSON.stringify(separator)}, all-hidden ${hidden})`, async () => {
        const host = await createEditorHarness({ separator, text: hidden ? `private${separator}metadata\nmore${separator}hidden` : '', header: true, hiddenRows: hidden ? 99 : 0 });
        let view = createWebviewDom(host.panel.webview.html);
        const source = host.document.getText();
        try {
          assert.strictEqual(view.window.document.querySelector('thead'), null);
          const first = hidden ? 2 : 0;
          for (const enabled of [true, false]) {
            if (!enabled) {
              const action = menu(view, view.cell(first, 0)).find(item => item.textContent === 'Treat first row as data');
              assert.ok(action);
              const cursor = view.messages.length;
              action.click();
              const request = view.messages.slice(cursor).find(message => message.type === 'setHeader');
              assert.deepStrictEqual(JSON.parse(JSON.stringify(request)), { type: 'setHeader', enabled: false });
              await host.receive(request);
              await flushViewCommits(host, view);
              await new Promise(resolve => setTimeout(resolve, 20));
              view.close();
              view = createWebviewDom(host.panel.webview.html);
            }
            const table = view.window.document.querySelector('table');
            const result = await applyBlankDraft(host, view);
            assert.strictEqual(result.headerEnabled, enabled);
            assert.strictEqual(view.window.document.querySelector('table'), table);
            assert.strictEqual(view.window.document.querySelector('thead'), null);
            assert.strictEqual(view.window.document.getElementById('csv-root').dataset.headerenabled, enabled ? '1' : '0');
            const dataMenu = menu(view, view.cell(first, 0));
            assert.ok(dataMenu.some(item => item.textContent === (enabled ? 'Treat first row as data' : 'Use first row as header')));
            assert.ok(!dataMenu.some(item => item.textContent === 'Hide serial index column'));
            const serialMenu = menu(view, view.cell(first, -1));
            assert.ok(serialMenu.some(item => item.textContent === 'Hide serial index column'));
            assert.ok(!serialMenu.some(item => /Sort|column left|column right/i.test(item.textContent)));
            assert.strictEqual(host.document.getText(), source);
            assert.strictEqual(host.document.version, 1);
          }
        } finally { view.close(); host.dispose(); }
      });
    }
  }

  it('updates effective automatic header context when a committed cell edit changes inference before a partial redraw', async () => {
    const host = await createEditorHarness({ rows: [['Title'], ['word']], header: false });
    await host.context.workspaceState.update(CsvEditorProvider.headerKey, {});
    const view = createWebviewDom(host.panel.webview.html);
    try {
      await applyBlankDraft(host, view);
      assert.strictEqual(view.window.document.querySelector('thead'), null);
      const input = view.window.document.querySelector('[data-filter-value]');
      const cursor = view.messages.length;
      view.start(view.cell(1, 0));
      view.cell(1, 0).textContent = '42';
      change(view, input, '');
      await waitForInput();
      const outgoing = view.messages.slice(cursor).filter(message => ['cellEditStarted', 'editCell', 'updateColumnFilters'].includes(message.type));
      const responses = host.messages.length;
      await Promise.all(outgoing.map(message => host.receive(message)));
      const result = host.messages.slice(responses).find(message => message.type === 'columnFiltersResult');
      assert.strictEqual(result.headerEnabled, true);
      deliver(view, result);
      assert.strictEqual(view.cell(0, 0).tagName, 'TH');
      assert.strictEqual(view.window.document.getElementById('csv-root').dataset.headerenabled, '1');
      assert.ok(menu(view, view.cell(0, 0)).some(item => item.textContent === 'Treat first row as data'));
      const corner = view.window.document.querySelector('thead [data-serial-index]');
      assert.ok(corner);
      const cornerMenu = menu(view, corner);
      assert.ok(cornerMenu.some(item => item.textContent === 'Hide serial index column'));
      assert.ok(!cornerMenu.some(item => /Treat first row|Use first row|Sort/.test(item.textContent)));
      assert.strictEqual(host.rows()[1][0], '42');
      assert.ok(!host.diskText.includes('42'));
    } finally { view.close(); host.dispose(); }
  });

  it('keeps newly typed filter text when an earlier queued cell edit changes membership in the active predicate', async () => {
    for (const separator of [',', '\t']) {
      const host = await createEditorHarness({ separator, rows: [['Name', 'Note'], ['one', 'original'], ['two', 'other']], filters: [{ column: 0, operator: 'contains', value: 'one' }] });
      let view = createWebviewDom(host.panel.webview.html);
      try {
        host.deferEdits();
        const cursor = view.messages.length;
        view.start(view.cell(1, 0));
        view.cell(1, 0).textContent = 'changed';
        change(view, view.window.document.querySelector('[data-filter-value]'), 'ch');
        await waitForInput();
        const outgoing = view.messages.slice(cursor).filter(message => ['cellEditStarted', 'editCell', 'updateColumnFilters'].includes(message.type));
        const pending = outgoing.map(message => host.receive(message));
        await new Promise(resolve => setImmediate(resolve));
        assert.strictEqual(host.pendingEdits, 1);
        host.resumeEdits(); host.releaseEdit();
        await Promise.all(pending);
        let hostCursor = 0, viewCursor = view.messages.length;
        let currentHtml = host.panel.webview.html;
        for (let round = 0; round < 6; round++) {
          const hostMessages = host.messages.slice(hostCursor);
          hostCursor = host.messages.length;
          for (const message of hostMessages) {
            const begin = view.messages.length;
            deliver(view, message);
            await Promise.all(view.messages.slice(begin).map(response => host.receive(response)));
            viewCursor = view.messages.length;
            if (host.panel.webview.html !== currentHtml) {
              view.close();
              currentHtml = host.panel.webview.html;
              view = createWebviewDom(currentHtml);
              viewCursor = 0;
            }
          }
          await waitForInput();
          const followups = view.messages.slice(viewCursor);
          viewCursor = view.messages.length;
          await Promise.all(followups.map(message => host.receive(message)));
          if (hostCursor === host.messages.length && !followups.length) { break; }
        }
        const input = view.window.document.querySelector('[data-filter-value]');
        assert.strictEqual(input.value, 'ch', 'a membership refresh must retain the newly typed filter draft');
        assert.deepStrictEqual(saved(host), [{ column: 0, operator: 'contains', value: 'ch' }], 'the latest live query eventually applies without another key');
        assert.strictEqual(view.cell(1, 0).textContent, 'changed');
        assert.strictEqual(view.cell(2, 0), null);
        assert.strictEqual(host.rows()[1][0], 'changed');
        assert.strictEqual(host.document.version, 2);
        assert.ok(!host.diskText.includes('changed'));
      } finally { view.close(); host.dispose(); }
    }
  });

  it('does not reveal a detached navigation target on the next frame after a live table swap', async () => {
    const host = await createEditorHarness({ rows: Array.from({ length: 20 }, (_, row) => [`row${row}`]), header: false, serialIndex: false, frozenRows: 0 });
    const dom = new JSDOM(host.panel.webview.html, { runScripts: 'outside-only', pretendToBeVisual: true });
    const { window } = dom;
    const frames = new Map<number, (time: number) => void>();
    let frame = 0, state: any = {};
    const messages: any[] = [], scrolls: any[] = [];
    window.requestAnimationFrame = (callback: (time: number) => void) => { const id = ++frame; frames.set(id, callback); return id; };
    window.cancelAnimationFrame = (id: number) => { frames.delete(id); };
    window.IntersectionObserver = class { observe() {} disconnect() {} };
    window.HTMLElement.prototype.scrollIntoView = () => {};
    window.acquireVsCodeApi = () => ({ postMessage: (message: any) => messages.push(message), getState: () => state, setState: (next: any) => { state = next; } });
    const container = window.document.querySelector('.table-container');
    const table = container.querySelector('table');
    Object.defineProperties(container, { clientWidth: { value: 100 }, clientHeight: { value: 80 }, clientTop: { value: 0 }, clientLeft: { value: 0 } });
    container.getBoundingClientRect = () => ({ left: 0, top: 0, right: 100, bottom: 80, width: 100, height: 80 });
    container.scrollTo = (position: any) => scrolls.push(position);
    const nativeRect = window.HTMLElement.prototype.getBoundingClientRect;
    window.HTMLElement.prototype.getBoundingClientRect = function (this: any) {
      if (!this.hasAttribute('data-row')) { return nativeRect.call(this); }
      const top = Number(this.dataset.row) * 24;
      return { left: 0, right: 80, top, bottom: top + 24, width: 80, height: 24 };
    };
    const flush = () => {
      for (let pass = 0; frames.size && pass < 10; pass++) {
        const callbacks = [...frames.values()]; frames.clear();
        callbacks.forEach(callback => callback(pass * 16));
      }
      assert.strictEqual(frames.size, 0);
    };
    try {
      for (const script of ['frozen-panes.js', 'column-filters.js', 'main.js']) {
        window.eval(fs.readFileSync(path.join(process.cwd(), 'media', script), 'utf8') + (script === 'main.js' ? '\nwindow.revealTestApi={select:setSingleSelection};' : ''));
      }
      await new Promise(resolve => setTimeout(resolve, 20)); flush(); scrolls.length = 0;
      const old = table.querySelector('[data-row="10"][data-col="0"]');
      window.revealTestApi.select(old);
      assert.ok(frames.size > 0, 'selection has queued a reveal for a target beyond the viewport');
      const cursor = messages.length;
      window.csvColumnFilters.add(0);
      const input = window.document.querySelector('[data-filter-value]');
      await waitForInput();
      const request = messages.slice(cursor).find(message => message.type === 'updateColumnFilters');
      assert.ok(request);
      const responses = host.messages.length;
      await host.receive(request);
      const result = host.messages.slice(responses).find(message => message.type === 'columnFiltersResult');
      window.dispatchEvent(new window.MessageEvent('message', { data: result }));
      assert.strictEqual(old.isConnected, false);
      assert.strictEqual(window.document.querySelector('table'), table);
      assert.notStrictEqual(table.querySelector('[data-row="10"][data-col="0"]'), old);
      flush();
      assert.deepStrictEqual(scrolls, [], 'the detached target cannot move the current viewport');
      assert.strictEqual(window.document.activeElement, input);
      assert.strictEqual(host.document.version, 1);
    } finally { window.close(); host.dispose(); }
  });

  it('retains filter typing after its refresh ACK was captured but before the operation queue consumes it', async () => {
    for (const separator of [',', '\t']) {
      const source = [['Name'], ['one'], ['one more'], ['two']];
      const host = await createEditorHarness({ separator, rows: source, filters: [{ column: 0, operator: 'contains', value: 'one' }] });
      let view = createWebviewDom(host.panel.webview.html);
      let release = () => {};
      try {
        // Gate the actual ordered queue without a cell mutation, which would
        // independently require a fresh cell ACK and conceal filter-only activity.
        const gate = new Promise<void>(resolve => { release = resolve; });
        const blocked = (host.activeController as any).enqueueOperation(() => gate) as Promise<void>;
        await new Promise(resolve => setImmediate(resolve));
        const originalHtml = host.panel.webview.html;
        host.requestViewCommit();
        const prepare = host.messages.filter(message => message.type === 'prepareViewRefresh').slice(-1)[0];
        assert.ok(prepare);
        deliver(view, prepare);
        const ack = view.messages.filter(message => message.type === 'viewRefreshReady').slice(-1)[0];
        assert.strictEqual(ack.filterDraft.rows[0].value, 'one');
        const acknowledging = host.receive(ack);
        assert.strictEqual(host.panel.webview.html, originalHtml, 'the actual refresh ACK is still queued behind the gate');

        const input = view.window.document.querySelector('[data-filter-value]');
        const activityCursor = view.messages.length;
        change(view, input, 'one m');
        // Forward synchronous activity before debounce. This must invalidate the
        // queued ACK even though the next filter snapshot has not been sent yet.
        const activity = view.messages.slice(activityCursor).map(message => host.receive(message));
        let viewCursor = view.messages.length;
        let hostCursor = host.messages.length;
        let currentHtml = originalHtml;
        release();
        await Promise.all([blocked, acknowledging, ...activity]);
        const recreate = () => {
          if (host.panel.webview.html === currentHtml) { return; }
          view.close();
          currentHtml = host.panel.webview.html;
          view = createWebviewDom(currentHtml);
          viewCursor = 0;
        };
        recreate();
        for (let round = 0; round < 8; round++) {
          const incoming = host.messages.slice(hostCursor);
          hostCursor = host.messages.length;
          for (const message of incoming) {
            const start = view.messages.length;
            deliver(view, message);
            await Promise.all(view.messages.slice(start).map(response => host.receive(response)));
            viewCursor = view.messages.length;
            recreate();
          }
          await waitForInput();
          const outgoing = view.messages.slice(viewCursor);
          viewCursor = view.messages.length;
          await Promise.all(outgoing.map(message => host.receive(message)));
          recreate();
          if (hostCursor === host.messages.length && !outgoing.length) { break; }
        }
        assert.strictEqual(view.window.document.querySelector('[data-filter-value]').value, 'one m', 'typing after ACK capture must survive the queued full refresh');
        assert.deepStrictEqual(saved(host), [{ column: 0, operator: 'contains', value: 'one m' }]);
        assert.strictEqual(view.cell(1, 0), null);
        assert.strictEqual(view.cell(2, 0).textContent, 'one more');
        assert.strictEqual(view.cell(3, 0), null);
        assert.deepStrictEqual(host.rows(), source);
        assert.strictEqual(host.document.version, 1);
        assert.strictEqual(host.document.getText(), host.diskText);
      } finally { release(); view.close(); host.dispose(); }
    }
  });

});
