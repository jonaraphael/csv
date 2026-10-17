import fs from 'fs';
import path from 'path';
import vm from 'vm';

type Listener = { callback: (event: any) => void; capture: boolean };

// Execute the complete shipped script. The small DOM model supplies selection,
// focus and event propagation; it does not reimplement clipboard behavior.
export function createWebview(options: { state?: any; persistedColumns?: Record<string, number>; header?: boolean } = {}) {
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
    rect = { left: 0, right: 100, top: 0, bottom: 30, width: 100, height: 30 };
    getBoundingClientRect() { return this.rect; }
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
  if (options.header !== false) { table.appendChild(head); }
  root.appendChild(table);
  root.dataset.columnsizes = JSON.stringify(options.persistedColumns || {});
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
  let savedState = options.state || {};
  const context = vm.createContext({
    document, window, Element, Node: Element,
    acquireVsCodeApi: () => ({ getState: () => savedState, setState: (state: any) => { savedState = state; }, postMessage: (message: any) => messages.push(JSON.parse(JSON.stringify(message))) }),
    setTimeout: () => 0, clearTimeout: () => {}, requestAnimationFrame: () => 0,
    console
  });
  (document as any).createElement = (tag: string) => new Element(tag.toUpperCase());
  vm.runInContext(fs.readFileSync(path.join(process.cwd(), 'media', 'main.js'), 'utf8'), context);
  // Interaction assertions begin after the independent initialization handshake.
  messages.length = 0;
  const cell = (row: number, col: number, value: string, header = false) => {
    const el = new Element(header ? 'TH' : 'TD');
    el.rect = { left: col * 100, right: (col + 1) * 100, top: row * 30, bottom: (row + 1) * 30, width: 100, height: 30 };
    el.style.width = ''; el.style.minWidth = '8ch'; el.style.maxWidth = '100ch';
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

