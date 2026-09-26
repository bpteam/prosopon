import { AmplitudeLipSync } from '@avatar/audio/AmplitudeLipSync';
import { AudioInput } from '@avatar/audio/AudioInput';
import { sampleLipSyncFrame } from '@avatar/audio/LipSyncFrame';
import { VisemeAnalyzerHost, type AnalyzerChoice } from '@avatar/audio/VisemeAnalyzerHost';
import { VisemeLipSync } from '@avatar/audio/VisemeLipSync';
import { headAudioFactory } from '@avatar/audio/analyzers/HeadAudioAnalyzer';
import { wLipSyncFactory } from '@avatar/audio/analyzers/WLipSyncAnalyzer';
import { EmotionModelHost } from '@avatar/audio/emotion/EmotionModelHost';
import {
  LIPSYNC_PORT,
  describeError,
  message,
  parseMessage,
  type AudioContextTelemetry,
  type CaptureListReply,
  type CaptureReply,
  type DevTelemetry,
  type EmotionStatus,
  type ExtensionPayload,
  type MicInfo,
  type MicStatus,
  type CalibrationReply,
} from '../shared/messages';
import { PCM_CHUNK_SECONDS, ProsodyChannel, attachFeatureWorklet } from './ProsodyChannel';
import { CalibrationRecorder, type RecorderTap } from './CalibrationRecorder';
import { DEFAULT_PROSODY_EMOTION_CONFIG } from '@avatar/audio/emotion/ProsodyEmotionAnalyzer';
import { UserVoicePipeline } from './UserVoicePipeline';
import { workerEmotionLoader } from './WorkerEmotionModel';

declare const __PROSOPON_ML__: boolean;

/**
 * Offscreen audio runtime, the only extension context that touches audio. Two independent pipelines:
 *
 *   assistant: tab capture → AudioInput ─┬─ existing lip-sync pipeline → LipSyncFrame, per tab
 *                                        └─ voice-feature worklet → ProsodyChannel → EmotionFrame ('assistant')
 *   user:      microphone → UserVoicePipeline (own AudioContext, worklet) → UserVoiceFrame ─┐, one for all tabs
 *                                                                        ProsodyChannel ◄──┘ → EmotionFrame ('user')
 *
 * Both channels run the same feature extractor and the same ProsodyEmotionAnalyzer class, each with its own
 * instance. An opted-in locally stored model serves both through one host.
 * They never share a node or a context; each only produces frames, streamed to the content scripts over their
 * Ports. Knows nothing about the avatar, three.js or ChatGPT's DOM.
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
  /** UserVoiceFrames per second (counted in audio time by the worklet); also the assistant's feature rate. */
  userFrameRate: 25,
  /** ONNX Runtime's WebAssembly binary (serves the WebGPU and the WASM backend). */
  ortWasmPath: 'ort/ort-wasm-simd-threaded.jsep.wasm',
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
  /** The assistant's voice channel of this tab. */
  readonly emotion: ProsodyChannel;
  private detachFeatures: (() => void) | null = null;
  /** Whether this capture's worklet must emit transient PCM chunks for the local model. */
  private modelPcm = false;
  private readonly lipSync = new VisemeLipSync(new AmplitudeLipSync(() => this.input.readRms()));
  private readonly host = new VisemeAnalyzerHost(this.input, this.lipSync, factories, AUDIO_RUNTIME_CONFIG.analyzer);
  private readonly ports = new Set<chrome.runtime.Port>();
  /** Ports of tabs in Developer Mode: they also get dev:telemetry. */
  private readonly telemetryPorts = new Set<chrome.runtime.Port>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private last = 0;
  private sinceStatus = Infinity;
  private disposed = false;

  private constructor(
    readonly tabId: number,
    private readonly stream: MediaStream,
    private readonly onEnded: (session: CaptureSession, reason: string) => void,
  ) {
    this.emotion = new ProsodyChannel(
      `assistant:${tabId}`,
      AUDIO_RUNTIME_CONFIG.userFrameRate,
      (frame) => this.broadcast({ type: 'emotion:frame', channel: 'assistant', frame }),
      emotionHost,
    );
    this.modelPcm = emotionHost !== null;
  }

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
    await session.startEmotion();
    return session;
  }

  /** Prosody of the assistant's voice. Optional: if it fails, lip sync and the avatar carry on without it. */
  private async startEmotion(): Promise<void> {
    const ctx = this.input.context;
    if (!ctx) return;
    try {
      const detach = await attachFeatureWorklet(
        ctx,
        url('worklets/user-voice.js'),
        (node) => this.input.addTap(node),
        { frameRate: AUDIO_RUNTIME_CONFIG.userFrameRate, pcm: this.modelPcm },
        (frame) => {
          this.emotion.pushFeatures(frame);
          if (calibration?.tabId === this.tabId) calibration.recorder.pushFeatures('assistant', frame);
        },
        (samples, rate) => this.emotion.pushPcm(samples, rate),
      );
      if (this.disposed) detach();
      else this.detachFeatures = detach;
    } catch (error) {
      console.warn('[prosopon] assistant prosody unavailable; lip sync continues:', error);
    }
  }

  /** Rebuild just the feature tap after a model became available after tab capture had already begun. */
  async enableEmotionPcm(): Promise<void> {
    if (this.disposed || this.modelPcm) return;
    this.modelPcm = true;
    this.detachFeatures?.();
    this.detachFeatures = null;
    await this.startEmotion();
  }

  /** Where the calibration recorder listens to this tab's audio. */
  readonly recorderTap: RecorderTap = {
    context: () => (this.disposed ? null : this.input.context),
    connect: (node) => this.input.addTap(node),
  };

  addPort(port: chrome.runtime.Port): void {
    this.ports.add(port);
    port.onDisconnect.addListener(() => {
      this.ports.delete(port);
      this.telemetryPorts.delete(port);
    });
    port.onMessage.addListener((raw) => {
      const msg = parseMessage(raw);
      if (msg?.type !== 'dev:subscribe') return;
      if (msg.enabled) this.telemetryPorts.add(port);
      else this.telemetryPorts.delete(port);
    });
    port.onMessage.addListener((raw) => {
      const msg = parseMessage(raw);
      if (!msg || !msg.type.startsWith('calibration:')) return;
      void handleCalibration(this, msg).then((reply) => this.send(port, { type: 'calibration:reply', reply }));
    });
    if (import.meta.env.DEV) {
      // Development only: lets a test drive the analyser (including turning it off) on a live capture.
      port.onMessage.addListener((raw) => {
        const msg = parseMessage(raw);
        if (msg?.type === 'debug:analyzer') this.host.select(msg.choice);
        if (msg?.type === 'debug:emotion-config') {
          this.emotion.applyConfig(msg.config);
          userEmotion.applyConfig(msg.config);
        }
      });
    }
    this.sinceStatus = Infinity; // new listener: send the status right away
    this.send(port, { type: 'user:status', status: userVoice.status });
    this.send(port, { type: 'emotion:status', status: emotionStatus });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // The tab's capture ends: so does its calibration (recordings and any built bundle are dropped).
    if (calibration?.tabId === this.tabId) discardCalibration();
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.detachFeatures?.();
    this.detachFeatures = null;
    this.emotion.dispose();
    this.host.dispose();
    void this.input.dispose();
    for (const track of this.stream.getTracks()) track.stop();
    for (const port of this.ports) port.disconnect();
    this.ports.clear();
    this.telemetryPorts.clear();
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
        this.broadcast({ type: 'emotion:status', status: refreshEmotionStatus() });
        if (this.telemetryPorts.size > 0) {
          const telemetry = this.telemetry();
          for (const port of this.telemetryPorts) this.send(port, { type: 'dev:telemetry', telemetry });
        }
      }
    } catch (error) {
      this.onEnded(this, `audio runtime failed: ${describeError(error)}`);
    }
  }

  /** Developer Mode only (a subscribed port): audio context state and latency, analyser and model status. */
  private telemetry(): DevTelemetry {
    const contexts: AudioContextTelemetry[] = [];
    const assistant = this.input.context;
    if (assistant) contexts.push(contextTelemetry('assistant', assistant));
    const mic = userVoice.context;
    if (mic) contexts.push(contextTelemetry('mic', mic));
    const rms = this.input.readRms();
    return {
      contexts,
      emotionInferenceMs: emotionHost?.lastInferenceMs ?? null,
      emotionBackend: emotionHost?.mode ?? emotionStatus.mode,
      analyzer: this.host.status,
      assistantRmsDb: rms > 0 ? 20 * Math.log10(rms) : null,
      featureWorklet: this.detachFeatures !== null,
      micWorklet: userVoice.running,
    };
  }

  /** Live settings of this tab's assistant analysis, for the calibration snapshot. */
  get analysisConfig(): Record<string, unknown> {
    return { analyzer: this.host.status, lipSyncMode: this.lipSync.mode, prosody: { ...this.emotion.analyzer.config } };
  }

  broadcast(payload: ExtensionPayload): void {
    if (this.ports.size === 0) return;
    for (const port of this.ports) this.send(port, payload);
  }

  private send(port: chrome.runtime.Port, payload: ExtensionPayload): void {
    try {
      port.postMessage(message(payload));
    } catch {
      this.ports.delete(port); // content script went away between disconnect events
    }
  }
}

const sessions = new Map<number, CaptureSession>();

// --- Calibration recording (Developer Mode wizard) ---------------------------------------------------------------

/** The one calibration session: recordings of one tab's audio (and the mic), alive until discarded. */
let calibration: { tabId: number; recorder: CalibrationRecorder } | null = null;

const micTap: RecorderTap = { context: () => userVoice.context, connect: (node) => userVoice.tap(node) };

type CalibrationRequest = Extract<ReturnType<typeof parseMessage> & object, { requestId: number }>;

async function handleCalibration(session: CaptureSession, msg: NonNullable<ReturnType<typeof parseMessage>>): Promise<CalibrationReply> {
  const requestId = (msg as CalibrationRequest).requestId ?? 0;
  try {
    switch (msg.type) {
      case 'calibration:begin': {
        calibration?.recorder.dispose();
        calibration = {
          tabId: session.tabId,
          recorder: new CalibrationRecorder({ assistant: session.recorderTap, user: micTap }, url('worklets/calibration-recorder.js')),
        };
        return {
          requestId,
          ok: true,
          data: {
            assistantSampleRate: calibration.recorder.sampleRate('assistant'),
            micSampleRate: calibration.recorder.sampleRate('user'),
            audioRuntime: { ...AUDIO_RUNTIME_CONFIG },
            assistantAnalysis: session.analysisConfig,
            userProsody: { ...userEmotion.analyzer.config },
            defaultProsody: { ...DEFAULT_PROSODY_EMOTION_CONFIG },
            emotion: refreshEmotionStatus(),
          },
        };
      }
      case 'calibration:record': {
        const recorder = ownRecorder(session);
        const data = msg.action === 'start' ? await recorder.startClip(msg.clipId, msg.channel) : recorder.stopClip(msg.clipId);
        return { requestId, ok: data !== null, data: data ? { ...data } : undefined, error: data ? undefined : 'unknown clip' };
      }
      case 'calibration:file':
        ownRecorder(session).addFile(msg.name, msg.text, msg.append);
        return { requestId, ok: true };
      case 'calibration:build': {
        const built = await ownRecorder(session).build(msg.fileName);
        return { requestId, ok: true, data: { name: built.name, bytes: built.bytes } };
      }
      case 'calibration:discard':
        discardCalibration();
        return { requestId, ok: true };
      default:
        return { requestId, ok: false, error: `unexpected ${msg.type}` };
    }
  } catch (error) {
    return { requestId, ok: false, error: describeError(error) };
  }
}

function ownRecorder(session: CaptureSession): CalibrationRecorder {
  if (!calibration || calibration.tabId !== session.tabId) throw new Error('no calibration session for this tab');
  return calibration.recorder;
}

function discardCalibration(): void {
  calibration?.recorder.dispose();
  calibration = null;
}

function contextTelemetry(id: AudioContextTelemetry['id'], ctx: AudioContext): AudioContextTelemetry {
  const ms = (s: number | undefined) => (typeof s === 'number' && Number.isFinite(s) ? s * 1000 : null);
  return { id, state: ctx.state, sampleRate: ctx.sampleRate, baseLatencyMs: ms(ctx.baseLatency), outputLatencyMs: ms(ctx.outputLatency) };
}

/** Optional local emotion model, shared by every channel; null = prosody rules only. */
let emotionHost: EmotionModelHost | null = null;
let emotionStatus: EmotionStatus = { model: 'off', mode: 'heuristic', inferences: 0 };
let emotionLoad: Promise<void> | null = null;

/** The user's voice channel: one for all tabs, like the microphone. */
const userEmotion = new ProsodyChannel('user', AUDIO_RUNTIME_CONFIG.userFrameRate, (frame) =>
  broadcastAll({ type: 'emotion:frame', channel: 'user', frame }),
);

/** One microphone for the whole browser: its frames go to every enabled tab. */
const userVoice = new UserVoicePipeline(
  {
    getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
    createContext: () => new AudioContext(),
    workletUrl: url('worklets/user-voice.js'),
    frameRate: AUDIO_RUNTIME_CONFIG.userFrameRate,
    pcmChunkSeconds: () => (emotionHost ? PCM_CHUNK_SECONDS : undefined),
    onPcm: (samples, rate) => userEmotion.pushPcm(samples, rate),
  },
  (frame) => {
    broadcastAll({ type: 'user:frame', frame });
    userEmotion.pushFeatures(frame);
    calibration?.recorder.pushFeatures('user', frame);
  },
  (status) => {
    if (status.state !== 'on') userEmotion.reset();
    broadcastAll({ type: 'user:status', status });
  },
);

function setEmotionStatus(status: EmotionStatus): void {
  emotionStatus = status;
  broadcastAll({ type: 'emotion:status', status });
}

/**
 * Reads an opted-in installed model only when the offscreen audio runtime exists.
 */
async function loadEmotionModel(allowPendingInstall = false): Promise<void> {
  if (emotionHost) return Promise.resolve();
  if (emotionLoad) {
    await emotionLoad;
    if (emotionHost || !allowPendingInstall) return;
  }
  emotionLoad = loadEmotionModelOnce(allowPendingInstall).finally(() => { emotionLoad = null; });
  return emotionLoad;
}

async function loadEmotionModelOnce(allowPendingInstall: boolean): Promise<void> {
  if (!__PROSOPON_ML__) return;
  try {
    const { installedEmotionModel } = await import('../emotion/InstalledModel');
    const installed = await installedEmotionModel(allowPendingInstall);
    if (!installed) return;
    const spec = { ...installed.spec, data: installed.data, outputNames: { arousal: 'arousal', valence: 'valence' } };
    const host = new EmotionModelHost(spec, workerEmotionLoader(url(AUDIO_RUNTIME_CONFIG.ortWasmPath)));
    emotionHost = host;
    userEmotion.attachHost(host);
    for (const session of sessions.values()) {
      session.emotion.attachHost(host);
      void session.enableEmotionPcm();
    }
    setEmotionStatus({ model: 'loading', mode: 'heuristic', inferences: 0 });
    await host.load();
    refreshEmotionStatus();
    // The microphone worklet chooses PCM output at creation. Restart only the local analysis graph when it was
    // already running, so it begins sending transient chunks to the newly ready local model.
    if (host.status === 'ready' && userVoice.running) {
      userVoice.stop();
      void syncMic();
    }
  } catch (error) {
    setEmotionStatus({ model: 'failed', mode: 'fallback', inferences: 0, error: `emotion model could not be initialized: ${describeError(error)}` });
  }
}

/** Current model status (inference count and failures change without events). */
function refreshEmotionStatus(): EmotionStatus {
  const host = emotionHost;
  if (!host) return emotionStatus;
  const model = host.status === 'ready' ? 'ready' : host.status === 'failed' ? 'failed' : 'loading';
  emotionStatus = { model, mode: host.mode, inferences: host.inferenceCount, error: host.error ?? undefined };
  return emotionStatus;
}
void loadEmotionModel();
async function selfTestEmotionModel(): Promise<{ ok: true } | { ok: false; error: string }> {
  // The service worker called this after a verified write; do not let a
  // delayed public installation-state message hide that fresh local artifact.
  await loadEmotionModel(true);
  try {
    if (!emotionHost) return { ok: false, error: emotionStatus.error ?? 'Installed model was not found in local storage.' };
    await emotionHost.selfTest();
    return { ok: true };
  }
  catch (error) { return { ok: false, error: describeError(error) }; }
}
function deactivateEmotionModel(): void {
  emotionHost?.dispose();
  emotionHost = null;
  userEmotion.attachHost(null);
  for (const session of sessions.values()) session.emotion.attachHost(null);
  setEmotionStatus({ model: 'off', mode: 'heuristic', inferences: 0 });
}
/** Set by the service worker from the user's opt-in; off until then. */
let micWanted = false;

function broadcastAll(payload: ExtensionPayload): void {
  for (const session of sessions.values()) session.broadcast(payload);
}

/** The mic track exists only while the user wants reactions AND at least one tab is enabled. */
function syncMic(): Promise<MicStatus> {
  if (micWanted && sessions.size > 0) return userVoice.start();
  userVoice.stop();
  return Promise.resolve(userVoice.status);
}
/** In-flight starts. A stop, or a newer start after a stop, replaces/removes the entry, which cancels the old one. */
const starting = new Map<number, { promise: Promise<CaptureReply> }>();

function endSession(session: CaptureSession, reason: string): void {
  if (sessions.get(session.tabId) !== session) return;
  sessions.delete(session.tabId);
  session.dispose();
  void syncMic();
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
      void syncMic();
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
  void syncMic();
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
    case 'mic:set':
      micWanted = msg.enabled;
      void syncMic().then(sendResponse);
      return true;
    case 'mic:info':
      sendResponse(userVoice.info satisfies MicInfo);
      return;
    case 'emotion:model-self-test':
      void selfTestEmotionModel().then(sendResponse);
      return true;
    case 'emotion:model-deactivate':
      deactivateEmotionModel();
      sendResponse({ ok: true });
      return;
    // The export page: the finished bundle's blob URL (same origin), or null. Audio itself never crosses.
    case 'calibration:bundle':
      sendResponse(calibration?.recorder.built ?? null);
      return;
    case 'calibration:discard':
      discardCalibration();
      sendResponse({ ok: true });
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
