import { describe, expect, it } from 'vitest';
import { NEUTRAL_EMOTION } from '../../src/audio/emotion/EmotionFrame';
import type { AvatarState } from '../../src/avatar/AvatarStateProfiles';
import { ARM_BONES, seededRandom, type GestureContext, type GestureFrame } from '../../src/avatar/gesture/Gesture';
import { GESTURE_CONFIG, GESTURE_LIMITS } from '../../src/avatar/gesture/GestureConfig';
import { GestureEngine, type GestureEngineOptions } from '../../src/avatar/gesture/GestureEngine';
import { SemanticGesturePolicy, type SemanticEngineView } from '../../src/avatar/gesture/SemanticGesturePolicy';
import { SemanticAnalyzer } from '../../src/semantic/SemanticAnalyzer';
import type { EnumerationRole, SemanticCueType, SemanticIntent } from '../../src/semantic/SemanticCue';
import { DEMO_REPLIES } from '../../src/semantic/demoReplies';

const FPS = 1 / 60;

function ctx(state: AvatarState = 'speaking', over: Partial<GestureContext> = {}): GestureContext {
  return {
    conversationState: state,
    userSpeaking: false,
    assistantSpeaking: state === 'speaking',
    userEmotion: NEUTRAL_EMOTION,
    assistantEmotion: NEUTRAL_EMOTION,
    utteranceEnds: 0,
    lastUtteranceDuration: 0,
    ...over,
  };
}

let seq = 0;
function intent(
  types: SemanticCueType | SemanticCueType[],
  o: { segment?: string; message?: string; confidence?: number; strength?: number; role?: EnumerationRole; modifiers?: SemanticIntent['modifiers'] } = {},
): SemanticIntent {
  const message = o.message ?? 'm';
  const segmentId = o.segment ?? `${message}#${++seq}`;
  const list = Array.isArray(types) ? types : [types];
  return {
    messageId: message,
    segmentId,
    charStart: 0,
    charEnd: 10,
    early: false,
    text: 'text',
    modifiers: o.modifiers ?? [],
    matches: [],
    cues: list.map((type, i) => ({
      id: `${segmentId}:${type}`,
      type,
      role: type === 'enumeration' ? (o.role ?? 'item') : undefined,
      confidence: o.confidence ?? 0.9,
      strength: o.strength ?? 1,
      segmentId,
      charStart: 0,
      charEnd: 4,
      sequence: seq * 10 + i,
    })),
  };
}

/** Always-accept (next() = 0) or never-accept (next() ≈ 1) randomness. */
const ALWAYS = { next: () => 0 };
const NEVER = { next: () => 0.999999 };

function view(over: Partial<SemanticEngineView> = {}): SemanticEngineView {
  return {
    clock: 100,
    state: 'speaking',
    userSpeaking: false,
    handsAllowed: true,
    activity: 0.5,
    busy: false,
    lastGestureType: null,
    random: ALWAYS,
    ...over,
  };
}

function engine(options: GestureEngineOptions = {}, seed = 1): GestureEngine {
  return new GestureEngine({ random: seededRandom(seed), ...options });
}

function steps(e: GestureEngine, c: GestureContext, seconds: number): void {
  for (let i = 0; i < Math.round(seconds / FPS); i++) e.update(FPS, c);
}

describe('SemanticGesturePolicy', () => {
  it('cue ≠ gesture: a confident cue that loses the roll is a logged "no gesture"', () => {
    const p = new SemanticGesturePolicy();
    const d = p.decide(intent('contrast'), 0, view({ random: NEVER }));
    expect(d.accepted).toBe(false);
    expect(d.reason).toBe('probability');
    expect(d.probability).toBeGreaterThan(0);
    expect(d.probability).toBeLessThan(1);
    expect(p.history.at(-1)).toBe(d);
  });

  it('every cue type maps to one of its configured gestures', () => {
    for (const type of ['question', 'enumeration', 'contrast', 'conclusion', 'agreement', 'disagreement', 'emphasis'] as const) {
      const p = new SemanticGesturePolicy();
      const d = p.decide(intent(type), 0, view());
      expect(d.accepted, type).toBe(true);
      expect(p.config.cues[type].gestures.map(([g]) => g), type).toContain(d.gesture);
      expect(d.intensity).toBeGreaterThanOrEqual(p.config.intensity[0] * (1 - p.config.prosodyGain) - 1e-9);
      expect(d.intensity).toBeLessThanOrEqual(1);
    }
  });

  it('agreement never shakes the head, disagreement never nods', () => {
    for (let i = 0; i < 200; i++) {
      const r = seededRandom(i);
      const a = new SemanticGesturePolicy().decide(intent('agreement'), 0, view({ random: { next: () => (r.next() < 0.5 ? 0 : r.next()) } }));
      if (a.gesture) expect(['nod', 'double-nod']).toContain(a.gesture);
      const d = new SemanticGesturePolicy().decide(intent('disagreement'), 0, view({ random: { next: () => (r.next() < 0.5 ? 0 : r.next()) } }));
      if (d.gesture) expect(['head-shake', 'head-tilt']).toContain(d.gesture);
    }
  });

  it('state: listening → skip; thinking and idle are damped relative to speaking', () => {
    const p = new SemanticGesturePolicy();
    expect(p.decide(intent('question'), 0, view({ state: 'listening' })).reason).toBe('state');
    const prob = (state: AvatarState) => new SemanticGesturePolicy().decide(intent('question'), 0, view({ state, random: NEVER, activity: 0 })).probability;
    expect(prob('thinking')).toBeLessThan(prob('idle'));
    expect(prob('idle')).toBeLessThan(prob('speaking'));
  });

  it('user interruption stays above semantics', () => {
    const d = new SemanticGesturePolicy().decide(intent('agreement'), 0, view({ userSpeaking: true }));
    expect(d.reason).toBe('user-speaking');
  });

  it('low-confidence cues and weak-only intents do not move the avatar', () => {
    const d = new SemanticGesturePolicy().decide(intent('contrast', { confidence: 0.3 }), 0, view());
    expect(d.reason).toBe('low-confidence');
    expect(d.cue).toBeNull();
  });

  it('global and per-type cooldowns', () => {
    const p = new SemanticGesturePolicy();
    const c = p.config;
    expect(p.decide(intent('contrast'), 0, view({ clock: 10 })).accepted).toBe(true);
    expect(p.decide(intent('question'), 0, view({ clock: 10 + c.globalCooldown / 2 })).reason).toBe('cooldown');
    // Global cooldown over, same type still cooling down.
    expect(p.decide(intent('contrast'), 0, view({ clock: 10 + c.globalCooldown + 0.1 })).reason).toBe('type-cooldown');
    expect(p.decide(intent('question'), 0, view({ clock: 10 + c.globalCooldown + 0.1 })).accepted).toBe(true);
    expect(p.decide(intent('contrast'), 0, view({ clock: 10 + c.typeCooldown + 0.1 })).accepted).toBe(true);
  });

  it('"but … however … but …": repeated contrast is suppressed and damped', () => {
    const p = new SemanticGesturePolicy();
    let clock = 0;
    let accepted = 0;
    const probabilities: number[] = [];
    for (let i = 0; i < 10; i++) {
      clock += 1.2; // a clause every 1.2 s
      const d = p.decide(intent('contrast'), 0, view({ clock, random: seededRandom(i) }));
      if (d.accepted) accepted++;
      if (d.probability) probabilities.push(d.probability);
    }
    // 12 s of back-to-back contrast: the type cooldown alone caps it at 2.
    expect(accepted).toBeLessThanOrEqual(Math.ceil(12 / p.config.typeCooldown));
    // After a contrast was accepted, the next contrast rolls with the repetition penalty.
    const fresh = new SemanticGesturePolicy().decide(intent('contrast'), 0, view({ random: NEVER })).probability;
    const q = new SemanticGesturePolicy();
    q.decide(intent('contrast'), 0, view({ clock: 0 }));
    const repeated = q.decide(intent('contrast'), 0, view({ clock: 100, random: NEVER })).probability;
    expect(repeated).toBeCloseTo(fresh * p.config.repeatCuePenalty, 2);
  });

  it('one decision per segment (early + final of the same segment)', () => {
    const p = new SemanticGesturePolicy();
    expect(p.decide(intent('question', { segment: 'm#1' }), 0, view({ random: NEVER })).reason).toBe('probability');
    expect(p.decide(intent('question', { segment: 'm#1' }), 0, view({ clock: 200 })).reason).toBe('segment-done');
    // A new message starts fresh ids.
    expect(p.decide(intent('question', { segment: 'm#1', message: 'n' }), 0, view({ clock: 300 })).accepted).toBe(true);
  });

  it('stale intents are dropped', () => {
    const p = new SemanticGesturePolicy();
    expect(p.decide(intent('question'), p.config.maxAge + 0.1, view()).reason).toBe('stale');
  });

  it('a running gesture of equal or higher priority is not preempted', () => {
    expect(new SemanticGesturePolicy().decide(intent('question'), 0, view({ busy: true })).reason).toBe('active-gesture');
  });

  it('hands disallowed: hand candidates drop out, the rest can still play', () => {
    for (let i = 0; i < 100; i++) {
      const d = new SemanticGesturePolicy().decide(intent('enumeration'), 0, view({ handsAllowed: false, random: seededRandom(i) }));
      expect(d.gesture).not.toBe('hand-emphasis');
    }
  });

  it('emphasis only modulates: contrast + emphasis → contrast gesture, higher chance and intensity', () => {
    const plain = new SemanticGesturePolicy().decide(intent('contrast'), 0, view({ random: NEVER }));
    const stressed = new SemanticGesturePolicy().decide(intent(['emphasis', 'contrast']), 0, view({ random: NEVER }));
    expect(stressed.cue).toBe('contrast');
    expect(stressed.probability).toBeGreaterThan(plain.probability);
    const alone = new SemanticGesturePolicy().decide(intent('emphasis'), 0, view());
    expect(alone.cue).toBe('emphasis');
  });

  it('agreement outranks contrast in "Yes, but …"', () => {
    const d = new SemanticGesturePolicy().decide(intent(['contrast', 'agreement']), 0, view());
    expect(d.cue).toBe('agreement');
  });

  it('enumeration items are likelier than the intro', () => {
    const intro = new SemanticGesturePolicy().decide(intent('enumeration', { role: 'intro' }), 0, view({ random: NEVER }));
    const item = new SemanticGesturePolicy().decide(intent('enumeration', { role: 'item' }), 0, view({ random: NEVER }));
    expect(item.probability).toBeGreaterThan(intro.probability);
  });

  it('disabled → every intent skipped, nothing accepted', () => {
    const p = new SemanticGesturePolicy({ enabled: false });
    expect(p.decide(intent('question'), 0, view()).reason).toBe('disabled');
    expect(p.stats.accepted).toBe(0);
  });
});

describe('GestureEngine semantic path', () => {
  it('a semantic intent starts a gesture on the next update', () => {
    const e = engine({ config: { auto: false }, semantic: { probabilityScale: 100 } });
    e.update(FPS, ctx());
    e.pushSemantic(intent('disagreement'));
    e.update(FPS, ctx());
    expect(e.semanticStatus.accepted).toBe(1);
    expect(['head-shake', 'head-tilt']).toContain(e.history.lastGestureType);
  });

  it('interruption clears queued intents', () => {
    const e = engine({ config: { auto: false }, semantic: { probabilityScale: 100 } });
    e.update(FPS, ctx('speaking'));
    e.pushSemantic(intent('question'));
    e.update(FPS, ctx('listening', { userSpeaking: true }));
    expect(e.semanticStatus.queued).toBe(0);
    expect(e.semanticStatus.accepted).toBe(0);
    expect(e.history.gestureCount).toBe(0);
  });

  it('fail-soft: a throwing policy switches semantics off, procedural gestures carry on', () => {
    const e = engine({ config: { rateScale: 4 } });
    (e.semantic as unknown as { decide: () => never }).decide = () => {
      throw new Error('boom');
    };
    e.update(FPS, ctx());
    e.pushSemantic(intent('question'));
    expect(() => e.update(FPS, ctx())).not.toThrow();
    expect(e.semanticStatus.error).toBe('boom');
    expect(e.semantic.config.enabled).toBe(false);
    steps(e, ctx(), 30);
    expect(e.history.gestureCount).toBeGreaterThan(0);
  });

  it('malformed intents are ignored', () => {
    const e = engine();
    expect(() => e.pushSemantic(null as unknown as SemanticIntent)).not.toThrow();
    expect(() => e.pushSemantic({} as SemanticIntent)).not.toThrow();
    expect(e.semanticStatus.queued).toBe(0);
  });

  it('head-shake and lean-in stay within GESTURE_LIMITS and are semantic/manual only', () => {
    for (const type of ['head-shake', 'lean-in'] as const) {
      for (const state of ['idle', 'listening', 'thinking', 'speaking'] as const) expect(GESTURE_CONFIG.rates[state][type], type).toBe(0);
      const e = engine({ config: { auto: false } });
      e.trigger(type, 1);
      let peak = 0;
      let yawSigns = new Set<number>();
      for (let i = 0; i < 60 * 3; i++) {
        const f: Readonly<GestureFrame> = e.update(FPS, ctx());
        expect(Math.abs(f.head.yaw)).toBeLessThanOrEqual(GESTURE_LIMITS.headYaw + 1e-9);
        expect(Math.abs(f.head.pitch)).toBeLessThanOrEqual(GESTURE_LIMITS.headPitch + 1e-9);
        expect(Math.abs(f.body.lean)).toBeLessThanOrEqual(GESTURE_LIMITS.bodyLean + 1e-9);
        for (const b of ARM_BONES) expect(Math.abs(f.arms[b].x) + Math.abs(f.arms[b].y) + Math.abs(f.arms[b].z)).toBe(0);
        peak = Math.max(peak, Math.abs(f.head.yaw), Math.abs(f.body.lean));
        if (Math.abs(f.head.yaw) > 0.005) yawSigns.add(Math.sign(f.head.yaw));
      }
      expect(peak, type).toBeGreaterThan(0.005);
      // A shake goes both ways.
      if (type === 'head-shake') expect(yawSigns.size).toBe(2);
      yawSigns = new Set();
    }
  });

  it('ambient speaking gestures are halved while semantic intents are recent', () => {
    const count = (withSemantic: boolean) => {
      let total = 0;
      for (let seed = 1; seed <= 6; seed++) {
        const e = engine({ semantic: { enabled: true, probabilityScale: 0 } }, seed);
        const excited = { ...NEUTRAL_EMOTION, active: true, arousal: 0.9, energy: 0.8, pitchVariation: 0.7, confidence: 0.9 };
        for (let t = 0; t < 120; t += 1) {
          if (withSemantic) e.pushSemantic(intent('question', { confidence: 0.1 }));
          steps(e, ctx('speaking', { assistantEmotion: excited }), 1);
        }
        total += e.history.gestureCount;
      }
      return total;
    };
    const plain = count(false);
    const semantic = count(true);
    expect(semantic).toBeLessThan(plain * 0.75);
    expect(semantic).toBeGreaterThan(0);
  });

  it('long multilingual reply: 100+ cues → a moderate share become gestures (no over-animation)', () => {
    // All four demo replies twice (eight messages), released at a 14 chars/s speaking rate.
    let cues = 0;
    let intents = 0;
    const rates: number[] = [];
    for (let seed = 1; seed <= 5; seed++) {
      const e = engine({}, seed);
      let spokenSeconds = 0;
      let c = 0;
      const replies = [...Object.entries(DEMO_REPLIES), ...Object.entries(DEMO_REPLIES)];
      for (const [n, [locale, text]] of replies.entries()) {
        const analyzer = new SemanticAnalyzer();
        const due = analyzer.update(`${locale}-${n}`, text, true);
        for (const i of due) {
          c += i.cues.length;
          const at = i.charStart / 14;
          if (at > spokenSeconds) {
            steps(e, ctx(), at - spokenSeconds);
            spokenSeconds = at;
          }
          e.pushSemantic(i);
          intents++;
        }
        steps(e, ctx(), 2);
        spokenSeconds = 0;
      }
      cues = c;
      rates.push(e.semanticStatus.accepted / c);
    }
    expect(cues).toBeGreaterThanOrEqual(100);
    const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
    // Target from the story: 100 cues → 15–30 gestures.
    console.info(`semantic density: ${cues} cues, accepted/cues per seed ${rates.map((r) => r.toFixed(2)).join(' ')}`);
    expect(mean).toBeGreaterThanOrEqual(0.12);
    expect(mean).toBeLessThanOrEqual(0.35);
    expect(intents).toBeGreaterThan(0);
  });
});
