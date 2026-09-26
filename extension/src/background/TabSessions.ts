import { describeError, type ExtensionTabState } from '../shared/messages';

/** Browser side effects of the state machine. Implemented with chrome.* in the service worker, faked in tests. */
export interface CaptureBackend {
  /** chrome.tabCapture.getMediaStreamId for the tab. Needs a user gesture on the tab (action click). */
  getStreamId(tabId: number): Promise<string>;
  /** Makes sure the offscreen document exists and starts analysing the stream there. Rejects on failure. */
  startCapture(tabId: number, streamId: string): Promise<void>;
  /** Stops the tab's capture in the offscreen document, if there is one. Must not reject for an unknown tab. */
  stopCapture(tabId: number): Promise<void>;
  /** Called when no tab is enabled or starting any more: closes the offscreen document. */
  release(): Promise<void>;
}

export type StateListener = (tabId: number, state: ExtensionTabState, error?: string) => void;

interface Session {
  state: ExtensionTabState;
  error?: string;
  /** Bumped on every transition started by enable()/disable(), so a slow enable() can tell it was cancelled. */
  generation: number;
}

/**
 * Per-tab enable state. The only writer of ExtensionTabState; the service worker just routes events into it.
 *
 * enable() and disable() are idempotent: enabling a starting/enabled tab or disabling a disabled one is a no-op,
 * so repeated clicks, messages and navigations never start a second capture or stop twice.
 */
export class TabSessions {
  private readonly sessions = new Map<number, Session>();
  private readonly listeners = new Set<StateListener>();

  constructor(private readonly backend: CaptureBackend) {}

  get(tabId: number): { state: ExtensionTabState; error?: string } {
    const s = this.sessions.get(tabId);
    return s ? { state: s.state, error: s.error } : { state: 'disabled' };
  }

  /** Tabs that are enabled or starting. */
  get activeTabs(): number[] {
    return [...this.sessions].filter(([, s]) => isActive(s.state)).map(([id]) => id);
  }

  /** @returns unsubscribe */
  onChange(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  /** The action button: disable an active tab, (re-)enable anything else. */
  toggle(tabId: number): Promise<void> {
    return isActive(this.get(tabId).state) ? this.disable(tabId) : this.enable(tabId);
  }

  async enable(tabId: number): Promise<void> {
    const session = this.session(tabId);
    if (isActive(session.state)) return;
    const generation = ++session.generation;
    this.set(tabId, 'starting');
    try {
      const streamId = await this.backend.getStreamId(tabId);
      if (session.generation !== generation) return;
      await this.backend.startCapture(tabId, streamId);
      if (session.generation !== generation) {
        // Disabled while the capture was starting: the disable() already ran, undo what it couldn't see.
        await this.backend.stopCapture(tabId);
        await this.releaseIfIdle();
        return;
      }
      this.set(tabId, 'enabled');
    } catch (error) {
      if (session.generation !== generation) return;
      this.set(tabId, 'error', describeError(error));
      await this.backend.stopCapture(tabId).catch(() => {});
      await this.releaseIfIdle();
    }
  }

  async disable(tabId: number): Promise<void> {
    const session = this.sessions.get(tabId);
    if (!session || session.state === 'disabled') return;
    session.generation++;
    const wasActive = isActive(session.state);
    this.set(tabId, 'disabled');
    if (wasActive) await this.backend.stopCapture(tabId).catch(() => {});
    await this.releaseIfIdle();
  }

  /** The offscreen runtime reports that a capture ended without being asked to (tab muted, stream ended, crash). */
  async captureEnded(tabId: number, reason: string): Promise<void> {
    const session = this.sessions.get(tabId);
    if (!session || session.state !== 'enabled') return;
    session.generation++;
    this.set(tabId, 'error', reason);
    await this.releaseIfIdle();
  }

  /** Tab closed: forget it entirely. */
  async remove(tabId: number): Promise<void> {
    await this.disable(tabId);
    this.sessions.delete(tabId);
  }

  /** After a service worker restart: tabs the offscreen document still captures are enabled. */
  restore(tabIds: readonly number[]): void {
    for (const tabId of tabIds) {
      const session = this.session(tabId);
      if (session.state !== 'enabled') this.set(tabId, 'enabled');
    }
  }

  private session(tabId: number): Session {
    let s = this.sessions.get(tabId);
    if (!s) {
      s = { state: 'disabled', generation: 0 };
      this.sessions.set(tabId, s);
    }
    return s;
  }

  private set(tabId: number, state: ExtensionTabState, error?: string): void {
    const s = this.session(tabId);
    s.state = state;
    s.error = error;
    for (const listener of [...this.listeners]) listener(tabId, state, error);
  }

  private async releaseIfIdle(): Promise<void> {
    if (this.activeTabs.length === 0) await this.backend.release().catch(() => {});
  }
}

function isActive(state: ExtensionTabState): boolean {
  return state === 'starting' || state === 'enabled';
}
