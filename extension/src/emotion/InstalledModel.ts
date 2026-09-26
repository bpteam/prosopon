import type { EmotionModelSpec } from '@avatar/audio/emotion/EmotionModel';
import { EMOTION_MODEL, EMOTION_MODEL_KEY } from './EmotionModelManifest';
import { IndexedDbModelStorage } from './ModelStorage';

const STORAGE_VISIBILITY_RETRIES = [0, 50, 150] as const;

/** Reads only validated, opted-in model bytes; called lazily by the offscreen audio runtime. */
export async function installedEmotionModel(allowPendingInstall = false): Promise<{ spec: EmotionModelSpec; data: ArrayBuffer } | null> {
  // Offscreen documents have runtime messaging but not the full chrome.storage API. The service worker owns the
  // metadata check; IndexedDB remains directly available here for the model bytes.
  const state = await chrome.runtime.sendMessage({ v: 3, type: 'emotion:model-info' }) as { installed?: boolean; enabled?: boolean };
  // A self-test is dispatched immediately after the service worker has
  // committed the Blob. It may arrive before that worker's public state is
  // observable in this context, so it is allowed to verify the local artifact
  // directly. Normal runtime loads remain gated by installed + enabled.
  if ((!state?.installed || !state.enabled) && !allowPendingInstall) return null;
  const storage = new IndexedDbModelStorage();
  // The service worker has just committed a large Blob before it asks the
  // offscreen document to self-test it. A different extension context can
  // observe that commit a turn later, so retry the read briefly rather than
  // treating a transient visibility delay as a missing installation.
  for (const delay of STORAGE_VISIBILITY_RETRIES) {
    if (delay) await new Promise<void>((resolve) => setTimeout(resolve, delay));
    if (await storage.has(EMOTION_MODEL_KEY)) {
      return {
        data: await storage.read(EMOTION_MODEL_KEY),
        spec: { url: '', sampleRate: EMOTION_MODEL.sampleRate, windowSeconds: 2, inputName: EMOTION_MODEL.inputName,
          arousalIndex: 0, valenceIndex: 1, outputRange: [-1, 1], trust: 0.6, inferInterval: 0.25,
          // The offscreen document also owns tab audio and lip sync. A GPU
          // driver reset here can take down that entire extension process, so
          // use the stable, single-threaded WASM backend for this local model.
          preferWebGpu: false },
      };
    }
  }
  throw new Error('Installed model was not found in local storage.');
}
