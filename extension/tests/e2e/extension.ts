import { test as base, chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const EXTENSION_DIR = resolve(here, '../../dist');
const FIXTURE = readFileSync(resolve(here, 'fixtures/chatgpt.html'), 'utf8');

/** Chromium's id for an unpacked extension: sha256 of its absolute path, hex digits mapped to a–p. */
export function unpackedExtensionId(path: string): string {
  const hex = createHash('sha256').update(path).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

/**
 * A CSP in the spirit of chatgpt.com's: page scripts can't load chrome-extension:// resources or blob: images,
 * so the test catches anything that only works because the page is permissive.
 */
const FIXTURE_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self'",
].join('; ');

export interface ExtensionOptions {
  /**
   * WAV played by Chromium's fake microphone (--use-fake-device-for-media-stream). Also grants the extension origin
   * the microphone, which a real user does once on the permission page. Undefined: no fake mic.
   */
  fakeMicWav: string | undefined;
  /** Grant the microphone up front (what the permission page does once for a real user). Default true. */
  grantMic: boolean;
}

export interface ExtensionFixtures {
  context: BrowserContext;
  serviceWorker: Worker;
  extensionId: string;
  /** chatgpt.com fixture page with the extension's content script injected. */
  chatgpt: Page;
}

export const test = base.extend<ExtensionFixtures & ExtensionOptions>({
  fakeMicWav: [undefined, { option: true }],
  grantMic: [true, { option: true }],
  context: async ({ fakeMicWav, grantMic }, use) => {
    if (!existsSync(resolve(EXTENSION_DIR, 'manifest.json'))) {
      throw new Error(`No built extension in ${EXTENSION_DIR}: run "npm run build:dev" first`);
    }
    const id = unpackedExtensionId(EXTENSION_DIR);
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium', // new headless: supports extensions
      headless: true,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
      // Playwright mutes headless audio, which would make the captured tab audio all zeros.
      ignoreDefaultArgs: ['--mute-audio'],
      args: [
        `--disable-extensions-except=${EXTENSION_DIR}`,
        `--load-extension=${EXTENSION_DIR}`,
        // Lets the E2E hook start tabCapture without a click on the toolbar button (user gesture).
        `--allowlisted-extension-id=${id}`,
        '--autoplay-policy=no-user-gesture-required',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        ...(fakeMicWav
          ? [
              // Not --use-fake-ui-for-media-stream: it makes tabCapture's stream id fail ("Requested device not found").
              '--use-fake-device-for-media-stream',
              `--use-file-for-fake-audio-capture=${fakeMicWav}%noloop`,
            ]
          : []),
      ],
    });
    // Chromium refuses a grant for the chrome-extension:// origin by name ("opaque origin"); a context-wide grant
    // covers it. A real user grants it once on the extension's permission page.
    if (fakeMicWav && grantMic) await context.grantPermissions(['microphone']);
    await context.route('https://chatgpt.com/**', (route) =>
      route.fulfill({ contentType: 'text/html', headers: { 'content-security-policy': FIXTURE_CSP }, body: FIXTURE }),
    );
    await use(context);
    await context.close();
  },
  serviceWorker: async ({ context }, use) => {
    const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    await use(sw);
  },
  extensionId: async ({ serviceWorker }, use) => {
    await use(new URL(serviceWorker.url()).host);
  },
  chatgpt: async ({ context }, use) => {
    const page = await context.newPage();
    await page.goto('https://chatgpt.com/');
    await page.locator('html[data-prosopon-content="ready"]').waitFor({ state: 'attached' });
    await use(page);
  },
});

export const expect = test.expect;

export async function tabIdOf(sw: Worker, page: Page): Promise<number> {
  const url = page.url();
  return sw.evaluate(async (u) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url === u) ?? tabs.find((t) => t.url?.startsWith('https://chatgpt.com/'));
    if (tab?.id === undefined) throw new Error(`no tab for ${u}`);
    return tab.id;
  }, url);
}

interface E2EHook {
  toggle(tabId: number): Promise<void>;
  state(tabId: number): { state: string; error?: string };
  hasOffscreen(): Promise<boolean>;
  setMic(enabled: boolean, interactive?: boolean): Promise<{ state: string; error?: string } | null>;
  micInfo(): Promise<MicInfoReply | null>;
}

export interface MicInfoReply {
  state: string;
  error?: string;
  liveTracks: number;
  pipelines: number;
  analyserOutputs: number | null;
  reachedDestination: boolean;
}

/** The "Microphone reactions" menu checkbox, through the development-only hook. */
export function setMic(
  sw: Worker,
  enabled: boolean,
  interactive = false,
): Promise<{ state: string; error?: string } | null> {
  return sw.evaluate(
    ([on, click]) => (globalThis as unknown as { __prosopon: E2EHook }).__prosopon.setMic(on, click),
    [enabled, interactive] as const,
  );
}

export function micInfo(sw: Worker): Promise<MicInfoReply | null> {
  return sw.evaluate(() => (globalThis as unknown as { __prosopon: E2EHook }).__prosopon.micInfo());
}

/** The toolbar button, through the development-only hook in the service worker. */
export function toggle(sw: Worker, tabId: number): Promise<void> {
  return sw.evaluate((id) => (globalThis as unknown as { __prosopon: E2EHook }).__prosopon.toggle(id), tabId);
}

export function tabState(sw: Worker, tabId: number): Promise<{ state: string; error?: string }> {
  return sw.evaluate((id) => (globalThis as unknown as { __prosopon: E2EHook }).__prosopon.state(id), tabId);
}

export function hasOffscreen(sw: Worker): Promise<boolean> {
  return sw.evaluate(() => (globalThis as unknown as { __prosopon: E2EHook }).__prosopon.hasOffscreen());
}

export const root = (page: Page) => page.locator('#prosopon-root');

/** Counts inside the overlay's (open) shadow root and on the page. */
export function overlayCounts(page: Page): Promise<{ roots: number; canvases: number }> {
  return page.evaluate(() => {
    const roots = document.querySelectorAll('#prosopon-root');
    let canvases = 0;
    for (const r of roots) canvases += r.shadowRoot?.querySelectorAll('canvas').length ?? 0;
    return { roots: roots.length, canvases };
  });
}
