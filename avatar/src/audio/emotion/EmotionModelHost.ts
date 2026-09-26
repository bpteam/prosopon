import type { AnalyzerMode } from './EmotionFrame';
import type { EmotionModel, EmotionModelLoader, EmotionModelSpec } from './EmotionModel';
import type { ProsodyEmotionAnalyzer } from './ProsodyEmotionAnalyzer';

export type ModelHostStatus = 'off' | 'loading' | 'ready' | 'failed';

interface Channel {
  analyzer: ProsodyEmotionAnalyzer;
  /** Ring of the last window of audio at the model's rate. */
  ring: Float32Array;
  pos: number;
  fill: number;
  /** Audio seconds since the last inference of this channel. */
  since: number;
  /** Linear resampler state: input rate, position of the next output sample in input samples, previous sample. */
  rate: number;
  t: number;
  prev: number;
}

export interface EmotionModelHostOptions {
  /** Inference failures in a row after which the model is dropped for good. */
  maxFailures?: number;
  /** A load that hasn't settled after this long counts as failed, ms (a runtime can hang instead of rejecting). */
  loadTimeoutMs?: number;
  /** An inference that hasn't settled after this long counts as a failure, ms. */
  inferTimeoutMs?: number;
  logger?: { warn(message: string): void };
}

/**
 * Runs ONE local emotion model for any number of voice channels (user, assistant tabs) and feeds each channel's
 * ProsodyEmotionAnalyzer. Audio arrives as short chunks at the model's rate and lives only in a per-channel ring
 * one window long.
 *
 * Failure policy: a model that doesn't load, has no usable backend, or keeps failing turns every channel to
 * 'fallback'; the analysers then run on prosody rules alone. Nothing propagates.
 */
export class EmotionModelHost {
  private model: EmotionModel | null = null;
  private statusValue: ModelHostStatus = 'off';
  private errorValue: string | null = null;
  private readonly channels = new Map<string, Channel>();
  private busy = false;
  private failures = 0;
  private inferences = 0;
  private disposed = false;
  private readonly windowSamples: number;
  private readonly maxFailures: number;
  private readonly loadTimeoutMs: number;
  private readonly inferTimeoutMs: number;
  private readonly logger: { warn(message: string): void };

  constructor(
    readonly spec: EmotionModelSpec,
    private readonly loader: EmotionModelLoader,
    options: EmotionModelHostOptions = {},
  ) {
    this.windowSamples = Math.max(1, Math.round(spec.sampleRate * spec.windowSeconds));
    this.maxFailures = options.maxFailures ?? 3;
    this.loadTimeoutMs = options.loadTimeoutMs ?? 30_000;
    this.inferTimeoutMs = options.inferTimeoutMs ?? 5_000;
    this.logger = options.logger ?? console;
  }

  get status(): ModelHostStatus {
    return this.statusValue;
  }

  get error(): string | null {
    return this.errorValue;
  }

  get inferenceCount(): number {
    return this.inferences;
  }

  /** Mode every attached analyser reports right now. */
  get mode(): AnalyzerMode {
    if (this.statusValue === 'failed') return 'fallback';
    if (this.statusValue === 'ready' && this.model) return this.model.backend === 'webgpu' ? 'ml-webgpu' : 'ml-wasm';
    return 'heuristic';
  }

  /** Loads the model once. Resolves (never rejects) with the resulting status. */
  async load(): Promise<ModelHostStatus> {
    if (this.statusValue !== 'off') return this.statusValue;
    this.statusValue = 'loading';
    try {
      const model = await withTimeout(this.loader(this.spec), this.loadTimeoutMs, 'load timed out', (late) => late.dispose());
      if (this.disposed) {
        model.dispose();
        return this.statusValue;
      }
      this.model = model;
      this.statusValue = 'ready';
    } catch (error) {
      this.fail(`model failed to load: ${describe(error)}`);
    }
    this.applyMode();
    return this.statusValue;
  }

  attach(id: string, analyzer: ProsodyEmotionAnalyzer): void {
    this.channels.set(id, {
      analyzer,
      ring: new Float32Array(this.windowSamples),
      pos: 0,
      fill: 0,
      since: 0,
      rate: this.spec.sampleRate,
      t: 0,
      prev: 0,
    });
    analyzer.setMode(this.mode);
  }

  detach(id: string): void {
    this.channels.delete(id);
  }

  /**
   * Audio for channel `id` at `rate` Hz (resampled linearly to spec.sampleRate). Starts an inference when that
   * channel is due and the model is idle.
   */
  pushAudio(id: string, samples: ArrayLike<number>, rate = this.spec.sampleRate): void {
    const ch = this.channels.get(id);
    if (!ch || this.statusValue === 'failed' || !(rate > 0)) return;
    if (rate !== ch.rate) {
      ch.rate = rate;
      ch.t = 0;
    }
    const ring = ch.ring;
    const step = rate / this.spec.sampleRate;
    const write = (v: number) => {
      ring[ch.pos] = v;
      ch.pos = (ch.pos + 1) % ring.length;
      if (ch.fill < ring.length) ch.fill++;
    };
    if (step === 1) {
      for (let i = 0; i < samples.length; i++) write(samples[i]!);
    } else {
      // Output sample k sits at input position t (relative to the chunk; −1 is the previous chunk's last sample).
      let t = ch.t;
      while (t < samples.length - 1) {
        const i = Math.floor(t);
        const a = i < 0 ? ch.prev : samples[i]!;
        const b = samples[i + 1]!;
        write(a + (b - a) * (t - i));
        t += step;
      }
      ch.t = t - samples.length;
      if (samples.length > 0) ch.prev = samples[samples.length - 1]!;
    }
    ch.since += samples.length / rate;
    if (this.statusValue !== 'ready' || this.busy) return;
    if (ch.fill < ring.length || ch.since < this.spec.inferInterval) return;
    // Silence is not worth a model run: the analyser is already returning to neutral.
    if (!ch.analyzer.value.active) return;
    ch.since = 0;
    void this.infer(id, ch);
  }

  dispose(): void {
    this.disposed = true;
    this.model?.dispose();
    this.model = null;
    this.channels.clear();
  }

  /** Installation smoke test: a deterministic 2-second silent waveform must load and produce finite dimensions. */
  async selfTest(): Promise<void> {
    if (this.statusValue !== 'ready' || !this.model) throw new Error(this.errorValue ?? 'model is not ready');
    const value = await withTimeout(this.model.infer(new Float32Array(this.windowSamples)), this.inferTimeoutMs, 'self-test timed out');
    if (!Number.isFinite(value.arousal) || !Number.isFinite(value.valence)) throw new Error('self-test returned non-finite output');
  }

  private async infer(id: string, ch: Channel): Promise<void> {
    const model = this.model;
    if (!model) return;
    this.busy = true;
    // Chronological copy of the ring; the ring keeps filling while the model runs.
    const window = new Float32Array(ch.ring.length);
    window.set(ch.ring.subarray(ch.pos), 0);
    window.set(ch.ring.subarray(0, ch.pos), ch.ring.length - ch.pos);
    try {
      const estimate = await withTimeout(model.infer(window), this.inferTimeoutMs, 'inference timed out');
      this.failures = 0;
      this.inferences++;
      if (this.channels.get(id) === ch) ch.analyzer.setModelEstimate(estimate);
    } catch (error) {
      this.failures++;
      this.logger.warn(`[emotion] inference failed (${this.failures}/${this.maxFailures}): ${describe(error)}`);
      if (this.failures >= this.maxFailures) {
        this.fail(`inference failed: ${describe(error)}`);
        this.applyMode();
      }
    } finally {
      this.busy = false;
    }
  }

  private fail(error: string): void {
    this.statusValue = 'failed';
    this.errorValue = error;
    this.model?.dispose();
    this.model = null;
    this.logger.warn(`[emotion] ${error}; continuing with prosody rules`);
  }

  private applyMode(): void {
    const mode = this.mode;
    for (const ch of this.channels.values()) ch.analyzer.setMode(mode);
  }
}

/** Rejects after `ms`; a result that arrives later is handed to `onLate` (to release it) and otherwise dropped. */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string, onLate?: (value: T) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      done = true;
      reject(new Error(message));
    }, ms);
    promise.then(
      (value) => {
        if (done) onLate?.(value);
        else {
          done = true;
          clearTimeout(timer);
          resolve(value);
        }
      },
      (error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
