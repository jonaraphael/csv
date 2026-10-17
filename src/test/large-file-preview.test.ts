import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it } from 'node:test';
import { createEditorHarness } from './edit-integrity-harness';
import { LargeFilePreviewProvider, renderPreviewRows } from '../large-file-preview';
import { activate } from '../extension';
const { JSDOM } = require('jsdom');

async function previewFixture(run: (fixture: any) => Promise<void>) {
  const host = await createEditorHarness();
  host.configuration.largeFilePreviewRows = 1;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-preview-'));
  const file = path.join(directory, 'preview.csv');
  fs.writeFileSync(file, 'name,value\none,two\nthree,four\n');
  const Uri = host.document.uri.constructor as any;
  const provider = new LargeFilePreviewProvider({ extensionPath: process.cwd(), workspaceState: { get: (_key: string, fallback: unknown) => fallback } } as any);
  const document = await provider.openCustomDocument(new Uri(file));
  const messages: any[] = [];
  let receive!: (message: unknown) => Promise<void>;
  let dispose!: () => void;
  const panel = {
    webview: {
      html: '', options: {},
      asWebviewUri: (uri: unknown) => String(uri),
      postMessage: (message: unknown) => { messages.push(message); return Promise.resolve(true); },
      onDidReceiveMessage: (listener: typeof receive) => { receive = listener; }
    },
    onDidDispose: (listener: () => void) => { dispose = listener; }
  };
  try {
    await provider.resolveCustomEditor(document, panel as any, { isCancellationRequested: false } as any);
    await run({ host, file, provider, document, panel, messages, receive: (message: unknown) => receive(message), dispose: () => dispose() });
  } finally {
    document.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

describe('Read-only large file provider', () => {
  it('pages complete records, reports source changes and reloads on explicit Start', async () => {
    await previewFixture(async fixture => {
      await fixture.receive({ type: 'ready' });
      assert.ok(fixture.messages.at(-1).html.includes('name'));
      await fixture.receive({ type: 'next' });
      assert.ok(fixture.messages.at(-1).html.includes('one'));
      assert.ok(!fixture.messages.at(-1).html.includes('name'));
      fs.appendFileSync(fixture.file, 'changed,row\n');
      await fixture.receive({ type: 'next' });
      assert.match(fixture.messages.at(-1).error, /file changed/);
      assert.strictEqual(fixture.messages.at(-1).html, '');
      await fixture.receive({ type: 'previous' });
      assert.match(fixture.messages.at(-1).error, /file changed/);
      await fixture.receive({ type: 'start' });
      assert.strictEqual(fixture.messages.at(-1).error, '');
      assert.ok(fixture.messages.at(-1).html.includes('name'));
    });
  });

  it('does not read or post after panel/document disposal and rejects remote file providers', async () => {
    await previewFixture(async fixture => {
      fixture.dispose();
      await fixture.receive({ type: 'ready' });
      assert.strictEqual(fixture.messages.length, 0);
      const Uri = fixture.host.document.uri.constructor;
      await assert.rejects(fixture.provider.openCustomDocument(new Uri('/remote/file.csv', 'vscode-remote')), /host-local/);
    });
  });

  it('respects csv.enabled before any preview data read', async () => {
    await previewFixture(async fixture => {
      fixture.host.configuration.enabled = false;
      await fixture.receive({ type: 'ready' });
      assert.match(fixture.messages.at(-1).error, /CSV is disabled/);
      assert.strictEqual(fixture.messages.at(-1).html, '');
    });
  });

  it('rejects unsupported automatic separator mode explicitly rather than displaying wrong columns', async () => {
    await previewFixture(async fixture => {
      fixture.host.configuration.separatorMode = 'auto';
      await fixture.receive({ type: 'ready' });
      assert.match(fixture.messages.at(-1).error, /does not support automatic separator detection/);
      assert.match(fixture.messages.at(-1).error, /csv.separatorMode/);
      assert.strictEqual(fixture.messages.at(-1).html, '');
      fixture.host.configuration.separatorMode = 'extension';
      await fixture.receive({ type: 'start' });
      assert.strictEqual(fixture.messages.at(-1).error, '');
      assert.ok(fixture.messages.at(-1).html.includes('name'));
    });
  });

  it('opens directly as a readonly custom document and never writes saved bytes', async () => {
    await previewFixture(async fixture => {
      fixture.host.registerCommands();
      const before = fs.readFileSync(fixture.file);
      await fixture.host.commands.get('csv.openLargeFilePreview')(fixture.document.uri);
      assert.strictEqual(fixture.host.executedCommands.at(-1).name, 'vscode.openWith');
      assert.strictEqual(fixture.host.executedCommands.at(-1).args[1], LargeFilePreviewProvider.viewType);
      await fixture.receive({ type: 'ready' });
      await fixture.receive({ type: 'editCell', row: 0, col: 0, value: 'attempted mutation' });
      await fixture.receive({ type: 'next' });
      assert.deepStrictEqual(fs.readFileSync(fixture.file), before);
    });
  });

  it('keeps a readonly preview from upgrading to a full text document when CSV is enabled', async () => {
    await previewFixture(async fixture => {
      fixture.host.tabGroups = [{ tabs: [{ input: { uri: fixture.document.uri, viewType: LargeFilePreviewProvider.viewType } }] }];
      activate({ subscriptions: [], extensionPath: process.cwd() } as any);
      fixture.host.configurationListeners[0]({ affectsConfiguration: (key: string) => key === 'csv.enabled' });
      await new Promise(resolve => setImmediate(resolve));
      assert.strictEqual(fixture.host.executedCommands.length, 0);
      assert.ok(fixture.host.providers.includes(LargeFilePreviewProvider.viewType));
    });
  });

  it('shows malformed records as errors without displaying partial data', async () => {
    await previewFixture(async fixture => {
      fs.writeFileSync(fixture.file, 'name,value\n"unfinished');
      await fixture.receive({ type: 'ready' });
      await fixture.receive({ type: 'next' });
      assert.match(fixture.messages.at(-1).error, /Unterminated quoted record/);
      assert.strictEqual(fixture.messages.at(-1).html, '');
      assert.strictEqual(fixture.messages.at(-1).canNext, false);
    });
  });

  it('closes an in-flight read when its document is disposed and posts no late data', async () => {
    await previewFixture(async fixture => {
      const originalOpen = fs.promises.open;
      let release!: () => void;
      let reading!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const started = new Promise<void>(resolve => { reading = resolve; });
      let closed = 0;
      (fs.promises as any).open = async (...args: Parameters<typeof fs.promises.open>) => {
        const handle = await originalOpen(...args);
        return new Proxy(handle, {
          get(target, key) {
            if (key === 'read') {
              return async (...readArgs: any[]) => { reading(); await gate; return (target.read as any)(...readArgs); };
            }
            if (key === 'close') {
              return async () => { closed++; await target.close(); };
            }
            const value = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
          }
        });
      };
      try {
        const pending = fixture.receive({ type: 'ready' });
        await started;
        fixture.document.dispose();
        release();
        await pending;
        assert.strictEqual(closed, 1);
        assert.strictEqual(fixture.messages.length, 0);
      } finally {
        release();
        fs.promises.open = originalOpen;
      }
    });
  });

  it('renders escaped values and replaces rather than accumulating DOM pages', async () => {
    await previewFixture(async fixture => {
      const dom = new JSDOM(fixture.panel.webview.html, { runScripts: 'outside-only' });
      const messages: unknown[] = [];
      dom.window.acquireVsCodeApi = () => ({ postMessage: (message: unknown) => messages.push(message) });
      dom.window.eval(fs.readFileSync(path.join(process.cwd(), 'media', 'large-preview.js'), 'utf8'));
      const payload = '<img src="https://example.test/secret" onerror="bad()"> & "quoted"';
      for (let page = 0; page < 100; page++) {
        dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: {
          type: 'page', html: renderPreviewRows([[payload, String(page)]], page), status: 'Read-only', canBack: true, canNext: true
        } }));
      }
      assert.strictEqual(dom.window.document.querySelectorAll('#records tbody tr').length, 1);
      assert.strictEqual(dom.window.document.querySelectorAll('#records img, #records script').length, 0);
      assert.ok(dom.window.document.getElementById('records').textContent.includes(payload));
      assert.strictEqual(dom.window.document.querySelectorAll('[contenteditable]').length, 0);
      dom.window.document.getElementById('next').click();
      assert.deepStrictEqual(messages.map((message: any) => message.type), ['ready', 'next']);
      dom.window.close();
    });
  });
});
