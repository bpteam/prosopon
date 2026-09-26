// Renderer-free (tests/unit/architecture.test.ts): decides whether a semantic intent becomes a gesture. It sees
// only typed data — the intent and a view of the engine — and returns a decision; GestureEngine runs it.
import { CUE_RANK, type EnumerationRole, type SemanticCue, type SemanticCueType, type SemanticIntent } from '../../semantic/SemanticCue';
import type { AvatarState } from '../AvatarStateProfiles';
import type { GestureType, RandomSource } from './Gesture';
import { semanticGestureConfig, type SemanticGestureConfig, type SemanticGestureConfigOverrides } from './SemanticGestureConfig';

export const SEMANTIC_SKIP_REASONS = [
  'disabled',
  'stale',
  'segment-done',
  'low-confidence',
  'user-speaking',
  'state',
  'cooldown',
  'type-cooldown',
  'active-gesture',
  'no-gesture',
  'probability',
] as const;
export type SemanticSkipReason = (typeof SEMANTIC_SKIP_REASONS)[number];

export interface SemanticDecision {
  /** Engine clock, seconds. */
  at: number;
  messageId: string;
  segmentId: string;
  early: boolean;
  /** Every cue type of the intent, rank order. */
  cues: SemanticCueType[];
  /** The cue that decided (null when none was confident enough). */
  cue: SemanticCueType | null;
  role?: EnumerationRole;
  confidence: number;
  strength: number;
  /** Chance that was rolled (0 when a check skipped before the roll). */
  probability: number;
  accepted: boolean;
  gesture: GestureType | null;
  intensity: number;
  /** +1 model's left, −1 right. */
  side: number;
  reason: SemanticSkipReason | null;
}

/** What the policy may know about the engine at decision time. */
export interface SemanticEngineView {
  clock: number;
  state: AvatarState;
  userSpeaking: boolean;
  handsAllowed: boolean;
  /** Assistant prosodic activity, [0, 1] (0 when unsure or not speaking). */
  activity: number;
  /** A gesture the semantic request must not preempt is running. */
  busy: boolean;
  lastGestureType: GestureType | null;
  random: RandomSource;
}

export interface SemanticPolicyStats {
  intents: number;
  accepted: number;
  skipped: Record<SemanticSkipReason, number>;
}

const HAND: GestureType = 'hand-emphasis';

/**
 * Cue ≠ gesture. For each intent: one primary cue (rank order; emphasis only modulates others), then state,
 * cooldowns, a running gesture, and finally a probability roll
 *   p = base × confidence × strength × state × emphasis × prosody × repetition.
 * At most one decision per segment. Every outcome — including "no gesture" and why — lands in `history`.
 */
export class SemanticGesturePolicy {
  readonly config: SemanticGestureConfig;
  private readonly decided = new Set<string>();
  private message: string | null = null;
  private lastAcceptedAt = -Infinity;
  private readonly lastCueAt = new Map<SemanticCueType, number>();
  private lastCue: SemanticCueType | null = null;
  private side = 1;
  private readonly log: SemanticDecision[] = [];
  private readonly counters: SemanticPolicyStats = {
    intents: 0,
    accepted: 0,
    skipped: Object.fromEntries(SEMANTIC_SKIP_REASONS.map((r) => [r, 0])) as Record<SemanticSkipReason, number>,
  };

  constructor(overrides: SemanticGestureConfigOverrides = {}) {
    this.config = semanticGestureConfig(overrides);
  }

  /** Newest last. */
  get history(): readonly SemanticDecision[] {
    return this.log;
  }

  get stats(): Readonly<SemanticPolicyStats> {
    return this.counters;
  }

  /** Clock of the last accepted semantic gesture (−Infinity before the first). */
  get lastAccepted(): number {
    return this.lastAcceptedAt;
  }

  reset(): void {
    this.decided.clear();
    this.message = null;
    this.lastAcceptedAt = -Infinity;
    this.lastCueAt.clear();
    this.lastCue = null;
  }

  decide(intent: SemanticIntent, age: number, v: SemanticEngineView): SemanticDecision {
    const c = this.config;
    this.counters.intents++;
    if (intent.messageId !== this.message) {
      this.message = intent.messageId;
      this.decided.clear();
    }
    const cues = [...intent.cues].sort((a, b) => CUE_RANK.indexOf(a.type) - CUE_RANK.indexOf(b.type));
    const confident = cues.filter((q) => q.confidence >= c.minConfidence);
    const primary: SemanticCue | undefined = confident.find((q) => q.type !== 'emphasis') ?? confident[0];
    const emphasis = primary && primary.type !== 'emphasis' ? (confident.find((q) => q.type === 'emphasis')?.confidence ?? 0) : 0;
    const d: SemanticDecision = {
      at: v.clock,
      messageId: intent.messageId,
      segmentId: intent.segmentId,
      early: intent.early,
      cues: cues.map((q) => q.type),
      cue: primary?.type ?? null,
      role: primary?.role,
      confidence: primary?.confidence ?? 0,
      strength: primary?.strength ?? 0,
      probability: 0,
      accepted: false,
      gesture: null,
      intensity: 0,
      side: 0,
      reason: null,
    };
    const skip = (reason: SemanticSkipReason): SemanticDecision => {
      d.reason = reason;
      this.counters.skipped[reason]++;
      this.push(d);
      return d;
    };

    if (!c.enabled) return skip('disabled');
    if (this.decided.has(intent.segmentId)) return skip('segment-done');
    this.decided.add(intent.segmentId);
    if (age > c.maxAge) return skip('stale');
    if (!primary) return skip('low-confidence');
    if (v.userSpeaking) return skip('user-speaking');
    const stateFactor = Math.max(0, c.stateFactor[v.state] ?? 0);
    if (stateFactor <= 0) return skip('state');
    if (v.clock - this.lastAcceptedAt < c.globalCooldown) return skip('cooldown');
    if (v.clock - (this.lastCueAt.get(primary.type) ?? -Infinity) < c.typeCooldown) return skip('type-cooldown');
    if (v.busy) return skip('active-gesture');

    const cue = c.cues[primary.type];
    const explanatory = intent.modifiers.length > 0;
    const weights = cue.gestures.map(([g, w]) => {
      if (g === HAND && !v.handsAllowed) return 0;
      let x = Math.max(0, w);
      if (g === v.lastGestureType) x *= c.repeatGesturePenalty;
      if (g === HAND && explanatory) x *= 1 + c.explanatoryHandBoost;
      return x;
    });
    const total = weights.reduce((a, b) => a + b, 0);
    if (!(total > 0)) return skip('no-gesture');

    const base = primary.type === 'enumeration' ? c.enumerationBase[primary.role ?? 'item'] : cue.base;
    const speaking = v.state === 'speaking';
    const prosody = speaking ? lerp(1 - c.prosodyGain, 1 + c.prosodyGain, clamp01(v.activity)) : 1;
    const repetition = primary.type === this.lastCue ? c.repeatCuePenalty : 1;
    const p = Math.min(
      0.95,
      Math.max(0, c.probabilityScale) *
        base *
        primary.confidence *
        (0.7 + 0.3 * clamp01(primary.strength)) *
        stateFactor *
        (1 + c.emphasisBoost * emphasis) *
        prosody *
        repetition,
    );
    d.probability = round3(p);
    if (v.random.next() >= p) return skip('probability');

    let pick = v.random.next() * total;
    let gesture = cue.gestures[cue.gestures.length - 1]![0];
    for (let i = 0; i < weights.length; i++) {
      pick -= weights[i]!;
      if (pick < 0 && weights[i]! > 0) {
        gesture = cue.gestures[i]![0];
        break;
      }
    }
    const [lo, hi] = c.intensity;
    const side = cue.side === 'alternate' ? -this.side : v.random.next() < 0.5 ? 1 : -1;
    d.accepted = true;
    d.gesture = gesture;
    d.side = side;
    d.intensity = round3(
      clamp01(lerp(lo, hi, clamp01(primary.confidence * primary.strength)) * (1 + (c.emphasisBoost / 2) * emphasis) * prosody),
    );
    this.side = side;
    this.lastAcceptedAt = v.clock;
    this.lastCueAt.set(primary.type, v.clock);
    this.lastCue = primary.type;
    this.counters.accepted++;
    this.push(d);
    return d;
  }

  private push(d: SemanticDecision): void {
    this.log.push(d);
    if (this.log.length > this.config.historySize) this.log.shift();
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 0;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
