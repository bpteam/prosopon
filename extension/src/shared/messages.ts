import { isLipSyncFrame, type LipSyncFrame } from '@avatar/audio/LipSyncFrame';
import { isUserVoiceFrame, type UserVoiceFrame } from '@avatar/audio/user/UserVoiceFrame';
import { EMOTION_CHANNELS, isEmotionFrame, type EmotionChannel, type EmotionFrame } from '@avatar/audio/emotion/EmotionFrame';

/**
 * Protocol between the service worker, the offscreen audio runtime and the content script.
 * Bump when a message changes shape: contexts of different versions (content scripts left over from before an
 * extension update) then ignore each other instead of misreading.
 */
export const PROTOCOL_VERSION = 5;

/** Port the content script opens to the offscreen document to receive lip-sync frames for its tab. */
export const LIPSYNC_PORT = 'prosopon:lipsync';

export type ExtensionTabState = 'disabled' | 'starting' | 'enabled' | 'error';

export const TAB_STATES: readonly ExtensionTabState[] = ['disabled', 'starting', 'enabled', 'error'];

/** Offscreen → content, a few times a second. For diagnostics only. */
export interface AudioStatus {
  mode: 'amplitude' | 'viseme';
  /** VisemeAnalyzerHost status: off, loading, ready, error: … */
  analyzer: string;
}

/**
 * Microphone reactions (the user's voice pipeline in the offscreen document):
 * off (not wanted, or no tab enabled) · starting · on · denied (no permission for the extension origin) ·
 * unavailable (no device, or the device went away) · error.
 */
export type MicState = 'off' | 'starting' | 'on' | 'denied' | 'unavailable' | 'error';

export const MIC_STATES: readonly MicState[] = ['off', 'starting', 'on', 'denied', 'unavailable', 'error'];

export interface MicStatus {
  state: MicState;
  error?: string;
}

/** Reply to mic:info (diagnostics and E2E). */
export interface MicInfo extends MicStatus {
  /** Live microphone tracks held by the offscreen document. */
  liveTracks: number;
  /** User voice pipelines alive (0 or 1). */
  pipelines: number;
  /** Outputs of the analysis node: 0 means the mic has no path to the speakers. */
  analyserOutputs: number | null;
  /** Whether anything from the mic graph was ever connected to AudioContext.destination. */
  reachedDestination: boolean;
}

/** Emotion analysis in the offscreen document (diagnostics). */
export interface EmotionStatus {
  /** off: no model configured (prosody rules) · loading · ready · failed (prosody rules as fallback). */
  model: 'off' | 'loading' | 'ready' | 'failed';
  mode: AnalyzerModeName;
  /** Model runs so far (all channels). */
  inferences: number;
  error?: string;
}
export type EmotionModelInstallStatus = 'not-installed' | 'downloading' | 'verifying' | 'initializing' | 'ready' | 'disabled' | 'error';
export interface EmotionModelInstallState {
  status: EmotionModelInstallStatus;
  downloaded?: number;
  error?: string;
  installed?: boolean;
  enabled?: boolean;
}
type AnalyzerModeName = EmotionFrame['mode'];

/** One AudioContext of the offscreen document (developer telemetry). */
export interface AudioContextTelemetry {
  id: 'assistant' | 'mic';
  state: string;
  sampleRate: number;
  /** AudioContext.baseLatency / outputLatency, ms (null where the browser doesn't report it). */
  baseLatencyMs: number | null;
  outputLatencyMs: number | null;
}

/**
 * Offscreen → content, 2 per second, only to a port that asked with dev:subscribe (Developer Mode on). Numbers
 * only: no audio.
 */
export interface DevTelemetry {
  contexts: AudioContextTelemetry[];
  /** Wall time of the last model inference, ms (null: no model or none yet). */
  emotionInferenceMs: number | null;
  emotionBackend: AnalyzerModeName;
  /** VisemeAnalyzerHost status of this tab's capture. */
  analyzer: string;
  /** Unmapped assistant level at the analyser, dBFS (null: silence/no input). */
  assistantRmsDb: number | null;
  /** The assistant's prosody feature worklet is attached. */
  featureWorklet: boolean;
  /** The microphone's worklet is running. */
  micWorklet: boolean;
}

/** Calibration recording channel (Developer Mode wizard): the assistant's tab audio or the user's microphone. */
export type CalibrationChannel = 'assistant' | 'user';

/** Largest text chunk of one calibration:file message, characters (bigger files are sent in parts). */
export const CALIBRATION_FILE_CHUNK = 4_000_000;

/** Reply to every calibration:* request, over the same port. `data` depends on the request (see CalibrationAudio). */
export interface CalibrationReply {
  requestId: number;
  ok: boolean;
  error?: string;
  data?: Record<string, unknown>;
}

/** Reply to calibration:bundle (export page): the built ZIP as a same-origin blob URL, or null when none exists. */
export interface CalibrationBundleInfo {
  name: string;
  url: string;
  bytes: number;
}

export type ExtensionPayload =
  /** SW → offscreen. Reply: CaptureReply. */
  | { type: 'capture:start'; tabId: number; streamId: string }
  /** SW → offscreen. Reply: CaptureReply. */
  | { type: 'capture:stop'; tabId: number }
  /** SW → offscreen, after the SW restarted. Reply: CaptureListReply. */
  | { type: 'capture:list' }
  /** Offscreen → SW: the capture ended by itself (tab closed, stream ended, audio runtime failed). */
  | { type: 'capture:ended'; tabId: number; reason: string }
  /** Content → SW on load. Reply: a tab:state message. */
  | { type: 'tab:hello' }
  /** Popup → service worker: enable/disable Prosopon for the active ChatGPT tab. */
  | { type: 'prosopon:toggle' }
  | { type: 'prosopon:status' }
  /** SW → content. */
  | { type: 'tab:state'; state: ExtensionTabState; error?: string }
  /** Offscreen → content over LIPSYNC_PORT, 20–30 per second. */
  | { type: 'lipsync:frame'; frame: LipSyncFrame }
  /** Offscreen → content over LIPSYNC_PORT. */
  | { type: 'audio:status'; status: AudioStatus }
  /** SW → offscreen: whether the user wants microphone reactions. Reply: MicStatus once settled. */
  | { type: 'mic:set'; enabled: boolean }
  /** SW → offscreen. Reply: MicInfo. */
  | { type: 'mic:info' }
  /** Permission page → SW: the extension origin was just granted the microphone. */
  | { type: 'mic:granted' }
  /** Popup/options ↔ service worker: consented local model management. */
  | { type: 'emotion:model-info' }
  | { type: 'emotion:model-install'; enable: boolean }
  | { type: 'emotion:model-cancel' }
  | { type: 'emotion:model-remove' }
  | { type: 'emotion:model-enable'; enabled: boolean }
  /** Service worker → offscreen: load the just-installed local artifact and run a deterministic smoke inference. */
  | { type: 'emotion:model-self-test' }
  | { type: 'emotion:model-deactivate' }
  /** Service worker → popup/offscreen: state of a binary model installation. */
  | { type: 'emotion:model-state'; state: EmotionModelInstallState }
  /** Offscreen → every enabled tab's content over LIPSYNC_PORT, ~25 per second while the mic is on. */
  | { type: 'user:frame'; frame: UserVoiceFrame }
  /** Offscreen → content over LIPSYNC_PORT, on change and to every new port. */
  | { type: 'user:status'; status: MicStatus }
  /**
   * Offscreen → content over LIPSYNC_PORT, ~8 per second per channel while it has audio: the assistant channel of
   * that tab, and the user channel (one microphone, sent to every enabled tab).
   */
  | { type: 'emotion:frame'; channel: EmotionChannel; frame: EmotionFrame }
  /** Offscreen → content over LIPSYNC_PORT, on change and to every new port. */
  | { type: 'emotion:status'; status: EmotionStatus }
  /**
   * Content → offscreen over LIPSYNC_PORT, development builds only: numeric ProsodyEmotionAnalyzer settings for
   * calibration (applied to both channels' analysers). Ignored by production builds.
   */
  | { type: 'debug:emotion-config'; config: Record<string, number> }
  /** Content → offscreen over LIPSYNC_PORT: send (or stop sending) dev:telemetry to this port (Developer Mode). */
  | { type: 'dev:subscribe'; enabled: boolean }
  /** Offscreen → content over LIPSYNC_PORT, 2 per second while subscribed. */
  | { type: 'dev:telemetry'; telemetry: DevTelemetry }
  /** Popup → content of the active tab: start/stop dragging the avatar into place. */
  | { type: 'ui:placement'; active: boolean }
  /** Popup → SW: the "Microphone reactions" opt-in. Reply: MicPreference. */
  | { type: 'mic:preference' }
  /** Popup → SW: set the opt-in (same as the toolbar context menu). Reply: MicPreference. */
  | { type: 'mic:set-preference'; enabled: boolean }
  /** Content → SW: a failure that doesn't stop the capture (the VRM failed to load, etc.). */
  | { type: 'extension:error'; error: string }
  /**
   * Content → offscreen over LIPSYNC_PORT, development builds only: switch the viseme analyser, or drop it with
   * 'none' to exercise the amplitude fallback against real audio. Ignored by production builds.
   */
  | { type: 'debug:analyzer'; choice: 'headaudio' | 'wlipsync' | 'none' }
  /**
   * Calibration wizard (Developer Mode), content → offscreen over LIPSYNC_PORT; each gets a calibration:reply.
   * Recording exists only between begin and discard/build: audio is kept in the offscreen document's memory, packed
   * into the ZIP there, and never crosses a context (only its blob URL does, to the export page).
   */
  | { type: 'calibration:begin'; requestId: number }
  | { type: 'calibration:record'; requestId: number; clipId: string; channel: CalibrationChannel; action: 'start' | 'stop' }
  /** A text file of the bundle (trace, results, reports), in parts of at most CALIBRATION_FILE_CHUNK characters. */
  | { type: 'calibration:file'; requestId: number; name: string; text: string; append: boolean }
  | { type: 'calibration:build'; requestId: number; fileName: string }
  /** Drops every recording and any built bundle. Also sent by the export page (no port: requestId 0). */
  | { type: 'calibration:discard'; requestId: number }
  /** Offscreen → content over LIPSYNC_PORT. */
  | { type: 'calibration:reply'; reply: CalibrationReply }
  /** Content → SW: open the export page for the built bundle. */
  | { type: 'calibration:open-export' }
  /** Export page → offscreen. Reply: CalibrationBundleInfo | null. */
  | { type: 'calibration:bundle' };

export type ExtensionMessage = ExtensionPayload & { v: typeof PROTOCOL_VERSION };
export type MessageType = ExtensionMessage['type'];
export type MessageOf<T extends MessageType> = Extract<ExtensionMessage, { type: T }>;

/** Reply to mic:preference / mic:set-preference. */
export interface MicPreference {
  enabled: boolean;
  /** Offscreen pipeline status when a tab is enabled; null otherwise. */
  status: MicStatus | null;
}

export type CaptureReply = { ok: true } | { ok: false; error: string };
export interface CaptureListReply {
  tabIds: number[];
}

/** Stamps the protocol version on a payload. */
export function message<P extends ExtensionPayload>(payload: P): P & { v: typeof PROTOCOL_VERSION } {
  return { ...payload, v: PROTOCOL_VERSION };
}

type Validator = (m: Record<string, unknown>) => boolean;

const VALIDATORS: Record<MessageType, Validator> = {
  'capture:start': (m) => isTabId(m.tabId) && typeof m.streamId === 'string' && m.streamId.length > 0,
  'capture:stop': (m) => isTabId(m.tabId),
  'capture:list': () => true,
  'capture:ended': (m) => isTabId(m.tabId) && typeof m.reason === 'string',
  'tab:hello': () => true,
  'prosopon:toggle': () => true,
  'prosopon:status': () => true,
  'tab:state': (m) =>
    TAB_STATES.includes(m.state as ExtensionTabState) && (m.error === undefined || typeof m.error === 'string'),
  'lipsync:frame': (m) => isLipSyncFrame(m.frame),
  'audio:status': (m) => {
    const s = m.status as Record<string, unknown> | null;
    return !!s && typeof s === 'object' && (s.mode === 'amplitude' || s.mode === 'viseme') && typeof s.analyzer === 'string';
  },
  'mic:set': (m) => typeof m.enabled === 'boolean',
  'mic:info': () => true,
  'mic:granted': () => true,
  'emotion:model-info': () => true,
  'emotion:model-install': (m) => typeof m.enable === 'boolean',
  'emotion:model-cancel': () => true,
  'emotion:model-remove': () => true,
  'emotion:model-enable': (m) => typeof m.enabled === 'boolean',
  'emotion:model-self-test': () => true,
  'emotion:model-deactivate': () => true,
  'emotion:model-state': (m) => isEmotionModelInstallState(m.state),
  'user:frame': (m) => isUserVoiceFrame(m.frame),
  'user:status': (m) => isMicStatus(m.status),
  'extension:error': (m) => typeof m.error === 'string',
  'debug:analyzer': (m) => m.choice === 'headaudio' || m.choice === 'wlipsync' || m.choice === 'none',
  'calibration:begin': (m) => isRequestId(m.requestId),
  'calibration:record': (m) =>
    isRequestId(m.requestId) &&
    typeof m.clipId === 'string' &&
    isClipId(m.clipId) &&
    (m.channel === 'assistant' || m.channel === 'user') &&
    (m.action === 'start' || m.action === 'stop'),
  'calibration:file': (m) =>
    isRequestId(m.requestId) &&
    isBundlePath(m.name) &&
    typeof m.text === 'string' &&
    m.text.length <= CALIBRATION_FILE_CHUNK &&
    typeof m.append === 'boolean',
  'calibration:build': (m) => isRequestId(m.requestId) && typeof m.fileName === 'string' && /^[\w.-]{1,120}\.zip$/.test(m.fileName),
  'calibration:discard': (m) => isRequestId(m.requestId),
  'calibration:reply': (m) => {
    const r = m.reply as Record<string, unknown> | null;
    return (
      !!r &&
      typeof r === 'object' &&
      isRequestId(r.requestId) &&
      typeof r.ok === 'boolean' &&
      (r.error === undefined || typeof r.error === 'string') &&
      (r.data === undefined || (!!r.data && typeof r.data === 'object' && !Array.isArray(r.data)))
    );
  },
  'calibration:open-export': () => true,
  'calibration:bundle': () => true,
  'emotion:frame': (m) => EMOTION_CHANNELS.includes(m.channel as EmotionChannel) && isEmotionFrame(m.frame),
  'emotion:status': (m) => isEmotionStatus(m.status),
  'dev:subscribe': (m) => typeof m.enabled === 'boolean',
  'dev:telemetry': (m) => isDevTelemetry(m.telemetry),
  'ui:placement': (m) => typeof m.active === 'boolean',
  'mic:preference': () => true,
  'mic:set-preference': (m) => typeof m.enabled === 'boolean',
  'debug:emotion-config': (m) => {
    const c = m.config as Record<string, unknown> | null;
    if (!c || typeof c !== 'object' || Array.isArray(c)) return false;
    const entries = Object.entries(c);
    return entries.length <= 64 && entries.every(([k, v]) => /^[a-zA-Z]{1,40}$/.test(k) && typeof v === 'number' && Number.isFinite(v));
  },
};

const MODEL_STATES: readonly EmotionStatus['model'][] = ['off', 'loading', 'ready', 'failed'];
const MODES: readonly AnalyzerModeName[] = ['heuristic', 'ml-webgpu', 'ml-wasm', 'fallback'];

export function isEmotionStatus(raw: unknown): raw is EmotionStatus {
  if (!raw || typeof raw !== 'object') return false;
  const s = raw as Record<string, unknown>;
  return (
    MODEL_STATES.includes(s.model as EmotionStatus['model']) &&
    MODES.includes(s.mode as AnalyzerModeName) &&
    typeof s.inferences === 'number' &&
    Number.isInteger(s.inferences) &&
    s.inferences >= 0 &&
    (s.error === undefined || typeof s.error === 'string')
  );
}

const nullableNumber = (v: unknown) => v === null || (typeof v === 'number' && Number.isFinite(v));

export function isDevTelemetry(raw: unknown): raw is DevTelemetry {
  if (!raw || typeof raw !== 'object') return false;
  const t = raw as Record<string, unknown>;
  return (
    Array.isArray(t.contexts) &&
    t.contexts.length <= 4 &&
    t.contexts.every((c) => {
      const x = c as Record<string, unknown> | null;
      return !!x && (x.id === 'assistant' || x.id === 'mic') && typeof x.state === 'string' && typeof x.sampleRate === 'number' &&
        nullableNumber(x.baseLatencyMs) && nullableNumber(x.outputLatencyMs);
    }) &&
    nullableNumber(t.emotionInferenceMs) &&
    MODES.includes(t.emotionBackend as AnalyzerModeName) &&
    typeof t.analyzer === 'string' &&
    nullableNumber(t.assistantRmsDb) &&
    typeof t.featureWorklet === 'boolean' &&
    typeof t.micWorklet === 'boolean'
  );
}

export function isEmotionModelInstallState(raw: unknown): raw is EmotionModelInstallState {
  if (!raw || typeof raw !== 'object') return false;
  const s = raw as Record<string, unknown>;
  return ['not-installed', 'downloading', 'verifying', 'initializing', 'ready', 'disabled', 'error'].includes(s.status as string) &&
    (s.downloaded === undefined || (typeof s.downloaded === 'number' && s.downloaded >= 0)) &&
    (s.error === undefined || typeof s.error === 'string') &&
    (s.installed === undefined || typeof s.installed === 'boolean') && (s.enabled === undefined || typeof s.enabled === 'boolean');
}

/**
 * Validates a message received from another context. Returns null for anything that isn't ours or is of another
 * protocol version; never throws.
 */
export function parseMessage(raw: unknown): ExtensionMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (m.v !== PROTOCOL_VERSION || typeof m.type !== 'string') return null;
  const validate = VALIDATORS[m.type as MessageType] as Validator | undefined;
  return validate?.(m) ? (raw as ExtensionMessage) : null;
}

export function isCaptureReply(raw: unknown): raw is CaptureReply {
  if (!raw || typeof raw !== 'object') return false;
  const r = raw as Record<string, unknown>;
  return r.ok === true || (r.ok === false && typeof r.error === 'string');
}

export function isMicStatus(raw: unknown): raw is MicStatus {
  if (!raw || typeof raw !== 'object') return false;
  const s = raw as Record<string, unknown>;
  return MIC_STATES.includes(s.state as MicState) && (s.error === undefined || typeof s.error === 'string');
}

function isRequestId(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

/** A calibration clip id, e.g. "assistant/ru/ru.question.normal.retry1": becomes audio/<id>.wav in the bundle. */
export function isClipId(v: unknown): v is string {
  return typeof v === 'string' && v.length <= 120 && /^[\w-]+(\/[\w.-]+)*$/.test(v) && !v.split('/').includes('..');
}

/** A relative path inside the calibration bundle: no absolute paths, no "..", plain characters. */
export function isBundlePath(v: unknown): v is string {
  return typeof v === 'string' && /^[\w-]+(\/[\w.-]+)*\.(json|jsonl|md|wav)$/.test(v) && !v.split('/').includes('..') && v.length <= 160;
}

function isTabId(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
