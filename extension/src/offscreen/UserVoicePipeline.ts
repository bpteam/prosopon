import type { UserVoiceFrame } from '@avatar/audio/user/UserVoiceFrame';
import {
  USER_VOICE_PROCESSOR,
  type UserVoiceProcessorOptions,
  type UserVoiceWorkletCommand,
  type UserVoiceWorkletMessage,
} from '@avatar/audio/user/UserVoiceWorkletProtocol';
import { describeError, type MicInfo, type MicStatus } from '../shared/messages';

/**
 * The user's microphone, analysed and nothing else:
 *
 *   getUserMedia → MediaStreamSource → AudioWorkletNode(UserVoiceAnalyzer, 0 outputs)
 *
 * Its own AudioContext, never shared with the assistant capture, so the two signals meet only as frames. The
 * analysis node has no outputs at all, so there is no path from the mic to the speakers to get wrong. No audio is
 * kept: the worklet posts numbers, and stop() ends the track and closes the context.
 */

export const USER_MEDIA_CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    // Preferred for dynamics; a browser or device that ignores it is fine.
    autoGainControl: false,
  },
  video: false,
};

export interface UserVoicePipelineDeps {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  createContext(): AudioContext;
  /** URL of the built UserVoiceWorklet module. */
  workletUrl: string;
  frameRate: number;
  /**
   * Also receive the decimated audio in chunks of this many seconds (a local emotion model is configured). Read at
   * each start(); undefined: the worklet posts frames only.
   */
  pcmChunkSeconds?: () => number | undefined;
  onPcm?(samples: Float32Array, sampleRate: number): void;
  /** AudioWorkletNode constructor; injected by tests. */
  createNode?(ctx: AudioContext, name: string, options: AudioWorkletNodeOptions): AudioWorkletNode;
}

type Graph = {
  stream: MediaStream;
  ctx: AudioContext;
  source: MediaStreamAudioSourceNode | null;
  node: AudioWorkletNode | null;
  onEnded: () => void;
};

export class UserVoicePipeline {
  private statusValue: MicStatus = { state: 'off' };
  private graph: Graph | null = null;
  private generation = 0;
  private reachedDestination = false;

  constructor(
    private readonly deps: UserVoicePipelineDeps,
    private readonly onFrame: (frame: UserVoiceFrame) => void,
    private readonly onStatus: (status: MicStatus) => void,
  ) {}

  get status(): MicStatus {
    return this.statusValue;
  }

  get running(): boolean {
    return this.graph !== null;
  }

  get info(): MicInfo {
    const tracks = this.graph?.stream.getAudioTracks() ?? [];
    return {
      ...this.statusValue,
      liveTracks: tracks.filter((t) => t.readyState === 'live').length,
      pipelines: this.graph ? 1 : 0,
      analyserOutputs: this.graph?.node?.numberOfOutputs ?? null,
      reachedDestination: this.reachedDestination,
    };
  }

  /** Opens the mic and starts analysing. Idempotent while starting/on. Resolves with the settled status. */
  async start(): Promise<MicStatus> {
    if (this.graph || this.statusValue.state === 'starting') return this.statusValue;
    const generation = ++this.generation;
    this.setStatus({ state: 'starting' });
    let stream: MediaStream;
    try {
      stream = await this.deps.getUserMedia(USER_MEDIA_CONSTRAINTS);
    } catch (error) {
      if (generation !== this.generation) return this.statusValue;
      return this.setStatus(classify(error));
    }
    if (generation !== this.generation) {
      // stop() while the device was opening.
      for (const track of stream.getTracks()) track.stop();
      return this.statusValue;
    }
    const graph: Graph = { stream, ctx: this.deps.createContext(), source: null, node: null, onEnded: () => {} };
    this.graph = graph;
    try {
      await graph.ctx.audioWorklet.addModule(this.deps.workletUrl);
      if (generation !== this.generation) return this.statusValue;
      if (graph.ctx.state === 'suspended') await graph.ctx.resume();
      const createNode = this.deps.createNode ?? ((ctx, name, options) => new AudioWorkletNode(ctx, name, options));
      const node = createNode(graph.ctx, USER_VOICE_PROCESSOR, {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCount: 1,
        channelCountMode: 'explicit',
        processorOptions: {
          frameRate: this.deps.frameRate,
          pcmChunkSeconds: this.deps.pcmChunkSeconds?.(),
        } satisfies UserVoiceProcessorOptions,
      });
      node.port.onmessage = (event: MessageEvent<UserVoiceWorkletMessage>) => {
        if (this.graph !== graph) return;
        const msg = event.data;
        if (msg?.type === 'frame') this.onFrame(msg.frame);
        // Samples go to the in-document model only; they are never forwarded or stored.
        else if (msg?.type === 'pcm') this.deps.onPcm?.(msg.samples, msg.sampleRate);
      };
      graph.node = node;
      graph.source = graph.ctx.createMediaStreamSource(stream);
      this.link(graph, graph.source, node);
      graph.onEnded = () => {
        if (this.graph !== graph) return;
        this.teardown();
        this.setStatus({ state: 'unavailable', error: 'microphone disconnected' });
      };
      for (const track of stream.getAudioTracks()) track.addEventListener('ended', graph.onEnded);
      return this.setStatus({ state: 'on' });
    } catch (error) {
      if (generation !== this.generation) return this.statusValue;
      this.teardown();
      return this.setStatus({ state: 'error', error: describeError(error) });
    }
  }

  /** Ends the track, disconnects and closes everything; the analyser state (VAD, baseline) goes with it. */
  stop(): void {
    this.generation++;
    this.teardown();
    if (this.statusValue.state !== 'off') this.setStatus({ state: 'off' });
  }

  /** Every edge of the mic graph goes through here, so "never to the speakers" is checked, not assumed. */
  private link(graph: Graph, from: AudioNode, to: AudioNode): void {
    if (to === graph.ctx.destination) {
      this.reachedDestination = true;
      throw new Error('microphone must never be connected to the speakers');
    }
    from.connect(to);
  }

  private teardown(): void {
    const graph = this.graph;
    this.graph = null;
    if (!graph) return;
    for (const track of graph.stream.getTracks()) {
      track.removeEventListener('ended', graph.onEnded);
      track.stop();
    }
    graph.source?.disconnect();
    if (graph.node) {
      graph.node.port.onmessage = null;
      graph.node.port.postMessage({ type: 'stop' } satisfies UserVoiceWorkletCommand);
      graph.node.disconnect();
    }
    void graph.ctx.close().catch(() => {});
  }

  private setStatus(status: MicStatus): MicStatus {
    this.statusValue = status;
    this.onStatus(status);
    return status;
  }
}

function classify(error: unknown): MicStatus {
  const name = (error as { name?: string } | null)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return { state: 'denied', error: describeError(error) };
  if (name === 'NotFoundError' || name === 'NotReadableError' || name === 'OverconstrainedError' || name === 'AbortError') {
    return { state: 'unavailable', error: describeError(error) };
  }
  return { state: 'error', error: describeError(error) };
}
