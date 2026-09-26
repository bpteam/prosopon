import type { ExtensionMessage, ExtensionTabState } from '../shared/messages';
import type { AvatarRuntimeHandle } from './avatar-runtime';

export interface FrameLink {
  disconnect(): void;
}

export interface ContentLifecycleDeps {
  /** Loads and mounts the avatar runtime (dynamic import in the real content script). */
  mount(): Promise<AvatarRuntimeHandle>;
  /** Opens the lip-sync port to the offscreen document. */
  connect(onMessage: (msg: ExtensionMessage) => void, onDisconnect: () => void): FrameLink;
  /** Asks the service worker for this tab's state (tab:hello). Null when the extension is gone. */
  requestState(): Promise<{ state: ExtensionTabState; error?: string } | null>;
  /** False once the extension was reloaded/removed and this script is an orphan. */
  isExtensionAlive(): boolean;
  /** Reconnect scheduling; setTimeout in production. */
  schedule(fn: () => void, ms: number): void;
  onError?(error: unknown): void;
}

const RECONNECT_DELAY_MS = 300;
const MAX_RECONNECTS = 3;

/**
 * Content-script lifecycle for one tab: mounts the avatar runtime and the frame port while the tab is enabled,
 * tears both down otherwise. Idempotent: repeated enabled/disabled states, SPA navigations and duplicate messages
 * never create a second runtime or port.
 */
export class ContentLifecycle {
  private stateValue: ExtensionTabState = 'disabled';
  private runtime: AvatarRuntimeHandle | null = null;
  private mounting: Promise<void> | null = null;
  private link: FrameLink | null = null;
  private reconnects = 0;
  private disposed = false;
  /** Bumped by teardown, so a mount that resolves after a disable is discarded. */
  private generation = 0;

  constructor(private readonly deps: ContentLifecycleDeps) {}

  get state(): ExtensionTabState {
    return this.stateValue;
  }

  get mounted(): AvatarRuntimeHandle | null {
    return this.runtime;
  }

  get connected(): boolean {
    return this.link !== null;
  }

  async apply(state: ExtensionTabState, error?: string): Promise<void> {
    if (this.disposed) return;
    this.stateValue = state;
    if (state === 'enabled') {
      await this.ensureMounted();
      if (this.stateValue !== 'enabled' || this.disposed) return;
      this.runtime?.setExtensionState(state, error);
      this.ensureConnected();
    } else if (state === 'disabled' || state === 'error') {
      this.teardown();
    }
    // 'starting': keep whatever is there; the enabled/error state follows.
  }

  /** Final teardown (orphaned script, page unload). */
  dispose(): void {
    this.disposed = true;
    this.teardown();
  }

  private async ensureMounted(): Promise<void> {
    if (this.runtime) return;
    if (!this.mounting) {
      const generation = this.generation;
      this.mounting = this.deps
        .mount()
        .then((runtime) => {
          if (generation !== this.generation || this.disposed) runtime.dispose();
          else this.runtime = runtime;
        })
        .catch((error: unknown) => this.deps.onError?.(error))
        .finally(() => {
          this.mounting = null;
        });
    }
    await this.mounting;
  }

  private ensureConnected(): void {
    if (this.link || !this.runtime) return;
    const link = this.deps.connect(
      (msg) => this.onMessage(msg),
      () => this.onDisconnect(link),
    );
    this.link = link;
    this.runtime.setOffscreenConnected(true);
  }

  private onMessage(msg: ExtensionMessage): void {
    const runtime = this.runtime;
    if (!runtime) return;
    if (msg.type === 'lipsync:frame') {
      this.reconnects = 0;
      runtime.pushFrame(msg.frame);
    } else if (msg.type === 'audio:status') {
      runtime.setAudioStatus(msg.status);
    }
  }

  private onDisconnect(link: FrameLink): void {
    if (this.link !== link) return;
    this.link = null;
    this.runtime?.setOffscreenConnected(false);
    if (!this.deps.isExtensionAlive()) {
      // Extension reloaded or removed: this script is an orphan with a dead runtime API. Leave the page clean.
      this.dispose();
      return;
    }
    if (this.stateValue !== 'enabled' || this.reconnects >= MAX_RECONNECTS) return;
    this.reconnects++;
    // The offscreen document may be restarting, or the capture ended: ask the SW what the tab's state is now.
    this.deps.schedule(() => {
      void this.deps.requestState().then((s) => {
        if (s) void this.apply(s.state, s.error);
        else if (!this.deps.isExtensionAlive()) this.dispose();
      });
    }, RECONNECT_DELAY_MS);
  }

  private teardown(): void {
    this.generation++;
    this.link?.disconnect();
    this.link = null;
    this.runtime?.dispose();
    this.runtime = null;
    this.reconnects = 0;
  }
}
