import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const EXT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const manifest = JSON.parse(readFileSync(resolve(EXT, 'manifest.json'), 'utf8')) as {
  permissions: string[];
  content_scripts: { js: string[] }[];
};
const serviceWorker = readFileSync(resolve(EXT, 'src/background/service-worker.ts'), 'utf8');

/**
 * Regression (US-005): after an extension reload/update, chatgpt.com tabs that were already open held no content
 * script until the user refreshed them — the avatar could not be enabled in the tab the user was looking at.
 */
describe('content script recovery after an extension update', () => {
  it('declares the scripting permission the re-injection needs', () => {
    expect(manifest.permissions).toContain('scripting');
  });

  it('re-injects the content script into open chatgpt.com tabs on install/update', () => {
    expect(serviceWorker).toMatch(/chrome\.runtime\.onInstalled\.addListener/);
    expect(serviceWorker).toMatch(/chrome\.scripting\s*\n?\s*\.executeScript/);
    expect(serviceWorker).toMatch(/files: \['content\.js'\]/);
    // The injected file is the one the manifest declares, not a second copy of the content script.
    expect(manifest.content_scripts[0]!.js).toEqual(['content.js']);
  });
});
