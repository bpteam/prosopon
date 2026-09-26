import { describe, expect, it } from 'vitest';
import { AudioInput } from '../../src/audio/AudioInput';

/** Just enough of WebAudio to observe routing: every connect() is recorded as "from→to". */
function fakeContext() {
  const edges = new Set<string>();
  let n = 0;
  const node = (name: string) => {
    const id = `${name}${n++}`;
    const self: any = {
      id,
      context: null,
      connect(to: any) {
        edges.add(`${id}→${to.id}`);
        return to;
      },
      disconnect(to?: any) {
        for (const e of [...edges]) if (e.startsWith(`${id}→`) && (!to || e === `${id}→${to.id}`)) edges.delete(e);
      },
    };
    return self;
  };
  const ctx: any = {
    state: 'running',
    destination: node('destination'),
    createAnalyser: () => Object.assign(node('analyser'), { fftSize: 1024, getFloatTimeDomainData: () => {} }),
    createMediaStreamSource: () => node('stream'),
    createDelay: () => Object.assign(node('delay'), { delayTime: { value: 0 } }),
    resume: async () => {},
    close: async () => {},
  };
  return { ctx: ctx as AudioContext, edges };
}

function fakeStream() {
  const track = new EventTarget();
  return { stream: { getAudioTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream, track };
}

describe('AudioInput.attachMediaStream', () => {
  it('analyses the stream and, with monitor, keeps it audible', async () => {
    const { ctx, edges } = fakeContext();
    const input = new AudioInput({ context: ctx });
    await input.attachMediaStream(fakeStream().stream, { monitor: true });
    expect(input.kind).toBe('stream');
    expect([...edges].sort()).toEqual(['stream2→analyser1', 'stream2→destination0'].sort());
  });

  it('without monitor only analyses (e.g. a stream that is already audible elsewhere)', async () => {
    const { ctx, edges } = fakeContext();
    const input = new AudioInput({ context: ctx });
    await input.attachMediaStream(fakeStream().stream);
    expect([...edges].some((e) => e.includes('destination'))).toBe(false);
  });

  it('monitorDelay delays only what is heard', async () => {
    const { ctx, edges } = fakeContext();
    const input = new AudioInput({ context: ctx });
    await input.attachMediaStream(fakeStream().stream, { monitor: true, monitorDelay: 0.08 });
    expect([...edges].sort()).toEqual(['delay3→destination0', 'stream2→analyser1', 'stream2→delay3'].sort());
  });

  it('stop() disconnects everything; the track ending stops the input', async () => {
    const { ctx, edges } = fakeContext();
    const input = new AudioInput({ context: ctx });
    const { stream, track } = fakeStream();
    await input.attachMediaStream(stream, { monitor: true });
    track.dispatchEvent(new Event('ended'));
    expect(input.kind).toBe('none');
    expect(edges.size).toBe(0);
  });

  it('rejects a stream without audio', async () => {
    const { ctx } = fakeContext();
    const input = new AudioInput({ context: ctx });
    const empty = { getAudioTracks: () => [], getTracks: () => [] } as unknown as MediaStream;
    await expect(input.attachMediaStream(empty)).rejects.toThrow(/no audio track/);
    expect(input.kind).toBe('none');
  });
});
