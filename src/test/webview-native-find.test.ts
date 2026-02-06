import assert from 'assert';
import { describe, it } from 'node:test';
import fs from 'fs';
import path from 'path';

describe('Webview custom find integration', () => {
  const extensionSource = fs.readFileSync(path.join(process.cwd(), 'src', 'extension.ts'), 'utf8');
  const providerSource = fs.readFileSync(path.join(process.cwd(), 'src', 'CsvEditorProvider.ts'), 'utf8');
  const webviewScript = fs.readFileSync(path.join(process.cwd(), 'media', 'main.js'), 'utf8');

  it('does not enable native webview find widget', () => {
    assert.ok(!extensionSource.includes('enableFindWidget: true'));
  });

  it('renders the custom in-webview find/replace controls', () => {
    assert.ok(providerSource.includes('id="findReplaceWidget"'));
    assert.ok(providerSource.includes('id="findInput"'));
    assert.ok(providerSource.includes('id="replaceInput"'));
    assert.ok(providerSource.includes('id="findNext"'));
    assert.ok(providerSource.includes("case 'findMatches':"));
    assert.ok(providerSource.includes("type: 'findMatchesResult'"));
  });

  it('handles Ctrl/Cmd+F and Ctrl/Cmd+H in the webview script', () => {
    assert.ok(webviewScript.includes("key === 'f'"));
    assert.ok(webviewScript.includes("key === 'h'"));
    assert.ok(webviewScript.includes('openFindReplace(false);'));
    assert.ok(webviewScript.includes('openFindReplace(true);'));
  });
});
