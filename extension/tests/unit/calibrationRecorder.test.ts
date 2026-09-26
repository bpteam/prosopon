import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildZip, crc32, readZip } from '../../src/calibration/zip';
import { encodeWav, toInt16 } from '../../src/calibration/wav';
import { CalibrationRecorder, type RecorderTap } from '../../src/offscreen/CalibrationRecorder';

describe('zip', () => {
  it('crc32 matches the reference value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('round-trips stored and deflated entries with UTF-8 names', async () => {
    const big = new TextEncoder().encode('{"a":1}\n'.repeat(5000));
    const bin = new Uint8Array(1000).map((_, i) => (i * 37) & 255);
    const blob = await buildZip([
      { path: 'calibration/trace.jsonl', data: big, compress: true },
      { path: 'calibration/audio/assistant/ru/голос.wav', data: bin },
      { path: 'calibration/empty.json', data: new Uint8Array(0), compress: true },
    ]);
    expect(blob.size).toBeLessThan(big.length);
    const files = await readZip(blob);
    expect([...files.keys()]).toEqual(['calibration/trace.jsonl', 'calibration/audio/assistant/ru/голос.wav', 'calibration/empty.json']);
    expect(files.get('calibration/trace.jsonl')).toEqual(big);
    expect(files.get('calibration/audio/assistant/ru/голос.wav')).toEqual(bin);
    expect(files.get('calibration/empty.json')!.length).toBe(0);
  });
});

describe('wav', () => {
  it('writes a 16-bit mono RIFF header and clamps samples', () => {
    const pcm = toInt16([0, 1, -1, 2, -2, 0.5]);
    expect([...pcm]).toEqual([0, 32767, -32768, 32767, -32768, 16384]);
    const wav = encodeWav([pcm.subarray(0, 3), pcm.subarray(3)], 48000);
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    const ascii = (o: number) => String.fromCharCode(...wav.subarray(o, o + 4));
    expect(ascii(0)).toBe('RIFF');
    expect(ascii(8)).toBe('WAVE');
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(48000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(12);
    expect(wav.length).toBe(44 + 12);
    expect(view.getInt16(46, true)).toBe(32767);
  });
});

class FakeNode {
  static created: FakeNode[] = [];
  readonly port = { onmessage: null as ((e: MessageEvent) => void) | null, posted: [] as unknown[], postMessage(m: unknown) { this.posted.push(m); } };
  disconnected = false;
  constructor(readonly ctx: unknown, readonly name: string, readonly options: AudioWorkletNodeOptions) {
    FakeNode.created.push(this);
  }
  disconnect() {
    this.disconnected = true;
  }
  chunk(samples: number[]) {
    this.port.onmessage?.({ data: { type: 'chunk', samples: Float32Array.from(samples), sampleRate: 8000 } } as MessageEvent);
  }
}

function fakeTap(rate = 8000) {
  const ctx = { sampleRate: rate, audioWorklet: { addModule: vi.fn(async () => undefined) } } as unknown as BaseAudioContext;
  let connected = 0;
  const tap: RecorderTap = {
    context: () => ctx,
    connect: () => {
      connected++;
      return () => void connected--;
    },
  };
  return { tap, ctx, get connected() { return connected; } };
}

describe('CalibrationRecorder', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeNode.created = [];
  });

  function recorder() {
    vi.stubGlobal('AudioWorkletNode', FakeNode);
    const a = fakeTap();
    const u = fakeTap();
    const urls: string[] = [];
    const revoked: string[] = [];
    let n = 0;
    const r = new CalibrationRecorder({ assistant: a.tap, user: u.tap }, 'worklet.js', () => (n += 100), (b) => (urls.push(`blob:${b.size}`), urls.at(-1)!), (x) => void revoked.push(x));
    return { r, a, u, urls, revoked };
  }

  it('records only while a clip is open, into a record-only worklet, and packs WAVs, files and features', async () => {
    const { r, a, urls } = recorder();
    await r.startClip('assistant/ru/ru.question.normal', 'assistant');
    const node = FakeNode.created[0]!;
    expect(node.options.numberOfOutputs).toBe(0);
    expect(a.connected).toBe(1);
    node.chunk([0.5, -0.5, 0, 0]);
    r.pushFeatures('assistant', { rms: 0.1 } as never);
    r.stopClip('assistant/ru/ru.question.normal');
    node.chunk([1, 1, 1]); // after stop: dropped
    r.pushFeatures('assistant', { rms: 0.2 } as never); // after stop: dropped
    r.addFile('trace.jsonl', '{"t":1}\n', false);
    r.addFile('trace.jsonl', '{"t":2}\n', true);
    const built = await r.build('prosopon-calibration-sol-2026-09-26.zip');
    expect(built.url).toBe(urls[0]);
    expect(a.connected).toBe(0);
    expect(node.port.posted).toEqual([{ type: 'stop' }]);
    const files = await readZip((r as unknown as { bundle: { blob: Blob } }).bundle.blob);
    expect(new TextDecoder().decode(files.get('calibration/trace.jsonl'))).toBe('{"t":1}\n{"t":2}\n');
    expect(files.get('calibration/audio/assistant/ru/ru.question.normal.wav')!.length).toBe(44 + 8);
    const index = JSON.parse(new TextDecoder().decode(files.get('calibration/audio/index.json')));
    expect(index).toMatchObject([{ clipId: 'assistant/ru/ru.question.normal', channel: 'assistant', seconds: 4 / 8000 }]);
    expect(new TextDecoder().decode(files.get('calibration/features.jsonl')).trim().split('\n')).toHaveLength(1);
  });

  it('refuses the mic channel when the microphone is not running', async () => {
    vi.stubGlobal('AudioWorkletNode', FakeNode);
    const a = fakeTap();
    const r = new CalibrationRecorder({ assistant: a.tap, user: { context: () => null, connect: () => () => undefined } }, 'w.js');
    await expect(r.startClip('user/ru/x', 'user')).rejects.toThrow(/microphone/);
  });

  it('dispose drops everything, revokes the bundle and refuses further use', async () => {
    const { r, revoked } = recorder();
    await r.startClip('user/en/x', 'user');
    await r.build('x.zip');
    const url = r.built!.url;
    r.dispose();
    expect(revoked).toEqual([url]);
    expect(r.built).toBeNull();
    await expect(r.startClip('user/en/y', 'user')).rejects.toThrow(/ended/);
  });
});

describe('CalibrationRecorderWorklet', () => {
  it('keeps posting full chunks after the first one was transferred (detached)', async () => {
    let Processor: (new () => { process(inputs: Float32Array[][]): boolean; port: { onmessage: unknown } }) | null = null;
    const chunks: Float32Array[] = [];
    class FakeProcessor {
      readonly port = {
        onmessage: null as unknown,
        postMessage(msg: { samples: Float32Array }, transfer: Transferable[]) {
          // Like a real MessagePort: the sender's buffer is detached.
          chunks.push(structuredClone(msg, { transfer }).samples);
        },
      };
    }
    vi.stubGlobal('sampleRate', 400);
    vi.stubGlobal('AudioWorkletProcessor', FakeProcessor);
    vi.stubGlobal('registerProcessor', (_: string, ctor: typeof Processor) => void (Processor = ctor));
    vi.resetModules();
    await import('../../src/offscreen/CalibrationRecorderWorklet');
    const p = new Processor!();
    for (let i = 0; i < 10; i++) p.process([[new Float32Array(128).fill(0.1)]]);
    // 1280 samples in chunks of 100.
    expect(chunks).toHaveLength(12);
    expect(chunks.every((c) => c.length === 100)).toBe(true);
  });
});
