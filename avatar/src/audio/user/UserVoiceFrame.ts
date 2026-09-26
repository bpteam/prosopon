// Contract only: imported by every extension context (offscreen, content, worklet), so it must stay dependency-free.

/**
 * Acoustic description of the user's voice at one moment, the only thing that crosses from the microphone pipeline
 * to the avatar side. Describes how the speech sounds, never what it means or how the user feels. No PCM, no FFT
 * bins, no nodes: every field is a plain number/boolean so it serialises cheaply at 20–30 Hz.
 */
export interface UserVoiceFrame {
  /** Voice activity after hysteresis/hangover (VoiceActivityDetector). */
  speaking: boolean;
  /**
   * Seconds of the current speech segment while speaking; while not speaking, the length of the last finished
   * segment (0 before the first one). Lets a consumer tell a meaningful utterance from a cough.
   */
  segmentDuration: number;
  /** Level of the last analysis hop, dBFS (-100 for digital silence). */
  rmsDb: number;
  /** Tracked background level, dBFS. */
  noiseFloorDb: number;
  /** Speech energy above the noise floor, normalised to [0, 1]. 0 while not speaking. */
  energy: number;
  /** Fundamental frequency, Hz. Null when unvoiced, silent or the estimate is not confident enough. */
  pitchHz: number | null;
  /** Clarity of the pitch estimate, [0, 1]. */
  pitchConfidence: number;
  /** Pitch relative to the session baseline, semitones. 0 when unvoiced or before a baseline exists. */
  relativePitch: number;
  /** Standard deviation of recent voiced pitch, semitones (≈ intonation liveliness). */
  pitchVariation: number;
  /** Power-weighted mean frequency of the last window (0–8 kHz band), Hz. 0 below the speech gate. */
  spectralCentroid: number;
  /** Frequency below which 85% of the window's power lies, Hz. 0 below the speech gate. */
  spectralRolloff: number;
  /** Sign changes per sample of the last hop, [0, 1]. 0 below the speech gate. */
  zeroCrossingRate: number;
}

/**
 * The same frame describes any voice channel: the extractor that produces it runs on the user's microphone and on the
 * assistant's tab audio alike. `UserVoiceFrame` is the historical name.
 */
export type VoiceFeatureFrame = UserVoiceFrame;

export const SILENT_USER_VOICE_FRAME: Readonly<UserVoiceFrame> = Object.freeze({
  speaking: false,
  segmentDuration: 0,
  rmsDb: -100,
  noiseFloorDb: -100,
  energy: 0,
  pitchHz: null,
  pitchConfidence: 0,
  relativePitch: 0,
  pitchVariation: 0,
  spectralCentroid: 0,
  spectralRolloff: 0,
  zeroCrossingRate: 0,
});

const NUMBER_FIELDS = [
  'segmentDuration',
  'rmsDb',
  'noiseFloorDb',
  'energy',
  'pitchConfidence',
  'relativePitch',
  'pitchVariation',
  'spectralCentroid',
  'spectralRolloff',
  'zeroCrossingRate',
] as const satisfies readonly (keyof UserVoiceFrame)[];

/** Structural check for frames received from another context: primitives only, bounded ranges. */
export function isUserVoiceFrame(value: unknown): value is UserVoiceFrame {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const f = value as Record<string, unknown>;
  if (typeof f.speaking !== 'boolean') return false;
  for (const key of NUMBER_FIELDS) if (typeof f[key] !== 'number' || !Number.isFinite(f[key])) return false;
  if (f.pitchHz !== null && (typeof f.pitchHz !== 'number' || !(f.pitchHz > 0))) return false;
  if ((f.energy as number) < 0 || (f.energy as number) > 1) return false;
  if ((f.pitchConfidence as number) < 0 || (f.pitchConfidence as number) > 1) return false;
  if ((f.zeroCrossingRate as number) < 0 || (f.zeroCrossingRate as number) > 1) return false;
  if ((f.spectralCentroid as number) < 0 || (f.spectralRolloff as number) < 0) return false;
  // Nothing else rides along: a frame never carries buffers or nested objects.
  return Object.keys(f).every((k) => k === 'speaking' || k === 'pitchHz' || (NUMBER_FIELDS as readonly string[]).includes(k));
}
