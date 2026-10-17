import type * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { performance } from 'perf_hooks';

const journalPrefix = 'csv.nativeEditorRouting.';
type Journal = { created: number; state: Ownership };
export const csvEditorSelectors = ['*.csv', '*.tsv', '*.tab', '*.psv'] as const;
const csvEditor = 'csv.editor';
type Associations = Record<string, unknown>;
type OwnedEntry = { previous?: string; hadPrevious: boolean; applied: string; textView?: boolean; owner?: string };
type Ownership = { version: 1; entries: Record<string, OwnedEntry>; ignored: string[]; released: Record<string, string>; containerAbsent: boolean };
type Scope = 'global' | 'workspace';

const has = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const put = <T>(object: Record<string, T>, key: string, value: T): Record<string, T> => ({ ...object, [key]: value });
function dictionary(value: unknown): Associations {
  if (value === undefined) { return {}; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('workbench.editorAssociations must be an object before CSV can change its routing.');
  }
  return { ...value as Associations };
}
function ownership(raw: unknown): Ownership {
  const empty: Ownership = { version: 1, entries: {}, ignored: [], released: {}, containerAbsent: false };
  if (!raw || typeof raw !== 'object') { return empty; }
  const value = raw as Ownership;
  if (value.version !== 1 || !value.entries || typeof value.entries !== 'object' || Array.isArray(value.entries) || !Array.isArray(value.ignored)) { return empty; }
  const entries: Record<string, OwnedEntry> = {};
  for (const [pattern, entry] of Object.entries(value.entries)) {
    if (!entry || typeof entry !== 'object' || typeof entry.hadPrevious !== 'boolean' ||
        (entry.previous !== undefined && typeof entry.previous !== 'string') ||
        (entry.applied !== 'default' && entry.applied !== csvEditor)) { continue; }
    Object.defineProperty(entries, pattern, { value: { ...entry }, enumerable: true, configurable: true, writable: true });
  }
  const released = Object.fromEntries(Object.entries(value.released || {}).filter(([, token]) => typeof token === 'string'));
  return { version: 1, entries, ignored: value.ignored.filter(pattern => typeof pattern === 'string'), released, containerAbsent: value.containerAbsent === true };
}
function recovery(storage: vscode.Memento): { state: Ownership; journals: Array<{ key: string; value: Journal }> } {
  const journals = storage.keys().filter(key => key.startsWith(journalPrefix)).map(key => ({ key, value: storage.get<Journal>(key)! }))
    .filter(({ value }) => value && typeof value.created === 'number' && value.state?.version === 1)
    .sort((a, b) => b.value.created - a.value.created || b.key.localeCompare(a.key));
  const state = ownership(undefined);
  state.containerAbsent = journals[0]?.value.state.containerAbsent ?? false;
  const decided = new Set<string>();
  for (const journal of journals) {
    const stored = ownership(journal.value.state);
    for (const [pattern, entry] of Object.entries(stored.entries)) {
      if (!decided.has(pattern)) {
        Object.defineProperty(state.entries, pattern, { value: entry, enumerable: true, configurable: true, writable: true });
        decided.add(pattern);
      }
    }
    for (const pattern of stored.ignored) {
      if (!decided.has(pattern)) { state.ignored.push(pattern); decided.add(pattern); }
    }
    for (const [pattern, token] of Object.entries(stored.released)) {
      if (!decided.has(pattern)) { state.released[pattern] = token; decided.add(pattern); }
    }
  }
  return { state, journals };
}
function observe(current: Associations, stored: Ownership): { original: Associations; state: Ownership } {
  let original = { ...current }, entries = { ...stored.entries };
  const ignored = new Set(stored.ignored);
  let containerAbsent = stored.containerAbsent;
  for (const [pattern, entry] of Object.entries(entries)) {
    if (current[pattern] !== entry.applied) {
      // An intervening user edit owns this key for the rest of this disabled period.
      delete entries[pattern];
      ignored.add(pattern);
      containerAbsent = false;
      continue;
    }
    if (entry.hadPrevious) { original = put(original, pattern, entry.previous); }
    else { delete original[pattern]; }
  }
  return { original, state: { ...stored, entries, ignored: [...ignored], containerAbsent } };
}
function desiredNative(original: Associations): Map<string, string> {
  const external = Object.entries(original).filter(([, editor]) => typeof editor === 'string' && editor !== csvEditor);
  // These patterns cover every CSV-like basename. Their explicit editor choice
  // already outranks the contributed editor, so adding *.csv would change it.
  const universal = new Set(['*', '**', '**/*', '*.*', '**/*.*']);
  const hasUniversal = external.some(([pattern]) => universal.has(pattern));
  const patterns = new Set<string>(Object.keys(original).filter(pattern => original[pattern] === csvEditor));
  for (const selector of csvEditorSelectors) {
    if (has(original, selector) || hasUniversal) { continue; }
    const extension = selector.slice(1);
    const overlaps = external.filter(([pattern]) => {
      if (pattern.length > selector.length || !/[*?{[]/.test(pattern)) { return false; }
      const suffix = pattern.split(/[*?}\]]/).pop() || '';
      return !suffix || extension.endsWith(suffix);
    });
    if (overlaps.length) {
      throw new Error(`CSV preserved overlapping editor associations (${overlaps.map(([pattern]) => pattern).join(', ')}). Add an explicit ${selector} choice before retrying the toggle.`);
    }
    patterns.add(selector);
  }
  return new Map([...patterns].map(pattern => [pattern, 'default']));
}
function plan(current: Associations, absent: boolean, stored: Ownership, desired: Map<string, string>, enabled: boolean) {
  let next = { ...current }, entries = { ...stored.entries };
  const ignored = enabled ? new Set<string>() : new Set(stored.ignored);
  const released = { ...stored.released };
  if (enabled) { for (const pattern of stored.ignored) { released[pattern] = ''; } }
  const beforeWrite = { ...stored, entries: { ...entries }, ignored: [...ignored], released: { ...released } };
  if (!Object.keys(entries).length) { beforeWrite.containerAbsent = absent; }
  for (const [pattern, entry] of Object.entries(entries)) {
    if (desired.get(pattern) === entry.applied) { continue; }
    if (current[pattern] === entry.applied) {
      if (entry.hadPrevious) { next = put(next, pattern, entry.previous); }
      else { delete next[pattern]; }
    }
    delete entries[pattern];
    released[pattern] = '';
  }
  for (const [pattern, value] of desired) {
    if (ignored.has(pattern) || next[pattern] === value) { continue; }
    // Existing associations to another editor belong to that editor/user.
    if (has(next, pattern) && next[pattern] !== csvEditor && !stored.entries[pattern]) { continue; }
    const previous = next[pattern];
    const entry: OwnedEntry = { hadPrevious: has(next, pattern), previous: typeof previous === 'string' ? previous : undefined, applied: value };
    entries = put(entries, pattern, entry);
    delete released[pattern];
    delete beforeWrite.released[pattern];
    beforeWrite.entries = put(beforeWrite.entries, pattern, entry);
    next = put(next, pattern, value);
  }
  const conflicts = [...desired].filter(([pattern, value]) => ignored.has(pattern) && current[pattern] !== value);
  if (conflicts.length) {
    throw new Error(`CSV preserved your changed editor associations (${conflicts.map(([pattern]) => pattern).join(', ')}). Remove or change those CSV editor choices before retrying the toggle.`);
  }
  const finalState: Ownership = { ...beforeWrite, entries, ignored: [...ignored], released };
  const removeContainer = !Object.keys(next).length && beforeWrite.containerAbsent;
  return { next, value: removeContainer ? undefined : next, beforeWrite, finalState };
}

export type EditorSwitchRouting = { supported: boolean; limitation?: string; commit(): Promise<void>; rollback(): Promise<void> };
export function exactFileEditorPattern(uri: vscode.Uri): string | undefined {
  // The workbench matches scheme:path, case-insensitively, and omits authority.
  // Do not turn a remote/virtual URI into a wider preference for other hosts.
  if (uri.scheme !== 'file' || uri.authority || uri.query || uri.fragment) { return undefined; }
  return `${uri.scheme}:${uri.path}`.replace(/[\[\]*?{}]/g, character => `[${character}]`);
}

/** Reversible native routing uses the existing toggle; no document text is stored. */
export class CsvEditorAssociationRouting implements vscode.Disposable {
  private pending: Promise<void> = Promise.resolve();
  private disposed = false;
  constructor(private readonly context: vscode.ExtensionContext, private readonly api: typeof vscode) {}
  dispose(): void { this.disposed = true; }
  synchronize(): Promise<void> {
    const next = this.pending.catch(() => {}).then(() => this.synchronizeOnce());
    this.pending = next;
    return next;
  }
  prepareEditorSwitch(uri: vscode.Uri, target: 'default' | 'csv.editor'): Promise<EditorSwitchRouting> {
    if (target === csvEditor) {
      // Keep Text routing until its replacement table is genuinely usable.
      return Promise.resolve({ supported: true, rollback: async () => {}, commit: () => {
        const commit = this.pending.catch(() => {}).then(async () => {
          // A prior no-workspace choice can coexist with a workspace override.
          for (let scope = 0; scope < 2; scope++) { await this.prepareEditorSwitchOnce(uri, csvEditor); }
        });
        this.pending = commit;
        return commit;
      } });
    }
    const next = this.pending.catch(() => {}).then(() => this.prepareEditorSwitchOnce(uri, target));
    this.pending = next.then(() => {}, () => {});
    return next;
  }
  private async prepareEditorSwitchOnce(uri: vscode.Uri, target: 'default' | 'csv.editor'): Promise<EditorSwitchRouting> {
    const pattern = exactFileEditorPattern(uri);
    const unsupported = (limitation: string): EditorSwitchRouting => ({ supported: false, limitation, commit: async () => {}, rollback: async () => {} });
    if (!pattern) {
      return unsupported('CSV: This view can switch, but VS Code cannot isolate this URI in editor associations. Turn CSV off in this workspace before using Find in Files in its text view.');
    }
    if (this.disposed) { throw new Error('CSV: Editor routing is no longer active.'); }
    const hasWorkspace = !!this.api.workspace.workspaceFile || !!this.api.workspace.workspaceFolders?.length;
    let scope: Scope = hasWorkspace ? 'workspace' : 'global';
    const setting = this.api.workspace.getConfiguration('workbench').inspect<Associations>('editorAssociations');
    if (target === 'csv.editor' && !recovery(this.context.workspaceState).state.entries[pattern]?.textView &&
      recovery(this.context.globalState).state.entries[pattern]?.textView) { scope = 'global'; }
    const storage = scope === 'global' ? this.context.globalState : this.context.workspaceState;
    const raw = scope === 'global' ? setting?.globalValue : setting?.workspaceValue;
    const current = dictionary(raw);
    const stored = recovery(storage).state;
    const observed = observe(current, stored);
    if (!equal(stored, observed.state)) { await this.recordObservedOwnership(scope, current, raw === undefined, observed.state); }
    const previousEntry = observed.state.entries[pattern] && { ...observed.state.entries[pattern] };
    const hadPrevious = has(current, pattern), previousValue = current[pattern];
    const token = randomBytes(12).toString('hex');
    const desired = new Map(Object.entries(observed.state.entries).map(([key, entry]) => [key, entry.applied]));
    if (target === 'default') {
      const inherited = { ...dictionary(setting?.defaultValue), ...(scope === 'workspace' ? dictionary(setting?.globalValue) : {}) };
      if (!has(current, pattern) && typeof inherited[pattern] === 'string' && inherited[pattern] !== csvEditor && inherited[pattern] !== 'default') {
        return unsupported('CSV: Your inherited editor association has been preserved. The view can switch; turn CSV off before using Find in Files if that association opens another editor.');
      }
      if (!previousEntry && current[pattern] === 'default') { return { supported: true, commit: async () => {}, rollback: async () => {} }; }
      if (observed.state.ignored.includes(pattern) || (has(current, pattern) && current[pattern] !== csvEditor && !previousEntry)) {
        return unsupported('CSV: Your editor association has been preserved. The view can switch; turn CSV off before using Find in Files if that association opens another editor.');
      }
      desired.set(pattern, 'default');
    } else {
      if (!previousEntry?.textView) { return { supported: true, commit: async () => {}, rollback: async () => {} }; }
      desired.delete(pattern);
    }
    const change = plan(current, raw === undefined, observed.state, desired, false);
    if (target === 'default') {
      const entry = { ...change.finalState.entries[pattern], textView: true, owner: token };
      change.beforeWrite.entries[pattern] = { ...entry };
      change.finalState.entries[pattern] = entry;
    } else { change.finalState.released[pattern] = token; }
    const config = this.api.workspace.getConfiguration('csv');
    const enabled = config.get<boolean>('enabled', true);
    const stillCurrent = () => !this.disposed && this.api.workspace.getConfiguration('csv').get<boolean>('enabled', true) === enabled;
    const readCurrent = () => {
      const latest = this.api.workspace.getConfiguration('workbench').inspect<Associations>('editorAssociations');
      return dictionary(scope === 'global' ? latest?.globalValue : latest?.workspaceValue);
    };
    const expectedHas = has(change.next, pattern), expectedValue = change.next[pattern];
    const rollbackOnce = async () => {
      const latest = readCurrent();
      const stored = recovery(storage).state;
      const recovered = observe(latest, stored);
      if (!equal(stored, recovered.state)) { await this.recordObservedOwnership(scope, latest, false, recovered.state, true); }
      const decision = recovered.state.entries[pattern]?.owner ?? recovered.state.released[pattern];
      if (decision !== token || has(latest, pattern) !== expectedHas || latest[pattern] !== expectedValue) { return; }
      const nextMap = { ...latest };
      if (hadPrevious) { Object.defineProperty(nextMap, pattern, { value: previousValue, enumerable: true, configurable: true, writable: true }); }
      else { delete nextMap[pattern]; }
      const finalState: Ownership = { ...recovered.state, entries: { ...recovered.state.entries }, released: { ...recovered.state.released } };
      if (previousEntry) { finalState.entries[pattern] = previousEntry; delete finalState.released[pattern]; }
      else { delete finalState.entries[pattern]; finalState.released[pattern] = randomBytes(12).toString('hex'); }
      const beforeWrite = previousEntry ? finalState : recovered.state;
      await this.apply(scope, latest, {
        next: nextMap, value: !Object.keys(nextMap).length && change.beforeWrite.containerAbsent ? undefined : nextMap,
        beforeWrite, finalState
      }, () => true, true);
    };
    try {
      await this.apply(scope, current, change, stillCurrent);
      if (!stillCurrent()) { throw new Error('CSV: Editor routing changed while switching views.'); }
      if (has(readCurrent(), pattern) !== expectedHas || readCurrent()[pattern] !== expectedValue) {
        throw new Error('CSV: Could not prepare the file’s editor routing.');
      }
    } catch (error) {
      await rollbackOnce();
      throw error;
    }
    return {
      supported: true, commit: async () => {},
      rollback: () => {
        const rollback = this.pending.catch(() => {}).then(rollbackOnce);
        this.pending = rollback;
        return rollback;
      }
    };
  }
  private async recordObservedOwnership(scope: Scope, current: Associations, absent: boolean, observed: Ownership, cleanup = false): Promise<void> {
    const desired = new Map(Object.entries(observed.entries).map(([pattern, entry]) => [pattern, entry.applied]));
    await this.apply(scope, current, plan(current, absent, observed, desired, false), () => cleanup || !this.disposed, cleanup);
  }
  private async synchronizeOnce(): Promise<void> {
    if (this.disposed) { return; }
    const workbench = this.api.workspace.getConfiguration('workbench');
    const setting = workbench.inspect<Associations>('editorAssociations');
    const enabledSetting = this.api.workspace.getConfiguration('csv').inspect<boolean>('enabled');
    const globalEnabled = enabledSetting?.globalValue ?? enabledSetting?.defaultValue ?? true;
    const effectiveEnabled = this.api.workspace.getConfiguration('csv').get<boolean>('enabled', true);
    const hasWorkspace = !!this.api.workspace.workspaceFile || !!this.api.workspace.workspaceFolders?.length;
    const defaults = dictionary(setting?.defaultValue);
    const globalCurrent = dictionary(setting?.globalValue);
    const globalRecovery = recovery(this.context.globalState);
    const globalObserved = observe(globalCurrent, globalRecovery.state);
    const globalOriginal = { ...defaults, ...globalObserved.original };
    const globalDesired = (hasWorkspace ? globalEnabled : effectiveEnabled) ? new Map<string, string>() : desiredNative(globalOriginal);
    for (const [pattern, entry] of Object.entries(globalObserved.state.entries)) {
      if (entry.textView) { globalDesired.set(pattern, 'default'); }
    }
    const globalPlan = plan(globalCurrent, setting?.globalValue === undefined, globalObserved.state, globalDesired, globalEnabled);
    const stillCurrent = () => {
      const config = this.api.workspace.getConfiguration('csv');
      const global = config.inspect<boolean>('enabled');
      return (global?.globalValue ?? global?.defaultValue ?? true) === globalEnabled && config.get<boolean>('enabled', true) === effectiveEnabled;
    };
    await this.apply('global', globalCurrent, globalPlan, stillCurrent);
    if (this.disposed || !stillCurrent()) { return; }
    if (!hasWorkspace) { this.verifyEffectiveRouting(effectiveEnabled); return; }

    const fresh = workbench.inspect<Associations>('editorAssociations');
    const workspaceCurrent = dictionary(fresh?.workspaceValue);
    const observed = observe(workspaceCurrent, recovery(this.context.workspaceState).state);
    const desired = new Map<string, string>();
    if (!effectiveEnabled) {
      const patterns = new Set(desiredNative({ ...globalOriginal, ...observed.original }).keys());
      for (const pattern of patterns) {
        if (has(observed.original, pattern)) {
          if (observed.original[pattern] === csvEditor) { desired.set(pattern, 'default'); }
        } else if (({ ...defaults, ...globalPlan.next })[pattern] === undefined || ({ ...defaults, ...globalPlan.next })[pattern] === csvEditor) {
          desired.set(pattern, 'default');
        }
      }
    } else {
      // A workspace explicitly enabled above global Off must counter only our
      // inherited temporary native bindings, leaving other editor choices alone.
      for (const [pattern, entry] of Object.entries(globalPlan.finalState.entries)) {
        if (!entry.textView && !has(observed.original, pattern) && globalPlan.next[pattern] === entry.applied) {
          desired.set(pattern, entry.hadPrevious ? entry.previous! : csvEditor);
        }
      }
    }
    for (const [pattern, entry] of Object.entries(observed.state.entries)) {
      if (entry.textView) { desired.set(pattern, 'default'); }
    }
    await this.apply('workspace', workspaceCurrent,
      plan(workspaceCurrent, fresh?.workspaceValue === undefined, observed.state, desired, effectiveEnabled), stillCurrent);
    if (!this.disposed && stillCurrent()) { this.verifyEffectiveRouting(effectiveEnabled); }
  }
  private verifyEffectiveRouting(enabled: boolean): void {
    if (enabled) { return; }
    const effective = this.api.workspace.getConfiguration('workbench').get<Associations>('editorAssociations', {});
    const blocked = Object.keys(effective).filter(pattern => effective[pattern] === csvEditor);
    if (blocked.length) {
      throw new Error(`CSV could not disable its effective editor associations (${blocked.join(', ')}). A policy or another settings scope still selects CSV.`);
    }
  }
  private async apply(scope: Scope, previous: Associations, change: ReturnType<typeof plan>, stillCurrent: () => boolean, cleanup = false): Promise<void> {
    const storage = scope === 'global' ? this.context.globalState : this.context.workspaceState;
    const target = scope === 'global' ? this.api.ConfigurationTarget.Global : this.api.ConfigurationTarget.Workspace;
    const current = () => {
      const setting = this.api.workspace.getConfiguration('workbench').inspect<Associations>('editorAssociations');
      return dictionary(scope === 'global' ? setting?.globalValue : setting?.workspaceValue);
    };
    if (!equal(previous, change.next)) {
      // Each operation owns an immutable key. A delayed window cannot overwrite
      // another window's backup of a more-specific user association.
      const key = `${journalPrefix}${Date.now()}.${randomBytes(12).toString('hex')}`;
      const journal: Journal = { created: performance.timeOrigin + performance.now(), state: change.beforeWrite };
      await storage.update(key, journal);
      const discardUnappliedJournal = async () => {
        if (equal(current(), previous) && equal(storage.get(key), journal)) { await storage.update(key, undefined); }
      };
      if ((!cleanup && this.disposed) || !stillCurrent()) { await discardUnappliedJournal(); return; }
      const fresh = current();
      if (!equal(fresh, previous)) {
        // We have not changed preferences. Only the operation that actually
        // installed this map owns its recovery; a coalesced stale plan must not
        // supersede a newer user choice captured by that operation.
        if (equal(storage.get(key), journal)) { await storage.update(key, undefined); }
        if (!equal(fresh, change.next)) {
          throw new Error('Editor associations changed while CSV was updating routing; retry the toggle.');
        }
        return; // The actual writer also owns finalization of this map.
      }
      try {
        if (!equal(fresh, change.next)) {
          await this.api.workspace.getConfiguration('workbench').update('editorAssociations', change.value, target);
        }
        if (!equal(current(), change.next)) {
          throw new Error('VS Code did not apply the routing preferences; a policy or read-only settings may prevent this change.');
        }
      } catch (error) {
        await discardUnappliedJournal();
        throw new Error(`CSV could not update ${scope} editor routing: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (!stillCurrent() || (!cleanup && this.disposed)) { return; }
    const keep = Object.keys(change.finalState.entries).length || change.finalState.ignored.length;
    const recovered = recovery(storage);
    if (keep && !equal(recovered.state, change.finalState)) {
      // A real observed user edit relinquishes ownership even if it needs no
      // settings write. Choosing the old value later must remain user-owned.
      const key = `${journalPrefix}${Date.now()}.${randomBytes(12).toString('hex')}`;
      await storage.update(key, { created: performance.timeOrigin + performance.now(), state: change.finalState } as Journal);
    }
    if (!keep) {
      const live = current();
      const relinquished = new Set([...recovered.state.ignored, ...Object.keys(recovered.state.released)]);
      for (const { key, value } of recovered.journals) {
        // Clear only the observed immutable record after its temporary values
        // have gone. A concurrently added journal has a different key.
        if (Object.entries(ownership(value.state).entries).some(([pattern, entry]) => !relinquished.has(pattern) && live[pattern] === entry.applied)) { continue; }
        if (equal(storage.get(key), value)) { await storage.update(key, undefined); }
      }
    }
  }
}
