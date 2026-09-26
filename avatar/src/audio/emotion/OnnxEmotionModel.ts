import type * as Ort from 'onnxruntime-web';
import { readEstimate, type EmotionModel, type EmotionModelLoader, type EmotionModelSpec, type ModelBackend } from './EmotionModel';

export interface OnnxLoaderOptions {
  /**
   * Where ONNX Runtime finds its WebAssembly binary (ort-wasm-simd-threaded.jsep.wasm). Extensions must point it at
   * a packaged file: the default resolves next to the bundle, and a CDN is not allowed.
   */
  wasmUrl?: string;
  /** Injected runtime (tests); imported lazily otherwise, so pages without a model never load ONNX Runtime. */
  ort?: typeof Ort;
  /** navigator.gpu probe; injected by tests. */
  hasWebGpu?: () => Promise<boolean>;
  logger?: { warn(message: string): void };
}

/**
 * ONNX Runtime Web loader: WebGPU when an adapter exists, WebAssembly otherwise. Any failure is thrown to the caller
 * (EmotionModelHost), which falls back to prosody rules; nothing here can break the avatar.
 */
export function onnxEmotionLoader(options: OnnxLoaderOptions = {}): EmotionModelLoader {
  return async (spec) => {
    // The default build: WebGPU (JSEP) + WASM in one glue, paired with ort-wasm-simd-threaded.jsep.wasm. Not
    // 'onnxruntime-web/webgpu', whose glue expects the asyncify binary and crashes against the JSEP one.
    const ort = options.ort ?? ((await import('onnxruntime-web')) as unknown as typeof Ort);
    if (options.wasmUrl) ort.env.wasm.wasmPaths = { wasm: options.wasmUrl };
    // Extension pages are not cross-origin isolated: no SharedArrayBuffer, so no threads.
    ort.env.wasm.numThreads = 1;
    ort.env.logLevel = 'error';

    const attempts: ModelBackend[] = [];
    if (spec.preferWebGpu !== false && (await (options.hasWebGpu ?? probeWebGpu)())) attempts.push('webgpu');
    attempts.push('wasm');
    let lastError: unknown = null;
    for (const backend of attempts) {
      try {
        const session = spec.data
          ? await ort.InferenceSession.create(new Uint8Array(spec.data), { executionProviders: [backend] })
          : await ort.InferenceSession.create(spec.url, { executionProviders: [backend] });
        return new OnnxEmotionModel(ort, session, spec, backend);
      } catch (error) {
        lastError = error;
        options.logger?.warn(`[emotion] ${backend} backend unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  };
}

async function probeWebGpu(): Promise<boolean> {
  const gpu = (globalThis.navigator as { gpu?: { requestAdapter(): Promise<unknown> } } | undefined)?.gpu;
  if (!gpu) return false;
  try {
    return (await gpu.requestAdapter()) != null;
  } catch {
    return false;
  }
}

class OnnxEmotionModel implements EmotionModel {
  private readonly inputName: string;
  private readonly outputName: string;
  private disposed = false;

  constructor(
    private readonly ort: typeof Ort,
    private readonly session: Ort.InferenceSession,
    private readonly spec: EmotionModelSpec,
    readonly backend: ModelBackend,
  ) {
    this.inputName = spec.inputName ?? session.inputNames[0]!;
    this.outputName = spec.outputName ?? session.outputNames[0]!;
  }

  async infer(samples: Float32Array) {
    if (this.disposed) throw new Error('model disposed');
    const input = new this.ort.Tensor('float32', samples, [1, samples.length]);
    const result = await this.session.run({ [this.inputName]: input });
    if (this.spec.outputNames) {
      const arousal = result[this.spec.outputNames.arousal];
      const valence = result[this.spec.outputNames.valence];
      if (!arousal || !valence) throw new Error('model has no arousal/valence outputs');
      const a = Number(((await arousal.getData()) as Float32Array)[0]);
      const v = Number(((await valence.getData()) as Float32Array)[0]);
      if (!Number.isFinite(a) || !Number.isFinite(v)) throw new Error('model returned non-finite output');
      return readEstimate(this.spec, [a, v]);
    }
    const output = result[this.outputName];
    if (!output) throw new Error(`model has no output "${this.outputName}"`);
    return readEstimate(this.spec, (await output.getData()) as Float32Array);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    void this.session.release().catch(() => {});
  }
}
