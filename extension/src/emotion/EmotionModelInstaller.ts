import { EMOTION_MODEL, EMOTION_MODEL_KEY, type EmotionModelManifest } from './EmotionModelManifest';
import type { ModelStorage } from './ModelStorage';

declare const __PROSOPON_EMBED_MODEL__: boolean;

export type EmotionModelStatus = 'not-installed' | 'downloading' | 'verifying' | 'initializing' | 'ready' | 'disabled' | 'error';
export interface EmotionInstallMetadata {
  modelId: string;
  revision: string;
  sha256: string;
  installedAt: number;
  enabled: boolean;
}
export interface EmotionInstallState { status: EmotionModelStatus; downloaded?: number; error?: string; metadata?: EmotionInstallMetadata }

const METADATA_KEY = 'emotionModelMetadata';

/** Network, integrity and binary persistence only; it has no dependency on audio or rendering. */
export class EmotionModelInstaller {
  private abort: AbortController | null = null;
  private state: EmotionInstallState = { status: 'not-installed' };

  constructor(private readonly storage: ModelStorage, private readonly onState: (state: EmotionInstallState) => void) {}
  get current(): EmotionInstallState { return this.state; }

  async restore(): Promise<EmotionInstallState> {
    const metadata = (await chrome.storage.local.get(METADATA_KEY))[METADATA_KEY] as EmotionInstallMetadata | undefined;
    if (metadata && metadata.modelId === EMOTION_MODEL.id && metadata.revision === EMOTION_MODEL.modelRevision &&
      metadata.sha256 === EMOTION_MODEL.sha256 && await this.storage.has(EMOTION_MODEL_KEY)) {
      return this.set({ status: metadata.enabled ? 'ready' : 'disabled', metadata });
    }
    if (metadata) await chrome.storage.local.remove(METADATA_KEY);
    return this.set({ status: 'not-installed' });
  }

  async install(enable = true): Promise<EmotionInstallState> {
    if (this.abort) return this.state;
    this.abort = new AbortController();
    try {
      this.set({ status: 'downloading', downloaded: 0 });
      const bytes = await this.download(EMOTION_MODEL, this.abort.signal);
      this.set({ status: 'verifying', downloaded: bytes.byteLength });
      if ((await sha256(bytes)) !== EMOTION_MODEL.sha256) throw new Error('Model integrity check failed.');
      await this.storage.write(EMOTION_MODEL_KEY, bytes);
      const metadata: EmotionInstallMetadata = { modelId: EMOTION_MODEL.id, revision: EMOTION_MODEL.modelRevision, sha256: EMOTION_MODEL.sha256, installedAt: Date.now(), enabled: enable };
      await chrome.storage.local.set({ [METADATA_KEY]: metadata });
      return this.set({ status: enable ? 'initializing' : 'disabled', metadata });
    } catch (error) {
      await this.storage.remove(EMOTION_MODEL_KEY).catch(() => {});
      await chrome.storage.local.remove(METADATA_KEY).catch(() => {});
      return this.set({ status: 'error', error: error instanceof Error ? error.message : String(error) });
    } finally { this.abort = null; }
  }

  cancel(): void { this.abort?.abort(); }
  async remove(): Promise<EmotionInstallState> {
    this.cancel();
    await this.storage.remove(EMOTION_MODEL_KEY).catch(() => {});
    await chrome.storage.local.remove(METADATA_KEY);
    return this.set({ status: 'not-installed' });
  }
  async setEnabled(enabled: boolean): Promise<EmotionInstallState> {
    const metadata = this.state.metadata;
    if (!metadata) return this.install(enabled);
    const next = { ...metadata, enabled };
    await chrome.storage.local.set({ [METADATA_KEY]: next });
    return this.set({ status: enabled ? 'initializing' : 'disabled', metadata: next });
  }
  markReady(): EmotionInstallState {
    return this.set({ status: 'ready', metadata: this.state.metadata });
  }
  async markRuntimeError(error: string): Promise<EmotionInstallState> {
    // Keep verified bytes and metadata so Retry can recover without another download.
    return this.set({ status: 'error', error, metadata: this.state.metadata });
  }

  private set(state: EmotionInstallState): EmotionInstallState { this.state = state; this.onState(state); return state; }
  private async download(model: EmotionModelManifest, signal: AbortSignal): Promise<ArrayBuffer> {
    const response = await fetch(__PROSOPON_EMBED_MODEL__ ? chrome.runtime.getURL(model.packagedPath) : model.url, { signal, redirect: 'follow' });
    if (!response.ok || !response.body) throw new Error(`Model download failed (${response.status})`);
    if (!__PROSOPON_EMBED_MODEL__ && !response.url.startsWith('https://')) throw new Error('Model download must use HTTPS');
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    for (;;) { const part = await reader.read(); if (part.done) break; chunks.push(part.value); size += part.value.byteLength; this.set({ status: 'downloading', downloaded: size }); }
    if (size !== model.size) throw new Error(`Model size mismatch (expected ${model.size} bytes, got ${size})`);
    const bytes = new Uint8Array(size); let at = 0;
    for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
    return bytes.buffer;
  }
}

async function sha256(data: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
