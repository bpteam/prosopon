/** Immutable, reviewable source of truth for the downloadable emotion model. */
export interface EmotionModelManifest {
  id: string;
  version: string;
  modelRevision: string;
  url: string;
  packagedPath: string;
  fileName: string;
  size: number;
  sha256: string;
  sampleRate: number;
  inputName: string;
  outputNames: { arousal: string; valence: string };
}

// The int8 artifact was introduced in this immutable Hugging Face commit. Its LFS SHA-256 is verified on install.
export const EMOTION_MODEL: Readonly<EmotionModelManifest> = {
  id: 'omote-ai/distilhubert-ser',
  version: '1',
  modelRevision: '6c4a6846578f718581e01883d01af7d174839123',
  url: 'https://huggingface.co/omote-ai/distilhubert-ser/resolve/6c4a6846578f718581e01883d01af7d174839123/distilhubert_ser_int8.onnx',
  packagedPath: 'emotion-model/distilhubert_ser_int8.onnx',
  fileName: 'distilhubert_ser_int8.onnx',
  size: 50_630_102,
  sha256: 'b3bd62c1d1e74983ce712458e25368dfe32d37b7fc20618f109fd0bfa49cfa97',
  sampleRate: 16_000,
  inputName: 'audio',
  outputNames: { arousal: 'arousal', valence: 'valence' },
};

export const EMOTION_MODEL_KEY = `${EMOTION_MODEL.id}@${EMOTION_MODEL.modelRevision}`;
