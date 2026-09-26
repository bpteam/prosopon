import type { EmotionModelSpec } from '@avatar/audio/emotion/EmotionModel';
import { EMOTION_MODEL, EMOTION_MODEL_KEY } from './EmotionModelManifest';
import { IndexedDbModelStorage } from './ModelStorage';

/** Reads only validated, opted-in model bytes; called lazily by the offscreen audio runtime. */
export async function installedEmotionModel(): Promise<{ spec: EmotionModelSpec; data: ArrayBuffer } | null> {
  const metadata = (await chrome.storage.local.get('emotionModelMetadata')).emotionModelMetadata as
    | { modelId?: string; revision?: string; sha256?: string; enabled?: boolean } | undefined;
  if (!metadata?.enabled || metadata.modelId !== EMOTION_MODEL.id || metadata.revision !== EMOTION_MODEL.modelRevision || metadata.sha256 !== EMOTION_MODEL.sha256) return null;
  const storage = new IndexedDbModelStorage();
  if (!(await storage.has(EMOTION_MODEL_KEY))) return null;
  return {
    data: await storage.read(EMOTION_MODEL_KEY),
    spec: { url: '', sampleRate: EMOTION_MODEL.sampleRate, windowSeconds: 2, inputName: EMOTION_MODEL.inputName,
      arousalIndex: 0, valenceIndex: 1, outputRange: [-1, 1], trust: 0.6, inferInterval: 0.25 },
  };
}
