import type { VoiceFeatureFrame } from '../user/UserVoiceFrame';
import { NEUTRAL_EMOTION, type AnalyzerMode, type EmotionFrame } from './EmotionFrame';

/**
 * A model's view of the last window (see EmotionModel). Arousal [0, 1], valence [−1, 1], confidence [0, 1].
 */
export interface ModelEstimate {
  arousal: number;
  valence: number;
  confidence: number;
}

export interface ProsodyEmotionConfig {
  /** Rolling analysis window, seconds of audio. */
  window: number;
  /** An EmotionFrame is produced every this many seconds of audio (8 Hz). */
  outputInterval: number;

  /** Speech must cover this fraction of the window to turn `active` on… */
  activeOnRatio: number;
  /** …and less than this to turn it off (hysteresis). */
  activeOffRatio: number;

  /** Semitones above/below the baseline that give pitchLift ±1. */
  pitchLiftRange: number;
  /** Pitch standard deviation (semitones) that gives pitchVariation 1. */
  pitchVariationRange: number;
  /** Energy peaks per second of speech that give speechRate 1. */
  speechRateMax: number;
  /** A peak must stand this far above the preceding dip to count as a syllable, dB. */
  syllableProminenceDb: number;
  /** Spectral centroid mapped to brightness 0 and 1, Hz. */
  centroidLowHz: number;
  centroidHighHz: number;

  /** Arousal = Σ weight × cue over energy, pitch variation, speech rate, brightness, minus pauses. */
  arousalWeights: { energy: number; pitchVariation: number; speechRate: number; brightness: number; pauses: number };
  /** Share of arousal taken relative to the channel's own baseline (0 = absolute scale only). */
  baselineWeight: number;
  /** Speech needed before the baseline is trusted, seconds. */
  baselineWarmup: number;
  /** Time constant of the baseline, seconds of speech. Long, so it tracks the voice, not the phrase. */
  baselineAdaptation: number;
  /** Floor of the baseline's spread, arousal units (keeps a monotone voice from blowing up small changes). */
  baselineMinSpread: number;

  /** Heuristic valence: weights of pitch lift, liveliness, speech rate and tension (negative). */
  valenceWeights: { pitchLift: number; pitchVariation: number; speechRate: number; tension: number };
  /** Upper bound of confidence without a model. */
  heuristicConfidence: number;
  /** Upper bound of valenceConfidence without a model: prosody barely tells pleasant from unpleasant. */
  heuristicValenceConfidence: number;

  /** How much a model's arousal replaces the heuristic one, at model confidence 1. */
  modelArousalWeight: number;
  /** A model estimate older than this is ignored, seconds of audio. */
  modelMaxAge: number;

  /** Ignore target changes smaller than this (per field), so the output doesn't creep on noise. */
  hysteresis: number;
  /** Attack/release time constants, seconds. */
  arousalAttack: number;
  arousalRelease: number;
  valenceAttack: number;
  valenceRelease: number;
  energyAttack: number;
  energyRelease: number;
  tensionAttack: number;
  tensionRelease: number;
  pitchAttack: number;
  pitchRelease: number;
  confidenceAttack: number;
  confidenceRelease: number;
  /** Time constant of the return to neutral after speech stops, seconds. */
  silenceRelease: number;
}

export const DEFAULT_PROSODY_EMOTION_CONFIG: Readonly<ProsodyEmotionConfig> = Object.freeze({
  window: 1.5,
  outputInterval: 0.125,
  activeOnRatio: 0.2,
  activeOffRatio: 0.08,
  pitchLiftRange: 6,
  pitchVariationRange: 4,
  speechRateMax: 8,
  syllableProminenceDb: 3,
  centroidLowHz: 700,
  centroidHighHz: 2600,
  // A steady synthetic Voice response can be highly melodic even when it is deliberately calm.
  // Let its own loudness baseline carry more of arousal than pitch variation, which prevents
  // a calm Sol-style answer from reading as excited merely because it has expressive intonation.
  arousalWeights: Object.freeze({ energy: 0.55, pitchVariation: 0.16, speechRate: 0.13, brightness: 0.3, pauses: 0.1 }),
  baselineWeight: 0.5,
  baselineWarmup: 4,
  baselineAdaptation: 30,
  baselineMinSpread: 0.05,
  valenceWeights: Object.freeze({ pitchLift: 0.35, pitchVariation: 0.35, speechRate: 0.1, tension: 0.6 }),
  heuristicConfidence: 0.7,
  heuristicValenceConfidence: 0.25,
  modelArousalWeight: 0.6,
  modelMaxAge: 2,
  hysteresis: 0.04,
  arousalAttack: 0.5,
  arousalRelease: 1.0,
  valenceAttack: 1.0,
  valenceRelease: 1.5,
  energyAttack: 0.2,
  energyRelease: 0.5,
  tensionAttack: 0.6,
  tensionRelease: 1.0,
  pitchAttack: 0.3,
  pitchRelease: 0.6,
  confidenceAttack: 0.6,
  confidenceRelease: 0.8,
  silenceRelease: 1.2,
}) as Readonly<ProsodyEmotionConfig>;

/** Raw (unsmoothed) cues of the current window. Exposed for calibration. */
export interface ProsodyCues {
  activeRatio: number;
  voicedRatio: number;
  energy: number;
  pitchLift: number;
  pitchVariation: number;
  speechRate: number;
  brightness: number;
  pauses: number;
  /** Arousal on the absolute scale, before the baseline. */
  arousalAbsolute: number;
  tension: number;
  valence: number;
  confidence: number;
}

interface Entry {
  dt: number;
  speaking: boolean;
  rmsDb: number;
  energy: number;
  voiced: boolean;
  relativePitch: number;
  pitchVariation: number;
  centroid: number;
}

type Smoothed = 'valence' | 'arousal' | 'energy' | 'tension' | 'pitchLift' | 'pitchVariation' | 'speechRate' | 'confidence' | 'valenceConfidence';

/**
 * Prosody → EmotionFrame for ONE voice channel. The user's microphone and the assistant's audio each get their own
 * instance of this same class; nothing is static or shared, so the channels cannot leak into each other.
 *
 * Input: VoiceFeatureFrames (VAD, pitch, spectrum; 20–30 Hz) with the audio time each covers. The analyser keeps a
 * rolling window of them (≈1.5 s), turns it into cues every outputInterval (8 Hz), maps the cues to targets with
 * explicit rules, and follows the targets with attack/release EMAs behind a small hysteresis. A local model, when
 * one runs, contributes through setModelEstimate(); without it the rules alone drive the frame.
 *
 * Knows audio features and EmotionFrame only: no avatar, no mixer, no three.js.
 */
export class ProsodyEmotionAnalyzer {
  readonly config: ProsodyEmotionConfig;
  private entries: Entry[] = [];
  private windowTime = 0;
  private sinceOutput = 0;
  private isActive = false;
  private modeValue: AnalyzerMode = 'heuristic';
  private model: ModelEstimate | null = null;
  private modelAge = Infinity;

  /** Baseline of absolute arousal: mean/variance over speech, and how much speech taught it. */
  private baseMean = 0;
  private baseVar = 0;
  private baseTime = 0;

  private readonly target: Record<Smoothed, number> = {
    valence: 0,
    arousal: 0,
    energy: 0,
    tension: 0,
    pitchLift: 0,
    pitchVariation: 0,
    speechRate: 0,
    confidence: 0,
    valenceConfidence: 0,
  };
  private readonly out: EmotionFrame = { ...NEUTRAL_EMOTION };
  private cuesValue: ProsodyCues = emptyCues();

  constructor(config: Partial<ProsodyEmotionConfig> = {}) {
    const d = DEFAULT_PROSODY_EMOTION_CONFIG;
    // Nested weights are copied too: tuning one instance (debug UI) must not touch the defaults or the other channel.
    this.config = {
      ...d,
      ...config,
      arousalWeights: { ...d.arousalWeights, ...config.arousalWeights },
      valenceWeights: { ...d.valenceWeights, ...config.valenceWeights },
    };
  }

  get mode(): AnalyzerMode {
    return this.modeValue;
  }

  /** Set by whoever runs the model (EmotionModelHost). */
  setMode(mode: AnalyzerMode): void {
    this.modeValue = mode;
    if (mode === 'heuristic' || mode === 'fallback') this.model = null;
    this.out.mode = mode;
  }

  /** A model's estimate of the most recent window; null drops it. */
  setModelEstimate(estimate: ModelEstimate | null): void {
    this.model = estimate;
    this.modelAge = 0;
  }

  /** Cues of the last analysed window (calibration/debug). */
  get cues(): Readonly<ProsodyCues> {
    return this.cuesValue;
  }

  /** The current (smoothed) frame. Mutated in place; use frame() for a copy. */
  get value(): Readonly<EmotionFrame> {
    return this.out;
  }

  frame(): EmotionFrame {
    return { ...this.out };
  }

  /** Seconds of speech the channel baseline has learned from. */
  get baselineSeconds(): number {
    return this.baseTime;
  }

  /**
   * Feed one feature frame covering `dt` seconds of audio.
   * @returns a fresh EmotionFrame when an output tick happened (every outputInterval), otherwise null
   */
  push(frame: Readonly<VoiceFeatureFrame>, dt: number): EmotionFrame | null {
    if (!(dt > 0) || !Number.isFinite(dt)) return null;
    this.entries.push({
      dt,
      speaking: frame.speaking,
      rmsDb: Number.isFinite(frame.rmsDb) ? frame.rmsDb : -100,
      energy: clamp01(frame.energy),
      voiced: frame.speaking && frame.pitchHz !== null,
      relativePitch: finite(frame.relativePitch),
      pitchVariation: finite(frame.pitchVariation),
      centroid: finite(frame.spectralCentroid),
    });
    this.windowTime += dt;
    while (this.entries.length > 1 && this.windowTime - this.entries[0]!.dt >= this.config.window) {
      this.windowTime -= this.entries.shift()!.dt;
    }
    this.modelAge += dt;
    this.sinceOutput += dt;
    if (this.sinceOutput < this.config.outputInterval) return null;
    const step = this.sinceOutput;
    this.sinceOutput = 0;
    this.tick(step);
    return this.frame();
  }

  reset(): void {
    this.entries = [];
    this.windowTime = 0;
    this.sinceOutput = 0;
    this.isActive = false;
    this.model = null;
    this.modelAge = Infinity;
    this.baseMean = this.baseVar = this.baseTime = 0;
    for (const k of Object.keys(this.target) as Smoothed[]) this.target[k] = 0;
    Object.assign(this.out, NEUTRAL_EMOTION, { mode: this.modeValue });
    this.cuesValue = emptyCues();
  }

  // --- internals -------------------------------------------------------------------------------------------------

  private tick(dt: number): void {
    const c = this.config;
    const cues = this.analyseWindow();
    this.cuesValue = cues;

    // Activity with hysteresis: a cough doesn't switch it on, a breath doesn't switch it off.
    if (!this.isActive && cues.activeRatio >= c.activeOnRatio) this.isActive = true;
    else if (this.isActive && cues.activeRatio < c.activeOffRatio) this.isActive = false;
    this.out.active = this.isActive;
    this.out.mode = this.modeValue;

    if (this.isActive) {
      this.learnBaseline(cues.arousalAbsolute, dt * cues.activeRatio);
      let arousal = cues.arousalAbsolute;
      if (this.baseTime >= c.baselineWarmup) {
        const spread = Math.max(c.baselineMinSpread, Math.sqrt(this.baseVar));
        const relative = clamp01(0.5 + (cues.arousalAbsolute - this.baseMean) / (4 * spread));
        arousal = (1 - c.baselineWeight) * arousal + c.baselineWeight * relative;
      }
      let valence = cues.valence;
      let confidence = cues.confidence;
      let valenceConfidence = Math.min(c.heuristicValenceConfidence, confidence);
      const m = this.model !== null && this.modelAge <= c.modelMaxAge ? this.model : null;
      if (m) {
        const mc = clamp01(m.confidence);
        const w = c.modelArousalWeight * mc;
        arousal = (1 - w) * arousal + w * clamp01(m.arousal);
        // Prosody rules have next to no valence signal: a confident model takes it over.
        valence = (1 - mc) * valence + mc * clamp(m.valence, -1, 1);
        confidence = Math.max(confidence, mc * cues.activeRatio);
        valenceConfidence = Math.max(valenceConfidence, mc * cues.activeRatio);
      }
      this.setTarget('arousal', arousal);
      this.setTarget('valence', valence);
      this.setTarget('energy', cues.energy);
      this.setTarget('tension', cues.tension);
      this.setTarget('pitchLift', cues.pitchLift);
      this.setTarget('pitchVariation', cues.pitchVariation);
      this.setTarget('speechRate', cues.speechRate);
      this.setTarget('confidence', confidence);
      this.setTarget('valenceConfidence', Math.min(valenceConfidence, confidence));
    } else {
      // Silence: everything returns to neutral, slowly (silenceRelease), whatever the per-field release says.
      for (const k of Object.keys(this.target) as Smoothed[]) this.target[k] = 0;
    }

    const o = this.out;
    const active = this.isActive;
    const rel = (r: number) => (active ? r : c.silenceRelease);
    o.arousal = follow(o.arousal, this.target.arousal, dt, c.arousalAttack, rel(c.arousalRelease));
    o.valence = followSigned(o.valence, this.target.valence, dt, c.valenceAttack, rel(c.valenceRelease));
    o.energy = follow(o.energy, this.target.energy, dt, c.energyAttack, rel(c.energyRelease));
    o.tension = follow(o.tension, this.target.tension, dt, c.tensionAttack, rel(c.tensionRelease));
    o.pitchLift = followSigned(o.pitchLift, this.target.pitchLift, dt, c.pitchAttack, rel(c.pitchRelease));
    o.pitchVariation = follow(o.pitchVariation, this.target.pitchVariation, dt, c.pitchAttack, rel(c.pitchRelease));
    o.speechRate = follow(o.speechRate, this.target.speechRate, dt, c.pitchAttack, rel(c.pitchRelease));
    o.confidence = follow(o.confidence, this.target.confidence, dt, c.confidenceAttack, rel(c.confidenceRelease));
    o.valenceConfidence = Math.min(
      o.confidence,
      follow(o.valenceConfidence, this.target.valenceConfidence, dt, c.confidenceAttack, rel(c.confidenceRelease)),
    );
    for (const k of Object.keys(this.target) as Smoothed[]) {
      // Snap the tail of the decay to exactly neutral so consumers can tell "no influence" apart.
      if (!active && Math.abs(o[k]) < 0.01) o[k] = 0;
    }
    // Whatever the cues did, the contract's ranges hold.
    for (const k of ['arousal', 'energy', 'tension', 'pitchVariation', 'speechRate', 'confidence', 'valenceConfidence'] as const) {
      o[k] = clamp01(o[k]);
    }
    o.valence = clamp(o.valence, -1, 1);
    o.pitchLift = clamp(o.pitchLift, -1, 1);
  }

  /** Updates a target only when it moved by more than the hysteresis band. */
  private setTarget(key: Smoothed, value: number): void {
    const v = Number.isFinite(value) ? value : 0;
    if (Math.abs(v - this.target[key]) > this.config.hysteresis) this.target[key] = v;
  }

  private learnBaseline(value: number, dt: number): void {
    if (!(dt > 0)) return;
    const c = this.config;
    if (this.baseTime === 0) {
      this.baseMean = value;
      this.baseVar = 0;
    } else {
      // Faster while warming up (1/n-like), then the long time constant.
      const tau = Math.min(c.baselineAdaptation, Math.max(dt, this.baseTime));
      const a = 1 - Math.exp(-dt / tau);
      const d = value - this.baseMean;
      this.baseMean += a * d;
      this.baseVar = (1 - a) * (this.baseVar + a * d * d);
    }
    this.baseTime += dt;
  }

  private analyseWindow(): ProsodyCues {
    const c = this.config;
    const e = this.entries;
    let total = 0;
    let speech = 0;
    let voiced = 0;
    let energy = 0;
    let lift = 0;
    let variation = 0;
    let centroid = 0;
    let centroidTime = 0;
    let pauses = 0;
    let inPause = false;
    let seenSpeech = false;
    for (const x of e) {
      total += x.dt;
      if (x.speaking) {
        speech += x.dt;
        energy += x.energy * x.dt;
        if (x.centroid > 0) {
          centroid += x.centroid * x.dt;
          centroidTime += x.dt;
        }
        if (x.voiced) {
          voiced += x.dt;
          lift += x.relativePitch * x.dt;
          variation += x.pitchVariation * x.dt;
        }
        if (inPause) pauses++;
        inPause = false;
        seenSpeech = true;
      } else if (seenSpeech) {
        inPause = true;
      }
    }
    if (total <= 0 || speech <= 0) return { ...emptyCues(), activeRatio: 0 };

    const activeRatio = speech / total;
    const voicedRatio = voiced / speech;
    const meanEnergy = energy / speech;
    const pitchLift = voiced > 0 ? clamp(lift / voiced / c.pitchLiftRange, -1, 1) : 0;
    const pitchVariation = voiced > 0 ? clamp01(variation / voiced / c.pitchVariationRange) : 0;
    const speechRate = clamp01(this.syllables() / speech / c.speechRateMax);
    const brightness =
      centroidTime > 0 ? clamp01((centroid / centroidTime - c.centroidLowHz) / (c.centroidHighHz - c.centroidLowHz)) : 0;
    // Pause structure: gaps inside the window per second, 0–3/s mapped to [0, 1].
    const pauseRate = clamp01(pauses / total / 3);

    const w = c.arousalWeights;
    const arousalAbsolute = clamp01(
      w.energy * meanEnergy +
        w.pitchVariation * pitchVariation +
        w.speechRate * speechRate +
        w.brightness * brightness -
        w.pauses * pauseRate,
    );
    // Strain: a bright spectrum at high effort with flat intonation. A proxy, not a detector.
    const tension = clamp01(brightness * meanEnergy * 1.6 * (1 - 0.5 * pitchVariation));
    const vw = c.valenceWeights;
    const valence = clamp(
      vw.pitchLift * pitchLift +
        vw.pitchVariation * (pitchVariation - 0.3) +
        vw.speechRate * (speechRate - 0.4) -
        vw.tension * tension,
      -1,
      1,
    );
    const warm = 0.5 + 0.5 * Math.min(1, this.baseTime / c.baselineWarmup);
    const confidence =
      c.heuristicConfidence * Math.min(1, activeRatio / 0.5) * (0.5 + 0.5 * voicedRatio) * warm;
    return {
      activeRatio,
      voicedRatio,
      energy: meanEnergy,
      pitchLift,
      pitchVariation,
      speechRate,
      brightness,
      pauses: pauseRate,
      arousalAbsolute,
      tension,
      valence,
      confidence: clamp01(confidence),
    };
  }

  /** Energy peaks (syllable nuclei) inside speech in the window. */
  private syllables(): number {
    const e = this.entries;
    const prominence = this.config.syllableProminenceDb;
    let count = 0;
    let dip = Infinity;
    let rising = false;
    for (let i = 1; i < e.length; i++) {
      const prev = e[i - 1]!;
      const cur = e[i]!;
      if (!cur.speaking) {
        dip = Infinity;
        rising = false;
        continue;
      }
      if (cur.rmsDb < dip) dip = cur.rmsDb;
      if (cur.rmsDb > prev.rmsDb) rising = true;
      else if (rising && cur.rmsDb < prev.rmsDb) {
        // prev was a local maximum
        if (prev.rmsDb - dip >= prominence) {
          count++;
          dip = cur.rmsDb;
        }
        rising = false;
      }
    }
    return count;
  }
}

function emptyCues(): ProsodyCues {
  return {
    activeRatio: 0,
    voicedRatio: 0,
    energy: 0,
    pitchLift: 0,
    pitchVariation: 0,
    speechRate: 0,
    brightness: 0,
    pauses: 0,
    arousalAbsolute: 0,
    tension: 0,
    valence: 0,
    confidence: 0,
  };
}

/** One-pole follower with separate rise/fall time constants (same shape as lip sync's `follow`). */
function follow(current: number, target: number, dt: number, attack: number, release: number): number {
  if (!(dt > 0)) return current;
  const tau = target > current ? attack : release;
  if (!(tau > 0)) return target;
  return target + (current - target) * Math.exp(-dt / tau);
}

/** For signed values "attack" means moving away from 0, "release" moving towards it. */
function followSigned(current: number, target: number, dt: number, attack: number, release: number): number {
  if (!(dt > 0)) return current;
  const away = Math.abs(target) > Math.abs(current) && Math.sign(target) !== -Math.sign(current);
  const tau = away ? attack : release;
  if (!(tau > 0)) return target;
  return target + (current - target) * Math.exp(-dt / tau);
}

function finite(v: number): number {
  return Number.isFinite(v) ? v : 0;
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 0;
}

function clamp(v: number, min: number, max: number): number {
  return Number.isFinite(v) ? (v < min ? min : v > max ? max : v) : 0;
}
