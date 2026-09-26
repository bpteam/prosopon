import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmotionModelInstaller } from '../../src/emotion/EmotionModelInstaller';
import { EMOTION_MODEL, EMOTION_MODEL_KEY } from '../../src/emotion/EmotionModelManifest';
import type { ModelStorage } from '../../src/emotion/ModelStorage';

const METADATA_KEY = 'emotionModelMetadata';

afterEach(() => vi.unstubAllGlobals());

describe('EmotionModelInstaller', () => {
  it('clears stale metadata when IndexedDB no longer contains the installed binary', async () => {
    const local = {
      get: vi.fn(async () => ({
        [METADATA_KEY]: {
          modelId: EMOTION_MODEL.id,
          revision: EMOTION_MODEL.modelRevision,
          sha256: EMOTION_MODEL.sha256,
          installedAt: 1,
          enabled: true,
        },
      })),
      set: vi.fn(),
      remove: vi.fn(async () => {}),
    };
    vi.stubGlobal('chrome', { storage: { local } });
    const storage: ModelStorage = {
      has: vi.fn(async () => true),
      read: vi.fn(),
      write: vi.fn(),
      remove: vi.fn(async () => {}),
    };
    const installer = new EmotionModelInstaller(storage, () => {});
    await installer.restore();

    const result = await installer.markStorageMissing('Installed model was not found in local storage.');

    expect(storage.remove).toHaveBeenCalledWith(EMOTION_MODEL_KEY);
    expect(local.remove).toHaveBeenCalledWith(METADATA_KEY);
    expect(result).toEqual({ status: 'error', error: 'Installed model was not found in local storage.' });
  });
});
