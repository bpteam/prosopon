import type { MouthShape } from '../avatar/Avatar';

/**
 * A real-time speech analyser that tells which mouth shape is being pronounced.
 *
 * Contract: read() reports the *shape*, not how open the mouth is. Weights are in [0, 1] and sum to at most 1;
 * all zeros means a closed mouth (silence, p/b/m). Loudness is applied by VisemeLipSync from the amplitude
 * path, so every analyser opens the mouth by the same amount for the same signal.
 */
export interface VisemeAnalyzer {
  readonly name: VisemeAnalyzerName;
  /** Node the speech signal is connected to. Produces no audio. */
  readonly input: AudioNode;
  /** False once the worklet has failed; VisemeLipSync then falls back to amplitude. */
  readonly healthy: boolean;
  /** Writes the current shape into `out`. Called once per frame. */
  read(out: MouthShape): void;
  dispose(): void;
}

export type VisemeAnalyzerName = 'headaudio' | 'wlipsync';

/** Creates an analyser in the given context. Rejects if the browser or the assets don't allow it. */
export type VisemeAnalyzerFactory = (context: AudioContext) => Promise<VisemeAnalyzer>;

/** Copies `row` into `out`, filling missing visemes with 0. */
export function writeShape(out: MouthShape, row: Readonly<Partial<MouthShape>> | undefined): void {
  out.aa = row?.aa ?? 0;
  out.ih = row?.ih ?? 0;
  out.ou = row?.ou ?? 0;
  out.ee = row?.ee ?? 0;
  out.oh = row?.oh ?? 0;
}

export function assertAudioWorklet(context: AudioContext): void {
  // Missing outside secure contexts (plain http) and in old browsers.
  if (!context.audioWorklet) throw new Error('AudioWorklet is not available (needs https or localhost)');
}
