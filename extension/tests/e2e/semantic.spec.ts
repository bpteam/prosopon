import type { Locator } from '@playwright/test';
import { expect, root, tabIdOf, test, toggle } from './extension';

/**
 * Semantic layer end to end on the fixture page: a streamed assistant reply (fixture.streamReply, the reply DOM
 * ChatGPTAdapter expects) → ChatGPTAdapter.readLatestReply → SemanticFeed → GestureEngine.pushSemantic. Observed
 * through the development build's data-semantic-* attributes. The real chatgpt.com reply DOM (text and voice mode)
 * is a manual check: docs/semantic-calibration.md.
 */

const num = async (host: Locator, attr: string) => Number(await host.getAttribute(attr));

test('a streamed reply becomes semantic cues and intents; the reply already on the page is ignored', async ({ serviceWorker, chatgpt }) => {
  // History: on the page before the avatar starts.
  await chatgpt.evaluate(() => (window as any).fixture.streamReply('old', ['Но это старый ответ. Поэтому он не считается.'], 1));
  await toggle(serviceWorker, await tabIdOf(serviceWorker, chatgpt));
  const host = root(chatgpt);
  await expect(host).toHaveAttribute('data-avatar-loaded', 'true', { timeout: 30_000 });
  await expect(host).toHaveAttribute('data-semantic-enabled', 'true');
  await chatgpt.waitForTimeout(500);
  expect(await num(host, 'data-semantic-cues')).toBe(0);

  // Text chat: no voice session → intents go out as their text arrives.
  await chatgpt.evaluate(() =>
    document.dispatchEvent(new CustomEvent('prosopon:semantic', { detail: { probabilityScale: 4 } })),
  );
  await chatgpt.evaluate(() =>
    (window as any).fixture.streamReply('r1', [
      'Да, это рабочий вариант.',
      'Но есть нюанс: во-первых, задержка растёт. Во-вторых, память.',
      'Поэтому я бы начал с измерений. Что думаешь?',
    ]),
  );
  await expect(host).toHaveAttribute('data-semantic-mode', 'immediate');
  await expect.poll(() => num(host, 'data-semantic-cues'), { timeout: 10_000 }).toBeGreaterThanOrEqual(5);
  await expect.poll(() => num(host, 'data-semantic-intents'), { timeout: 10_000 }).toBeGreaterThanOrEqual(4);
  // The last sentence ("Что думаешь?") is a question.
  await expect(host).toHaveAttribute('data-semantic-last', /question/, { timeout: 10_000 });
  // Cue ≠ gesture: some intents are skipped (idle state, cooldowns), never more gestures than intents.
  expect(await num(host, 'data-semantic-accepted')).toBeLessThanOrEqual(await num(host, 'data-semantic-intents'));

  // Off: a new reply is not analysed.
  await chatgpt.evaluate(() => document.dispatchEvent(new CustomEvent('prosopon:semantic', { detail: { enabled: false } })));
  await expect(host).toHaveAttribute('data-semantic-enabled', 'false');
  const cues = await num(host, 'data-semantic-cues');
  await chatgpt.evaluate(() => (window as any).fixture.streamReply('r2', ['Однако это важно. Поэтому нет.'], 5));
  await chatgpt.waitForTimeout(500);
  expect(await num(host, 'data-semantic-cues')).toBe(cues);
});
