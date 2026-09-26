import type { ModelEstimate } from './ProsodyEmotionAnalyzer';

export type ModelBackend = 'webgpu' | 'wasm';

/**
 * How to read a speech-emotion model that takes raw audio and returns dimensional scores. Models publish no
 * calibrated confidence and different output layouts, so the layout and the trust are configuration.
 *
 * Example (unverified, check the model card): a wav2vec2/wav2small-style A/D/V regressor
 *   { url, sampleRate: 16000, windowSeconds: 2, arousalIndex: 0, valenceIndex: 2, outputRange: [0, 1], trust: 0.6 }
 */
export interface EmotionModelSpec {
  /** URL of the .onnx file (packaged or local). Nothing is fetched from the network by default. */
  url: string;
  /** Local model bytes, used by extension binary storage. Takes precedence over url. */
  data?: ArrayBuffer;
  /** Rate the model expects, Hz. The audio is fed at this rate. */
  sampleRate: number;
  /** Audio per inference, seconds. */
  windowSeconds: number;
  /** Input tensor name; the model's first input when omitted. Shape [1, samples], float32. */
  inputName?: string;
  /** Output tensor name; the model's first output when omitted. */
  outputName?: string;
  /** Separate named outputs for arousal and valence regressors. */
  outputNames?: { arousal: string; valence: string };
  arousalIndex: number;
  valenceIndex: number;
  /** Range of the raw outputs; mapped linearly to arousal [0, 1] and valence [−1, 1]. */
  outputRange: [number, number];
  /** How much this model is trusted at full speech coverage, [0, 1]. */
  trust: number;
  /** Seconds between inferences per channel while it is active. */
  inferInterval: number;
  /** Try WebGPU first (default true). */
  preferWebGpu?: boolean;
}

/** A loaded model. One instance serves both channels, one inference at a time. */
export interface EmotionModel {
  readonly backend: ModelBackend;
  /** @param samples mono audio at spec.sampleRate, exactly spec.windowSeconds long */
  infer(samples: Float32Array): Promise<ModelEstimate>;
  dispose(): void;
}

export type EmotionModelLoader = (spec: EmotionModelSpec) => Promise<EmotionModel>;

/** Maps a raw output vector to an estimate according to the spec. */
export function readEstimate(spec: EmotionModelSpec, raw: ArrayLike<number>): ModelEstimate {
  const [lo, hi] = spec.outputRange;
  const span = hi - lo || 1;
  const unit = (i: number) => {
    const v = (Number(raw[i]) - lo) / span;
    return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5;
  };
  const trust = Math.min(1, Math.max(0, spec.trust));
  return { arousal: unit(spec.arousalIndex), valence: unit(spec.valenceIndex) * 2 - 1, confidence: trust };
}

/**
 * Validates a model description (emotion-model/model.json next to the .onnx file) and resolves its file. Returns
 * null for anything off-spec. Shape: { file, sampleRate, windowSeconds, arousalIndex, valenceIndex, outputRange,
 * trust?, inferInterval?, inputName?, outputName?, preferWebGpu? }.
 */
export function parseModelSpec(raw: unknown, resolveUrl: (path: string) => string): EmotionModelSpec | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown, min: number, max: number) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
  if (typeof r.file !== 'string' || !/^[\w.-]+\.onnx$/.test(r.file)) return null;
  if (!num(r.sampleRate, 8000, 48000) || !num(r.windowSeconds, 0.25, 10)) return null;
  if (!num(r.arousalIndex, 0, 64) || !num(r.valenceIndex, 0, 64)) return null;
  const range = r.outputRange;
  if (!Array.isArray(range) || range.length !== 2 || !num(range[0], -1e3, 1e3) || !num(range[1], -1e3, 1e3)) return null;
  return {
    url: resolveUrl(r.file),
    sampleRate: r.sampleRate as number,
    windowSeconds: r.windowSeconds as number,
    inputName: typeof r.inputName === 'string' ? r.inputName : undefined,
    outputName: typeof r.outputName === 'string' ? r.outputName : undefined,
    arousalIndex: r.arousalIndex as number,
    valenceIndex: r.valenceIndex as number,
    outputRange: [range[0] as number, range[1] as number],
    trust: num(r.trust, 0, 1) ? (r.trust as number) : 0.5,
    inferInterval: num(r.inferInterval, 0.1, 10) ? (r.inferInterval as number) : 0.5,
    preferWebGpu: r.preferWebGpu !== false,
  };
}
