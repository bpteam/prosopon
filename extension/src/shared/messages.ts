import { isLipSyncFrame, type LipSyncFrame } from '@avatar/audio/LipSyncFrame';

/**
 * Protocol between the service worker, the offscreen audio runtime and the content script.
 * Bump when a message changes shape: contexts of different versions (content scripts left over from before an
 * extension update) then ignore each other instead of misreading.
 */
export const PROTOCOL_VERSION = 1;

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
  /** SW → content. */
  | { type: 'tab:state'; state: ExtensionTabState; error?: string }
  /** Offscreen → content over LIPSYNC_PORT, 20–30 per second. */
  | { type: 'lipsync:frame'; frame: LipSyncFrame }
  /** Offscreen → content over LIPSYNC_PORT. */
  | { type: 'audio:status'; status: AudioStatus }
  /** Content → SW: a failure that doesn't stop the capture (the VRM failed to load, etc.). */
  | { type: 'extension:error'; error: string };

export type ExtensionMessage = ExtensionPayload & { v: typeof PROTOCOL_VERSION };
export type MessageType = ExtensionMessage['type'];
export type MessageOf<T extends MessageType> = Extract<ExtensionMessage, { type: T }>;

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
  'tab:state': (m) =>
    TAB_STATES.includes(m.state as ExtensionTabState) && (m.error === undefined || typeof m.error === 'string'),
  'lipsync:frame': (m) => isLipSyncFrame(m.frame),
  'audio:status': (m) => {
    const s = m.status as Record<string, unknown> | null;
    return !!s && typeof s === 'object' && (s.mode === 'amplitude' || s.mode === 'viseme') && typeof s.analyzer === 'string';
  },
  'extension:error': (m) => typeof m.error === 'string',
};

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

function isTabId(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
