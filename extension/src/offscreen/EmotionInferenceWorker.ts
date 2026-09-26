import { onnxEmotionLoader } from '@avatar/audio/emotion/OnnxEmotionModel';
import type { EmotionModel, EmotionModelSpec } from '@avatar/audio/emotion/EmotionModel';

type Init = { type: 'init'; spec: EmotionModelSpec; wasmUrl: string };
type Infer = { type: 'infer'; id: number; samples: Float32Array };
type Request = Init | Infer | { type: 'dispose' };

let model: EmotionModel | null = null;

self.onmessage = (event: MessageEvent<Request>) => {
  void handle(event.data);
};

async function handle(message: Request): Promise<void> {
  if (message.type === 'init') {
    try {
      model = await onnxEmotionLoader({ wasmUrl: message.wasmUrl })(message.spec);
      postMessage({ type: 'ready', backend: model.backend });
    } catch (error) {
      postMessage({ type: 'init-error', error: describe(error) });
    }
    return;
  }
  if (message.type === 'dispose') {
    model?.dispose();
    model = null;
    close();
    return;
  }
  try {
    if (!model) throw new Error('model is not ready');
    const value = await model.infer(message.samples);
    postMessage({ type: 'result', id: message.id, value });
  } catch (error) {
    postMessage({ type: 'error', id: message.id, error: describe(error) });
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
