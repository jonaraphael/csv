import assert from 'assert';
import { describe, it } from 'node:test';
import { createEditorHarness, createWebviewDom } from './edit-integrity-harness';

const rows = [['metadata', '', ''], ['alpha', 'a', 'keep'], ['hidden', 'b', 'drop'], ['beta', 'c', 'keep'], ['gamma', 'd', 'keep']];
async function fixture(separator = ',') {
  const host = await createEditorHarness({ rows, separator, header: false, hiddenRows: 1, filters: [{ column: 2, operator: 'equals', value: 'keep' }] });
  const view = createWebviewDom(host.panel.webview.html);
  view.window.document.querySelector('.table-container').scrollTo = () => {};
  return { host, view };
}
function selected(view: ReturnType<typeof createWebviewDom>) {
  return Array.from(view.window.document.querySelectorAll('td.selected, th.selected'))
    .map((cell: any) => `${cell.getAttribute('data-row')}:${cell.getAttribute('data-col')}`);
}

describe('Modified arrows in the combined filtered editor', () => {
  for (const separator of [',', '\t']) {
    it(`extends across visible source rows and copies the same range in ${separator === ',' ? 'CSV' : 'TSV'}`, async () => {
      const { host, view } = await fixture(separator);
      try {
        const source = host.document.getText();
        view.window.editingTestApi.setSingleSelection(view.cell(3, 1));
        view.key('ArrowUp', { shiftKey: true });
        assert.deepStrictEqual(selected(view), ['1:1', '3:1']);
        view.key('ArrowRight', { metaKey: true, shiftKey: true });
        assert.deepStrictEqual(selected(view), ['1:1', '1:2', '3:1', '3:2']);
        assert.strictEqual(view.window.document.activeElement, view.cell(3, 1));
        view.key('c', { metaKey: true });
        const copy = view.messages.slice().reverse().find((message: any) => message.type === 'copyCells');
        assert.deepStrictEqual(Array.from(copy.rowIds), [1, 3]);
        assert.deepStrictEqual(JSON.parse(JSON.stringify(copy.matrix)), [['a', 'keep'], ['c', 'keep']]);
        assert.strictEqual(host.document.getText(), source);
      } finally { view.close(); }
    });
  }

  it('leaves modified arrows on filter controls outside the grid handler', async () => {
    const { view } = await fixture();
    try {
      view.window.editingTestApi.setSingleSelection(view.cell(3, 1));
      const before = selected(view);
      view.window.document.getElementById('clearAllFilters').focus();
      for (const modifier of ['metaKey', 'ctrlKey']) {
        for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
          const event = new view.window.KeyboardEvent('keydown', { key, [modifier]: true, shiftKey: true, bubbles: true, cancelable: true });
          view.window.document.activeElement.dispatchEvent(event);
          assert.strictEqual(event.defaultPrevented, false);
          assert.deepStrictEqual(selected(view), before);
        }
      }
    } finally { view.close(); }
  });
});
