import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { readZip } from '../../src/calibration/zip';
import { expect, root, tabIdOf, test, toggle } from './extension';

/**
 * Calibration wizard end to end on the fixture page, reduced to one language and two assistant samples (the debug
 * event 'prosopon:calibration'): Start → preflight → fresh chat + setup prompt → Voice → voice detected from the page
 * → prompts typed into the composer → the fixture "speaks" them (tab audio) and streams the text → analysis →
 * Export → the export page downloads the ZIP. The real chatgpt.com DOM is a manual check: docs/calibration-wizard.md.
 */

const ui = (page: Page) => page.locator('#prosopon-ui');

test('Start → automatic run → Export: the ZIP holds the manifest, trace, text, audio and the agent task', async ({ context, serviceWorker, chatgpt }) => {
  test.setTimeout(180_000);
  await toggle(serviceWorker, await tabIdOf(serviceWorker, chatgpt));
  await expect(root(chatgpt)).toHaveAttribute('data-avatar-loaded', 'true', { timeout: 30_000 });
  await chatgpt.evaluate(() =>
    document.dispatchEvent(
      new CustomEvent('prosopon:calibration', { detail: { languages: ['en'], categories: ['question.normal', 'disagreement'], user: false } }),
    ),
  );
  await serviceWorker.evaluate(() => chrome.storage.local.set({ 'prosopon.developerMode': true }));
  await expect(ui(chatgpt)).toHaveAttribute('data-dev-tools', 'mounted');
  await ui(chatgpt).locator('[data-testid="dev-window-hud"] [data-action="expand"]').click();
  const devtools = ui(chatgpt).locator('[data-testid="dev-window-devtools"]');
  await devtools.locator('[role="tab"][data-tab="Calibration"]').click();
  const panel = devtools.locator('[data-testid="calibration"]');
  await expect(panel.locator('[data-testid="calibration-capture"]')).toContainText('Ready');

  await panel.locator('[data-testid="calibration-start"]').click();
  const phase = panel.locator('[data-testid="calibration-phase"]');
  await expect(phase).toHaveAttribute('data-phase', 'complete', { timeout: 150_000 });
  await expect(panel.locator('[data-testid="calibration-samples"]')).toHaveText('2 / 2 valid');
  const sent: string[] = await chatgpt.evaluate(() => (window as any).fixture.sent);
  expect(sent).toHaveLength(3); // setup + two samples, all through the composer
  expect(sent[1]).toMatch(/"[^"]+"\s*$/);
  // ChatGPT's own mic was muted for the scripted steps and given back afterwards.
  expect(await chatgpt.evaluate(() => (window as any).fixture.muted)).toBe(false);

  const exportPage = context.waitForEvent('page', { predicate: (p) => p.url().includes('calibration-export') });
  await panel.locator('[data-testid="calibration-export"]').click();
  const page = await exportPage;
  const download = await page.waitForEvent('download', { timeout: 30_000 });
  expect(download.suggestedFilename()).toMatch(/^prosopon-calibration-sol-\d{4}-\d{2}-\d{2}.*\.zip$/);
  const files = await readZip(new Blob([readFileSync((await download.path())!)]));
  const names = [...files.keys()];
  for (const f of ['manifest.json', 'config-before.json', 'scenarios.json', 'results.json', 'summary.json', 'trace.jsonl', 'events.jsonl', 'assistant-text.jsonl', 'REPORT.md', 'AGENT_TASK.md', 'audio/index.json']) {
    expect(names, f).toContain(`calibration/${f}`);
  }
  const text = (name: string) => new TextDecoder().decode(files.get(`calibration/${name}`));
  const manifest = JSON.parse(text('manifest.json'));
  expect(manifest.chatgpt).toMatchObject({ voice: 'Sol', voiceMode: 'realtime', voiceRuntimeModel: null });
  expect(manifest.prosopon.commit).toMatch(/^[0-9a-f]{40}$/);
  const wavs = names.filter((n) => /^calibration\/audio\/assistant\/en\/.+\.wav$/.test(n));
  expect(wavs.length).toBeGreaterThanOrEqual(2);
  // The fixture's speech reached the recorder (a WAV longer than its header).
  expect(Math.max(...wavs.map((n) => files.get(n)!.length))).toBeGreaterThan(44 + 48000);
  const replies = text('assistant-text.jsonl').trim().split('\n').map((l) => JSON.parse(l));
  expect(replies.filter((r) => r.kind === 'assistant')).toHaveLength(2);
  expect(replies.every((r) => typeof r.requestedText === 'string')).toBe(true);
  expect(text('trace.jsonl').trim().split('\n').length).toBeGreaterThan(50);
  expect(text('AGENT_TASK.md')).toContain('calibration');

  // The export page's Discard drops the bundle.
  await page.locator('#discard').click();
  await expect(page.locator('#status')).toHaveText('Recordings discarded.');
});
