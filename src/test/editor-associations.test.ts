import assert from 'assert';
import { describe, it } from 'node:test';
import { CsvEditorAssociationRouting, csvEditorSelectors, exactFileEditorPattern } from '../editor-associations';

type MapValue = Record<string, string> | undefined;
const clone = <T>(value: T): T => value === undefined ? value : JSON.parse(JSON.stringify(value));
function fixture(options: { global?: MapValue; workspace?: MapValue; globalEnabled?: boolean; workspaceEnabled?: boolean; hasWorkspace?: boolean; defaults?: MapValue } = {}) {
  const data = {
    global: clone(options.global), workspace: clone(options.workspace),
    globalEnabled: options.globalEnabled, workspaceEnabled: options.workspaceEnabled,
    storeAfterWait: false, fail: false, ignoreWrite: false, policy: undefined as MapValue, beforeStorage: undefined as (() => Promise<void>) | undefined, beforeWrite: undefined as (() => Promise<void>) | undefined,
    writes: [] as Array<{ target: number; value: MapValue }>, storageWrites: 0
  };
  const globalValues = new Map<string, unknown>(), workspaceValues = new Map<string, unknown>();
  const store = (values: Map<string, unknown>) => ({
    get: (key: string) => clone(values.get(key)),
    keys: () => [...values.keys()].filter(key => values.get(key) !== undefined),
    update: async (key: string, value: unknown) => { data.storageWrites++; if (!data.storeAfterWait) { values.set(key, clone(value)); } await data.beforeStorage?.(); if (data.storeAfterWait) { values.set(key, clone(value)); } }
  });
  const context = { globalState: store(globalValues), workspaceState: store(workspaceValues) } as any;
  const api = {
    ConfigurationTarget: { Global: 1, Workspace: 2 },
    workspace: {
      workspaceFolders: options.hasWorkspace === false ? undefined : [{}],
      workspaceFile: undefined,
      getConfiguration: (section: string) => section === 'csv' ? {
        get: () => data.workspaceEnabled ?? data.globalEnabled ?? true,
        inspect: () => ({ defaultValue: true, globalValue: data.globalEnabled, workspaceValue: data.workspaceEnabled })
      } : {
        inspect: () => ({ defaultValue: clone(options.defaults), globalValue: clone(data.global), workspaceValue: clone(data.workspace) }),
        get: () => clone(data.policy ?? { ...(options.defaults || {}), ...(data.global || {}), ...(data.workspace || {}) }),
        update: async (_key: string, value: MapValue, target: number) => {
          await data.beforeWrite?.();
          if (data.fail) { throw new Error('settings are read-only'); }
          data.writes.push({ target, value: clone(value) });
          if (!data.ignoreWrite) { if (target === 1) { data.global = clone(value); } else { data.workspace = clone(value); } }
        }
      }
    }
  } as any;
  return { data, context, api, globalValues, workspaceValues, manager: () => new CsvEditorAssociationRouting(context, api) };
}
const native = () => Object.fromEntries(csvEditorSelectors.map(pattern => [pattern, 'default']));

describe('Reversible disabled CSV editor associations', () => {
  it('routes all four selectors and more-specific CSV choices natively while preserving other editors', async () => {
    const original = { '**/special.csv': 'csv.editor', '*.tsv': 'another.editor', '*.tab': 'default', '*.md': 'markdown.preview' };
    const h = fixture({ global: original, globalEnabled: false, hasWorkspace: false });
    const routing = h.manager();
    await routing.synchronize();
    assert.deepStrictEqual(h.data.global, { ...native(), ...original, '**/special.csv': 'default', '*.csv': 'default', '*.psv': 'default' });
    h.data.globalEnabled = true;
    await routing.synchronize();
    assert.deepStrictEqual(h.data.global, original);
  });

  for (const original of [undefined, {}]) {
    it(`restores an originally ${original ? 'empty' : 'absent'} settings object exactly`, async () => {
      const h = fixture({ global: original, globalEnabled: false, hasWorkspace: false });
      const routing = h.manager();
      await routing.synchronize();
      assert.deepStrictEqual(h.data.global, native());
      h.data.globalEnabled = true;
      await routing.synchronize();
      assert.deepStrictEqual(h.data.global, original);
    });
  }

  it('limits workspace Off to workspace settings, including inherited specific CSV choices', async () => {
    const global = { '**/data.csv': 'csv.editor', '*.tsv': 'external.tsv' };
    const workspace = { '*.psv': 'external.psv' };
    const h = fixture({ global, workspace, workspaceEnabled: false });
    const routing = h.manager();
    await routing.synchronize();
    assert.deepStrictEqual(h.data.global, global);
    assert.deepStrictEqual(h.data.workspace, { ...workspace, '*.csv': 'default', '*.tab': 'default', '**/data.csv': 'default' });
    assert.ok(h.data.writes.every(write => write.target === 2));
    h.data.workspaceEnabled = true;
    await routing.synchronize();
    assert.deepStrictEqual(h.data.workspace, workspace);
  });

  it('uses workspace On counterbindings only for this extension’s inherited global shadows', async () => {
    const h = fixture({ globalEnabled: false, workspaceEnabled: true, global: { '**/data.csv': 'csv.editor', '*.tsv': 'external.tsv' }, workspace: { '*.psv': 'external.psv' } });
    const routing = h.manager();
    await routing.synchronize();
    assert.deepStrictEqual(h.data.global, { '*.csv': 'default', '*.tab': 'default', '*.psv': 'default', '**/data.csv': 'default', '*.tsv': 'external.tsv' });
    assert.deepStrictEqual(h.data.workspace, { '*.psv': 'external.psv', '*.csv': 'csv.editor', '*.tab': 'csv.editor', '**/data.csv': 'csv.editor' });
    h.data.globalEnabled = true;
    await routing.synchronize();
    assert.deepStrictEqual(h.data.global, { '**/data.csv': 'csv.editor', '*.tsv': 'external.tsv' });
    assert.deepStrictEqual(h.data.workspace, { '*.psv': 'external.psv' });
  });

  it('does not add redundant workspace overrides when native global routing is inherited', async () => {
    const h = fixture({ globalEnabled: false });
    await h.manager().synchronize();
    assert.deepStrictEqual(h.data.global, native());
    assert.strictEqual(h.data.workspace, undefined);
  });

  it('restores preferences after restart and preserves unrelated additions made while disabled', async () => {
    const h = fixture({ globalEnabled: false, hasWorkspace: false, global: { '*.csv': 'csv.editor' } });
    await h.manager().synchronize();
    h.data.global = { ...h.data.global, '*.json': 'external.json' };
    h.data.globalEnabled = true;
    await h.manager().synchronize();
    assert.deepStrictEqual(h.data.global, { '*.csv': 'csv.editor', '*.json': 'external.json' });
  });

  it('does not overwrite an intervening choice of another editor or native editor on re-enable', async () => {
    const h = fixture({ globalEnabled: false, hasWorkspace: false });
    const routing = h.manager();
    await routing.synchronize();
    h.data.global = { ...h.data.global, '*.csv': 'external.csv' };
    await routing.synchronize();
    h.data.globalEnabled = true;
    await routing.synchronize();
    assert.deepStrictEqual(h.data.global, { '*.csv': 'external.csv' });
  });

  it('preserves an intervening deletion or explicit CSV choice and reports the routing conflict', async () => {
    for (const replacement of [undefined, 'csv.editor']) {
      const h = fixture({ globalEnabled: false, hasWorkspace: false });
      const routing = h.manager();
      await routing.synchronize();
      if (replacement === undefined) { delete h.data.global!['*.csv']; }
      else { h.data.global!['*.csv'] = replacement; }
      const current = clone(h.data.global);
      await assert.rejects(routing.synchronize(), /preserved your changed editor associations/);
      assert.deepStrictEqual(h.data.global, current);
      h.data.globalEnabled = true;
      await routing.synchronize();
      assert.deepStrictEqual(h.data.global, replacement === undefined ? {} : { '*.csv': replacement });
    }
  });

  it('fails clearly on a denied write and can retry without a poisoned ownership record', async () => {
    const h = fixture({ globalEnabled: false, hasWorkspace: false });
    const routing = h.manager();
    h.data.fail = true;
    await assert.rejects(routing.synchronize(), /could not update global editor routing: settings are read-only/);
    assert.strictEqual(h.data.global, undefined);
    h.data.fail = false;
    await routing.synchronize();
    assert.deepStrictEqual(h.data.global, native());
    h.data.globalEnabled = true;
    await routing.synchronize();
    assert.strictEqual(h.data.global, undefined);
  });

  it('stores recovery metadata before settings change and avoids repeated writes when synchronized', async () => {
    const h = fixture({ globalEnabled: false, hasWorkspace: false });
    h.data.beforeWrite = async () => {
      assert.ok([...h.globalValues.values()].some((value: any) => Object.keys(value?.state?.entries || {}).length === 4));
    };
    const routing = h.manager();
    await routing.synchronize();
    const writes = h.data.writes.length;
    await routing.synchronize();
    assert.strictEqual(h.data.writes.length, writes);
  });
  it('preserves blanket and more-specific external choices while converting specific CSV overrides', async () => {
    for (const blanket of ['*', '**/*', '*.*']) {
      const original = { [blanket]: 'external.editor', '**/special.csv': 'csv.editor', '/path/*.csv': 'external.path' };
      const h = fixture({ global: original, globalEnabled: false, hasWorkspace: false });
      await h.manager().synchronize();
      assert.deepStrictEqual(h.data.global, { ...original, '**/special.csv': 'default' });
      h.data.globalEnabled = true;
      await h.manager().synchronize();
      assert.deepStrictEqual(h.data.global, original);
    }
    const h = fixture({ global: { 'a*': 'external.editor' }, globalEnabled: false, hasWorkspace: false });
    await assert.rejects(h.manager().synchronize(), /preserved overlapping editor associations/);
    assert.deepStrictEqual(h.data.global, { 'a*': 'external.editor' });
  });

  it('handles inherited blanket choices and more-specific CSV associations without global writes', async () => {
    const global = { '**/*': 'external.editor', '**/special.csv': 'csv.editor' };
    const h = fixture({ global, workspaceEnabled: false });
    await h.manager().synchronize();
    assert.deepStrictEqual(h.data.global, global);
    assert.deepStrictEqual(h.data.workspace, { '**/special.csv': 'default' });
  });

  it('shadows contributed default CSV associations and detects policy-valued routing', async () => {
    const h = fixture({ defaults: { '**/special.csv': 'csv.editor', '*.tsv': 'external.editor' }, globalEnabled: false, hasWorkspace: false });
    await h.manager().synchronize();
    assert.strictEqual(h.data.global!['**/special.csv'], 'default');
    assert.strictEqual(h.data.global!['*.tsv'], undefined);
    h.data.policy = { '*.csv': 'csv.editor' };
    await assert.rejects(h.manager().synchronize(), /policy or another settings scope/);
  });

  it('detects an ignored settings write and can recover without ownership debris', async () => {
    const h = fixture({ globalEnabled: false, hasWorkspace: false });
    h.data.ignoreWrite = true;
    await assert.rejects(h.manager().synchronize(), /did not apply the routing preferences/);
    assert.strictEqual(h.data.global, undefined);
    assert.ok([...h.globalValues.values()].every(value => value === undefined));
    h.data.ignoreWrite = false;
    await h.manager().synchronize();
    h.data.globalEnabled = true;
    await h.manager().synchronize();
    assert.strictEqual(h.data.global, undefined);
    assert.ok([...h.globalValues.values()].every(value => value === undefined), 'final state removes provisional ownership');
  });

  it('does not write settings after disposal during recovery metadata persistence', async () => {
    const h = fixture({ globalEnabled: false, hasWorkspace: false });
    const routing = h.manager();
    h.data.beforeStorage = async () => { h.data.beforeStorage = undefined; routing.dispose(); };
    await routing.synchronize();
    assert.strictEqual(h.data.writes.length, 0);
    assert.ok([...h.globalValues.values()].every(value => value === undefined));
  });

  it('finishes recovery ownership if disposed during an in-flight settings write', async () => {
    const h = fixture({ globalEnabled: false, workspaceEnabled: true });
    const routing = h.manager();
    h.data.beforeWrite = async () => { routing.dispose(); };
    await routing.synchronize();
    assert.deepStrictEqual(h.data.global, native());
    assert.strictEqual(h.data.workspace, undefined);
    h.data.beforeWrite = undefined;
    h.data.globalEnabled = true;
    await h.manager().synchronize();
    assert.strictEqual(h.data.global, undefined);
    assert.ok([...h.globalValues.values()].every(value => value === undefined));
  });

  it('does not overwrite a user map changed while recovery data was being persisted', async () => {
    const h = fixture({ globalEnabled: false, hasWorkspace: false });
    h.data.beforeStorage = async () => { h.data.beforeStorage = undefined; h.data.global = { '*.csv': 'external.editor' }; };
    await assert.rejects(h.manager().synchronize(), /changed while CSV was updating/);
    assert.deepStrictEqual(h.data.global, { '*.csv': 'external.editor' });
  });

  it('keeps recovery when another window has already installed the same temporary routing', async () => {
    const h = fixture({ globalEnabled: false, hasWorkspace: false });
    h.data.storeAfterWait = true;
    let releaseFirst!: () => void, releaseSecond!: () => void;
    let count = 0;
    h.data.beforeStorage = async () => {
      const operation = ++count;
      if (operation === 1) { await new Promise<void>(resolve => { releaseFirst = resolve; }); }
      if (operation === 2) { await new Promise<void>(resolve => { releaseSecond = resolve; }); }
    };
    const first = h.manager().synchronize();
    while (!releaseFirst) { await new Promise(resolve => setImmediate(resolve)); }
    const second = h.manager().synchronize();
    while (!releaseSecond) { await new Promise(resolve => setImmediate(resolve)); }
    releaseFirst(); await first;
    assert.deepStrictEqual(h.data.global, native());
    releaseSecond(); await second;
    assert.deepStrictEqual(h.data.global, native());
    assert.strictEqual(h.data.writes.length, 1);
    h.data.globalEnabled = true;
    await h.manager().synchronize();
    assert.strictEqual(h.data.global, undefined, 'last window retains the original absence for restoration');
    assert.ok([...h.globalValues.values()].every(value => value === undefined));
  });

  for (const original of [undefined, 'csv.editor']) {
    it(`does not let an older coalesced plan replace a newer user's ${original ? 'explicit CSV choice' : 'deletion'}`, async () => {
      const h = fixture({ globalEnabled: false, hasWorkspace: false, global: original ? undefined : { '*.csv': 'csv.editor' } });
      h.data.storeAfterWait = true;
      let release!: () => void;
      let held = false;
      h.data.beforeStorage = async () => {
        if (!held) { held = true; await new Promise<void>(resolve => { release = resolve; }); }
      };
      const pending = h.manager().synchronize();
      while (!release) { await new Promise(resolve => setImmediate(resolve)); }
      h.data.global = original ? { '*.csv': original } : undefined;
      await h.manager().synchronize();
      release(); await pending;
      h.data.globalEnabled = true;
      await h.manager().synchronize();
      assert.deepStrictEqual(h.data.global, original ? { '*.csv': original } : undefined);
      assert.ok([...h.globalValues.values()].every(value => value === undefined));
    });
  }

  it('keeps a newer window’s extra original binding when a delayed older plan conflicts', async () => {
    const h = fixture({ globalEnabled: false, hasWorkspace: false });
    h.data.storeAfterWait = true;
    let release!: () => void;
    let held = false;
    h.data.beforeStorage = async () => {
      if (!held) { held = true; await new Promise<void>(resolve => { release = resolve; }); }
    };
    const pending = h.manager().synchronize();
    while (!release) { await new Promise(resolve => setImmediate(resolve)); }
    h.data.global = { '**/special.csv': 'csv.editor' };
    await h.manager().synchronize();
    release(); await assert.rejects(pending, /changed while CSV was updating/);
    h.data.globalEnabled = true;
    await h.manager().synchronize();
    assert.deepStrictEqual(h.data.global, { '**/special.csv': 'csv.editor' });
    assert.ok([...h.globalValues.values()].every(value => value === undefined));
  });

  it('durably relinquishes an observed user edit even when no settings write is necessary', async () => {
    const h = fixture({ globalEnabled: false, hasWorkspace: false });
    await h.manager().synchronize();
    h.data.global!['*.csv'] = 'external.editor';
    const writeCount = h.data.writes.length;
    await h.manager().synchronize();
    assert.strictEqual(h.data.writes.length, writeCount, 'external choice needs no preference mutation');
    h.data.global!['*.csv'] = 'default';
    await h.manager().synchronize();
    h.data.globalEnabled = true;
    await h.manager().synchronize();
    assert.deepStrictEqual(h.data.global, { '*.csv': 'default' }, 'later user native choice remains on restart/re-enable');
    assert.ok([...h.globalValues.values()].every(value => value === undefined));
  });

});


const file = (path: string, fields: Partial<Record<string, string>> = {}) => ({ scheme: 'file', authority: '', query: '', fragment: '', path, ...fields } as any);
describe('Continuing per-file Text view routing', () => {
  it('uses literal scheme:path patterns and rejects URI identities the workbench cannot isolate', () => {
    assert.strictEqual(exactFileEditorPattern(file('/one [x]*?{y}/check.csv')), 'file:/one [[]x[]][*][?][{]y[}]/check.csv');
    for (const fields of [{ scheme: 'vscode-remote', authority: 'wsl+Ubuntu' }, { authority: 'server' }, { query: 'revision=1' }, { fragment: 'line50' }]) {
      assert.strictEqual(exactFileEditorPattern(file('/check.csv', fields)), undefined);
    }
  });

  it('keeps a workspace Text choice across synchronization, restart and Off→On', async () => {
    const h = fixture(), uri = file('/one/check.csv'), pattern = exactFileEditorPattern(uri)!;
    const text = await h.manager().prepareEditorSwitch(uri, 'default'); await text.commit();
    assert.deepStrictEqual(h.data.workspace, { [pattern]: 'default' }); assert.strictEqual(h.data.global, undefined);
    await h.manager().synchronize();
    h.data.globalEnabled = false; await h.manager().synchronize();
    h.data.globalEnabled = true; await h.manager().synchronize();
    assert.deepStrictEqual(h.data.workspace, { [pattern]: 'default' }); assert.strictEqual(h.data.global, undefined);
    const table = await h.manager().prepareEditorSwitch(uri, 'csv.editor');
    await table.rollback();
    assert.deepStrictEqual(h.data.workspace, { [pattern]: 'default' }, 'cancelled Table does not change Text routing');
    const successfulTable = await h.manager().prepareEditorSwitch(uri, 'csv.editor'); await successfulTable.commit();
    assert.strictEqual(h.data.workspace, undefined); assert.ok([...h.workspaceValues.values()].every(value => value === undefined));
  });

  it('releases only one file while another Text choice remains, without resurrecting older journals', async () => {
    const h = fixture(), a = file('/one/check.csv'), b = file('/two/check.csv');
    await (await h.manager().prepareEditorSwitch(a, 'default')).commit();
    await (await h.manager().prepareEditorSwitch(b, 'default')).commit();
    await (await h.manager().prepareEditorSwitch(b, 'csv.editor')).commit();
    await h.manager().synchronize();
    assert.deepStrictEqual(h.data.workspace, { [exactFileEditorPattern(a)!]: 'default' });
    await (await h.manager().prepareEditorSwitch(a, 'csv.editor')).commit();
    assert.strictEqual(h.data.workspace, undefined);
  });

  for (const original of [undefined, {}]) {
    it(`rolls a cancelled Text switch back to an originally ${original ? 'empty' : 'absent'} preference object`, async () => {
      const h = fixture({ workspace: original }), uri = file('/one/check.tsv');
      const transaction = await h.manager().prepareEditorSwitch(uri, 'default');
      await transaction.rollback();
      assert.deepStrictEqual(h.data.workspace, original);
      assert.ok([...h.workspaceValues.values()].every(value => value === undefined));
    });
  }

  it('preserves an unrelated concurrent preference and a user edit to the owned key on rollback/Table return', async () => {
    const h = fixture(), uri = file('/one/check.csv'), pattern = exactFileEditorPattern(uri)!;
    const transaction = await h.manager().prepareEditorSwitch(uri, 'default');
    h.data.workspace!['*.md'] = 'markdown.preview';
    h.data.workspace![pattern] = 'external.editor';
    await transaction.rollback();
    await (await h.manager().prepareEditorSwitch(uri, 'csv.editor')).commit();
    assert.deepStrictEqual(h.data.workspace, { '*.md': 'markdown.preview', [pattern]: 'external.editor' });
  });

  it('restores an existing exact CSV choice and preserves a preexisting native or external choice', async () => {
    const uri = file('/one/check.csv'), pattern = exactFileEditorPattern(uri)!;
    for (const prior of ['csv.editor', 'default', 'external.editor']) {
      const h = fixture({ workspace: { [pattern]: prior } });
      const transaction = await h.manager().prepareEditorSwitch(uri, 'default');
      assert.strictEqual(transaction.supported, prior !== 'external.editor');
      await transaction.commit();
      await (await h.manager().prepareEditorSwitch(uri, 'csv.editor')).commit();
      assert.deepStrictEqual(h.data.workspace, { [pattern]: prior });
    }
  });

  it('internally rolls back a provisional Text write when enablement changes during preparation', async () => {
    const h = fixture(), uri = file('/one/check.csv');
    h.data.beforeWrite = async () => { h.data.beforeWrite = undefined; h.data.globalEnabled = false; };
    await assert.rejects(h.manager().prepareEditorSwitch(uri, 'default'), /routing changed while switching/);
    assert.strictEqual(h.data.workspace, undefined);
    assert.ok([...h.workspaceValues.values()].every(value => value === undefined));
  });

  it('internally rolls back a provisional Text write if disposed while it is applying', async () => {
    const h = fixture(), uri = file('/one/check.csv'), manager = h.manager();
    h.data.beforeWrite = async () => { h.data.beforeWrite = undefined; manager.dispose(); };
    await assert.rejects(manager.prepareEditorSwitch(uri, 'default'), /routing changed while switching/);
    assert.strictEqual(h.data.workspace, undefined);
    assert.ok([...h.workspaceValues.values()].every(value => value === undefined));
  });

  it('does not leave ownership after denied or ignored provisional writes', async () => {
    for (const failure of ['fail', 'ignoreWrite'] as const) {
      const h = fixture(); h.data[failure] = true;
      await assert.rejects(h.manager().prepareEditorSwitch(file('/one/check.csv'), 'default'));
      assert.strictEqual(h.data.workspace, undefined);
      assert.ok([...h.workspaceValues.values()].every(value => value === undefined));
    }
  });

  it('leaves unsupported remote view switching available without changing any associations', async () => {
    const h = fixture();
    const transaction = await h.manager().prepareEditorSwitch(file('/one/check.csv', { scheme: 'vscode-remote', authority: 'wsl+Ubuntu' }), 'default');
    assert.strictEqual(transaction.supported, false); assert.match(transaction.limitation!, /Turn CSV off/);
    await transaction.commit(); await transaction.rollback();
    assert.strictEqual(h.data.writes.length, 0);
  });
  it('does not shadow an inherited exact choice of another editor', async () => {
    const uri = file('/one/check.csv'), pattern = exactFileEditorPattern(uri)!;
    const h = fixture({ global: { [pattern]: 'external.editor' } });
    const transaction = await h.manager().prepareEditorSwitch(uri, 'default');
    assert.strictEqual(transaction.supported, false);
    assert.strictEqual(h.data.workspace, undefined);
    assert.deepStrictEqual(h.data.global, { [pattern]: 'external.editor' });
  });

  for (const observedBy of ['table', 'rollback']) {
    for (const userValue of ['external.editor', undefined]) {
      it(`durably relinquishes a user ${userValue ? 'editor change' : 'deletion'} observed by ${observedBy} before the user chooses native again`, async () => {
        const h = fixture(), uri = file('/one/check.csv'), pattern = exactFileEditorPattern(uri)!;
        const text = await h.manager().prepareEditorSwitch(uri, 'default'); await text.commit();
        if (userValue === undefined) { delete h.data.workspace![pattern]; }
        else { h.data.workspace![pattern] = userValue; }
        if (observedBy === 'table') { await (await h.manager().prepareEditorSwitch(uri, 'csv.editor')).commit(); }
        else { await text.rollback(); }
        h.data.workspace![pattern] = 'default';
        await h.manager().synchronize();
        await (await h.manager().prepareEditorSwitch(uri, 'csv.editor')).commit();
        assert.deepStrictEqual(h.data.workspace, { [pattern]: 'default' });
      });
    }
  }

});
