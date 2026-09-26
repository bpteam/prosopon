import type { UserVoiceAnalyzerConfig } from './UserVoiceAnalyzer';
import type { UserVoiceFrame } from './UserVoiceFrame';

// Shared by the worklet module and whoever creates its node; no runtime dependencies.

export const USER_VOICE_PROCESSOR = 'prosopon-user-voice';

export interface UserVoiceProcessorOptions {
  /** Frames posted per second of audio. */
  frameRate: number;
  analyzer?: Partial<UserVoiceAnalyzerConfig>;
}

/** Worklet → node port. Frames only: the processor never posts samples. */
export type UserVoiceWorkletMessage = { type: 'frame'; frame: UserVoiceFrame };

/** Node port → worklet. */
export type UserVoiceWorkletCommand = { type: 'stop' };
