import type { EmotionModel, EmotionModelLoader, EmotionModelSpec, ModelBackend } from '@avatar/audio/emotion/EmotionModel';
import type { ModelEstimate } from '@avatar/audio/emotion/ProsodyEmotionAnalyzer';

/** Loads and executes ONNX away from the offscreen document's audio/timer thread. */
export function workerEmotionLoader(wasmUrl: string): EmotionModelLoader {
  return async (spec) => WorkerEmotionModel.create(spec, wasmUrl);
}

class WorkerEmotionModel implements EmotionModel {
  private readonly pending = new Map<number, { resolve(value: ModelEstimate): void; reject(error: Error): void }>();
  private nextId = 1;
  private disposed = false;

  private constructor(private readonly worker: Worker, readonly backend: ModelBackend) {
    worker.addEventListener('message', (event: MessageEvent<WorkerReply>) => this.onMessage(event.data));
    worker.addEventListener('error', (event) => this.failAll(new Error(event.message || 'emotion worker failed')));
  }

  static async create(spec: EmotionModelSpec, wasmUrl: string): Promise<WorkerEmotionModel> {
    const worker = new Worker(new URL('./EmotionInferenceWorker.ts', import.meta.url), { type: 'module' });
    const ready = new Promise<ModelBackend>((resolve, reject) => {
      const onMessage = (event: MessageEvent<WorkerReply>) => {
        if (event.data.type === 'ready') {
          cleanup();
          resolve(event.data.backend);
        } else if (event.data.type === 'init-error') {
          cleanup();
          reject(new Error(event.data.error));
        }
      };
      const onError = (event: ErrorEvent) => {
        cleanup();
        reject(new Error(event.message || 'emotion worker failed to start'));
      };
      const cleanup = () => {
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
      };
      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onError);
    });
    const data = spec.data;
    worker.postMessage({ type: 'init', spec, wasmUrl }, data ? [data] : []);
    try {
      return new WorkerEmotionModel(worker, await ready);
    } catch (error) {
      worker.terminate();
      throw error;
    }
  }

  infer(samples: Float32Array): Promise<ModelEstimate> {
    if (this.disposed) return Promise.reject(new Error('model disposed'));
    const id = this.nextId++;
    return new Promise<ModelEstimate>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ type: 'infer', id, samples }, [samples.buffer]);
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.worker.postMessage({ type: 'dispose' });
    this.worker.terminate();
    this.failAll(new Error('model disposed'));
  }

  private onMessage(message: WorkerReply): void {
    if (message.type !== 'result' && message.type !== 'error') return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.type === 'result') pending.resolve(message.value);
    else pending.reject(new Error(message.error));
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

type WorkerReply =
  | { type: 'ready'; backend: ModelBackend }
  | { type: 'init-error'; error: string }
  | { type: 'result'; id: number; value: ModelEstimate }
  | { type: 'error'; id: number; error: string };
