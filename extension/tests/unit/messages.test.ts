import { describe, expect, it } from 'vitest';
import { message, parseMessage, PROTOCOL_VERSION, type ExtensionPayload } from '../../src/shared/messages';

const frame = { active: true, volume: 0.4, visemes: { aa: 0.5, ih: 0, ou: 0.1, ee: 0, oh: 0 } };

describe('message protocol', () => {
  const valid: ExtensionPayload[] = [
    { type: 'capture:start', tabId: 7, streamId: 'abc' },
    { type: 'capture:stop', tabId: 7 },
    { type: 'capture:list' },
    { type: 'capture:ended', tabId: 7, reason: 'tab closed' },
    { type: 'tab:hello' },
    { type: 'tab:state', state: 'enabled' },
    { type: 'tab:state', state: 'error', error: 'denied' },
    { type: 'lipsync:frame', frame },
    { type: 'audio:status', status: { mode: 'viseme', analyzer: 'ready' } },
    { type: 'extension:error', error: 'VRM failed' },
  ];

  it.each(valid.map((p) => [p.type, p] as const))('accepts %s (also after structured cloning)', (_type, payload) => {
    const msg = message(payload);
    expect(msg.v).toBe(PROTOCOL_VERSION);
    expect(parseMessage(structuredClone(msg))).toEqual(msg);
  });

  it('rejects other protocol versions, unknown types and non-objects', () => {
    expect(parseMessage({ ...message({ type: 'tab:hello' }), v: PROTOCOL_VERSION + 1 })).toBeNull();
    expect(parseMessage({ type: 'tab:hello' })).toBeNull();
    expect(parseMessage({ v: PROTOCOL_VERSION, type: 'capture:pause' })).toBeNull();
    expect(parseMessage(null)).toBeNull();
    expect(parseMessage('capture:start')).toBeNull();
  });

  it('rejects malformed payloads', () => {
    const bad: unknown[] = [
      { type: 'capture:start', tabId: 7 },
      { type: 'capture:start', tabId: -1, streamId: 'x' },
      { type: 'capture:start', tabId: 1.5, streamId: 'x' },
      { type: 'capture:stop', tabId: '7' },
      { type: 'tab:state', state: 'paused' },
      { type: 'tab:state', state: 'error', error: 42 },
      { type: 'lipsync:frame', frame: { ...frame, volume: 3 } },
      { type: 'lipsync:frame', frame: { ...frame, visemes: { aa: 1 } } },
      { type: 'audio:status', status: { mode: 'phoneme', analyzer: 'ready' } },
      { type: 'extension:error' },
    ];
    for (const payload of bad) expect(parseMessage({ ...(payload as object), v: PROTOCOL_VERSION }), JSON.stringify(payload)).toBeNull();
  });
});

// Regression (US-005): the development analyser hook is part of the protocol, so a content script and an
// offscreen document of different builds can't half-understand it.
describe('debug:analyzer', () => {
  it('accepts the three analyser choices and rejects anything else', () => {
    for (const choice of ['headaudio', 'wlipsync', 'none'] as const) {
      expect(parseMessage(message({ type: 'debug:analyzer', choice }))?.type).toBe('debug:analyzer');
    }
    expect(parseMessage({ v: PROTOCOL_VERSION, type: 'debug:analyzer', choice: 'nope' })).toBeNull();
    expect(parseMessage({ v: PROTOCOL_VERSION, type: 'debug:analyzer' })).toBeNull();
  });
});

describe('user voice messages (US-005)', () => {
  const frame = { speaking: true, segmentDuration: 0.4, rmsDb: -30, noiseFloorDb: -60, energy: 0.5, pitchHz: 180, pitchConfidence: 0.9, relativePitch: 1.5, pitchVariation: 0.8 };

  it('accepts a UserVoiceFrame and mic statuses', () => {
    expect(parseMessage(message({ type: 'user:frame', frame }))).not.toBeNull();
    expect(parseMessage(message({ type: 'user:frame', frame: { ...frame, pitchHz: null } }))).not.toBeNull();
    expect(parseMessage(message({ type: 'user:status', status: { state: 'denied', error: 'x' } }))).not.toBeNull();
    expect(parseMessage(message({ type: 'mic:set', enabled: true }))).not.toBeNull();
  });

  it('rejects anything carrying audio: buffers, streams or extra fields in a frame', () => {
    for (const bad of [
      { ...frame, samples: new Float32Array(128) },
      { ...frame, pcm: new ArrayBuffer(256) },
      { ...frame, rmsDb: new Float32Array(1) },
      { ...frame, energy: 3 },
      new Float32Array(9),
    ]) {
      expect(parseMessage({ v: PROTOCOL_VERSION, type: 'user:frame', frame: bad })).toBeNull();
    }
    expect(parseMessage({ v: PROTOCOL_VERSION, type: 'user:status', status: { state: 'recording' } })).toBeNull();
    expect(parseMessage({ v: PROTOCOL_VERSION, type: 'mic:set', enabled: 'yes' })).toBeNull();
  });

  it('a frame serialises to plain JSON of the same shape (nothing lost or hidden in transport)', () => {
    expect(JSON.parse(JSON.stringify(frame))).toEqual(frame);
  });
});
