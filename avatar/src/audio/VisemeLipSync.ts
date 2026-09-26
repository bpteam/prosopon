import { CLOSED_MOUTH, VISEMES, type MouthShape, type MouthSource } from '../avatar/MouthShape';
import { follow, type AmplitudeLipSync } from './AmplitudeLipSync';
import type { VisemeAnalyzer } from './VisemeAnalyzer';

export interface VisemeLipSyncConfig {
  /** Use the analyser when one is attached. Off = amplitude only. */
  enabled: boolean;
  /**
   * How much loudness modulates the viseme opening, [0, 1]. 0: every detected viseme opens to maxOpen;
   * 1: opening is the amplitude level, the analyser only picks the shape.
   */
  levelInfluence: number;
  /** Per-viseme time constant while a weight rises, seconds. */
  attack: number;
  /** Per-viseme time constant while a weight falls, seconds. Longer than attack so shapes cross-blend. */
  release: number;
  /** Time constant of the amplitude ↔ viseme crossfade, seconds. */
  modeBlend: number;
}

export const DEFAULT_VISEME_CONFIG: Readonly<VisemeLipSyncConfig> = Object.freeze({
  enabled: true,
  levelInfluence: 0.6,
  attack: 0.04,
  release: 0.09,
  modeBlend: 0.15,
});

export type LipSyncMode = 'amplitude' | 'viseme';

/**
 * Lip sync with a viseme analyser on top of the amplitude fallback.
 *
 * Every frame the amplitude path runs (it is the fallback and it provides loudness). When a healthy analyser is
 * attached and enabled, its shape is scaled by loudness, gated closed on silence, smoothed per viseme and
 * crossfaded in over `modeBlend`; when it goes away or fails, the output crossfades back to amplitude "aa".
 * All smoothing integrates `delta` exactly, so the output doesn't depend on the frame rate.
 */
export class VisemeLipSync implements MouthSource {
  readonly config: VisemeLipSyncConfig;
  readonly amplitude: AmplitudeLipSync;

  private analyzer: VisemeAnalyzer | null = null;
  private readonly shape: MouthShape = { ...CLOSED_MOUTH };
  private readonly target: MouthShape = { ...CLOSED_MOUTH };
  private readonly smoothed: MouthShape = { ...CLOSED_MOUTH };
  private readonly out: MouthShape = { ...CLOSED_MOUTH };
  private weight = 0;

  constructor(amplitude: AmplitudeLipSync, config: Partial<VisemeLipSyncConfig> = {}) {
    this.amplitude = amplitude;
    this.config = { ...DEFAULT_VISEME_CONFIG, ...config };
  }

  /** The analyser is not owned: the caller disposes it. */
  setAnalyzer(analyzer: VisemeAnalyzer | null): void {
    this.analyzer = analyzer;
  }

  getAnalyzer(): VisemeAnalyzer | null {
    return this.analyzer;
  }

  /** Mode the output is heading to. */
  get mode(): LipSyncMode {
    return this.analyzerActive() ? 'viseme' : 'amplitude';
  }

  /** Crossfade position: 0 = amplitude, 1 = viseme. */
  get visemeWeight(): number {
    return this.weight;
  }

  /** Output of the last update. */
  get value(): Readonly<MouthShape> {
    return this.out;
  }

  update(delta: number): Readonly<MouthShape> {
    const c = this.config;
    const open = this.amplitude.update(delta);
    const active = this.analyzerActive();
    this.weight = follow(this.weight, active ? 1 : 0, delta, c.modeBlend, c.modeBlend);

    // Loudness, [0, maxOpen]: the unsmoothed amplitude target, so the viseme path has one smoothing stage.
    const level = this.amplitude.targetValue;
    const maxOpen = this.amplitude.config.maxOpen;
    const k = clamp01(c.levelInfluence);
    const gain = level > 0 ? (1 - k) * maxOpen + k * level : 0;
    if (active) this.analyzer!.read(this.shape);
    else Object.assign(this.shape, CLOSED_MOUTH);

    const w = this.weight;
    for (const v of VISEMES) {
      this.target[v] = clamp01(this.shape[v]) * gain;
      this.smoothed[v] = follow(this.smoothed[v], this.target[v], delta, c.attack, c.release);
      this.out[v] = w * this.smoothed[v];
    }
    this.out.aa += (1 - w) * open;
    return this.out;
  }

  reset(): void {
    this.amplitude.reset();
    this.weight = 0;
    Object.assign(this.shape, CLOSED_MOUTH);
    Object.assign(this.target, CLOSED_MOUTH);
    Object.assign(this.smoothed, CLOSED_MOUTH);
    Object.assign(this.out, CLOSED_MOUTH);
  }

  private analyzerActive(): boolean {
    return this.config.enabled && this.amplitude.config.enabled && !!this.analyzer?.healthy;
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : Number.isFinite(v) ? v : 0;
}
