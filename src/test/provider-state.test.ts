import assert from 'assert';
import { describe, it } from 'node:test';
import Module from 'module';

// Stub 'vscode' for Node test environment before importing code that requires it
const originalRequire = Module.prototype.require;
Module.prototype.require = function (id: string) {
  if (id === 'vscode') {
    return {
      window: { activeColorTheme: { kind: 1 } },
      ColorThemeKind: { Dark: 1 }
    } as any;
  }
  return originalRequire.apply(this, arguments as any);
};

import { CsvEditorProvider } from '../CsvEditorProvider';

// Minimal mock for vscode.ExtensionContext.workspaceState
function createMockContext(store: Record<string, any> = {}) {
  return {
    globalState: {
      get: (key: string, def: any) => (key in store ? store[key] : def),
      update: async (key: string, val: any) => { store[key] = val; }
    },
    workspaceState: {
      get: (key: string, def: any) => (key in store ? store[key] : def),
      update: async (key: string, val: any) => { store[key] = val; }
    }
  } as any;
}

function makeUri(id: string) {
  return { toString: () => `vscode-test://csv/${id}` } as any;
}

describe('Per-URI state mapping', () => {
  it('hiddenRows get/set clamps and clears', async () => {
    const ctx = createMockContext();
    const u = makeUri('one');
    assert.strictEqual(CsvEditorProvider.getHiddenRowsForUri(ctx, u), 0);
    await CsvEditorProvider.setHiddenRowsForUri(ctx, u, 5);
    assert.strictEqual(CsvEditorProvider.getHiddenRowsForUri(ctx, u), 5);
    await CsvEditorProvider.setHiddenRowsForUri(ctx, u, 0);
    assert.strictEqual(CsvEditorProvider.getHiddenRowsForUri(ctx, u), 0);
  });

  it('header override get/set and presence', async () => {
    const ctx = createMockContext();
    const u = makeUri('two');
    assert.strictEqual(CsvEditorProvider.getHeaderForUri(ctx, u), true);
    assert.strictEqual(CsvEditorProvider.hasHeaderOverride(ctx, u), false);
    await CsvEditorProvider.setHeaderForUri(ctx, u, false);
    assert.strictEqual(CsvEditorProvider.hasHeaderOverride(ctx, u), true);
    assert.strictEqual(CsvEditorProvider.getHeaderForUri(ctx, u), false);
  });

  it('serial index get/set defaults true', async () => {
    const ctx = createMockContext();
    const u = makeUri('three');
    assert.strictEqual(CsvEditorProvider.getSerialIndexForUri(ctx, u), true);
    await CsvEditorProvider.setSerialIndexForUri(ctx, u, false);
    assert.strictEqual(CsvEditorProvider.getSerialIndexForUri(ctx, u), false);
  });

  it('separator get/set/unset', async () => {
    const ctx = createMockContext();
    const u = makeUri('four');
    assert.strictEqual(CsvEditorProvider.getSeparatorForUri(ctx, u), undefined);
    await CsvEditorProvider.setSeparatorForUri(ctx, u, ';');
    assert.strictEqual(CsvEditorProvider.getSeparatorForUri(ctx, u), ';');
    await CsvEditorProvider.setSeparatorForUri(ctx, u, undefined);
    assert.strictEqual(CsvEditorProvider.getSeparatorForUri(ctx, u), undefined);
  });
});


describe('Durable column widths', () => {
  it('restores CSV and TSV widths from storage in a fresh context and isolates full URIs', async () => {
    const store: Record<string, any> = {};
    const ctx = createMockContext(store);
    const csv = makeUri('folder/data.csv');
    const tsv = makeUri('folder/data.tsv');
    const other = makeUri('other/data.csv');
    assert.deepStrictEqual(CsvEditorProvider.getColumnWidthsForUri(ctx, csv), {});
    await Promise.all([
      CsvEditorProvider.setColumnWidthsForUri(ctx, csv, { 0: 125, 2: 240 }),
      CsvEditorProvider.setColumnWidthsForUri(ctx, tsv, { 0: 180 })
    ]);
    const reopened = createMockContext(JSON.parse(JSON.stringify(store)));
    assert.deepStrictEqual(CsvEditorProvider.getColumnWidthsForUri(reopened, csv), { 0: 125, 2: 240 });
    assert.deepStrictEqual(CsvEditorProvider.getColumnWidthsForUri(reopened, tsv), { 0: 180 });
    assert.deepStrictEqual(CsvEditorProvider.getColumnWidthsForUri(reopened, other), {});
    await CsvEditorProvider.setColumnWidthsForUri(reopened, csv, {});
    assert.deepStrictEqual(CsvEditorProvider.getColumnWidthsForUri(reopened, csv), {});
    assert.deepStrictEqual(CsvEditorProvider.getColumnWidthsForUri(reopened, tsv), { 0: 180 });
  });

  it('validates stored widths and messages before passing them to HTML', async () => {
    const ctx = createMockContext();
    const uri = makeUri('data.csv');
    await CsvEditorProvider.setColumnWidthsForUri(ctx, uri, {
      0: 123.6, 1: 39, 2: Infinity, 3: NaN, 4: '100',
      '-1': 120, '1oops': 100, '<script>': 120, '01': 100
    });
    assert.deepStrictEqual(CsvEditorProvider.getColumnWidthsForUri(ctx, uri), { 0: 124 });
    for (const invalid of [null, undefined, [], 'oops']) {
      await CsvEditorProvider.setColumnWidthsForUri(ctx, uri, invalid);
      assert.deepStrictEqual(CsvEditorProvider.getColumnWidthsForUri(ctx, uri), {});
    }
  });
});
