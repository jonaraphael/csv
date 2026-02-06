import assert from 'assert';
import { describe, it } from 'node:test';
import fs from 'fs';
import path from 'path';

describe('Webview remote chunk transport', () => {
  const providerSource = fs.readFileSync(path.join(process.cwd(), 'src', 'CsvEditorProvider.ts'), 'utf8');
  const webviewSource = fs.readFileSync(path.join(process.cwd(), 'media', 'main.js'), 'utf8');

  it('publishes remote chunk metadata on the root table container', () => {
    assert.ok(providerSource.includes('data-nextchunkstart="${nextChunkStart >= 0 ? nextChunkStart : \'\'}"'));
    assert.ok(providerSource.includes('data-hasmorechunks="${hasRemoteChunks ? \'1\' : \'0\'}"'));
  });

  it('requests and handles chunk payloads over postMessage', () => {
    assert.ok(webviewSource.includes("type: 'requestChunk'"));
    assert.ok(webviewSource.includes("message.type === 'chunkData'"));
  });

  it('continues ensure-target rendering as chunks arrive', () => {
    assert.ok(webviewSource.includes('pendingEnsureTarget'));
    assert.ok(webviewSource.includes("window.addEventListener('csvChunkLoaded', ensureTargetStep);"));
  });
});
