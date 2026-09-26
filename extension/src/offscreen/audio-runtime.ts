import { AmplitudeLipSync } from '@avatar/audio/AmplitudeLipSync';
import { AudioInput } from '@avatar/audio/AudioInput';
import { sampleLipSyncFrame } from '@avatar/audio/LipSyncFrame';
import { VisemeAnalyzerHost, type AnalyzerChoice } from '@avatar/audio/VisemeAnalyzerHost';
import { VisemeLipSync } from '@avatar/audio/VisemeLipSync';
import { headAudioFactory } from '@avatar/audio/analyzers/HeadAudioAnalyzer';
import { wLipSyncFactory } from '@avatar/audio/analyzers/WLipSyncAnalyzer';
import {
  LIPSYNC_PORT,
  describeError,
  message,
  parseMessage,
  type CaptureListReply,
  type CaptureReply,
  type ExtensionPayload,
} from '../shared/messages';

/**
 * Offscreen audio runtime: tab capture → AudioInput → existing lip-sync pipeline → LipSyncFrame, streamed to the
 * tab's content script over a Port. The only extension context that touches audio; it knows nothing about the
 * avatar, three.js or ChatGPT's DOM.
 */

export const AUDIO_RUNTIME_CONFIG = {
  /** LipSyncFrames per second. The content script interpolates them to the display rate. */
  frameRate: 30,
  /** How often the diagnostics status is sent, seconds. */
  statusInterval: 0.5,
  analyzer: 'headaudio' as AnalyzerChoice,
  /**
   * Delay of what the user hears, seconds, to line the audio up with the mouth (analysis lags ~50–100 ms).
   * 0 by default: any value adds the same delay to ChatGPT's answers.
   */
  monitorDelay: 0,
};

const url = (path: string) => chrome.runtime.getURL(path);

const factories = {
  headaudio: headAudioFactory({
    workletUrl: url('lipsync/headaudio/headworklet.min.mjs'),
    modelUrl: url('lipsync/headaudio/model-en-mixed.bin'),
  }),
  wlipsync: wLipSyncFactory({
    profileUrl: url('lipsync/wlipsync/profile.bin'),
    // The package's single-file build loads its worklet from a data: URL, which extension CSP forbids.
    assets: { processorUrl: url('lipsync/wlipsync/audio-processor.js'), wasmUrl: url('lipsync/wlipsync/wlipsync.wasm') },
  }),
};

class CaptureSession {
  private readonly input = new AudioInput();
  private readonly lipSync = new VisemeLipSync(new AmplitudeLipSync(() => this.input.readRms()));
  private readonly host = new VisemeAnalyzerHost(this.input, this.lipSync, factories, AUDIO_RUNTIME_CONFIG.analyzer);
  private readonly ports = new Set<chrome.runtime.Port>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private last = 0;
  private sinceStatus = Infinity;
  private disposed = false;

  private constructor(
    readonly tabId: number,
    private readonly stream: MediaStream,
    private readonly onEnded: (session: CaptureSession, reason: string) => void,
  ) {}

  static async start(
    tabId: number,
    streamId: string,
    onEnded: (session: CaptureSession, reason: string) => void,
  ): Promise<CaptureSession> {
    // Chrome's legacy constraint syntax is the only way to open a tabCapture stream id.
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
      video: false,
    } as unknown as MediaStreamConstraints);
    const session = new CaptureSession(tabId, stream, onEnded);
    try {
      // monitor: tabCapture mutes the tab, so the captured audio is played from here instead.
      await session.input.attachMediaStream(stream, { monitor: true, monitorDelay: AUDIO_RUNTIME_CONFIG.monitorDelay });
    } catch (error) {
      session.dispose();
      throw error;
    }
    session.input.onKindChange((kind) => {
      if (kind === 'none' && !session.disposed) onEnded(session, 'tab audio capture ended');
    });
    session.startTicking();
    return session;
  }

  addPort(port: chrome.runtime.Port): void {
    this.ports.add(port);
    port.onDisconnect.addListener(() => this.ports.delete(port));
    this.sinceStatus = Infinity; // new listener: send the status right away
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.host.dispose();
    void this.input.dispose();
    for (const track of this.stream.getTracks()) track.stop();
    for (const port of this.ports) port.disconnect();
    this.ports.clear();
  }

  private startTicking(): void {
    // The document is hidden, so there's no requestAnimationFrame. Lip-sync smoothing integrates the real delta,
    // so timer jitter changes nothing but the frame spacing.
    this.last = performance.now();
    this.timer = setInterval(() => this.tick(), 1000 / AUDIO_RUNTIME_CONFIG.frameRate);
  }

  private tick(): void {
    const now = performance.now();
    const delta = Math.min((now - this.last) / 1000, 0.25);
    this.last = now;
    try {
      const frame = sampleLipSyncFrame(this.lipSync, delta);
      this.broadcast({ type: 'lipsync:frame', frame });
      this.sinceStatus += delta;
      if (this.sinceStatus >= AUDIO_RUNTIME_CONFIG.statusInterval) {
        this.sinceStatus = 0;
        this.broadcast({ type: 'audio:status', status: { mode: this.lipSync.mode, analyzer: this.host.status } });
      }
    } catch (error) {
      this.onEnded(this, `audio runtime failed: ${describeError(error)}`);
    }
  }

  private broadcast(payload: ExtensionPayload): void {
    if (this.ports.size === 0) return;
    const msg = message(payload);
    for (const port of this.ports) {
      try {
        port.postMessage(msg);
      } catch {
        this.ports.delete(port); // content script went away between disconnect events
      }
    }
  }
}

const sessions = new Map<number, CaptureSession>();
/** In-flight starts. A stop, or a newer start after a stop, replaces/removes the entry, which cancels the old one. */
const starting = new Map<number, { promise: Promise<CaptureReply> }>();

function endSession(session: CaptureSession, reason: string): void {
  if (sessions.get(session.tabId) !== session) return;
  sessions.delete(session.tabId);
  session.dispose();
  void chrome.runtime.sendMessage(message({ type: 'capture:ended', tabId: session.tabId, reason })).catch(() => {});
}

function start(tabId: number, streamId: string): Promise<CaptureReply> {
  if (sessions.has(tabId)) return Promise.resolve({ ok: true });
  const pending = starting.get(tabId);
  if (pending) return pending.promise;
  const entry = { promise: null as unknown as Promise<CaptureReply> };
  entry.promise = (async (): Promise<CaptureReply> => {
    try {
      const session = await CaptureSession.start(tabId, streamId, endSession);
      if (starting.get(tabId) !== entry) {
        // capture:stop arrived while starting.
        session.dispose();
        return { ok: false, error: 'stopped while starting' };
      }
      sessions.set(tabId, session);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: describeError(error) };
    } finally {
      if (starting.get(tabId) === entry) starting.delete(tabId);
    }
  })();
  starting.set(tabId, entry);
  return entry.promise;
}

function stop(tabId: number): CaptureReply {
  starting.delete(tabId);
  const session = sessions.get(tabId);
  sessions.delete(tabId);
  session?.dispose();
  return { ok: true };
}

chrome.runtime.onMessage.addListener((raw, _sender, sendResponse) => {
  const msg = parseMessage(raw);
  if (!msg) return;
  switch (msg.type) {
    case 'capture:start':
      void start(msg.tabId, msg.streamId).then(sendResponse);
      return true;
    case 'capture:stop':
      sendResponse(stop(msg.tabId));
      return;
    case 'capture:list':
      sendResponse({ tabIds: [...sessions.keys()] } satisfies CaptureListReply);
      return;
    default:
      return;
  }
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== LIPSYNC_PORT) return;
  const tabId = port.sender?.tab?.id;
  const session = tabId === undefined ? undefined : sessions.get(tabId);
  // Frames of one tab never go to another; a tab without a capture gets a closed port and asks the SW again.
  if (!session) port.disconnect();
  else session.addPort(port);
});
