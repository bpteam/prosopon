/**
 * AudioWorklet module: runs UserVoiceAnalyzer on the render thread, sample-accurate and independent of any
 * timer or display rate. Posts UserVoiceFrames (numbers only) at `frameRate`, counted in audio time. Samples leave
 * this scope only when `pcmChunkSeconds` is set (a local emotion model in the creating document), never otherwise.
 *
 * Built as a standalone module (no imports at runtime) and loaded with audioWorklet.addModule().
 */
import { UserVoiceAnalyzer } from './UserVoiceAnalyzer';
import {
  USER_VOICE_PROCESSOR,
  type UserVoiceProcessorOptions,
  type UserVoiceWorkletCommand,
  type UserVoiceWorkletMessage,
} from './UserVoiceWorkletProtocol';

// Minimal AudioWorkletGlobalScope typings (not part of the DOM lib).
declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: new (options: { processorOptions?: unknown }) => unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

if (typeof registerProcessor === 'function') {
  class UserVoiceProcessor extends AudioWorkletProcessor {
    private readonly analyzer: UserVoiceAnalyzer;
    private readonly samplesPerFrame: number;
    private sinceFrame = 0;
    private alive = true;

    constructor(options: { processorOptions?: unknown }) {
      super();
      const opts = (options.processorOptions ?? {}) as Partial<UserVoiceProcessorOptions>;
      this.analyzer = new UserVoiceAnalyzer(sampleRate, opts.analyzer);
      this.samplesPerFrame = Math.max(128, Math.round(sampleRate / (opts.frameRate ?? 25)));
      if (opts.pcmChunkSeconds && opts.pcmChunkSeconds > 0) this.analyzer.enablePcm(opts.pcmChunkSeconds);
      this.port.onmessage = (event: MessageEvent) => {
        if ((event.data as UserVoiceWorkletCommand | null)?.type === 'stop') this.alive = false;
      };
    }

    process(inputs: Float32Array[][]): boolean {
      // Mono: the first channel is enough for level and pitch, and the mic is mono in practice.
      const channel = inputs[0]?.[0];
      if (channel && channel.length > 0) {
        this.analyzer.process(channel);
        this.sinceFrame += channel.length;
        if (this.sinceFrame >= this.samplesPerFrame) {
          this.sinceFrame -= this.samplesPerFrame;
          this.port.postMessage({ type: 'frame', frame: this.analyzer.frame() } satisfies UserVoiceWorkletMessage);
        }
        // Only when a local model asked for it (pcmChunkSeconds); otherwise takePcm() is always null.
        for (let pcm = this.analyzer.takePcm(); pcm; pcm = this.analyzer.takePcm()) {
          const message: UserVoiceWorkletMessage = { type: 'pcm', samples: pcm, sampleRate: this.analyzer.decimatedRate };
          this.port.postMessage(message, [pcm.buffer]);
        }
      }
      return this.alive;
    }
  }
  registerProcessor(USER_VOICE_PROCESSOR, UserVoiceProcessor);
}
