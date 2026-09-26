import type { UserVoiceAnalyzerConfig } from './UserVoiceAnalyzer';
import type { UserVoiceFrame } from './UserVoiceFrame';

// Shared by the worklet module and whoever creates its node; no runtime dependencies.

/** Registered name of the voice-feature processor (used for the user's mic and the assistant's tab audio alike). */
export const USER_VOICE_PROCESSOR = 'prosopon-user-voice';

export interface UserVoiceProcessorOptions {
  /** Frames posted per second of audio. */
  frameRate: number;
  analyzer?: Partial<UserVoiceAnalyzerConfig>;
  /**
   * Also post the decimated audio in chunks of this many seconds, for a local emotion model in the same document.
   * Omitted (the default): the processor posts frames only and no samples ever leave the render thread.
   */
  pcmChunkSeconds?: number;
}

/**
 * Worklet → node port. Frames always; `pcm` only when pcmChunkSeconds was set (a local model is configured). PCM
 * stays in the document that created the node: it is never forwarded to another context or stored.
 */
export type UserVoiceWorkletMessage =
  | { type: 'frame'; frame: UserVoiceFrame }
  | { type: 'pcm'; samples: Float32Array; sampleRate: number };

/** Node port → worklet. */
export type UserVoiceWorkletCommand = { type: 'stop' };
