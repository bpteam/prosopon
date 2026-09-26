import type { MouthSource } from '../avatar/MouthShape';

export interface AmplitudeLipSyncConfig {
  enabled: boolean;
  /** Input gain applied before mapping, dB. */
  gainDb: number;
  /** Level at or below which the mouth is closed, dBFS. Doubles as the noise gate. */
  noiseFloorDb: number;
  /** Level at which the mouth is fully open, dBFS. */
  fullOpenDb: number;
  /** Time constant while the mouth is opening, seconds. */
  attack: number;
  /** Time constant while the mouth is closing, seconds. */
  release: number;
  /** Upper bound of the output, [0, 1]. A fully open "aa" looks like a yawn on most models. */
  maxOpen: number;
}

export const DEFAULT_LIP_SYNC_CONFIG: Readonly<AmplitudeLipSyncConfig> = Object.freeze({
  enabled: true,
  gainDb: 0,
  noiseFloorDb: -50,
  fullOpenDb: -18,
  attack: 0.03,
  release: 0.1,
  maxOpen: 0.8,
});

/** Lowest level reported, dBFS (instead of -Infinity for silence). */
export const MIN_DB = -100;

/**
 * Amplitude fallback for lip sync: RMS level → mouth openness.
 *
 * The level is mapped linearly in dB between `noiseFloorDb` and `fullOpenDb` (loudness is roughly logarithmic,
 * so this tracks syllables better than linear RMS), then smoothed by a one-pole follower with separate
 * attack/release time constants. The follower integrates `delta` with an exact exponential step, so the
 * result doesn't depend on frame rate for a given input signal.
 */
export class AmplitudeLipSync implements MouthSource {
  readonly config: AmplitudeLipSyncConfig;

  private readonly readRms: () => number;
  private current = 0;
  private target = 0;
  private db = MIN_DB;

  /** @param readRms current RMS of the signal, linear [0, 1] (e.g. AudioInput.readRms). */
  constructor(readRms: () => number, config: Partial<AmplitudeLipSyncConfig> = {}) {
    this.readRms = readRms;
    this.config = { ...DEFAULT_LIP_SYNC_CONFIG, ...config };
  }

  /** Smoothed mouth openness of the last update, [0, maxOpen]. */
  get value(): number {
    return this.current;
  }

  /** Unsmoothed mapped level of the last update, [0, 1]. */
  get targetValue(): number {
    return this.target;
  }

  /** Input level of the last update after gain, dBFS. */
  get levelDb(): number {
    return this.db;
  }

  update(delta: number): number {
    const c = this.config;
    const rms = c.enabled ? this.readRms() : 0;
    this.db = toDb(rms) + c.gainDb;
    this.target = mapLevel(this.db, c.noiseFloorDb, c.fullOpenDb) * clamp01(c.maxOpen);
    this.current = follow(this.current, this.target, delta, c.attack, c.release);
    return this.current;
  }

  reset(): void {
    this.current = 0;
    this.target = 0;
    this.db = MIN_DB;
  }
}

export function toDb(rms: number): number {
  if (!(rms > 0)) return MIN_DB;
  return Math.max(20 * Math.log10(rms), MIN_DB);
}

/** dB level → [0, 1], linear between floor and full. */
export function mapLevel(db: number, floorDb: number, fullDb: number): number {
  if (!(fullDb > floorDb)) return db > floorDb ? 1 : 0;
  return clamp01((db - floorDb) / (fullDb - floorDb));
}

/** One-pole follower step with separate attack (rising) and release (falling) time constants. */
export function follow(current: number, target: number, delta: number, attack: number, release: number): number {
  if (!(delta > 0)) return current;
  const tau = target > current ? attack : release;
  if (!(tau > 0)) return target;
  return target + (current - target) * Math.exp(-delta / tau);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : Number.isFinite(v) ? v : 0;
}
