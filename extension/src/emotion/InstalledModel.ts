import type { EmotionModelSpec } from '@avatar/audio/emotion/EmotionModel';
import { EMOTION_MODEL, EMOTION_MODEL_KEY } from './EmotionModelManifest';
import { IndexedDbModelStorage } from './ModelStorage';

/** Reads only validated, opted-in model bytes; called lazily by the offscreen audio runtime. */
export async function installedEmotionModel(): Promise<{ spec: EmotionModelSpec; data: ArrayBuffer } | null> {
  // Offscreen documents have runtime messaging but not the full chrome.storage API. The service worker owns the
  // metadata check; IndexedDB remains directly available here for the model bytes.
  const state = await chrome.runtime.sendMessage({ v: 3, type: 'emotion:model-info' }) as { installed?: boolean; enabled?: boolean };
  if (!state?.installed || !state.enabled) return null;
  const storage = new IndexedDbModelStorage();
  if (!(await storage.has(EMOTION_MODEL_KEY))) return null;
  return {
    data: await storage.read(EMOTION_MODEL_KEY),
    spec: { url: '', sampleRate: EMOTION_MODEL.sampleRate, windowSeconds: 2, inputName: EMOTION_MODEL.inputName,
      arousalIndex: 0, valenceIndex: 1, outputRange: [-1, 1], trust: 0.6, inferInterval: 0.25 },
  };
}
