export interface PitchBaselineConfig {
  /** Voiced speech needed before the first baseline exists (median of it), seconds. */
  warmup: number;
  /**
   * Time constant of the adaptation afterwards, seconds of voiced speech. Long on purpose: a baseline that follows
   * every phrase would cancel the relative signal it exists for.
   */
  adaptation: number;
  /** Largest step a single estimate can pull the baseline by, semitones (outliers, octave errors). */
  maxDeviation: number;
}

export const DEFAULT_PITCH_BASELINE_CONFIG: Readonly<PitchBaselineConfig> = Object.freeze({
  warmup: 1.5,
  adaptation: 40,
  maxDeviation: 7,
});

/**
 * Personal/session pitch baseline: a slow log-domain average of voiced, confident speech frames only. Raw Hz says
 * little about a speaker (a typical 220 Hz is high for one voice and low for another); semitones relative to this
 * baseline are comparable across people.
 */
export class PitchBaseline {
  readonly config: PitchBaselineConfig;
  private warm: number[] = [];
  private warmTime = 0;
  /** log2(Hz) of the baseline, null during warm-up. */
  private log: number | null = null;

  constructor(config: Partial<PitchBaselineConfig> = {}) {
    this.config = { ...DEFAULT_PITCH_BASELINE_CONFIG, ...config };
  }

  /** Baseline, Hz; null until warmed up. */
  get hz(): number | null {
    return this.log === null ? null : 2 ** this.log;
  }

  /** Seeds the baseline directly (tests, or a remembered value). */
  set(hz: number): void {
    if (hz > 0) this.log = Math.log2(hz);
  }

  /** Feed one voiced, confident estimate covering `dt` seconds. */
  add(hz: number, dt: number): void {
    if (!(hz > 0) || !(dt > 0)) return;
    const l = Math.log2(hz);
    if (this.log === null) {
      this.warm.push(l);
      this.warmTime += dt;
      if (this.warmTime >= this.config.warmup) {
        const sorted = [...this.warm].sort((a, b) => a - b);
        this.log = sorted[sorted.length >> 1]!;
        this.warm = [];
      }
      return;
    }
    const maxStep = this.config.maxDeviation / 12;
    const d = Math.max(-maxStep, Math.min(maxStep, l - this.log));
    this.log += d * (1 - Math.exp(-dt / this.config.adaptation));
  }

  /** 12·log2(hz / baseline); 0 before the baseline exists. */
  relative(hz: number): number {
    return this.log === null || !(hz > 0) ? 0 : 12 * (Math.log2(hz) - this.log);
  }

  reset(): void {
    this.warm = [];
    this.warmTime = 0;
    this.log = null;
  }
}
