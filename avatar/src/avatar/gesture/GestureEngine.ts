import {
  GESTURE_TYPES,
  clearGestureOffsets,
  createGestureFrame,
  mathRandom,
  type GestureContext,
  type GestureFrame,
  type GestureSource,
  type GestureType,
  type RandomSource,
} from './Gesture';
import { gestureConfig, type GestureConfig, type GestureConfigOverrides, type Range } from './GestureConfig';
import type { EmotionFrame } from '../../audio/emotion/EmotionFrame';
import type { SemanticIntent } from '../../semantic/SemanticCue';
import type { AvatarState } from '../AvatarStateProfiles';
import type { SemanticGestureConfigOverrides } from './SemanticGestureConfig';
import { SemanticGesturePolicy, type SemanticDecision } from './SemanticGesturePolicy';

/** Who asked for a gesture. A request only preempts a running gesture of lower priority. */
export const GESTURE_PRIORITY = Object.freeze({
  ambient: 0,
  /** Prosody-driven accents while the assistant speaks. */
  emphasis: 1,
  /** Semantic intents from the reply's text (question, contrast, conclusion …). */
  semantic: 2,
  /** Utterance boundaries: the user finished a phrase, the assistant starts talking. */
  boundary: 3,
  /** Debug/manual trigger. */
  forced: 4,
});

export interface GestureHistory {
  lastGestureType: GestureType | null;
  /** Engine clock (seconds of update() time) at the start of the last gesture; −Infinity before the first. */
  lastGestureAt: number;
  gestureCount: number;
}

export interface GestureEngineOptions {
  config?: GestureConfigOverrides;
  random?: RandomSource;
  /** How semantic intents map to gestures (probabilities, cooldowns, candidates). */
  semantic?: SemanticGestureConfigOverrides;
}

/** Semantic side of the engine, for diagnostics. */
export interface SemanticGestureStatus {
  enabled: boolean;
  /** Intents waiting for the next update(). */
  queued: number;
  intents: number;
  accepted: number;
  /** Last decisions, newest last. */
  decisions: readonly SemanticDecision[];
  /** Set when the semantic path threw; it is then switched off and the rest of the engine keeps running. */
  error: string | null;
}

interface Running {
  type: GestureType;
  priority: number;
  intensity: number;
  duration: number;
  elapsed: number;
  /** +1: the model's left, −1: right (mirrors tilt, shift, the gesturing arm). */
  side: number;
  cancelling: boolean;
  cancelElapsed: number;
  cancelDuration: number;
  /** Progress frozen at the moment of the cancel: the release fades that pose out. */
  cancelProgress: number;
}

interface Pending {
  type: GestureType;
  priority: number;
  intensity: number;
  /** 0: pick a side at random. */
  side: number;
}

/**
 * Gesture source: decides when to nod, tilt the head, shift the body or shoulders, lean in, shake the head slightly
 * or emphasise with a hand, from conversation state, both voices' prosody (EmotionFrame), user utterance
 * boundaries and, optionally, semantic intents of the reply's text (pushSemantic → SemanticGesturePolicy). No
 * renderer: the output is a GestureFrame of offsets that only BehaviorMixer turns into a pose.
 *
 * Scheduling: at most one primary gesture at a time; after it, a randomised per-type cooldown; out of cooldown, a
 * per-state rate (Poisson hazard, frame-rate independent) modulated by the assistant's activity while it speaks,
 * with a penalty on repeating the previous type. Boundary events (utterance end → nod) bypass the cooldown but not
 * the nod's own minimum interval. Everything runs on update() delta time: no timers, no listeners.
 */
export class GestureEngine implements GestureSource {
  readonly config: GestureConfig;
  private random: RandomSource;
  private readonly out: GestureFrame = createGestureFrame();
  private readonly running: Running = {
    type: 'nod',
    priority: 0,
    intensity: 0,
    duration: 1,
    elapsed: 0,
    side: 1,
    cancelling: false,
    cancelElapsed: 0,
    cancelDuration: 0,
    cancelProgress: 0,
  };
  private active = false;
  private hasPending = false;
  private readonly pendingSlot: Pending = { type: 'nod', priority: 0, intensity: 0, side: 0 };
  /** Decides whether semantic intents move the avatar. Mutable config for debug tuning. */
  readonly semantic: SemanticGesturePolicy;
  private readonly semanticQueue: { intent: SemanticIntent; at: number }[] = [];
  private lastSemanticIntentAt = -Infinity;
  private semanticError: string | null = null;
  private cooldown = 0;
  private clock = 0;

  private readonly hist: GestureHistory = { lastGestureType: null, lastGestureAt: -Infinity, gestureCount: 0 };
  private readonly counts: Record<GestureType, number> = Object.fromEntries(GESTURE_TYPES.map((t) => [t, 0])) as Record<
    GestureType,
    number
  >;
  private lastNodAt = -Infinity;
  private nodsThisUtterance = 0;

  // Edge detection over the context.
  private prevState: AvatarState | null = null;
  private prevUtteranceEnds: number | null = null;
  private prevUserSpeaking = false;
  private userSpeaking = false;
  private state: AvatarState = 'idle';

  private readonly weights: number[] = GESTURE_TYPES.map(() => 0);

  constructor(options: GestureEngineOptions = {}) {
    this.config = gestureConfig(options.config);
    this.random = options.random ?? mathRandom;
    this.semantic = new SemanticGesturePolicy(options.semantic);
  }

  /** Output of the last update(). Mutated in place every frame. */
  get current(): Readonly<GestureFrame> {
    return this.out;
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  /** Off: the running gesture releases gracefully and nothing starts, forced triggers included. */
  set enabled(on: boolean) {
    this.config.enabled = on;
    if (!on) this.cancel();
  }

  get auto(): boolean {
    return this.config.auto;
  }

  set auto(on: boolean) {
    this.config.auto = on;
  }

  /** Seconds until the scheduler may start the next gesture (0 while one runs). */
  get cooldownRemaining(): number {
    return this.active ? 0 : Math.max(0, this.cooldown);
  }

  get history(): Readonly<GestureHistory> {
    return this.hist;
  }

  /** Gestures started per type since construction (diagnostics). */
  get started(): Readonly<Record<GestureType, number>> {
    return this.counts;
  }

  /** Nods and double nods started (diagnostics; the old UserReaction nod counter). */
  get nods(): number {
    return this.counts.nod + this.counts['double-nod'];
  }

  get semanticStatus(): SemanticGestureStatus {
    const st = this.semantic.stats;
    return {
      enabled: this.semantic.config.enabled,
      queued: this.semanticQueue.length,
      intents: st.intents,
      accepted: st.accepted,
      decisions: this.semantic.history,
      error: this.semanticError,
    };
  }

  /**
   * A semantic intent (what a part of the reply does). Queued and decided on the next update(), where the engine
   * knows the conversation state, the user and the running gesture; most intents end in no gesture at all.
   * Never throws: a malformed intent or a policy error switches the semantic path off, nothing else.
   */
  pushSemantic(intent: SemanticIntent): void {
    if (!this.semantic.config.enabled || !intent || !Array.isArray(intent.cues)) return;
    const q = this.semanticQueue;
    q.push({ intent, at: this.clock });
    while (q.length > Math.max(1, this.semantic.config.maxQueue)) q.shift();
    this.lastSemanticIntentAt = this.clock;
  }

  /** Replaces the random source (a seeded one for deterministic tests/E2E). */
  setRandom(random: RandomSource): void {
    this.random = random;
  }

  /**
   * Debug/manual trigger: ignores probability and cooldown, never the safety bounds (BehaviorMixer clamps) and never
   * the rule that the hands stay still while the user speaks, listening or thinking. A running gesture releases first (≤ cancelRelease).
   * @returns whether the gesture was started or queued
   */
  trigger(type: GestureType, intensity = this.config.forcedIntensity): boolean {
    if (type === 'hand-emphasis' && !this.handsAllowed()) return false;
    return this.request(type, intensity, GESTURE_PRIORITY.forced);
  }

  cancel(): void {
    this.hasPending = false;
    this.startCancel(this.config.cancelRelease);
  }

  reset(): void {
    this.active = false;
    this.hasPending = false;
    this.semanticQueue.length = 0;
    this.semantic.reset();
    this.cooldown = 0;
    this.prevState = null;
    this.prevUtteranceEnds = null;
    this.prevUserSpeaking = this.userSpeaking = false;
    this.state = 'idle';
    this.nodsThisUtterance = 0;
    this.writeNeutral('none');
  }

  update(deltaTime: number, ctx: Readonly<GestureContext>): Readonly<GestureFrame> {
    const dt = deltaTime > 0 && Number.isFinite(deltaTime) ? deltaTime : 0;
    const c = this.config;
    this.clock += dt;
    this.userSpeaking = ctx.userSpeaking;
    this.state = ctx.conversationState;

    this.handleEvents(ctx);
    if (this.semanticQueue.length) this.handleSemantic(ctx);

    let finished = false;
    if (this.active) finished = this.advance(dt);
    if (!this.active && this.hasPending && c.enabled) {
      this.hasPending = false;
      this.start(this.pendingSlot.type, this.pendingSlot.intensity, this.pendingSlot.priority, this.pendingSlot.side);
    }
    if (!this.active) {
      this.cooldown -= dt;
      if (c.enabled && c.auto && this.cooldown <= 0) this.roll(dt, ctx);
    }

    if (this.active) this.render();
    else this.writeNeutral(finished ? 'done' : 'none');
    return this.out;
  }

  // --- events ------------------------------------------------------------------

  private handleEvents(ctx: Readonly<GestureContext>): void {
    const c = this.config;
    const state = ctx.conversationState;
    const prev = this.prevState;
    this.prevState = state;

    if (!c.enabled) {
      this.hasPending = false;
      this.startCancel(c.cancelRelease);
    }

    if (ctx.userSpeaking && !this.prevUserSpeaking) this.nodsThisUtterance = 0;
    this.prevUserSpeaking = ctx.userSpeaking;

    // Interruption: the assistant loses the floor to the user. Release fast, don't finish the gesture. The user's
    // emotion channel counts too: the reaction side may be suppressed (echo guard) while the assistant still talks.
    if (prev === 'speaking' && state !== 'speaking' && (ctx.userSpeaking || ctx.userEmotion.active)) {
      this.hasPending = false;
      // What the reply was about to stress no longer matters: the user has the floor.
      this.semanticQueue.length = 0;
      this.startCancel(c.interruptRelease);
      this.cooldown = Math.max(this.cooldown, c.interruptCooldown);
    }
    // Hands belong to the assistant's own speech (and idle, for forced tuning) only.
    if (this.active && this.running.type === 'hand-emphasis' && !this.running.cancelling && !this.handsAllowed()) {
      this.startCancel(c.interruptRelease);
    }

    const ends = ctx.utteranceEnds;
    if (this.prevUtteranceEnds !== null && ends !== this.prevUtteranceEnds && c.enabled && c.auto) {
      this.onUtteranceEnd(ctx);
    }
    this.prevUtteranceEnds = ends;

    if (prev !== null && prev !== 'speaking' && state === 'speaking' && c.enabled && c.auto) {
      if (this.random.next() < c.speakStartChance) {
        const type: GestureType = this.random.next() < 0.5 ? 'body-shift' : 'head-tilt';
        this.request(type, this.intensityFor(state, ctx), GESTURE_PRIORITY.boundary);
      }
    }
  }

  /** Never while the user speaks, listening or thinking; the scheduler itself only picks hands while speaking. */
  private handsAllowed(): boolean {
    return !this.userSpeaking && (this.state === 'speaking' || this.state === 'idle');
  }

  private onUtteranceEnd(ctx: Readonly<GestureContext>): void {
    const c = this.config;
    const d = ctx.lastUtteranceDuration;
    if (!(d >= c.nodMinUtterance)) return;
    if (ctx.conversationState === 'speaking') return;
    if (this.clock - this.lastNodAt < c.nodMinInterval) return;
    if (this.random.next() >= c.nodOnUtteranceChance) return;
    const u = ctx.userEmotion;
    const valence = u.valenceConfidence >= c.doubleNodValenceConfidence ? Math.max(0, u.valence) : 0;
    const engagement = u.confidence >= c.minConfidence ? Math.max(u.arousal, valence) : 0;
    const double =
      d >= c.doubleNodMinUtterance && engagement >= c.doubleNodMinEngagement && this.random.next() < c.doubleNodChance;
    this.request(double ? 'double-nod' : 'nod', this.intensityFor('listening', ctx), GESTURE_PRIORITY.boundary);
  }

  // --- semantic ----------------------------------------------------------------

  private handleSemantic(ctx: Readonly<GestureContext>): void {
    const q = this.semanticQueue;
    try {
      while (q.length) {
        const { intent, at } = q.shift()!;
        const r = this.running;
        const pendingBlocks = this.hasPending && this.pendingSlot.priority >= GESTURE_PRIORITY.semantic;
        const d = this.semantic.decide(intent, this.clock - at, {
          clock: this.clock,
          state: ctx.conversationState,
          userSpeaking: ctx.userSpeaking,
          handsAllowed: this.handsAllowed(),
          activity: ctx.conversationState === 'speaking' ? this.activity(ctx.assistantEmotion) : 0,
          busy: !this.config.enabled || pendingBlocks || (this.active && !r.cancelling && r.priority >= GESTURE_PRIORITY.semantic),
          lastGestureType: this.hist.lastGestureType,
          random: this.random,
        });
        if (d.accepted && d.gesture) this.request(d.gesture, d.intensity, GESTURE_PRIORITY.semantic, d.side);
      }
    } catch (error) {
      // Fail soft: the semantic path goes quiet, procedural gestures carry on.
      q.length = 0;
      this.semantic.config.enabled = false;
      this.semanticError = error instanceof Error ? error.message : String(error);
    }
  }

  // --- scheduler ---------------------------------------------------------------

  /** Out of cooldown: maybe start a gesture this frame (Poisson over the summed per-type rates). */
  private roll(dt: number, ctx: Readonly<GestureContext>): void {
    const c = this.config;
    const state = ctx.conversationState;
    const rates = c.rates[state];
    const scale = Math.max(0, Number.isFinite(c.rateScale) ? c.rateScale : 0);
    const a = ctx.assistantEmotion;
    const activity = state === 'speaking' ? this.activity(a) : 0;
    let speakingFactor = state === 'speaking' ? c.speakingRateFloor + (1 - c.speakingRateFloor) * activity : 1;
    // Semantic accents replace prosodic ones while the reply's text is being followed, instead of adding to them.
    const sem = this.semantic.config;
    if (state === 'speaking' && sem.enabled && this.clock - this.lastSemanticIntentAt < sem.ambientWindow) {
      speakingFactor *= sem.ambientRateScale;
    }

    let total = 0;
    for (let i = 0; i < GESTURE_TYPES.length; i++) {
      const type = GESTURE_TYPES[i]!;
      let r = Math.max(0, rates[type]) * scale * speakingFactor;
      if (type === 'hand-emphasis') {
        const ok =
          state === 'speaking' &&
          !ctx.userSpeaking &&
          a.confidence >= c.minConfidence &&
          a.arousal >= c.handMinArousal &&
          a.energy >= c.handMinEnergy;
        r = ok ? r * activity : 0;
      } else if ((type === 'nod' || type === 'double-nod') && state === 'listening') {
        // Listening nods only while the user talks, at most a few per utterance, never closer than the interval.
        if (!ctx.userSpeaking || this.nodsThisUtterance >= c.listeningNodsPerUtterance) r = 0;
        if (this.clock - this.lastNodAt < c.nodMinInterval) r = 0;
      }
      if (type === this.hist.lastGestureType) r *= c.repeatPenalty;
      this.weights[i] = r;
      total += r;
    }
    if (!(total > 0) || dt <= 0) return;
    if (this.random.next() >= 1 - Math.exp(-total * dt)) return;

    let pick = this.random.next() * total;
    let chosen: GestureType = GESTURE_TYPES[GESTURE_TYPES.length - 1]!;
    for (let i = 0; i < GESTURE_TYPES.length; i++) {
      pick -= this.weights[i]!;
      if (pick < 0 && this.weights[i]! > 0) {
        chosen = GESTURE_TYPES[i]!;
        break;
      }
    }
    if (this.weights[GESTURE_TYPES.indexOf(chosen)]! <= 0) return;
    const priority = state === 'speaking' ? GESTURE_PRIORITY.emphasis : GESTURE_PRIORITY.ambient;
    this.request(chosen, this.intensityFor(state, ctx), priority);
  }

  /**
   * Assistant activity, [0, 1]: arousal (mostly) and intonation, compressed into a band so that neither calm
   * speech nor a shout maps linearly onto motion. 0 when the analyser is unsure.
   */
  private activity(e: Readonly<EmotionFrame>): number {
    const c = this.config;
    if (!(e.confidence >= c.minConfidence)) return 0;
    const span = Math.max(1e-6, c.activityArousalTo - c.activityArousalFrom);
    const arousal = clamp01((e.arousal - c.activityArousalFrom) / span);
    const w = clamp01(c.activityPitchVariation);
    return smoothstep((1 - w) * arousal + w * clamp01(e.pitchVariation));
  }

  private intensityFor(state: AvatarState, ctx: Readonly<GestureContext>): number {
    const c = this.config;
    const [lo, hi] = c.intensity;
    if (state === 'speaking') return lerp(lo, hi, this.activity(ctx.assistantEmotion));
    if (state === 'listening') return lerp(lo, hi, 0.5 * this.activity(ctx.userEmotion)) * c.listeningIntensityScale;
    return lerp(lo, hi, 0.25);
  }

  private request(type: GestureType, intensity: number, priority: number, side = 0): boolean {
    if (!this.config.enabled) return false;
    const i = clamp01(intensity);
    if (this.active) {
      const r = this.running;
      // Only a higher priority preempts; a forced (debug) trigger always does.
      if (!r.cancelling && priority <= r.priority && priority < GESTURE_PRIORITY.forced) return false;
      if (this.hasPending && priority < this.pendingSlot.priority) return false;
      this.pendingSlot.type = type;
      this.pendingSlot.intensity = i;
      this.pendingSlot.priority = priority;
      this.pendingSlot.side = side;
      this.hasPending = true;
      if (!r.cancelling) this.startCancel(this.config.cancelRelease);
      return true;
    }
    this.start(type, i, priority, side);
    return true;
  }

  // --- lifecycle ---------------------------------------------------------------

  private start(type: GestureType, intensity: number, priority: number, side = 0): void {
    const t = this.config.types[type];
    const r = this.running;
    r.type = type;
    r.priority = priority;
    r.intensity = intensity;
    r.duration = Math.max(0.05, pickRange(t.duration, this.random));
    r.elapsed = 0;
    r.side = side !== 0 ? Math.sign(side) : this.random.next() < 0.5 ? 1 : -1;
    r.cancelling = false;
    r.cancelElapsed = 0;
    this.active = true;
    this.hist.lastGestureType = type;
    this.hist.lastGestureAt = this.clock;
    this.hist.gestureCount++;
    this.counts[type]++;
    if (type === 'nod' || type === 'double-nod') {
      this.lastNodAt = this.clock;
      if (this.userSpeaking) this.nodsThisUtterance++;
    }
  }

  private startCancel(duration: number): void {
    if (!this.active) return;
    const r = this.running;
    const d = Math.max(0, duration);
    if (r.cancelling) {
      // Already releasing: only ever shorten it (an interruption during a cancel).
      const remaining = r.cancelDuration - r.cancelElapsed;
      if (d >= remaining) return;
      // Keep the current fade level: restart a shorter fade from it by scaling the frozen pose.
      r.intensity *= 1 - smoothstep(r.cancelDuration > 0 ? r.cancelElapsed / r.cancelDuration : 1);
      r.cancelElapsed = 0;
      r.cancelDuration = d;
      return;
    }
    r.cancelling = true;
    r.cancelElapsed = 0;
    r.cancelDuration = d;
    r.cancelProgress = Math.min(1, r.elapsed / r.duration);
  }

  /** @returns whether the gesture finished this frame */
  private advance(dt: number): boolean {
    const r = this.running;
    if (r.cancelling) {
      r.cancelElapsed += dt;
      if (r.cancelElapsed < r.cancelDuration) return false;
    } else {
      r.elapsed += dt;
      if (r.elapsed < r.duration) return false;
    }
    this.active = false;
    const cd = pickRange(this.config.types[r.type].cooldown, this.random);
    this.cooldown = Math.max(this.cooldown, cd);
    return true;
  }

  // --- output --------------------------------------------------------------------

  private render(): void {
    const r = this.running;
    const t = this.config.types[r.type];
    const o = this.out;
    const p = r.cancelling ? r.cancelProgress : Math.min(1, r.elapsed / r.duration);
    let w = curve(r.type, p, t.attack, t.hold);
    if (r.cancelling) w *= 1 - smoothstep(r.cancelDuration > 0 ? r.cancelElapsed / r.cancelDuration : 1);
    const k = w * r.intensity;
    const s = r.side;

    o.active = true;
    o.type = r.type;
    o.progress = r.cancelling ? r.cancelProgress : p;
    o.intensity = r.intensity;
    o.phase = r.cancelling ? 'release' : phaseOf(p, t.attack, t.hold);

    o.head.pitch = t.headPitch * k;
    o.head.yaw = s * t.headYaw * k;
    o.head.roll = s * t.headRoll * k;
    o.body.lean = t.bodyLean * k;
    o.body.yaw = s * t.bodyYaw * k;
    o.body.roll = s * t.bodyRoll * k;
    const lift = t.shoulder * k;
    const drop = -t.shoulder * t.shoulderCounter * k;
    o.shoulders.left = s > 0 ? lift : drop;
    o.shoulders.right = s > 0 ? drop : lift;

    const arms = o.arms;
    arms.leftUpperArm.x = arms.leftUpperArm.y = arms.leftUpperArm.z = 0;
    arms.rightUpperArm.x = arms.rightUpperArm.y = arms.rightUpperArm.z = 0;
    arms.leftLowerArm.x = arms.leftLowerArm.y = arms.leftLowerArm.z = 0;
    arms.rightLowerArm.x = arms.rightLowerArm.y = arms.rightLowerArm.z = 0;
    if (t.armForward !== 0 || t.armOutward !== 0 || t.elbowBend !== 0) {
      // Normalized VRM axes (arms lowered by REST_POSE around Z): −X swings the arm forward, Z towards the T-pose
      // (+ for the left arm, − for the right), −Y/+Y bends the left/right elbow forward. A small beat on the
      // elbow makes it read as "emphasis" rather than "reach".
      const beat = 1 + 0.25 * Math.sin(4 * Math.PI * p);
      const upper = s > 0 ? arms.leftUpperArm : arms.rightUpperArm;
      const lower = s > 0 ? arms.leftLowerArm : arms.rightLowerArm;
      upper.x = -t.armForward * k;
      upper.z = s * t.armOutward * k;
      lower.y = -s * t.elbowBend * k * beat;
    }
  }

  private writeNeutral(phase: 'none' | 'done'): void {
    const o = this.out;
    o.active = false;
    o.type = null;
    o.phase = phase;
    o.progress = 0;
    o.intensity = 0;
    clearGestureOffsets(o);
  }
}

/** Shape of a gesture over its progress, [0, 1] (head-shake: signed, [−1, 1]), zero with zero slope at both ends. */
function curve(type: GestureType, p: number, attack: number, hold: number): number {
  if (p <= 0 || p >= 1) return 0;
  if (type === 'nod') return Math.sin(Math.PI * p) ** 2;
  if (type === 'double-nod') return Math.sin(2 * Math.PI * p) ** 2 * (p < 0.5 ? 1 : 0.7);
  // One swing to the side and back past centre, fading: signed, zero with zero slope at both ends.
  if (type === 'head-shake') return 1.3 * Math.sin(2 * Math.PI * p) * Math.sin(Math.PI * p);
  const a = Math.max(1e-3, attack);
  if (p < a) return smoothstep(p / a);
  if (p < a + hold) return 1;
  const rel = Math.max(1e-3, 1 - a - hold);
  return 1 - smoothstep((p - a - hold) / rel);
}

function phaseOf(p: number, attack: number, hold: number): GestureFrame['phase'] {
  if (p < attack * 0.25) return 'prepare';
  if (p < attack) return 'attack';
  if (p < attack + hold) return 'hold';
  return 'release';
}

function pickRange([lo, hi]: Range, random: RandomSource): number {
  return lo + (hi - lo) * random.next();
}

function smoothstep(x: number): number {
  const t = x < 0 ? 0 : x > 1 ? 1 : x;
  return t * t * (3 - 2 * t);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 0;
}
