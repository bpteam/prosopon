export interface PitchConfig {
  /** Search range of the fundamental, Hz. Covers adult and child speech, including raised voices. */
  minHz: number;
  maxHz: number;
  /** MPM "k": the first NSDF key maximum within k × the highest one wins (guards against octave-down errors). */
  peakThreshold: number;
  /** Below this clarity the estimate is discarded (unvoiced consonants, noise, reverb tails). */
  minConfidence: number;
  /** Windows quieter than this are not analysed, dBFS. */
  minLevelDb: number;
}

export const DEFAULT_PITCH_CONFIG: Readonly<PitchConfig> = Object.freeze({
  minHz: 60,
  maxHz: 800,
  peakThreshold: 0.9,
  minConfidence: 0.8,
  minLevelDb: -60,
});

export interface PitchEstimate {
  /** Null when unvoiced / below confidence / silent. */
  hz: number | null;
  /** NSDF clarity of the chosen peak, [0, 1] (reported even when below the confidence threshold). */
  confidence: number;
}

export const NO_PITCH: Readonly<PitchEstimate> = Object.freeze({ hz: null, confidence: 0 });

/**
 * McLeod Pitch Method on one window: normalised square difference function, key maxima between zero crossings,
 * first maximum above k × the global one, parabolic interpolation. O(window × maxLag); callers decimate first
 * (16 kHz is plenty for speech F0) to keep it cheap.
 */
export class PitchDetector {
  readonly config: PitchConfig;
  private nsdf = new Float64Array(0);

  constructor(config: Partial<PitchConfig> = {}) {
    this.config = { ...DEFAULT_PITCH_CONFIG, ...config };
  }

  /** Shortest window that can resolve minHz at `sampleRate` (two periods). */
  static windowFor(sampleRate: number, minHz = DEFAULT_PITCH_CONFIG.minHz): number {
    return Math.ceil((2 * sampleRate) / minHz);
  }

  detect(window: ArrayLike<number>, sampleRate: number): PitchEstimate {
    const c = this.config;
    const n = window.length;
    let energy = 0;
    let mean = 0;
    for (let i = 0; i < n; i++) mean += window[i]!;
    mean /= n || 1;
    for (let i = 0; i < n; i++) {
      const v = window[i]! - mean;
      energy += v * v;
    }
    if (n === 0 || 10 * Math.log10(energy / n + 1e-20) < c.minLevelDb) return NO_PITCH;

    const minLag = Math.max(2, Math.floor(sampleRate / c.maxHz));
    const maxLag = Math.min(n - 2, Math.ceil(sampleRate / c.minHz));
    if (maxLag <= minLag) return NO_PITCH;
    if (this.nsdf.length < maxLag + 2) this.nsdf = new Float64Array(maxLag + 2);
    const nsdf = this.nsdf;

    // NSDF(τ) = 2·Σ x[i]x[i+τ] / Σ (x[i]² + x[i+τ]²), mean removed. Computed from τ = 1 so the zero-lag lobe can be
    // skipped by its first negative zero crossing, as MPM prescribes.
    for (let tau = 1; tau <= maxLag + 1; tau++) {
      let acf = 0;
      let m = 0;
      for (let i = 0; i + tau < n; i++) {
        const a = window[i]! - mean;
        const b = window[i + tau]! - mean;
        acf += a * b;
        m += a * a + b * b;
      }
      nsdf[tau] = m > 0 ? (2 * acf) / m : 0;
    }

    // Key maxima: the highest point of each positive region after the zero-lag lobe.
    const peaks: number[] = [];
    let tau = 1;
    while (tau <= maxLag && nsdf[tau]! > 0) tau++;
    let best = -1;
    let bestTau = -1;
    let inPositive = false;
    for (; tau <= maxLag; tau++) {
      const v = nsdf[tau]!;
      if (v > 0) {
        if (!inPositive) {
          inPositive = true;
          best = -1;
        }
        if (v > best) {
          best = v;
          bestTau = tau;
        }
      } else if (inPositive) {
        inPositive = false;
        if (bestTau >= minLag) peaks.push(bestTau);
      }
    }
    if (inPositive && bestTau >= minLag && bestTau < maxLag) peaks.push(bestTau);
    if (peaks.length === 0) return NO_PITCH;

    let highest = 0;
    for (const p of peaks) highest = Math.max(highest, nsdf[p]!);
    const threshold = c.peakThreshold * highest;
    const chosen = peaks.find((p) => nsdf[p]! >= threshold)!;

    // Parabolic interpolation around the chosen lag.
    const y0 = nsdf[chosen - 1]!;
    const y1 = nsdf[chosen]!;
    const y2 = nsdf[chosen + 1]!;
    const denom = y0 - 2 * y1 + y2;
    const shift = denom !== 0 ? (0.5 * (y0 - y2)) / denom : 0;
    const lag = chosen + (Math.abs(shift) < 1 ? shift : 0);
    const clarity = Math.min(1, Math.max(0, y1 - 0.25 * (y0 - y2) * (Math.abs(shift) < 1 ? shift : 0)));
    const hz = sampleRate / lag;
    if (clarity < c.minConfidence || hz < c.minHz || hz > c.maxHz) return { hz: null, confidence: clarity };
    return { hz, confidence: clarity };
  }
}
