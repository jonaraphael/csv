import assert from 'assert';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { describe, it } from 'node:test';
import { serializeClipboardMatrix } from '../clipboard';

type Listener = { callback: (event: any) => void; capture: boolean };

// Execute the complete shipped script. The small DOM model supplies selection,
// focus and event propagation; it does not reimplement clipboard behavior.
function createWebview() {
  class Element {
    listeners = new Map<string, Listener[]>();
    attributes = new Map<string, string>();
    classes = new Set<string>();
    children: Element[] = [];
    parentElement: Element | null = null;
    style: Record<string, string> = {};
    dataset: Record<string, string> = {};
    textContent = '';
    value = '';
    isContentEditable = false;
    isConnected = true;
    classList = {
      add: (...names: string[]) => names.forEach(name => this.classes.add(name)),
      remove: (...names: string[]) => names.forEach(name => this.classes.delete(name)),
      contains: (name: string) => this.classes.has(name),
      toggle: (name: string, force?: boolean) => {
        const next = force ?? !this.classes.has(name);
        if (next) { this.classes.add(name); } else { this.classes.delete(name); }
        return next;
      }
    };
    constructor(public tagName = 'DIV', public id = '') {}
    addEventListener(type: string, callback: (event: any) => void, options?: any) {
      const listeners = this.listeners.get(type) || [];
      listeners.push({ callback, capture: options === true });
      this.listeners.set(type, listeners);
    }
    removeEventListener() {}
    setAttribute(name: string, value: string) { this.attributes.set(name, value); }
    getAttribute(name: string) { return this.attributes.get(name) ?? null; }
    hasAttribute(name: string) { return this.attributes.has(name); }
    appendChild(child: Element) { child.parentElement = this; this.children.push(child); }
    contains(other: Element): boolean { return other === this || this.children.some(child => child.contains(other)); }
    focus() { document.activeElement = this; }
    scrollIntoView() {}
    matches(selector: string): boolean {
      if (selector.includes(' ')) {
        const [ancestor, child] = selector.split(' ');
        return this.matches(child) && !!this.parentElement?.closest(ancestor);
      }
      if (selector.startsWith('#')) { return this.id === selector.slice(1); }
      const tag = selector.match(/^[a-z]+/i)?.[0];
      if (tag && this.tagName !== tag.toUpperCase()) { return false; }
      if (selector.includes('.')) { return selector.split('.').slice(1).every(name => this.classes.has(name)); }
      for (const match of selector.matchAll(/\[([^=\]]+)(?:="([^"]*)")?\]/g)) {
        if (match[2] === undefined ? !this.hasAttribute(match[1]) : this.getAttribute(match[1]) !== match[2]) { return false; }
      }
      return true;
    }
    closest(selector: string): Element | null {
      if (selector.split(',').some(part => this.matches(part.trim()))) { return this; }
      return this.parentElement?.closest(selector) ?? null;
    }
    querySelectorAll(selector: string): Element[] {
      const descendants = this.children.flatMap(child => [child, ...child.querySelectorAll('*')]);
      return descendants.filter(child => selector === '*' || selector.split(',').some(part => child.matches(part.trim())));
    }
    querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
    get innerHTML() { return ''; }
    set innerHTML(_value: string) { this.children = []; }
    get innerText() { return this.textContent; }
    set innerText(value: string) { this.textContent = value; }
  }
  const document = new Element('DOCUMENT') as Element & { body: Element; activeElement: Element | null; getElementById: (id: string) => Element };
  document.body = new Element('BODY');
  document.activeElement = null;
  document.appendChild(document.body);
  const elements = new Map<string, Element>();
  const byId = (id: string) => {
    if (!elements.has(id)) {
      const el = new Element(id.endsWith('Input') ? 'INPUT' : 'DIV', id);
      elements.set(id, el);
      document.body.appendChild(el);
    }
    return elements.get(id)!;
  };
  document.getElementById = byId;
  const root = byId('csv-root');
  const table = new Element('TABLE');
  const head = new Element('THEAD');
  table.appendChild(head);
  root.appendChild(table);
  byId('__csvChunks').textContent = '[]';
  const widget = byId('findReplaceWidget');
  for (const id of ['findInput', 'replaceInput']) {
    const input = byId(id);
    document.body.children = document.body.children.filter(el => el !== input);
    widget.appendChild(input);
  }
  const window = new Element('WINDOW') as any;
  window.getComputedStyle = () => ({ fontSize: '14px' });
  const messages: any[] = [];
  const context = vm.createContext({
    document, window, Element, Node: Element,
    acquireVsCodeApi: () => ({ getState: () => ({}), setState: () => {}, postMessage: (message: any) => messages.push(JSON.parse(JSON.stringify(message))) }),
    setTimeout: () => 0, clearTimeout: () => {}, requestAnimationFrame: () => 0,
    console
  });
  (document as any).createElement = (tag: string) => new Element(tag.toUpperCase());
  vm.runInContext(fs.readFileSync(path.join(process.cwd(), 'media', 'main.js'), 'utf8'), context);
  const cell = (row: number, col: number, value: string, header = false) => {
    const el = new Element(header ? 'TH' : 'TD');
    el.setAttribute('data-row', String(row));
    el.setAttribute('data-col', String(col));
    el.textContent = value;
    (header ? head : table).appendChild(el);
    return el;
  };
  const dispatch = (target: Element, type: string, options: any = {}) => {
    const event: any = {
      type, target, defaultPrevented: false, stopped: false, immediate: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.stopped = true; },
      stopImmediatePropagation() { this.stopped = true; this.immediate = true; },
      ...options
    };
    const invoke = (el: Element, capture: boolean) => {
      for (const listener of el.listeners.get(type) || []) {
        if (listener.capture === capture && !event.immediate) { listener.callback(event); }
      }
    };
    invoke(document, true);
    if (!event.stopped) { invoke(target, false); }
    for (let parent = target.parentElement; parent && !event.stopped; parent = parent.parentElement) { invoke(parent, false); }
    return event;
  };
  return { context, cell, byId, document, table, messages, dispatch, select: (startRow: number, startCol: number, endRow = startRow, endCol = startCol) => {
    vm.runInContext(`selectRange({ row: ${startRow}, col: ${startCol} }, { row: ${endRow}, col: ${endCol} }); anchorCell = currentSelection[0];`, context);
  }};
}

describe('Shipped webview clipboard interactions', () => {
  it('exports plain single-cell text for native paste into Search', () => {
    const view = createWebview();
    const cell = view.cell(1, 0, 'hello world');
    view.select(1, 0);
    view.dispatch(cell, 'copy');
    const clipboardText = serializeClipboardMatrix(view.messages[0].matrix, ',');
    assert.strictEqual(clipboardText, 'hello world');
    const input = view.byId('findInput');
    input.focus();
    const event = view.dispatch(input, 'paste', { clipboardData: { getData: () => clipboardText } });
    assert.strictEqual(event.defaultPrevented, false, 'Search must retain native text paste');
    assert.strictEqual(view.messages.length, 1, 'Search paste must not become a grid paste');
  });

  it('copies headers and multiline values without serial indices or trimmed blanks', () => {
    const view = createWebview();
    view.cell(0, -1, '#', true);
    view.cell(0, 0, 'Header', true);
    view.cell(0, 1, '', true);
    view.cell(1, -1, '1');
    const target = view.cell(1, 0, 'literal,comma\nand newline');
    view.cell(1, 1, '  ');
    view.select(0, -1, 1, 1);
    const event = view.dispatch(target, 'copy');
    assert.strictEqual(event.defaultPrevented, true);
    assert.deepStrictEqual(view.messages, [{ type: 'copyCells', matrix: [['Header', ''], ['literal,comma\nand newline', '  ']], rowIds: [0, 1], startCol: 0, cut: false }]);
  });

  it('routes grid Ctrl/Cmd+C and X through system clipboard messages', () => {
    for (const modifier of ['ctrlKey', 'metaKey']) {
      for (const key of ['c', 'x']) {
        const view = createWebview();
        const target = view.cell(1, 0, 'value');
        view.select(1, 0);
        const event = view.dispatch(target, 'keydown', { key, [modifier]: true });
        assert.strictEqual(event.defaultPrevented, true);
        assert.strictEqual(view.messages[0].cut, key === 'x');
        assert.strictEqual(target.textContent, 'value', 'cut must wait for the clipboard write');
      }
    }
  });

  it('provides Cut, Copy and Paste actions for the preserved right-click selection', () => {
    const view = createWebview();
    const first = view.cell(1, 0, 'one');
    const second = view.cell(1, 1, 'two');
    view.select(1, 0, 1, 1);
    view.dispatch(second, 'mousedown', { button: 2 });
    view.dispatch(second, 'contextmenu', { pageX: 10, pageY: 20 });
    const menu = view.byId('contextMenu');
    for (const label of ['Copy', 'Cut', 'Paste']) {
      const item = menu.children.find(child => child.textContent === label)!;
      assert.ok(item);
      view.dispatch(item, 'click');
    }
    assert.deepStrictEqual(view.messages.map(message => message.type), ['copyCells', 'copyCells', 'pasteFromClipboard']);
    assert.deepStrictEqual(view.messages[0].matrix, [['one', 'two']]);
    assert.strictEqual(view.messages[1].cut, true);
    assert.strictEqual(view.messages[2].anchorCol, 0);
    assert.strictEqual(first.textContent, 'one');
  });

  it('allows native text clipboard shortcuts and paste in Find and Replace', () => {
    for (const id of ['findInput', 'replaceInput']) {
      for (const modifier of ['ctrlKey', 'metaKey']) {
        const view = createWebview();
        view.cell(1, 0, 'selected grid value');
        view.select(1, 0);
        const input = view.byId(id);
        for (const key of ['a', 'c', 'x', 'v']) {
          const event = view.dispatch(input, 'keydown', { key, [modifier]: true });
          assert.strictEqual(event.defaultPrevented, false, `${id} ${key} default`);
          assert.strictEqual(event.stopped, false, `${id} ${key} must reach the VS Code webview bridge`);
        }
        for (const type of ['copy', 'cut', 'paste']) {
          const event = view.dispatch(input, type, { clipboardData: { getData: () => 'SKU-123' } });
          assert.strictEqual(event.defaultPrevented, false);
        }
        assert.deepStrictEqual(view.messages, []);
      }
    }
  });

  it('keeps native text copy, cut, paste and context menus while editing a cell', () => {
    const view = createWebview();
    const target = view.cell(1, 0, 'text edit');
    view.select(1, 0);
    vm.runInContext('editingCell = currentSelection[0];', view.context);
    target.isContentEditable = true;
    for (const type of ['copy', 'cut', 'paste', 'contextmenu']) {
      const event = view.dispatch(target, type, { clipboardData: { getData: () => 'text' } });
      assert.strictEqual(event.defaultPrevented, false);
    }
    const event = view.dispatch(target, 'keydown', { key: 'c', metaKey: true });
    assert.strictEqual(event.defaultPrevented, false);
    assert.deepStrictEqual(view.messages, []);
  });

  it('posts a grid paste while leaving the selected cell contents to the host', () => {
    const view = createWebview();
    const target = view.cell(1, 0, 'before');
    view.select(1, 0);
    const event = view.dispatch(target, 'paste', { clipboardData: { getData: () => '"with,comma"' } });
    assert.strictEqual(event.defaultPrevented, true);
    assert.strictEqual(view.messages[0].type, 'pasteCells');
    assert.strictEqual(view.messages[0].text, '"with,comma"');
    assert.strictEqual(target.textContent, 'before');
  });
});
