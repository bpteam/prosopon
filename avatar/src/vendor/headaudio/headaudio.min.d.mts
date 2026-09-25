/** Hand-written types for the subset of HeadAudio that HeadAudioAnalyzer uses. */
export declare class HeadAudio extends AudioWorkletNode {
  constructor(
    context: BaseAudioContext,
    options?: { processorOptions?: Record<string, unknown>; parameterData?: Record<string, number> } | null,
  );
  /** Index into visemeNames of the viseme currently detected, or -1 for silence. */
  visemeActive: number;
  readonly visemeNames: readonly string[];
  loadModel(url: string, reset?: boolean): Promise<void>;
  start(): void;
  stop(): void;
}
