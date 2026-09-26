// Contract only: imported by the offscreen document, the content script and the avatar side, so it stays
// dependency-free (no three.js, no Web Audio, no avatar imports).

/**
 * Where the valence/arousal of a frame came from:
 *  - heuristic: prosody rules only (no model configured);
 *  - ml-webgpu / ml-wasm: a local model on that ONNX Runtime backend, fused with the prosody rules;
 *  - fallback: a model was configured but failed (load, backend, inference); prosody rules only.
 */
export const ANALYZER_MODES = ['heuristic', 'ml-webgpu', 'ml-wasm', 'fallback'] as const;
export type AnalyzerMode = (typeof ANALYZER_MODES)[number];

/**
 * How one voice channel (the user's mic, or the assistant's audio) sounds right now, derived from audio only: no
 * transcript, no semantics. Smoothed by the analyser (EMA with attack/release), so consumers can apply it directly.
 */
export interface EmotionFrame {
  /** Speech is present on this channel (hysteresis over the VAD). */
  active: boolean;

  /** Pleasant (+1) … unpleasant (−1). Weakly observable from prosody alone: see valenceConfidence. */
  valence: number;
  /** Calm (0) … activated (1). */
  arousal: number;

  /** Loudness above the channel's noise floor, [0, 1]. */
  energy: number;
  /** Vocal effort/strain proxy (bright spectrum at high effort with flat intonation), [0, 1]. */
  tension: number;

  /** Pitch relative to the channel's baseline, [−1, 1] (±pitchLiftRange semitones). */
  pitchLift: number;
  /** Intonation liveliness, [0, 1] (0 = monotone). */
  pitchVariation: number;

  /** Trust in arousal/energy/tension, [0, 1]. Low right after the channel starts, on noise, or in silence. */
  confidence: number;

  // --- additional fields (allowed by the contract) ---

  /** Trust in valence specifically, [0, 1], ≤ confidence. Prosody rules cap it low; a model raises it. */
  valenceConfidence: number;
  /** Syllable-rate proxy, [0, 1] (≈ 0–8 energy peaks per second of speech). */
  speechRate: number;
  mode: AnalyzerMode;
}

export const NEUTRAL_EMOTION: Readonly<EmotionFrame> = Object.freeze({
  active: false,
  valence: 0,
  arousal: 0,
  energy: 0,
  tension: 0,
  pitchLift: 0,
  pitchVariation: 0,
  confidence: 0,
  valenceConfidence: 0,
  speechRate: 0,
  mode: 'heuristic',
});

export type EmotionChannel = 'user' | 'assistant';
export const EMOTION_CHANNELS: readonly EmotionChannel[] = ['user', 'assistant'];

const UNIT_FIELDS = [
  'arousal',
  'energy',
  'tension',
  'pitchVariation',
  'confidence',
  'valenceConfidence',
  'speechRate',
] as const satisfies readonly (keyof EmotionFrame)[];
const SIGNED_FIELDS = ['valence', 'pitchLift'] as const satisfies readonly (keyof EmotionFrame)[];
const KEYS: ReadonlySet<string> = new Set(['active', 'mode', ...UNIT_FIELDS, ...SIGNED_FIELDS]);

/** Structural check for frames received from another context: every field present, finite and in range. */
export function isEmotionFrame(value: unknown): value is EmotionFrame {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const f = value as Record<string, unknown>;
  if (typeof f.active !== 'boolean') return false;
  if (!(ANALYZER_MODES as readonly unknown[]).includes(f.mode)) return false;
  for (const k of UNIT_FIELDS) if (!inRange(f[k], 0, 1)) return false;
  for (const k of SIGNED_FIELDS) if (!inRange(f[k], -1, 1)) return false;
  return Object.keys(f).every((k) => KEYS.has(k));
}

/** Clamps every field into its range; NaN/±Infinity become the neutral value. */
export function sanitizeEmotionFrame(f: Readonly<EmotionFrame>, out: EmotionFrame = { ...NEUTRAL_EMOTION }): EmotionFrame {
  out.active = f.active === true;
  out.mode = (ANALYZER_MODES as readonly string[]).includes(f.mode) ? f.mode : 'heuristic';
  for (const k of UNIT_FIELDS) out[k] = clamp(f[k], 0, 1);
  for (const k of SIGNED_FIELDS) out[k] = clamp(f[k], -1, 1);
  if (out.valenceConfidence > out.confidence) out.valenceConfidence = out.confidence;
  return out;
}

function inRange(v: unknown, min: number, max: number): boolean {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
}

function clamp(v: number, min: number, max: number): number {
  return Number.isFinite(v) ? (v < min ? min : v > max ? max : v) : 0;
}
