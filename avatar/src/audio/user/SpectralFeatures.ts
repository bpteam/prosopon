export interface SpectralEstimate {
  /** Power-weighted mean frequency, Hz. 0 for silence. */
  centroidHz: number;
  /** Frequency below which `rolloff` of the power lies, Hz. 0 for silence. */
  rolloffHz: number;
}

export const NO_SPECTRUM: Readonly<SpectralEstimate> = Object.freeze({ centroidHz: 0, rolloffHz: 0 });

/**
 * Spectral shape of one short window: Hann window → radix-2 FFT → centroid and roll-off. Brightness/effort cues
 * (a pressed or shouted voice moves energy up the spectrum). Allocates once; `size` must be a power of two.
 */
export class SpectralAnalyzer {
  private readonly re: Float64Array;
  private readonly im: Float64Array;
  private readonly hann: Float64Array;
  private readonly bitrev: Uint32Array;

  constructor(
    readonly size = 512,
    /** Fraction of power for the roll-off point. */
    readonly rolloff = 0.85,
  ) {
    if (size < 8 || (size & (size - 1)) !== 0) throw new Error('[SpectralAnalyzer] size must be a power of two ≥ 8');
    this.re = new Float64Array(size);
    this.im = new Float64Array(size);
    this.hann = new Float64Array(size);
    for (let i = 0; i < size; i++) this.hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
    this.bitrev = new Uint32Array(size);
    const bits = Math.log2(size);
    for (let i = 0; i < size; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.bitrev[i] = r;
    }
  }

  /** Analyses the last `size` samples of `window` (zero-padded at the front when shorter). */
  analyze(window: ArrayLike<number>, sampleRate: number): SpectralEstimate {
    const n = this.size;
    const re = this.re;
    const im = this.im;
    const offset = window.length - n;
    for (let i = 0; i < n; i++) {
      const src = offset + i;
      re[this.bitrev[i]!] = (src >= 0 ? window[src]! : 0) * this.hann[i]!;
      im[this.bitrev[i]!] = 0;
    }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const step = (-2 * Math.PI) / len;
      for (let start = 0; start < n; start += len) {
        for (let k = 0; k < half; k++) {
          const wr = Math.cos(step * k);
          const wi = Math.sin(step * k);
          const a = start + k;
          const b = a + half;
          const tr = re[b]! * wr - im[b]! * wi;
          const ti = re[b]! * wi + im[b]! * wr;
          re[b] = re[a]! - tr;
          im[b] = im[a]! - ti;
          re[a] = re[a]! + tr;
          im[a] = im[a]! + ti;
        }
      }
    }
    // Power spectrum in place (bins 1..n/2; DC carries no voice information).
    let total = 0;
    let weighted = 0;
    const bins = n >> 1;
    const binHz = sampleRate / n;
    for (let k = 1; k <= bins; k++) {
      const p = re[k]! * re[k]! + im[k]! * im[k]!;
      re[k] = p;
      total += p;
      weighted += p * k * binHz;
    }
    if (!(total > 1e-12)) return NO_SPECTRUM;
    const target = total * this.rolloff;
    let acc = 0;
    let rollBin = bins;
    for (let k = 1; k <= bins; k++) {
      acc += re[k]!;
      if (acc >= target) {
        rollBin = k;
        break;
      }
    }
    return { centroidHz: weighted / total, rolloffHz: rollBin * binHz };
  }
}
