import { describe, expect, it } from 'vitest';
import { AvatarController } from '@avatar/avatar/AvatarController';
import { ConversationSignalResolver } from '../../src/content/ConversationSignalResolver';

function setup() {
  const controller = new AvatarController({}); // no avatar yet: states before VRM load are kept
  const resolver = new ConversationSignalResolver(controller, {
    assistantReleaseHold: 0.4,
    interruptionMinDuration: 0.3,
    thinkingDelay: 0.2,
    thinkingTimeout: 5,
  });
  const run = (seconds: number) => {
    for (let t = 0; t < seconds - 1e-9; t += 0.02) resolver.update(0.02);
  };
  return { controller, resolver, run };
}

describe('ConversationSignalResolver', () => {
  it('no voice UI → idle, whatever the audio does', () => {
    const { controller, resolver } = setup();
    resolver.setUserSpeaking(true, 1);
    resolver.setAssistantAudioActive(true);
    expect(controller.getState()).toBe('idle');
  });

  it('voice UI, nobody talking → listening; user speaking → listening', () => {
    const { controller, resolver, run } = setup();
    resolver.setVoiceUiActive(true);
    expect(controller.getState()).toBe('listening');
    resolver.setUserSpeaking(true, 0.1);
    run(0.5);
    expect(controller.getState()).toBe('listening');
  });

  it('assistant speaking only → speaking, held across short pauses', () => {
    const { controller, resolver, run } = setup();
    resolver.setVoiceUiActive(true);
    resolver.setAssistantAudioActive(true);
    expect(controller.getState()).toBe('speaking');
    resolver.setAssistantAudioActive(false);
    run(0.2);
    expect(controller.getState()).toBe('speaking');
  });

  it('user stopped before the assistant started → thinking (after the grace delay)', () => {
    const { controller, resolver, run } = setup();
    resolver.setVoiceUiActive(true);
    resolver.setUserSpeaking(true, 0.1);
    run(1);
    resolver.setUserSpeaking(false);
    run(0.1);
    expect(controller.getState()).toBe('listening'); // inside thinkingDelay
    run(0.2);
    expect(controller.getState()).toBe('thinking');
  });

  it('a reply that starts within the grace delay goes straight to speaking', () => {
    const { controller, resolver, run } = setup();
    const seen = new Set<string>();
    controller.onStateChange((s) => void seen.add(s));
    resolver.setVoiceUiActive(true);
    resolver.setUserSpeaking(true, 0.1);
    run(1);
    resolver.setUserSpeaking(false);
    run(0.05);
    resolver.setAssistantAudioActive(true);
    expect(controller.getState()).toBe('speaking');
    expect(seen.has('thinking')).toBe(false);
  });

  it('full turn: listening → thinking → speaking → listening', () => {
    const { controller, resolver, run } = setup();
    resolver.setVoiceUiActive(true);
    resolver.setUserSpeaking(true, 0.1);
    run(1);
    resolver.setUserSpeaking(false);
    run(0.5);
    expect(controller.getState()).toBe('thinking');
    resolver.setAssistantAudioActive(true);
    run(2);
    expect(controller.getState()).toBe('speaking');
    resolver.setAssistantAudioActive(false);
    run(0.6);
    expect(controller.getState()).toBe('listening');
  });

  it('thinking times out back to listening when no reply comes', () => {
    const { controller, resolver, run } = setup();
    resolver.setVoiceUiActive(true);
    resolver.setUserSpeaking(true, 0.5);
    run(0.5);
    resolver.setUserSpeaking(false);
    run(1);
    expect(controller.getState()).toBe('thinking');
    run(5);
    expect(controller.getState()).toBe('listening');
  });

  it('interruption: assistant speaking + user speaking → listening (user wins)', () => {
    const { controller, resolver, run } = setup();
    resolver.setVoiceUiActive(true);
    resolver.setAssistantAudioActive(true);
    resolver.setUserSpeaking(true, 0.4);
    expect(resolver.signals).toEqual({ voiceUiActive: true, userSpeaking: true, assistantSpeaking: true });
    expect(controller.getState()).toBe('listening');
    run(0.5);
    expect(controller.getState()).toBe('listening');
    expect(resolver.diagnostics.crosstalk).toBe(true);
  });

  it('a short blip on the mic during assistant speech (echo) does not interrupt', () => {
    const { controller, resolver, run } = setup();
    resolver.setVoiceUiActive(true);
    resolver.setAssistantAudioActive(true);
    resolver.setUserSpeaking(true, 0.1);
    run(0.1);
    expect(controller.getState()).toBe('speaking');
    resolver.setUserSpeaking(false);
    run(0.1);
    expect(controller.getState()).toBe('speaking');
    expect(resolver.diagnostics.suppressedInterruptions).toBe(1);
    expect(resolver.diagnostics.crosstalkEvents).toBe(1);
    // It lasts: it is an interruption after all.
    resolver.setUserSpeaking(true, 0.1);
    run(0.3);
    expect(controller.getState()).toBe('listening');
  });

  it('voice UI closing mid-turn → idle and no pending thinking afterwards', () => {
    const { controller, resolver, run } = setup();
    resolver.setVoiceUiActive(true);
    resolver.setUserSpeaking(true, 1);
    run(0.5);
    resolver.setUserSpeaking(false);
    resolver.setVoiceUiActive(false);
    expect(controller.getState()).toBe('idle');
    resolver.setVoiceUiActive(true);
    run(0.5);
    expect(controller.getState()).toBe('listening');
  });
});
