import assert from 'assert';
import fs from 'fs';
import { describe, it } from 'node:test';
import { createEditorHarness, createWebviewDom } from './edit-integrity-harness';

const paint = (view: ReturnType<typeof createWebviewDom>) =>
  new Promise<void>(resolve => view.window.requestAnimationFrame(() => resolve()));

const setWrap = (view: ReturnType<typeof createWebviewDom>, enabled: boolean) =>
  view.window.dispatchEvent(new view.window.MessageEvent('message', { data: { type: 'setWordWrap', enabled } }));

describe('Word wrap display toggle', () => {
  it('contributes mutually exclusive icon actions immediately beside the table/text switch', () => {
    const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    const actions = manifest.contributes.menus['editor/title'];
    const mode = actions.find((entry: any) => entry.command === 'csv.toggleEditor');
    for (const [command, condition] of [['csv.enableWordWrap', '!csv.wordWrapEnabled'], ['csv.disableWordWrap', 'csv.wordWrapEnabled']]) {
      const action = actions.find((entry: any) => entry.command === command);
      const contribution = manifest.contributes.commands.find((entry: any) => entry.command === command);
      assert.strictEqual(action.group, 'navigation@2');
      assert.strictEqual(mode.group, 'navigation@1');
      assert.ok(action.when.endsWith(` && ${condition}`));
      assert.match(action.when, /activeCustomEditorId == csv\.editor/);
      assert.match(action.when, /activeWebviewPanelId == csv\.untitledEditor/);
      assert.strictEqual(contribution.icon, '$(word-wrap)');
      assert.ok(manifest.activationEvents.includes(`onCommand:${command}`));
    }
  });

  it('routes title actions to the active table and follows restored state across view changes', async () => {
    const host = await createEditorHarness();
    try {
      host.registerCommands();
      await host.commands.get('csv.enableWordWrap')!();
      assert.deepStrictEqual(host.messages.at(-1), { type: 'setWordWrap', enabled: true });
      await host.receive({ type: 'wordWrapChanged', enabled: true });
      const context = () => host.contextUpdates.at(-1);
      assert.deepStrictEqual(context(), ['csv.wordWrapEnabled', true]);
      await host.receive({ type: 'wordWrapChanged', enabled: 'false' });
      assert.deepStrictEqual(context(), ['csv.wordWrapEnabled', true]);
      await host.view(false, true);
      const cursor = host.messages.length;
      await host.commands.get('csv.disableWordWrap')!();
      assert.strictEqual(host.messages.length, cursor, 'an inactive table cannot be changed by a title action');
      await host.receive({ type: 'wordWrapChanged', enabled: false });
      await host.view(true, true);
      assert.deepStrictEqual(context(), ['csv.wordWrapEnabled', false]);
      await host.commands.get('csv.disableWordWrap')!();
      assert.deepStrictEqual(host.messages.at(-1), { type: 'setWordWrap', enabled: false });
      assert.strictEqual(host.document.version, 1);
    } finally { host.dispose(); }
  });

  for (const separator of [',', '\t']) {
    it(`preserves a selected range and full clipboard values (${JSON.stringify(separator)})`, async () => {
      const value = 'complete value\n' + 'long text '.repeat(200);
      const host = await createEditorHarness({ rows: [['Name', 'Value'], [value, 'two'], ['three', 'four']], separator });
      const view = createWebviewDom(host.panel.webview.html);
      try {
        await paint(view);
        view.window.editingTestApi.setSingleSelection(view.cell(1, 0));
        view.window.editingTestApi.selectRange({ row: 1, col: 0 }, { row: 2, col: 1 });
        const selection = () => Array.from(view.window.document.querySelectorAll('.selected'));
        const before = selection();
        view.window.dispatchEvent(new view.window.Event('focus'));
        await paint(view);
        assert.deepStrictEqual(selection(), before, 'returning from a native title action must retain the live range');
        assert.ok(view.window.document.getElementById('csv-root').classList.contains('csv-cutoff'));
        assert.strictEqual(view.window.document.querySelector('#csvViewToolbar, #toggleWordWrap'), null, 'display control lives in the native title bar');
        setWrap(view, true);
        setWrap(view, false);
        assert.strictEqual((view.state() as any).wordWrapEnabled, false);
        assert.deepStrictEqual(selection(), before);
        assert.strictEqual(view.window.document.activeElement, view.cell(1, 0));
        assert.strictEqual(view.cell(1, 0).textContent, value);
        view.cell(1, 0).dispatchEvent(new view.window.Event('copy', { bubbles: true, cancelable: true }));
        const copied = JSON.parse(JSON.stringify(view.messages.find(message => message.type === 'copyCells').matrix));
        assert.deepStrictEqual(copied, [[value, 'two'], ['three', 'four']]);
        setWrap(view, true);
        assert.strictEqual((view.state() as any).wordWrapEnabled, true);
        assert.deepStrictEqual(selection(), before);
        assert.strictEqual(host.document.version, 1);
      } finally { view.close(); host.dispose(); }
    });
  }

  it('does not blur, commit, replace or move the caret in a live cell draft', async () => {
    const host = await createEditorHarness();
    const view = createWebviewDom(host.panel.webview.html);
    try {
      await paint(view);
      const cell = view.cell();
      view.start(cell);
      cell.textContent = 'unsaved draft\nwith a second line';
      view.caret(cell.firstChild, 4);
      const cursor = view.messages.length;
      setWrap(view, true);
      await paint(view);
      assert.strictEqual(view.window.document.activeElement, cell);
      assert.ok(cell.classList.contains('editing'));
      assert.strictEqual(view.window.getSelection().anchorNode, cell.firstChild);
      assert.strictEqual(view.window.getSelection().anchorOffset, 4);
      assert.strictEqual(cell.textContent, 'unsaved draft\nwith a second line');
      assert.strictEqual(view.messages.slice(cursor).some(message => message.type === 'editCell'), false);
      assert.strictEqual(host.document.version, 1);
    } finally { view.close(); host.dispose(); }
  });

  it('restores a file’s wrap choice and manual sizes', async () => {
    const host = await createEditorHarness();
    const view = createWebviewDom(host.panel.webview.html, {
      wordWrapEnabled: true, columnSizes: { 0: 150 }, rowSizes: { 1: 32 }, anchorRow: 1, anchorCol: 0
    });
    try {
      await paint(view);
      assert.ok(!view.window.document.getElementById('csv-root').classList.contains('csv-cutoff'));
      const cell = view.cell();
      assert.strictEqual(cell.style.width, '150px');
      assert.strictEqual(cell.style.height, '32px');
      setWrap(view, false);
      const state = view.state() as any;
      assert.strictEqual(state.wordWrapEnabled, false);
      assert.strictEqual(state.columnSizes[0], 150);
      assert.strictEqual(state.rowSizes[1], 32);
    } finally { view.close(); host.dispose(); }
  });

  it('reveals the same selected cell after row geometry shrinks or expands beneath frozen headers', async () => {
    const rows = [['Name', 'Value'], ...Array.from({ length: 60 }, (_, i) => [`row ${i}\nmultiline`, String(i)])];
    const host = await createEditorHarness({ rows });
    const view = createWebviewDom(host.panel.webview.html);
    try {
      const root = view.window.document.getElementById('csv-root');
      const table = root.querySelector('table');
      let top = 0;
      Object.defineProperties(root, {
        clientWidth: { value: 300 }, clientHeight: { value: 180 }, clientTop: { value: 0 }, clientLeft: { value: 0 },
        scrollTop: { get: () => top, set: (value: number) => { top = Math.max(0, value); } }
      });
      root.getBoundingClientRect = () => ({ top: 32, bottom: 212, left: 0, right: 300, width: 300, height: 180 });
      root.scrollTo = (position: any) => { top = Math.max(0, position.top); };
      const height = () => root.classList.contains('csv-cutoff') ? 24 : 80;
      for (const row of Array.from(table.rows) as any[]) {
        const index = Number(row.cells[0].getAttribute('data-row'));
        row.getBoundingClientRect = () => ({ height: index === 0 ? 24 : height() });
        for (const cell of Array.from(row.cells) as any[]) {
          cell.getBoundingClientRect = () => {
            const h = index === 0 ? 24 : height();
            const y = index === 0 ? 32 : 56 + (index - 1) * height() - top;
            return { top: y, bottom: y + h, left: 40, right: 140, width: 100, height: h };
          };
        }
      }
      await paint(view);
      const target = view.cell(40, 0);
      view.window.editingTestApi.setSingleSelection(target);
      await paint(view);
      for (const enabled of [true, false]) {
        setWrap(view, enabled);
        await paint(view);
        const rect = target.getBoundingClientRect();
        assert.ok(target.classList.contains('selected'));
        assert.strictEqual(view.window.document.activeElement, target);
        assert.ok(rect.top >= 56 && rect.bottom <= 212, 'selected cell stays inside the usable viewport');
      }
    } finally { view.close(); host.dispose(); }
  });
});
