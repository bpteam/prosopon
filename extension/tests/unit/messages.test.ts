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
