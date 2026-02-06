import assert from 'assert';
import { describe, it } from 'node:test';
import fs from 'fs';
import path from 'path';

describe('Webview find/replace widget', () => {
  const providerSource = fs.readFileSync(path.join(process.cwd(), 'src', 'CsvEditorProvider.ts'), 'utf8');
  const webviewSource = fs.readFileSync(path.join(process.cwd(), 'media', 'main.js'), 'utf8');

  it('renders two-row find/replace overlay controls', () => {
    assert.ok(providerSource.includes('id="findReplaceWidget"'));
    assert.ok(providerSource.includes('id="replaceToggle"'));
    assert.ok(providerSource.includes('id="findInput"'));
    assert.ok(providerSource.includes('id="replaceInput"'));
    assert.ok(providerSource.includes('id="findCaseToggle"'));
    assert.ok(providerSource.includes('id="findWordToggle"'));
    assert.ok(providerSource.includes('id="findRegexToggle"'));
    assert.ok(providerSource.includes('id="replaceCaseToggle"'));
    assert.ok(providerSource.includes('id="findPrev"'));
    assert.ok(providerSource.includes('id="findNext"'));
    assert.ok(providerSource.includes('id="findMenuButton"'));
    assert.ok(providerSource.includes('id="replaceOne"'));
    assert.ok(providerSource.includes('id="replaceAll"'));
  });

  it('supports find and replace keyboard shortcuts', () => {
    assert.ok(webviewSource.includes("key === 'f'"));
    assert.ok(webviewSource.includes("key === 'h'"));
    assert.ok(webviewSource.includes('openFindReplace(false);'));
    assert.ok(webviewSource.includes('openFindReplace(true);'));
    assert.ok(webviewSource.includes('if (findReplaceState.open && e.key === \'Escape\') {'));
    assert.ok(webviewSource.includes('if (e.key === \'Enter\') {'));
  });

  it('tracks disabled states for navigation and replace actions', () => {
    assert.ok(webviewSource.includes('findPrev.disabled = !hasMatches;'));
    assert.ok(webviewSource.includes('findNext.disabled = !hasMatches;'));
    assert.ok(webviewSource.includes('replaceOne.disabled = !hasQuery || !hasMatches;'));
    assert.ok(webviewSource.includes('replaceAll.disabled = !hasQuery || !hasMatches;'));
  });

  it('sends replace-all changes in a single batch message', () => {
    assert.ok(webviewSource.includes("type: 'replaceCells'"));
  });

  it('requests global match coordinates from the extension and handles async results', () => {
    assert.ok(webviewSource.includes("type: 'findMatches'"));
    assert.ok(webviewSource.includes("message.type === 'findMatchesResult'"));
  });
});
