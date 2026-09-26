import { PitchBaseline, type PitchBaselineConfig } from './PitchBaseline';
import { NO_PITCH, PitchDetector, type PitchConfig, type PitchEstimate } from './PitchDetector';
import type { UserVoiceFrame } from './UserVoiceFrame';
import { VoiceActivityDetector, type VadConfig, type VoiceActivityState } from './VoiceActivityDetector';

export interface UserVoiceAnalyzerConfig {
  /** Level/VAD hop, seconds. Fixed, whatever size the input arrives in. */
  hop: number;
  /** Pitch is estimated every this many hops. */
  pitchEveryHops: number;
  /** Rate the pitch detector runs at after decimation, Hz. */
  pitchSampleRate: number;
  /** dB above floor + deactivation margin that map to energy 1. */
  energyRangeDb: number;
  /** Smoothing of energy, seconds. */
  energySmoothing: number;
  /** Window of voiced pitch the variation is measured over, seconds of analysis time. */
  variationWindow: number;
  vad?: Partial<VadConfig>;
  pitch?: Partial<PitchConfig>;
  baseline?: Partial<PitchBaselineConfig>;
}

export const DEFAULT_USER_VOICE_CONFIG: Readonly<UserVoiceAnalyzerConfig> = Object.freeze({
  hop: 0.01,
  pitchEveryHops: 2,
  pitchSampleRate: 16000,
  energyRangeDb: 30,
  energySmoothing: 0.05,
  variationWindow: 2,
});

/**
 * Sample-level analysis of the user's microphone: fixed-hop RMS → VAD, decimated windows → MPM pitch → session
 * baseline → relative pitch/variation. Pure computation with no Web Audio, DOM or avatar dependency, so it runs in an
 * AudioWorklet (the extension) and in unit tests alike. Samples live only in two short internal buffers
 * (one hop, one pitch window) and are overwritten as new audio arrives; nothing is kept or exposed.
 */
export class UserVoiceAnalyzer {
  readonly config: UserVoiceAnalyzerConfig;
  readonly vad: VoiceActivityDetector;
  readonly pitch: PitchDetector;
  readonly baseline: PitchBaseline;

  private readonly hopSamples: number;
  private hopFill = 0;
  private hopSum = 0;
  private hops = 0;

  private readonly decimation: number;
  private readonly pitchRate: number;
  private decimAcc = 0;
  private decimFill = 0;
  /** Ring of decimated samples, one pitch window long. */
  private readonly ring: Float32Array;
  private readonly windowBuf: Float32Array;
  private ringPos = 0;
  private ringFill = 0;

  private time = 0;
  private levelDb = -100;
  private energy = 0;
  private estimate: PitchEstimate = NO_PITCH;
  private reportedPitch: number | null = null;
  private relativePitch = 0;
  /** (analysis time, semitones re 1 Hz) of recent voiced estimates. */
  private voiced: { t: number; st: number }[] = [];

  constructor(
    readonly sampleRate: number,
    config: Partial<UserVoiceAnalyzerConfig> = {},
  ) {
    this.config = { ...DEFAULT_USER_VOICE_CONFIG, ...config };
    this.vad = new VoiceActivityDetector(this.config.vad);
    this.pitch = new PitchDetector(this.config.pitch);
    this.baseline = new PitchBaseline(this.config.baseline);
    this.hopSamples = Math.max(1, Math.round(sampleRate * this.config.hop));
    this.decimation = Math.max(1, Math.round(sampleRate / this.config.pitchSampleRate));
    this.pitchRate = sampleRate / this.decimation;
    const window = PitchDetector.windowFor(this.pitchRate, this.pitch.config.minHz);
    this.ring = new Float32Array(window);
    this.windowBuf = new Float32Array(window);
  }

  get activity(): VoiceActivityState {
    return this.vad.state;
  }

  /** Feed any number of mono samples. Chunk size doesn't matter: everything is processed in fixed hops. */
  process(samples: ArrayLike<number>): void {
    const n = samples.length;
    for (let i = 0; i < n; i++) {
      const s = samples[i]!;
      this.hopSum += s * s;
      this.decimAcc += s;
      if (++this.decimFill === this.decimation) {
        // Box-filter decimation: crude, but speech F0 sits far below the new Nyquist.
        this.ring[this.ringPos] = this.decimAcc / this.decimation;
        this.ringPos = (this.ringPos + 1) % this.ring.length;
        if (this.ringFill < this.ring.length) this.ringFill++;
        this.decimAcc = 0;
        this.decimFill = 0;
      }
      if (++this.hopFill === this.hopSamples) this.endHop();
    }
  }

  /** Current state as a fresh, serialisable frame. */
  frame(): UserVoiceFrame {
    const activity = this.vad.state;
    return {
      speaking: activity.speaking,
      segmentDuration: round(activity.duration, 3),
      rmsDb: round(this.levelDb, 1),
      noiseFloorDb: round(this.vad.noiseFloorDb, 1),
      energy: round(this.energy, 3),
      pitchHz: this.reportedPitch === null ? null : round(this.reportedPitch, 1),
      pitchConfidence: round(this.estimate.confidence, 3),
      relativePitch: round(this.relativePitch, 2),
      pitchVariation: round(this.variation(), 2),
    };
  }

  reset(): void {
    this.vad.reset();
    this.baseline.reset();
    this.hopFill = this.hopSum = this.hops = 0;
    this.decimAcc = this.decimFill = 0;
    this.ring.fill(0);
    this.ringPos = this.ringFill = 0;
    this.time = 0;
    this.levelDb = -100;
    this.energy = 0;
    this.estimate = NO_PITCH;
    this.reportedPitch = null;
    this.relativePitch = 0;
    this.voiced = [];
  }

  private endHop(): void {
    const c = this.config;
    const dt = this.hopSamples / this.sampleRate;
    const rms = Math.sqrt(this.hopSum / this.hopSamples);
    this.hopSum = 0;
    this.hopFill = 0;
    this.time += dt;
    this.levelDb = rms > 1e-5 ? 20 * Math.log10(rms) : -100;
    const activity = this.vad.process(this.levelDb, dt);

    const gate = this.vad.noiseFloorDb + this.vad.config.deactivationMargin;
    const target = activity.speaking ? clamp01((this.levelDb - gate) / c.energyRangeDb) : 0;
    this.energy += (target - this.energy) * (1 - Math.exp(-dt / c.energySmoothing));
    if (this.energy < 1e-4) this.energy = 0;

    if (++this.hops % c.pitchEveryHops === 0) this.estimatePitch(activity.speaking, gate, dt * c.pitchEveryHops);
  }

  private estimatePitch(speaking: boolean, gate: number, dt: number): void {
    if (this.ringFill < this.ring.length || this.levelDb < gate) {
      this.estimate = NO_PITCH;
    } else {
      // Unroll the ring into chronological order.
      const len = this.ring.length;
      const head = this.ringPos;
      this.windowBuf.set(this.ring.subarray(head), 0);
      this.windowBuf.set(this.ring.subarray(0, head), len - head);
      this.estimate = this.pitch.detect(this.windowBuf, this.pitchRate);
    }
    const hz = this.estimate.hz;
    this.reportedPitch = hz;
    if (hz === null) {
      this.relativePitch = 0;
    } else {
      // Only voiced, confident speech teaches the baseline: not noise, not the tail of a hum between phrases.
      if (speaking) this.baseline.add(hz, dt);
      this.relativePitch = this.baseline.relative(hz);
      this.voiced.push({ t: this.time, st: 12 * Math.log2(hz) });
    }
    const horizon = this.time - this.config.variationWindow;
    while (this.voiced.length > 0 && this.voiced[0]!.t < horizon) this.voiced.shift();
  }

  private variation(): number {
    const v = this.voiced;
    if (v.length < 5) return 0;
    let mean = 0;
    for (const e of v) mean += e.st;
    mean /= v.length;
    let sq = 0;
    for (const e of v) sq += (e.st - mean) ** 2;
    return Math.sqrt(sq / v.length);
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
