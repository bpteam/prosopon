// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatGPTAdapter, type VoiceUiSnapshot } from '../../src/content/ChatGPTAdapter';

/** Mirrors the selectors in CHATGPT_SELECTORS, like tests/e2e/fixtures/chatgpt.html. */
function voiceUi(): HTMLElement {
  const container = document.createElement('div');
  container.dataset.testid = 'voice-mode-container';
  const orb = document.createElement('div');
  orb.dataset.testid = 'voice-orb';
  container.append(orb);
  return container;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  document.body.innerHTML = '<main id="app"><p>chat</p></main>';
});

describe('ChatGPTAdapter', () => {
  it('detects the voice UI and its orb', () => {
    document.body.append(voiceUi());
    const adapter = new ChatGPTAdapter(document);
    expect(adapter.isVoiceModeActive()).toBe(true);
    expect(adapter.findVoiceContainer()?.dataset.testid).toBe('voice-mode-container');
    expect(adapter.findOrb()?.dataset.testid).toBe('voice-orb');
  });

  it('reports absence without throwing', () => {
    const adapter = new ChatGPTAdapter(document);
    expect(adapter.isVoiceModeActive()).toBe(false);
    expect(adapter.findVoiceContainer()).toBeNull();
    expect(adapter.findOrb()).toBeNull();
  });

  it('treats a hidden container as inactive', () => {
    const ui = voiceUi();
    ui.setAttribute('aria-hidden', 'true');
    document.body.append(ui);
    expect(new ChatGPTAdapter(document).isVoiceModeActive()).toBe(false);
  });

  it('notifies when the voice UI appears later and when it disappears', async () => {
    const adapter = new ChatGPTAdapter(document);
    const seen: VoiceUiSnapshot[] = [];
    const stop = adapter.observe((ui) => seen.push(ui));
    expect(seen.map((s) => s.active)).toEqual([false]);

    const ui = voiceUi();
    document.getElementById('app')!.append(ui);
    await flush();
    expect(seen.map((s) => s.active)).toEqual([false, true]);
    expect(seen[1]!.orb).toBe(ui.firstElementChild);

    ui.remove();
    await flush();
    expect(seen.map((s) => s.active)).toEqual([false, true, false]);
    stop();
  });

  it('ignores unrelated mutations and stops observing on unsubscribe', async () => {
    const adapter = new ChatGPTAdapter(document);
    const listener = vi.fn();
    const stop = adapter.observe(listener);
    for (let i = 0; i < 20; i++) document.getElementById('app')!.append(document.createElement('span'));
    await flush();
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
    document.body.append(voiceUi());
    await flush();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('hides the orb visually without removing it, and restores its inline style', () => {
    const ui = voiceUi();
    document.body.append(ui);
    const orb = ui.firstElementChild as HTMLElement;
    orb.style.setProperty('visibility', 'visible');
    const adapter = new ChatGPTAdapter(document);

    const restore = adapter.hideVisually(orb);
    expect(orb.isConnected).toBe(true);
    expect(orb.style.getPropertyValue('visibility')).toBe('hidden');
    expect(adapter.hideVisually(orb)).toBeTypeOf('function'); // second hide is a no-op

    restore();
    restore();
    expect(orb.style.getPropertyValue('visibility')).toBe('visible');
    expect(orb.hasAttribute('data-prosopon-hidden')).toBe(false);
  });
});
