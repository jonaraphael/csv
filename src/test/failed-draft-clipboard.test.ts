import assert from 'assert';
import { describe, it } from 'node:test';
import { createEditorHarness } from './edit-integrity-harness';

describe('clipboard mutations during failed cell recovery', () => {
  for (const type of ['pasteFromClipboard', 'copyCells']) {
    it(`blocks ${type} until the failed draft is resolved`, async () => {
      const host = await createEditorHarness();
      const before = host.rows();
      host.failEdits('false');
      await host.receive({ type: 'editCell', row: 1, col: 0, value: 'unapplied draft' });
      host.failEdits(undefined);
      host.clipboardText = 'replacement';
      await host.receive({ type, cut: true, matrix: [['one']], rowIds: [1], startCol: 0,
        anchorRow: 1, anchorCol: 0, selection: { rows: [1], cols: [0] } });
      assert.deepStrictEqual(host.rows(), before);
      assert.strictEqual(host.errors.length, 1);
      assert.strictEqual(host.clipboardText, 'replacement', 'a blocked cut must not change the clipboard');
      assert.ok(host.messages.some(message => message.type === 'editCellFailed' && message.retry));
      host.dispose();
    });
  }
});
