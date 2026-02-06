import assert from 'assert';
import { describe, it } from 'node:test';
import fs from 'fs';
import path from 'path';

describe('Webview navigation shortcuts', () => {
  const webviewScript = fs.readFileSync(path.join(process.cwd(), 'media', 'main.js'), 'utf8');

  it('does not hijack Ctrl/Cmd+PageUp or Ctrl/Cmd+PageDown', () => {
    assert.ok(!webviewScript.includes("'Home','End','PageUp','PageDown'"));
    assert.ok(webviewScript.includes("'Home','End'"));
  });
});
