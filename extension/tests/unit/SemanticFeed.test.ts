import { describe, expect, it, vi } from 'vitest';
import type { SemanticIntent } from '@avatar/semantic/SemanticCue';
import type { AssistantReply } from '../../src/content/ChatGPTAdapter';
import { SemanticFeed } from '../../src/content/SemanticFeed';

/** A reply source driven by the test: `set` changes the latest reply and fires the observer like a DOM mutation. */
function source(initial: AssistantReply | null = null) {
  let latest = initial;
  let listener: (() => void) | null = null;
  const stop = vi.fn();
  return {
    readLatestReply: vi.fn(() => latest),
    observeReplies: (cb: () => void) => {
      listener = cb;
      return stop;
    },
    set(reply: AssistantReply | null) {
      latest = reply;
      listener?.();
    },
    stop,
  };
}

function feed(src = source(), over: Partial<ConstructorParameters<typeof SemanticFeed>[0]> = {}) {
  const out: SemanticIntent[] = [];
  const f = new SemanticFeed({ source: src, sink: (i) => out.push(i), ...over });
  return { f, out, src };
}

/** Text chat (no voice session): intents are released as they are found. */
const tick = (f: SemanticFeed, seconds = 0.2) => f.update(seconds, false, false);

describe('SemanticFeed', () => {
  it('ignores the reply that was already on the page at activation', () => {
    const src = source({ id: 'old', text: 'Но это уже было. Поэтому неважно.' });
    const { f, out } = feed(src);
    for (let i = 0; i < 30; i++) tick(f);
    expect(out).toEqual([]);
    expect(f.status.messages).toBe(0);
  });

  it('streams a new reply into intents; the last sentence is analysed once the text settles', () => {
    const { f, out, src } = feed();
    const text = 'Да, это работает. Но есть нюанс. Поэтому я бы проверил';
    for (let n = 1; n <= text.length; n += 4) {
      src.set({ id: 'r1', text: text.slice(0, n) });
      tick(f, 0.13);
    }
    src.set({ id: 'r1', text });
    tick(f, 0.13);
    const before = out.flatMap((i) => i.cues.map((c) => c.type));
    expect(before).toEqual(expect.arrayContaining(['agreement', 'contrast']));
    // "Поэтому я бы проверил" has no closing punctuation: it is found early or when the reply settles.
    for (let i = 0; i < 20; i++) tick(f, 0.2);
    const all = out.flatMap((i) => i.cues.map((c) => c.type));
    expect(all).toContain('conclusion');
    // Each segment's cue type is sent once.
    const ids = out.flatMap((i) => i.cues.map((c) => c.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('reads at most every readInterval, and only after a change', () => {
    const src = source();
    const { f } = feed(src, { readInterval: 0.5 });
    tick(f, 0.1); // the activation read
    const base = src.readLatestReply.mock.calls.length;
    for (let i = 0; i < 10; i++) tick(f, 0.1); // no mutation
    expect(src.readLatestReply.mock.calls.length - base).toBe(0);
    for (let i = 0; i < 10; i++) {
      src.set({ id: 'r', text: `Текст ${i}.` });
      tick(f, 0.1);
    }
    expect(src.readLatestReply.mock.calls.length - base).toBeLessThanOrEqual(3);
  });

  it('pacing in voice mode holds intents until the speech clock reaches them', () => {
    const { f, out, src } = feed();
    const text = `${'Это длинное вступление без маркеров. '.repeat(4)}Но есть нюанс.`;
    src.set({ id: 'v', text });
    f.update(0.2, true, false);
    expect(out.filter((i) => i.cues.some((c) => c.type === 'contrast'))).toEqual([]);
    for (let i = 0; i < 300 && !out.some((x) => x.cues.some((c) => c.type === 'contrast')); i++) f.update(0.1, true, true);
    expect(out.some((i) => i.cues.some((c) => c.type === 'contrast'))).toBe(true);
    expect(f.status.pacer.mode).toBe('speech');
  });

  it('disabled: nothing is read or sent', () => {
    const { f, out, src } = feed();
    f.setEnabled(false);
    src.set({ id: 'x', text: 'Но это важно.' });
    for (let i = 0; i < 20; i++) tick(f);
    expect(out).toEqual([]);
  });

  it('fail-soft: a throwing source switches the feed off and reports the error once', () => {
    const src = source();
    const onError = vi.fn();
    const { f } = feed(src, { onError });
    src.readLatestReply.mockImplementation(() => {
      throw new Error('dom gone');
    });
    src.set(null);
    expect(() => tick(f)).not.toThrow();
    expect(() => tick(f)).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(f.status).toMatchObject({ enabled: false, error: 'dom gone' });
    f.setEnabled(true);
    expect(f.enabled).toBe(false);
  });

  it('dispose stops observing', () => {
    const { f, src } = feed();
    f.dispose();
    expect(src.stop).toHaveBeenCalled();
    expect(f.enabled).toBe(false);
  });

  it('an observer sees every analysed and released intent, and its exceptions never stop the feed', () => {
    const { f, out, src } = feed();
    const analyzed: string[] = [];
    const released: string[] = [];
    f.observer = {
      analyzed: (i) => {
        analyzed.push(i.segmentId);
        throw new Error('observer bug');
      },
      released: (i) => void released.push(i.segmentId),
    };
    src.set({ id: 'r1', text: 'Да, это работает. Но есть нюанс.' });
    for (let i = 0; i < 20; i++) tick(f);
    expect(out.length).toBeGreaterThan(0);
    expect(released).toEqual(out.map((i) => i.segmentId));
    expect(analyzed).toEqual(expect.arrayContaining(released));
    expect(f.status.error ?? null).toBeNull();
  });
});
