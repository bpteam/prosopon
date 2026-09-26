import { describe, expect, it, vi } from 'vitest';
import { SILENT_USER_VOICE_FRAME } from '@avatar/audio/user/UserVoiceFrame';
import { USER_MEDIA_CONSTRAINTS, UserVoicePipeline, type UserVoicePipelineDeps } from '../../src/offscreen/UserVoicePipeline';
import type { MicStatus } from '../../src/shared/messages';

/** Records every connect() in a fake Web Audio graph. */
function fakeAudio() {
  const edges: [string, string][] = [];
  const contexts: { closed: boolean }[] = [];
  const node = (label: string, extra: object = {}) => ({
    label,
    connect(to: { label: string }) {
      edges.push([label, to.label]);
      return to;
    },
    disconnect: vi.fn(),
    ...extra,
  });
  const createContext = () => {
    const ctx = {
      state: 'running',
      closed: false,
      destination: node('destination'),
      audioWorklet: { addModule: vi.fn(async () => {}) },
      createMediaStreamSource: () => node('mic'),
      close: vi.fn(async () => void (ctx.closed = true)),
      resume: vi.fn(async () => {}),
    };
    contexts.push(ctx);
    return ctx as unknown as AudioContext;
  };
  const workletNodes: { port: { onmessage: ((e: { data: unknown }) => void) | null; postMessage: ReturnType<typeof vi.fn> }; numberOfOutputs: number }[] = [];
  const createNode = (_ctx: AudioContext, _name: string, options: AudioWorkletNodeOptions) => {
    const n = node('analyser', {
      numberOfOutputs: options.numberOfOutputs ?? 1,
      port: { onmessage: null, postMessage: vi.fn() },
    }) as unknown as (typeof workletNodes)[number];
    workletNodes.push(n);
    return n as unknown as AudioWorkletNode;
  };
  return { edges, contexts, workletNodes, createContext, createNode };
}

function fakeStream() {
  const listeners = new Map<string, () => void>();
  const track = {
    readyState: 'live' as 'live' | 'ended',
    stop: vi.fn(() => void (track.readyState = 'ended')),
    addEventListener: (type: string, fn: () => void) => void listeners.set(type, fn),
    removeEventListener: (type: string) => void listeners.delete(type),
    end: () => {
      track.readyState = 'ended';
      listeners.get('ended')?.();
    },
  };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
  return { stream, track };
}

function setup(getUserMedia?: UserVoicePipelineDeps['getUserMedia']) {
  const audio = fakeAudio();
  const { stream, track } = fakeStream();
  const statuses: MicStatus[] = [];
  const frames: unknown[] = [];
  const gum = vi.fn(getUserMedia ?? (async () => stream));
  const pipeline = new UserVoicePipeline(
    { getUserMedia: gum, createContext: audio.createContext, createNode: audio.createNode, workletUrl: 'w.js', frameRate: 25 },
    (f) => void frames.push(f),
    (s) => void statuses.push(s),
  );
  return { pipeline, audio, track, statuses, frames, gum };
}

describe('UserVoicePipeline', () => {
  it('asks for the mic with the analysis constraints (AGC off, echo cancellation on)', async () => {
    const { pipeline, gum } = setup();
    await pipeline.start();
    expect(gum).toHaveBeenCalledWith(USER_MEDIA_CONSTRAINTS);
    expect(USER_MEDIA_CONSTRAINTS.audio).toMatchObject({ echoCancellation: true, noiseSuppression: true, autoGainControl: false });
  });

  it('the mic only feeds the analyser: never the speakers, and the analyser has no outputs', async () => {
    const { pipeline, audio } = setup();
    expect((await pipeline.start()).state).toBe('on');
    expect(audio.edges).toEqual([['mic', 'analyser']]);
    expect(audio.edges.some(([, to]) => to === 'destination')).toBe(false);
    expect(audio.workletNodes[0]!.numberOfOutputs).toBe(0);
    expect(pipeline.info).toMatchObject({ state: 'on', liveTracks: 1, pipelines: 1, analyserOutputs: 0, reachedDestination: false });
  });

  it('forwards worklet frames, and nothing after stop', async () => {
    const { pipeline, audio, frames } = setup();
    await pipeline.start();
    const port = audio.workletNodes[0]!.port;
    port.onmessage!({ data: { type: 'frame', frame: SILENT_USER_VOICE_FRAME } });
    expect(frames).toHaveLength(1);
    pipeline.stop();
    expect(port.onmessage).toBeNull();
  });

  it('start is idempotent: one stream, one context', async () => {
    const { pipeline, gum, audio } = setup();
    await Promise.all([pipeline.start(), pipeline.start()]);
    await pipeline.start();
    expect(gum).toHaveBeenCalledTimes(1);
    expect(audio.contexts).toHaveLength(1);
  });

  it('stop releases everything: track stopped, nodes disconnected, context closed, worklet told to stop', async () => {
    const { pipeline, audio, track, statuses } = setup();
    await pipeline.start();
    pipeline.stop();
    expect(track.stop).toHaveBeenCalled();
    expect(audio.contexts[0]!.closed).toBe(true);
    expect(audio.workletNodes[0]!.port.postMessage).toHaveBeenCalledWith({ type: 'stop' });
    expect(pipeline.info).toMatchObject({ state: 'off', liveTracks: 0, pipelines: 0 });
    expect(statuses.at(-1)).toEqual({ state: 'off' });
  });

  it('stop while the device is opening: the late stream is stopped at once', async () => {
    let resolve!: (s: MediaStream) => void;
    const { stream, track } = fakeStream();
    const { pipeline } = setup(() => new Promise((r) => (resolve = r)));
    const started = pipeline.start();
    pipeline.stop();
    resolve(stream);
    await started;
    expect(track.stop).toHaveBeenCalled();
    expect(pipeline.running).toBe(false);
  });

  it('permission denied → denied status, nothing held', async () => {
    const { pipeline } = setup(async () => {
      throw Object.assign(new Error('Permission dismissed'), { name: 'NotAllowedError' });
    });
    expect((await pipeline.start()).state).toBe('denied');
    expect(pipeline.info.pipelines).toBe(0);
  });

  it('no device → unavailable', async () => {
    const { pipeline } = setup(async () => {
      throw Object.assign(new Error('Requested device not found'), { name: 'NotFoundError' });
    });
    expect((await pipeline.start()).state).toBe('unavailable');
  });

  it('device lost (track ended) → unavailable and the graph is released', async () => {
    const { pipeline, track, audio } = setup();
    await pipeline.start();
    track.end();
    expect(pipeline.status).toEqual({ state: 'unavailable', error: 'microphone disconnected' });
    expect(audio.contexts[0]!.closed).toBe(true);
    expect(pipeline.running).toBe(false);
  });
});
