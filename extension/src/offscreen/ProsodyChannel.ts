import type { EmotionFrame } from '@avatar/audio/emotion/EmotionFrame';
import type { EmotionModelHost } from '@avatar/audio/emotion/EmotionModelHost';
import { ProsodyEmotionAnalyzer, type ProsodyEmotionConfig } from '@avatar/audio/emotion/ProsodyEmotionAnalyzer';
import type { VoiceFeatureFrame } from '@avatar/audio/user/UserVoiceFrame';
import {
  USER_VOICE_PROCESSOR,
  type UserVoiceProcessorOptions,
  type UserVoiceWorkletCommand,
  type UserVoiceWorkletMessage,
} from '@avatar/audio/user/UserVoiceWorkletProtocol';

/**
 * One voice channel's emotion analysis in the offscreen document: feature frames (and, with a model, PCM chunks) in,
 * EmotionFrames out. The user's mic and each assistant tab get their own instance around their own
 * ProsodyEmotionAnalyzer; the only shared piece is the optional model host, which keeps channels apart by id.
 */
export class ProsodyChannel {
  readonly analyzer: ProsodyEmotionAnalyzer;
  private host: EmotionModelHost | null = null;
  private disposed = false;

  constructor(
    readonly id: string,
    /** Feature frames per second of audio: each frame covers 1/frameRate s. */
    private readonly frameRate: number,
    private readonly onEmotion: (frame: EmotionFrame) => void,
    host: EmotionModelHost | null = null,
    config: Partial<ProsodyEmotionConfig> = {},
  ) {
    this.analyzer = new ProsodyEmotionAnalyzer(config);
    this.attachHost(host);
  }

  /** Model host to contribute to this channel (it may be created after the channel). */
  attachHost(host: EmotionModelHost | null): void {
    if (this.disposed || host === this.host) return;
    this.host?.detach(this.id);
    this.host = host;
    host?.attach(this.id, this.analyzer);
  }

  pushFeatures(frame: VoiceFeatureFrame): void {
    if (this.disposed) return;
    const out = this.analyzer.push(frame, 1 / this.frameRate);
    if (out) this.onEmotion(out);
  }

  pushPcm(samples: Float32Array, sampleRate: number): void {
    if (!this.disposed) this.host?.pushAudio(this.id, samples, sampleRate);
  }

  /** Numeric analyser settings from the calibration hook (development builds). Unknown keys are ignored. */
  applyConfig(config: Record<string, number>): void {
    const target = this.analyzer.config as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(config)) if (typeof target[k] === 'number' && Number.isFinite(v)) target[k] = v;
  }

  reset(): void {
    this.analyzer.reset();
  }

  dispose(): void {
    this.disposed = true;
    this.host?.detach(this.id);
  }
}

/** Seconds of audio per PCM chunk the feature worklet posts when a model is configured. */
export const PCM_CHUNK_SECONDS = 0.1;

/**
 * The voice-feature worklet on another audio graph (the assistant's tab capture), fed through `connect` (e.g.
 * AudioInput.addTap). The same processor and analyser as the user's mic, so both channels' features are computed
 * the same way. 0 outputs: it only listens.
 */
export async function attachFeatureWorklet(
  ctx: BaseAudioContext,
  workletUrl: string,
  connect: (node: AudioNode) => () => void,
  options: { frameRate: number; pcm: boolean },
  onFrame: (frame: VoiceFeatureFrame) => void,
  onPcm: (samples: Float32Array, sampleRate: number) => void,
): Promise<() => void> {
  await ctx.audioWorklet.addModule(workletUrl);
  const node = new AudioWorkletNode(ctx, USER_VOICE_PROCESSOR, {
    numberOfInputs: 1,
    numberOfOutputs: 0,
    channelCount: 1,
    channelCountMode: 'explicit',
    processorOptions: {
      frameRate: options.frameRate,
      pcmChunkSeconds: options.pcm ? PCM_CHUNK_SECONDS : undefined,
    } satisfies UserVoiceProcessorOptions,
  });
  let alive = true;
  node.port.onmessage = (event: MessageEvent<UserVoiceWorkletMessage>) => {
    if (!alive) return;
    const msg = event.data;
    if (msg?.type === 'frame') onFrame(msg.frame);
    else if (msg?.type === 'pcm') onPcm(msg.samples, msg.sampleRate);
  };
  const disconnect = connect(node);
  return () => {
    alive = false;
    node.port.onmessage = null;
    node.port.postMessage({ type: 'stop' } satisfies UserVoiceWorkletCommand);
    disconnect();
    node.disconnect();
  };
}
