// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatGPTAdapter, type VoiceUiSnapshot } from '../../src/content/ChatGPTAdapter';

/**
 * Production chatgpt.com voice UI (2026-09-26), as in tests/e2e/fixtures/chatgpt.html: the orb is decorative and
 * carries aria-hidden="true"; its label lives on the button; the focus-mode div is the container.
 */
function voiceUi(): HTMLElement {
  const container = document.createElement('div');
  container.dataset.threadFocusMode = 'true';
  const button = document.createElement('button');
  button.setAttribute('aria-label', 'Exit voice focus mode');
  const orb = document.createElement('div');
  orb.dataset.realtimeVoiceOrb = 'true';
  orb.dataset.testid = 'avatar-overlay-voice-orb';
  orb.setAttribute('aria-hidden', 'true');
  button.append(orb);
  container.append(button);
  return container;
}

const orbOf = (ui: HTMLElement): HTMLElement => ui.querySelector<HTMLElement>('[data-realtime-voice-orb]')!;

const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  document.body.innerHTML = '<main id="app"><p>chat</p></main>';
});

describe('ChatGPTAdapter', () => {
  it('detects the voice UI and its orb', () => {
    document.body.append(voiceUi());
    const adapter = new ChatGPTAdapter(document);
    expect(adapter.isVoiceModeActive()).toBe(true);
    expect(adapter.findVoiceContainer()?.dataset.threadFocusMode).toBe('true');
    expect(adapter.findOrb()?.dataset.testid).toBe('avatar-overlay-voice-orb');
  });

  it('reports absence without throwing', () => {
    const adapter = new ChatGPTAdapter(document);
    expect(adapter.isVoiceModeActive()).toBe(false);
    expect(adapter.findVoiceContainer()).toBeNull();
    expect(adapter.findOrb()).toBeNull();
  });

  // Regression (US-005): production marks the orb aria-hidden="true"; reading that as "not rendered" left the
  // avatar permanently in its fallback position on the real site.
  it('detects the orb even though production marks it aria-hidden', () => {
    document.body.append(voiceUi());
    const adapter = new ChatGPTAdapter(document);
    expect(adapter.findOrb()?.getAttribute('aria-hidden')).toBe('true');
    expect(adapter.isVoiceModeActive()).toBe(true);
  });

  it('treats an orb marked with the hidden attribute as absent', () => {
    const ui = voiceUi();
    orbOf(ui).hidden = true;
    document.body.append(ui);
    expect(new ChatGPTAdapter(document).findOrb()).toBeNull();
  });

  // Regression (US-005): production has no voice dialog, and in the composer no known container ancestor either.
  it('falls back to the orb button as container when no known container wraps the orb', () => {
    const button = document.createElement('button');
    button.setAttribute('aria-label', 'Enter voice focus mode');
    const orb = document.createElement('div');
    orb.dataset.realtimeVoiceOrb = 'true';
    button.append(orb);
    document.body.append(button);
    const adapter = new ChatGPTAdapter(document);
    expect(adapter.isVoiceModeActive()).toBe(true);
    expect(adapter.findVoiceContainer()).toBe(button);
  });

  it('stays active while only the End Voice control is present', () => {
    const end = document.createElement('button');
    end.setAttribute('aria-label', 'End Voice');
    document.body.append(end);
    expect(new ChatGPTAdapter(document).isVoiceModeActive()).toBe(true);
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
    expect(seen[1]!.orb).toBe(orbOf(ui));

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
    const orb = orbOf(ui);
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
