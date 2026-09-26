import type { ProceduralPose } from './Avatar';
import { NEUTRAL_BODY_POSE } from './BodyPose';
import { NO_EMOTION_EXPRESSIONS } from './EmotionExpression';

export interface IdleConfig {
  enabled: boolean;
  /** 0..1 */
  breathingIntensity: number;
  /** Hz, clamped to [0.15, 0.35]. */
  breathingRate: number;
  /** 0..1 */
  headMotionIntensity: number;
  /** 0..1 */
  eyeMotionIntensity: number;
  blinkEnabled: boolean;
  /** Seconds between blinks, uniformly random in [min, max]. */
  blinkIntervalMin: number;
  blinkIntervalMax: number;
  /** Probability that a blink is followed by a quick second one. */
  doubleBlinkChance: number;
}

export const DEFAULT_IDLE_CONFIG: Readonly<IdleConfig> = Object.freeze({
  enabled: true,
  breathingIntensity: 1,
  breathingRate: 0.25,
  headMotionIntensity: 1,
  eyeMotionIntensity: 1,
  blinkEnabled: true,
  blinkIntervalMin: 2,
  blinkIntervalMax: 6,
  doubleBlinkChance: 0.1,
});

export const BREATHING_RATE_RANGE = [0.15, 0.35] as const;

/** Blink phase durations, seconds. */
export const BLINK_TIMING = Object.freeze({
  close: 0.07,
  hold: 0.05,
  open: 0.13,
  doubleBlinkGap: 0.12,
});

/**
 * Head micro-motion: per axis, a sum of two slow incommensurate sines.
 * `amplitude` (radians at intensity 1) is the hard bound of the axis.
 */
export const HEAD_MOTION = Object.freeze({
  yaw: { amplitude: 0.035, freqs: [0.071, 0.137] as const, weights: [0.65, 0.35] as const },
  pitch: { amplitude: 0.025, freqs: [0.053, 0.119] as const, weights: [0.6, 0.4] as const },
  roll: { amplitude: 0.018, freqs: [0.047, 0.101] as const, weights: [0.7, 0.3] as const },
});

/** Gaze: mostly at the target, occasionally a small glance away and back. */
export const GAZE = Object.freeze({
  /** Degrees at intensity 1. */
  maxYaw: 6,
  maxPitch: 3,
  centerHoldMin: 2,
  centerHoldMax: 5,
  awayHoldMin: 0.4,
  awayHoldMax: 1.2,
  /** Exponential approach rate, 1/s. High = saccade-like. */
  approachRate: 18,
});

/** Fade time constant when idle is toggled, seconds. */
const ENABLE_FADE_TAU = 0.25;

export type BlinkPhase = 'open' | 'closing' | 'closed' | 'opening';
export type GazePhase = 'center' | 'away';

export interface IdleState extends ProceduralPose {
  time: number;
  blinkPhase: BlinkPhase;
  gazePhase: GazePhase;
  /** 0..1 global idle weight (fades when enabled toggles). */
  weight: number;
}

export interface ProceduralSink {
  setProcedural(pose: Readonly<ProceduralPose>): void;
}

export type RandomSource = () => number;

/**
 * Procedural idle animation. Everything is driven by accumulated delta time.
 * Discrete events (blink phases, gaze switches) split the delta, so results
 * are the same at any frame rate.
 */
export class AvatarIdleController {
  readonly config: IdleConfig;
  readonly state: IdleState;

  private readonly random: RandomSource;
  private sink: ProceduralSink | null;

  private breathPhase = 0;
  private readonly headPhases: number[];

  private blinkTimer: number;
  private pendingDoubleBlink = false;

  private gazeTimer: number;
  private gazeTargetYaw = 0;
  private gazeTargetPitch = 0;

  constructor(options: { config?: Partial<IdleConfig>; random?: RandomSource; sink?: ProceduralSink | null } = {}) {
    this.config = { ...DEFAULT_IDLE_CONFIG, ...options.config };
    this.random = options.random ?? Math.random;
    this.sink = options.sink ?? null;

    // Random phase offsets so that two avatars are not in sync.
    this.headPhases = Array.from({ length: 6 }, () => this.random() * Math.PI * 2);
    this.blinkTimer = this.nextBlinkInterval();
    this.gazeTimer = this.range(GAZE.centerHoldMin, GAZE.centerHoldMax);

    this.state = {
      time: 0,
      weight: this.config.enabled ? 1 : 0,
      headYaw: 0,
      headPitch: 0,
      headRoll: 0,
      breath: 0,
      lean: 0,
      blink: 0,
      blinkPhase: 'open',
      gazeYaw: 0,
      gazePitch: 0,
      aa: 0,
      ih: 0,
      ou: 0,
      ee: 0,
      oh: 0,
      // Idle has no opinion about emotion: the mixer takes these from the emotion layer.
      ...NO_EMOTION_EXPRESSIONS,
      // Nor about gestures: body/shoulder/arm offsets come from the gesture layer only.
      ...NEUTRAL_BODY_POSE,
      gazePhase: 'center',
    };
  }

  setSink(sink: ProceduralSink | null): void {
    this.sink = sink;
  }

  /** Advance by delta seconds. Negative / NaN deltas are treated as 0. */
  update(delta: number): IdleState {
    const dt = Number.isFinite(delta) && delta > 0 ? delta : 0;
    const s = this.state;
    const c = this.config;
    s.time += dt;

    // Global enable fade (frame-rate independent exponential approach).
    const targetWeight = c.enabled ? 1 : 0;
    s.weight += (targetWeight - s.weight) * (1 - Math.exp(-dt / ENABLE_FADE_TAU));
    if (Math.abs(s.weight - targetWeight) < 1e-4) s.weight = targetWeight;
    const w = s.weight;

    // Breathing.
    const rate = clamp(c.breathingRate, BREATHING_RATE_RANGE[0], BREATHING_RATE_RANGE[1]);
    this.breathPhase = (this.breathPhase + Math.PI * 2 * rate * dt) % (Math.PI * 2);
    s.breath = Math.sin(this.breathPhase) * clamp(c.breathingIntensity, 0, 1) * w;

    // Head micro-motion (pure function of time).
    const hi = clamp(c.headMotionIntensity, 0, 1) * w;
    s.headYaw = this.headAxis(HEAD_MOTION.yaw, 0, s.time) * hi;
    s.headPitch = this.headAxis(HEAD_MOTION.pitch, 2, s.time) * hi;
    s.headRoll = this.headAxis(HEAD_MOTION.roll, 4, s.time) * hi;

    this.advanceBlink(dt);
    s.blink = blinkCurve(s.blinkPhase, this.blinkTimer);

    this.advanceGaze(dt);

    this.sink?.setProcedural(s);
    return s;
  }

  /** Force a blink now (e.g. for testing / future triggers). */
  triggerBlink(): void {
    if (this.state.blinkPhase === 'open') this.enterBlinkPhase('closing');
  }

  // --- blink -------------------------------------------------------------

  private advanceBlink(dt: number): void {
    let remaining = dt;
    const s = this.state;
    // Split dt at phase boundaries: behaviour is independent of frame size.
    while (remaining > 0) {
      if (s.blinkPhase === 'open' && !this.canBlink()) {
        // Hold the timer while blinking is disabled; the next blink comes a full interval after re-enabling.
        return;
      }
      if (this.blinkTimer > remaining) {
        this.blinkTimer -= remaining;
        return;
      }
      remaining -= this.blinkTimer;
      this.blinkTimer = 0;
      this.nextBlinkPhase();
    }
  }

  private nextBlinkPhase(): void {
    switch (this.state.blinkPhase) {
      case 'open':
        this.enterBlinkPhase('closing');
        break;
      case 'closing':
        this.enterBlinkPhase('closed');
        break;
      case 'closed':
        this.enterBlinkPhase('opening');
        break;
      case 'opening':
        this.enterBlinkPhase('open');
        break;
    }
  }

  private enterBlinkPhase(phase: BlinkPhase): void {
    this.state.blinkPhase = phase;
    switch (phase) {
      case 'closing':
        this.blinkTimer = BLINK_TIMING.close;
        break;
      case 'closed':
        this.blinkTimer = BLINK_TIMING.hold;
        break;
      case 'opening':
        this.blinkTimer = BLINK_TIMING.open;
        break;
      case 'open':
        if (this.pendingDoubleBlink) {
          this.pendingDoubleBlink = false;
          this.blinkTimer = BLINK_TIMING.doubleBlinkGap;
        } else {
          this.pendingDoubleBlink = this.random() < this.config.doubleBlinkChance;
          this.blinkTimer = this.nextBlinkInterval();
        }
        break;
    }
  }

  private canBlink(): boolean {
    return this.config.enabled && this.config.blinkEnabled;
  }

  private nextBlinkInterval(): number {
    const min = Math.max(0.1, this.config.blinkIntervalMin);
    const max = Math.max(min, this.config.blinkIntervalMax);
    return this.range(min, max);
  }

  // --- gaze --------------------------------------------------------------

  private advanceGaze(dt: number): void {
    let remaining = dt;
    while (remaining > 0) {
      const step = Math.min(remaining, this.gazeTimer);
      this.approachGaze(step);
      remaining -= step;
      this.gazeTimer -= step;
      if (this.gazeTimer <= 0) this.switchGaze();
    }
  }

  private approachGaze(dt: number): void {
    const s = this.state;
    const k = 1 - Math.exp(-GAZE.approachRate * dt);
    const scale = clamp(this.config.eyeMotionIntensity, 0, 1) * s.weight;
    s.gazeYaw += (this.gazeTargetYaw * scale - s.gazeYaw) * k;
    s.gazePitch += (this.gazeTargetPitch * scale - s.gazePitch) * k;
  }

  private switchGaze(): void {
    const s = this.state;
    if (s.gazePhase === 'center') {
      s.gazePhase = 'away';
      this.gazeTargetYaw = (this.random() * 2 - 1) * GAZE.maxYaw;
      this.gazeTargetPitch = (this.random() * 2 - 1) * GAZE.maxPitch;
      this.gazeTimer = this.range(GAZE.awayHoldMin, GAZE.awayHoldMax);
    } else {
      s.gazePhase = 'center';
      this.gazeTargetYaw = 0;
      this.gazeTargetPitch = 0;
      this.gazeTimer = this.range(GAZE.centerHoldMin, GAZE.centerHoldMax);
    }
  }

  // --- helpers -----------------------------------------------------------

  private headAxis(
    axis: { amplitude: number; freqs: readonly [number, number]; weights: readonly [number, number] },
    phaseIndex: number,
    t: number,
  ): number {
    const v =
      axis.weights[0] * Math.sin(Math.PI * 2 * axis.freqs[0] * t + this.headPhases[phaseIndex]!) +
      axis.weights[1] * Math.sin(Math.PI * 2 * axis.freqs[1] * t + this.headPhases[phaseIndex + 1]!);
    return clamp(v, -1, 1) * axis.amplitude;
  }

  private range(min: number, max: number): number {
    return min + this.random() * (max - min);
  }
}

/** Eyelid closure for a phase given the time remaining in it. */
function blinkCurve(phase: BlinkPhase, remaining: number): number {
  switch (phase) {
    case 'open':
      return 0;
    case 'closing':
      return smoothstep(1 - remaining / BLINK_TIMING.close);
    case 'closed':
      return 1;
    case 'opening':
      return 1 - smoothstep(1 - remaining / BLINK_TIMING.open);
  }
}

function smoothstep(x: number): number {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}
