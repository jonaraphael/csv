import assert from 'assert';
import { describe, it } from 'node:test';
import { createEditorHarness, createWebviewDom } from './edit-integrity-harness';

const settle = (view: ReturnType<typeof createWebviewDom>) =>
  new Promise<void>(resolve => view.window.requestAnimationFrame(() => view.window.setTimeout(resolve, 0)));

const deliver = (view: ReturnType<typeof createWebviewDom>, data: unknown) =>
  view.window.dispatchEvent(new view.window.MessageEvent('message', { data }));

// Explorer previews (single click) open the table with preserveFocus. Focusing
// inside the webview before VS Code focuses its frame pulls keyboard focus out
// of the Explorer, so F2 rename and other Explorer keys stop working.
describe('Webview focus ownership', () => {
  for (const separator of [',', '\t']) {
    it(`leaves focus outside until the frame is focused, then restores the selection (${JSON.stringify(separator)})`, async () => {
      const host = await createEditorHarness({ rows: [['Name', 'Value'], ['one', '1'], ['two', '2']], separator });
      const view = createWebviewDom(host.panel.webview.html, { anchorRow: 2, anchorCol: 1 });
      try {
        await settle(view);
        deliver(view, { type: 'focus' });
        await settle(view);
        const { document } = view.window;
        assert.strictEqual(document.hasFocus(), false, 'loading, restoring state and panel activation must not take focus');
        assert.ok(view.cell(2, 1).classList.contains('selected'), 'the restored selection is still shown');

        view.window.dispatchEvent(new view.window.Event('focus'));
        await settle(view);
        assert.strictEqual(document.activeElement, view.cell(2, 1), 'focusing the frame lands on the restored anchor');

        view.window.dispatchEvent(new view.window.Event('blur'));
        view.cell(2, 1).blur();
        deliver(view, { type: 'focus' });
        assert.notStrictEqual(document.activeElement, view.cell(2, 1), 'activation after blur does not reclaim focus');
        view.window.dispatchEvent(new view.window.Event('focus'));
        deliver(view, { type: 'focus' });
        assert.strictEqual(document.activeElement, view.cell(2, 1), 'activation while focused moves focus to the anchor');
      } finally { view.close(); host.dispose(); }
    });
  }

  it('does not focus the document body of a fresh table without frame focus', async () => {
    const host = await createEditorHarness();
    const view = createWebviewDom(host.panel.webview.html);
    try {
      await settle(view);
      deliver(view, { type: 'focus' });
      assert.strictEqual(view.window.document.hasFocus(), false);
    } finally { view.close(); host.dispose(); }
  });
});
