import assert from 'assert';
import { describe, it } from 'node:test';
import { createEditorHarness, createWebviewDom } from './edit-integrity-harness';

type View = ReturnType<typeof createWebviewDom>;
function key(view: View, value: string, modifiers: Record<string, unknown>) {
  const event = new view.window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...modifiers });
  view.window.document.activeElement.dispatchEvent(event);
  return event;
}

describe('Local Find and Replace shortcut modifiers', () => {
  for (const modifier of ['metaKey', 'ctrlKey']) {
    for (const shortcut of ['f', 'h']) {
      it(`opens local ${shortcut === 'f' ? 'Find' : 'Replace'} only for plain ${modifier}`, async () => {
        const host = await createEditorHarness();
        const view = createWebviewDom(host.panel.webview.html);
        try {
          const widget = view.window.document.getElementById('findReplaceWidget');
          view.window.editingTestApi.setSingleSelection(view.cell());
          const event = key(view, shortcut.toUpperCase(), { [modifier]: true });
          assert.strictEqual(event.defaultPrevented, true);
          assert.strictEqual(widget.classList.contains('open'), true);
          assert.strictEqual(widget.classList.contains('replace-expanded'), shortcut === 'h');
          assert.strictEqual(view.window.document.activeElement, view.window.document.getElementById('findInput'));
          assert.strictEqual(host.document.version, 1);
        } finally { view.close(); }
      });
      for (const extra of [{ shiftKey: true }, { altKey: true }, { shiftKey: true, altKey: true }]) {
        it(`leaves native ${modifier}+${Object.keys(extra).join('+')}+${shortcut.toUpperCase()} untouched`, async () => {
          const host = await createEditorHarness();
          const view = createWebviewDom(host.panel.webview.html);
          try {
            const cell = view.cell();
            view.start(cell);
            cell.textContent = 'live draft';
            const event = key(view, shortcut, { [modifier]: true, ...extra });
            assert.strictEqual(event.defaultPrevented, false);
            assert.strictEqual(event.cancelBubble, false);
            assert.strictEqual(view.window.document.getElementById('findReplaceWidget').classList.contains('open'), false);
            assert.strictEqual(view.window.document.activeElement, cell);
            assert.strictEqual(cell.getAttribute('contenteditable'), 'true');
            assert.ok(!view.messages.some(message => message.type === 'editCell' || message.type === 'findMatches'));
            assert.strictEqual(host.document.version, 1);
          } finally { view.close(); }
        });
      }
    }
  }
});
