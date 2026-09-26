export interface VoiceActivityState {
  speaking: boolean;
  /** Analysis time (seconds since the detector started) the current segment began, null while silent. */
  startedAt: number | null;
  /** Seconds of the current segment while speaking, of the last finished one while silent. */
  duration: number;
}

export interface VadConfig {
  /** Speech must be this far above the noise floor to start a segment, dB. */
  activationMargin: number;
  /** Once speaking, the level must stay above floor + this, dB (hysteresis: < activationMargin). */
  deactivationMargin: number;
  /** Level must exceed floor + activationMargin for this long before speaking starts, seconds. */
  attack: number;
  /** Level must stay below floor + deactivationMargin for this long before speaking ends, seconds. */
  hangover: number;
  /** Floor adaptation while silent: rising (slow, so speech onsets don't lift it) and falling (fast), dB/s. */
  floorRiseRate: number;
  floorFallRate: number;
  /**
   * Floor rise while speaking, dB/s. Small but not zero: a steady noise that starts loud (a fan) would otherwise
   * read as one endless segment with the floor frozen underneath it.
   */
  floorRiseRateSpeaking: number;
  /** Floor bounds, dBFS. The upper bound keeps a loud room from hiding speech entirely. */
  minFloorDb: number;
  maxFloorDb: number;
  /** Nothing quieter than this is speech, whatever the floor, dBFS. */
  minSpeechDb: number;
}

export const DEFAULT_VAD_CONFIG: Readonly<VadConfig> = Object.freeze({
  activationMargin: 12,
  deactivationMargin: 6,
  attack: 0.1,
  hangover: 0.3,
  floorRiseRate: 3,
  floorFallRate: 40,
  floorRiseRateSpeaking: 0.5,
  minFloorDb: -85,
  maxFloorDb: -35,
  minSpeechDb: -60,
});

/**
 * Energy VAD with a tracked noise floor and a two-state machine:
 *
 *   silence ──(level > floor+activation for `attack`)──► speaking
 *   speaking ──(level < floor+deactivation for `hangover`)──► silence
 *
 * Driven by per-hop levels with their duration, so the transitions depend on elapsed signal time and not on how the
 * signal was chunked (the analyser feeds fixed hops anyway).
 */
export class VoiceActivityDetector {
  readonly config: VadConfig;
  private floor: number;
  private time = 0;
  private isSpeaking = false;
  private above = 0;
  private below = 0;
  private segmentStart: number | null = null;
  private lastDuration = 0;
  private primed = false;

  constructor(config: Partial<VadConfig> = {}) {
    this.config = { ...DEFAULT_VAD_CONFIG, ...config };
    this.floor = this.config.minFloorDb;
  }

  get state(): VoiceActivityState {
    return {
      speaking: this.isSpeaking,
      startedAt: this.segmentStart,
      duration: this.isSpeaking && this.segmentStart !== null ? this.time - this.segmentStart : this.lastDuration,
    };
  }

  get speaking(): boolean {
    return this.isSpeaking;
  }

  get noiseFloorDb(): number {
    return this.floor;
  }

  /** Threshold the level has to cross right now to count as speech, dBFS. */
  get threshold(): number {
    const c = this.config;
    return Math.max(c.minSpeechDb, this.floor + (this.isSpeaking ? c.deactivationMargin : c.activationMargin));
  }

  /** @param levelDb level of the hop, dBFS; @param dt hop duration, seconds */
  process(levelDb: number, dt: number): VoiceActivityState {
    const c = this.config;
    if (!(dt > 0)) return this.state;
    const level = Number.isFinite(levelDb) ? levelDb : -100;
    if (!this.primed) {
      // Start at the first level heard instead of crawling up from the minimum.
      this.floor = clamp(level, c.minFloorDb, c.maxFloorDb);
      this.primed = true;
    }
    const start = this.time;
    this.time += dt;

    if (!this.isSpeaking) {
      if (level > this.threshold) {
        this.above += dt;
        if (this.above >= c.attack) {
          this.isSpeaking = true;
          this.below = 0;
          // The segment began when the level first crossed the threshold, not when attack was satisfied.
          this.segmentStart = this.time - this.above;
        }
      } else {
        this.above = 0;
      }
      // The floor only learns from non-speech; while an onset is pending it holds still.
      if (!this.isSpeaking && this.above === 0) this.trackFloor(level, dt, c.floorRiseRate);
    } else {
      this.trackFloor(level, dt, c.floorRiseRateSpeaking);
      if (level < this.threshold) {
        this.below += dt;
        if (this.below >= c.hangover) {
          this.isSpeaking = false;
          this.above = 0;
          // The segment ended when the level dropped, not when hangover ran out.
          const end = this.time - this.below;
          this.lastDuration = Math.max(0, end - (this.segmentStart ?? start));
          this.segmentStart = null;
        }
      } else {
        this.below = 0;
      }
    }
    return this.state;
  }

  reset(): void {
    this.floor = this.config.minFloorDb;
    this.time = 0;
    this.isSpeaking = false;
    this.above = 0;
    this.below = 0;
    this.segmentStart = null;
    this.lastDuration = 0;
    this.primed = false;
  }

  private trackFloor(level: number, dt: number, riseRate: number): void {
    const c = this.config;
    const target = clamp(level, c.minFloorDb, c.maxFloorDb);
    if (target > this.floor) this.floor = Math.min(target, this.floor + riseRate * dt);
    else this.floor = Math.max(target, this.floor - c.floorFallRate * dt);
  }
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}
