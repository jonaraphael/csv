import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { describe, it } from 'node:test';
import { createEditorHarness } from './edit-integrity-harness';
import { compareFilesAsTable, TableComparison } from '../table-comparison';
import { comparisonLimits } from '../csv-table-diff';
const { JSDOM } = require('jsdom');

async function comparisonFixture(before = 'id,value\n1,old\n2,same', after = 'id,value\n1,new\n2,same') {
  const host = await createEditorHarness();
  const Uri = host.document.uri.constructor as any;
  const original = { uri: new Uri('/test/original <img>.csv'), isClosed: false, getText: () => before };
  const modified = { uri: new Uri('/test/modified &.csv', 'vscode-remote'), isClosed: false, getText: () => after };
  const messages: any[] = [];
  let receive!: (message: unknown) => void;
  let dispose!: () => void;
  const panel = {
    webview: {
      html: '', options: {}, asWebviewUri: (uri: unknown) => String(uri),
      postMessage: (message: unknown) => { messages.push(message); return Promise.resolve(true); },
      onDidReceiveMessage: (listener: typeof receive) => { receive = listener; }
    },
    onDidDispose: (listener: () => void) => { dispose = listener; }
  };
  const context = { extensionPath: process.cwd(), workspaceState: { get: (_key: string, fallback: unknown) => fallback } };
  const comparison = new TableComparison(context as any, original as any, modified as any, panel as any);
  host.sourceDocuments.set(original.uri.toString(), original);
  host.sourceDocuments.set(modified.uri.toString(), modified);
  return { host, original, modified, messages, panel, context, comparison, receive: (message: unknown) => receive(message), dispose: () => dispose() };
}

describe('Readonly table comparison provider and command', () => {
  it('renders actual cell changes, escapes names/values and never exposes editable controls', async () => {
    const value = '<img src="https://example.test/secret" onerror="bad()"> & text';
    const fixture = await comparisonFixture('id,value\n1,old', `id,value\n1,${value}`);
    try {
      const dom = new JSDOM(fixture.panel.webview.html);
      const payload = fixture.messages.at(-1);
      dom.window.document.getElementById('original').innerHTML = payload.originalHtml;
      dom.window.document.getElementById('modified').innerHTML = payload.modifiedHtml;
      assert.strictEqual(dom.window.document.querySelectorAll('img, [contenteditable], input, textarea').length, 0);
      assert.ok(dom.window.document.querySelector('#modified td.added').textContent.includes(value));
      assert.strictEqual(dom.window.document.querySelectorAll('#original td.removed').length, 1);
      assert.ok(dom.window.document.querySelector('h2').textContent.includes('original <img>.csv'));
      assert.strictEqual(dom.window.document.querySelector('h2').title, 'original <img>.csv');
      for (const heading of dom.window.document.querySelectorAll('h2')) {
        const style = dom.window.getComputedStyle(heading);
        assert.strictEqual(style.whiteSpace, 'nowrap');
        assert.strictEqual(style.overflow, 'hidden');
        assert.strictEqual(style.textOverflow, 'ellipsis');
      }
      assert.ok(!fixture.panel.webview.html.includes('https://example.test/secret'));
      assert.deepStrictEqual(Object.keys(fixture.context.workspaceState), ['get']);
      assert.strictEqual(fixture.host.openedDocuments.length, 0);
      dom.window.close();
    } finally { fixture.dispose(); }
  });

  it('refreshes unsaved source documents including a reopened document object, and clears errors', async () => {
    const fixture = await comparisonFixture();
    try {
      const reopened = { ...fixture.modified, getText: () => 'id,value\n1,old\n2,same' };
      fixture.host.changeListeners.forEach(listener => listener({ document: reopened }));
      await new Promise(resolve => setTimeout(resolve, 190));
      assert.match(fixture.messages.at(-1).status, /Changed 0/);
      reopened.getText = () => '"unfinished';
      fixture.comparison.refresh();
      assert.match(fixture.messages.at(-1).error, /malformed/);
      assert.strictEqual(fixture.messages.at(-1).originalHtml, '');
      fixture.receive({ type: 'change', direction: 1 });
      assert.match(fixture.messages.at(-1).error, /malformed/);
      reopened.getText = () => 'id,value\n1,recovered';
      fixture.comparison.refresh();
      assert.strictEqual(fixture.messages.at(-1).error, '');
      assert.ok(fixture.messages.at(-1).modifiedHtml.includes('recovered'));
      assert.strictEqual(fixture.host.executedCommands.length, 0);
    } finally { fixture.dispose(); }
  });

  it('navigates pages and differences, and responds when a queued change disappears', async () => {
    const original = Array.from({ length: 450 }, (_, index) => `${index},same`).join('\n');
    const modified = original.replace('410,same', '410,changed');
    const fixture = await comparisonFixture(original, modified);
    try {
      fixture.receive({ type: 'change', direction: 1 });
      assert.strictEqual(fixture.messages.at(-1).page, 2);
      assert.strictEqual(fixture.messages.at(-1).focusRecord, 410);
      const count = fixture.messages.length;
      fixture.receive({ type: 'change', direction: 1 });
      assert.strictEqual(fixture.messages.length, count + 1);
      assert.strictEqual(fixture.messages.at(-1).canNextChange, false);
      fixture.modified.getText = () => original;
      fixture.comparison.refresh();
      const refreshed = fixture.messages.length;
      fixture.receive({ type: 'change', direction: 1 });
      assert.strictEqual(fixture.messages.length, refreshed + 1);
      assert.strictEqual(fixture.messages.at(-1).canPreviousChange, false);
      fixture.receive({ type: 'page', index: -100 });
      assert.strictEqual(fixture.messages.at(-1).page, 0);
      fixture.receive({ type: 'page', index: 100 });
      assert.strictEqual(fixture.messages.at(-1).page, 2);
    } finally { fixture.dispose(); }
  });

  it('stops delayed refreshes and messages after disposal', async () => {
    const fixture = await comparisonFixture();
    fixture.host.changeListeners.forEach(listener => listener({ document: fixture.modified }));
    const count = fixture.messages.length;
    fixture.dispose();
    fixture.receive({ type: 'ready' });
    await new Promise(resolve => setTimeout(resolve, 190));
    assert.strictEqual(fixture.messages.length, count);
  });

  it('uses TSV separators and reports disabled or decoded-size-limited documents', async () => {
    const fixture = await comparisonFixture();
    try {
      const Uri = fixture.original.uri.constructor as any;
      fixture.original.uri = new Uri('/test/original.tsv');
      fixture.modified.uri = new Uri('/test/modified.tsv');
      fixture.original.getText = () => 'id\tvalue\n1\told';
      fixture.modified.getText = () => 'id\tvalue\n1\tnew';
      fixture.comparison.refresh();
      assert.ok(fixture.messages.at(-1).modifiedHtml.includes('data-columns="2"'));
      fixture.host.configuration.enabled = false;
      fixture.comparison.refresh();
      assert.match(fixture.messages.at(-1).error, /disabled/);
      fixture.host.configuration.enabled = true;
      fixture.modified.getText = () => 'é'.repeat(comparisonLimits.textBytes / 2 + 1);
      fixture.comparison.refresh();
      assert.match(fixture.messages.at(-1).error, /5 MiB/);
      assert.strictEqual(fixture.messages.at(-1).modifiedHtml, '');
    } finally { fixture.dispose(); }
  });

  it('opens a known Explorer pair, respecting dirty already-open text without mutation', async () => {
    const fixture = await comparisonFixture();
    try {
      let panels = 0;
      fixture.host.existingDocuments = [fixture.original, fixture.modified];
      fixture.host.createPanel = () => { panels++; return fixture.panel; };
      await compareFilesAsTable(fixture.context as any, fixture.modified.uri as any, [fixture.original.uri, fixture.modified.uri] as any);
      assert.strictEqual(panels, 1);
      assert.deepStrictEqual(fixture.host.openedDocuments, []);
      assert.deepStrictEqual(fixture.host.executedCommands, []);
      assert.deepStrictEqual(fixture.host.errors, []);
    } finally { fixture.dispose(); }
  });

  it('rejects huge saved sources before openTextDocument even with maxFileSizeMB=0', async () => {
    const fixture = await comparisonFixture();
    try {
      fixture.host.configuration.maxFileSizeMB = 0;
      fixture.host.statSize = comparisonLimits.sourceBytes + 1;
      await compareFilesAsTable(fixture.context as any, undefined, [fixture.original.uri, fixture.modified.uri] as any);
      assert.match(fixture.host.errors.at(-1)!, /10 MiB of saved bytes/);
      assert.deepStrictEqual(fixture.host.openedDocuments, []);
    } finally { fixture.dispose(); }
  });

  it('refuses stat-less unopened sources, but permits bounded already-open remote documents', async () => {
    const fixture = await comparisonFixture();
    try {
      fixture.host.statError = new Error('No stat provider');
      await compareFilesAsTable(fixture.context as any, undefined, [fixture.original.uri, fixture.modified.uri] as any);
      assert.match(fixture.host.errors.at(-1)!, /Open it in a normal editor first/);
      assert.deepStrictEqual(fixture.host.openedDocuments, []);
      fixture.host.existingDocuments = [fixture.original, fixture.modified];
      let panels = 0;
      fixture.host.createPanel = () => { panels++; return fixture.panel; };
      await compareFilesAsTable(fixture.context as any, undefined, [fixture.original.uri, fixture.modified.uri] as any);
      assert.strictEqual(panels, 1);
      assert.deepStrictEqual(fixture.host.openedDocuments, []);
      fixture.modified.getText = () => 'é'.repeat(comparisonLimits.textBytes / 2 + 1);
      await compareFilesAsTable(fixture.context as any, undefined, [fixture.original.uri, fixture.modified.uri] as any);
      assert.match(fixture.host.errors.at(-1)!, /5 MiB/);
      assert.strictEqual(panels, 1);
    } finally { fixture.dispose(); }
  });

  it('opens bounded file documents through VS Code, honors soft limit and supports picker cancellation', async () => {
    const fixture = await comparisonFixture();
    try {
      fixture.host.activeTextDocument = fixture.original;
      fixture.host.dialogResults.push([fixture.modified.uri]);
      fixture.host.createPanel = () => fixture.panel;
      await compareFilesAsTable(fixture.context as any);
      assert.deepStrictEqual(fixture.host.openedDocuments, [fixture.original.uri.toString(), fixture.modified.uri.toString()]);
      fixture.host.openedDocuments.length = 0;
      fixture.host.configuration.maxFileSizeMB = 1;
      fixture.host.statSize = 2 * 1024 * 1024;
      await compareFilesAsTable(fixture.context as any, undefined, [fixture.original.uri, fixture.modified.uri] as any);
      assert.match(fixture.host.errors.at(-1)!, /maxFileSizeMB/);
      assert.deepStrictEqual(fixture.host.openedDocuments, []);
      fixture.host.dialogResults.push(undefined);
      await compareFilesAsTable(fixture.context as any);
      assert.deepStrictEqual(fixture.host.openedDocuments, []);
    } finally { fixture.dispose(); }
  });
});

describe('Table comparison frontend', () => {
  it('positions a focused change below the sticky header using actual pane geometry', async () => {
    const fixture = await comparisonFixture();
    const dom = new JSDOM(fixture.panel.webview.html, { runScripts: 'outside-only', pretendToBeVisual: true });
    const { window } = dom;
    let align!: () => void;
    window.requestAnimationFrame = (callback: () => void) => { align = callback; return 1; };
    window.cancelAnimationFrame = () => {};
    window.acquireVsCodeApi = () => ({ postMessage() {} });
    try {
      window.eval(fs.readFileSync(path.join(process.cwd(), 'media', 'table-comparison.js'), 'utf8'));
      window.dispatchEvent(new window.MessageEvent('message', { data: { ...fixture.messages.at(-1), focusRecord: 1 } }));
      const panes = ['original', 'modified'].map(id => window.document.getElementById(id));
      for (const pane of panes) {
        pane.scrollTop = 140;
        pane.getBoundingClientRect = () => ({ top: 115.5, height: 600 });
        Object.defineProperty(pane, 'clientTop', { value: 1 });
        pane.querySelector('thead').getBoundingClientRect = () => ({ height: 47 });
        const row = pane.querySelector('[data-align="1"]');
        Object.defineProperty(row, 'offsetTop', { value: 179 });
        row.getBoundingClientRect = () => ({ top: 350.5 - pane.scrollTop, height: 50 });
      }
      align();
      for (const pane of panes) {
        assert.strictEqual(pane.scrollTop, 187);
        assert.strictEqual(pane.querySelector('[data-align="1"]').getBoundingClientRect().top, 163.5);
        assert.ok(pane.querySelector('[data-align="1"]').classList.contains('focused'));
      }
    } finally { dom.window.close(); fixture.dispose(); }
  });

  it('synchronizes both scroll axes, aligns multiline row heights, replaces pages and recovers controls', async () => {
    const fixture = await comparisonFixture('id,value\n1,"one\ntwo"\n2,old', 'id,value\n1,short\n2,new');
    const dom = new JSDOM(fixture.panel.webview.html, { runScripts: 'outside-only', pretendToBeVisual: true });
    const { window } = dom;
    const requests: any[] = [];
    let writes = 0;
    const frames = new Map<number, () => void>();
    let frame = 0;
    window.requestAnimationFrame = (callback: () => void) => { frames.set(++frame, callback); return frame; };
    window.cancelAnimationFrame = (id: number) => frames.delete(id);
    window.acquireVsCodeApi = () => ({ postMessage: (message: unknown) => requests.push(message) });
    window.HTMLElement.prototype.getBoundingClientRect = function () {
      return { height: this.closest('#original') ? 50 : 25 };
    };
    const left = window.document.getElementById('original');
    const right = window.document.getElementById('modified');
    for (const pane of [left, right]) {
      let top = 0, horizontal = 0;
      Object.defineProperty(pane, 'scrollTop', { get: () => top, set: (value: number) => { top = value; writes++; pane.dispatchEvent(new window.Event('scroll')); } });
      Object.defineProperty(pane, 'scrollLeft', { get: () => horizontal, set: (value: number) => { horizontal = value; writes++; pane.dispatchEvent(new window.Event('scroll')); } });
    }
    try {
      window.eval(fs.readFileSync(path.join(process.cwd(), 'media', 'table-comparison.js'), 'utf8'));
      assert.strictEqual(requests[0].type, 'ready');
      const send = () => window.dispatchEvent(new window.MessageEvent('message', { data: fixture.messages.at(-1) }));
      for (let page = 0; page < 30; page++) { send(); }
      for (const callback of frames.values()) { callback(); }
      assert.strictEqual(left.querySelectorAll('tbody tr').length, 3);
      assert.strictEqual(left.querySelector('tbody tr').style.height, '50px');
      assert.strictEqual(right.querySelector('tbody tr').style.height, '50px');
      const before = writes;
      left.scrollTop = 140;
      left.scrollLeft = 180;
      assert.strictEqual(right.scrollTop, 140);
      assert.strictEqual(right.scrollLeft, 180);
      right.scrollTop = 20;
      right.scrollLeft = 30;
      assert.strictEqual(left.scrollTop, 20);
      assert.strictEqual(left.scrollLeft, 30);
      assert.ok(writes - before < 30, 'scrolling must not recursively bounce between panes');
      window.document.getElementById('nextChange').click();
      assert.strictEqual(requests.at(-1).type, 'change');
      assert.ok(Array.from(window.document.querySelectorAll('button')).every((button: any) => button.disabled));
      fixture.receive(requests.at(-1)); send();
      fixture.receive({ type: 'change', direction: 1 }); send();
      assert.ok(!window.document.getElementById('previousChange').disabled);
      assert.ok(window.document.getElementById('nextChange').disabled);
      assert.strictEqual(window.document.querySelectorAll('[contenteditable]').length, 0);
      assert.strictEqual(window.document.querySelectorAll('tbody tr').length, 6);
    } finally { dom.window.close(); fixture.dispose(); }
  });
});
