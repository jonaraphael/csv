import assert from 'assert';
import Module from 'module';
import { describe, it } from 'node:test';

const commands = new Map<string, () => Promise<void>>();
let input: string | undefined;
let prompt: any;
const changes: any[] = [];
const originalRequire = Module.prototype.require;
Module.prototype.require = function (id: string) {
  if (id === 'vscode') {
    return {
      commands: { registerCommand: (name: string, callback: () => Promise<void>) => { commands.set(name, callback); return { dispose() {} }; } },
      window: { showInputBox: async (options: any) => { prompt = options; return input; }, showInformationMessage() {} }
    };
  }
  return originalRequire.apply(this, arguments as any);
};
import { registerCsvCommands } from '../commands';
import { CsvEditorProvider } from '../CsvEditorProvider';
Module.prototype.require = originalRequire;
registerCsvCommands({ subscriptions: [] } as any);

describe('Frozen-pane commands', () => {
  it('updates the requested axis with validated counts and leaves cancellation unchanged', async () => {
    CsvEditorProvider.currentActive = { isActive: () => true, getCurrentFrozenPanes: () => ({ rows: 3, columns: 1 }), setFrozenPanes: async (change: any) => changes.push(change) } as any;
    input = '2';
    await commands.get('csv.changeFrozenRows')!();
    assert.strictEqual(prompt.value, '3');
    assert.strictEqual(prompt.validateInput('0'), undefined);
    assert.ok(prompt.validateInput('-1'));
    assert.ok(prompt.validateInput('1.5'));
    assert.deepStrictEqual(changes, [{ rows: 2 }]);
    input = '0';
    await commands.get('csv.changeFrozenColumns')!();
    assert.deepStrictEqual(changes, [{ rows: 2 }, { columns: 0 }]);
    input = undefined;
    await commands.get('csv.changeFrozenRows')!();
    input = 'invalid';
    await commands.get('csv.changeFrozenRows')!();
    assert.strictEqual(changes.length, 2);
    CsvEditorProvider.currentActive = undefined;
  });
});
