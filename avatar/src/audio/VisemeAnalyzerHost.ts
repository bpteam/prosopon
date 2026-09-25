import type { AudioInput } from './AudioInput';
import type { VisemeAnalyzer, VisemeAnalyzerFactory, VisemeAnalyzerName } from './VisemeAnalyzer';
import type { VisemeLipSync } from './VisemeLipSync';

export type AnalyzerChoice = VisemeAnalyzerName | 'none';

/**
 * Owns the selected viseme analyser: creates it lazily once AudioInput has an AudioContext (the context is only
 * created by a user gesture), taps it into the input and hands it to VisemeLipSync. Creation failures leave lip
 * sync in amplitude mode and are reported through `status`.
 */
export class VisemeAnalyzerHost {
  private choice: AnalyzerChoice;
  private current: VisemeAnalyzer | null = null;
  private untap: (() => void) | null = null;
  private pending: Promise<void> | null = null;
  private failed: string | null = null;
  /** Bumped by select()/dispose(), so a creation that resolves late for an old choice is discarded. */
  private generation = 0;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly input: AudioInput,
    private readonly lipSync: VisemeLipSync,
    private readonly factories: Readonly<Record<VisemeAnalyzerName, VisemeAnalyzerFactory>>,
    initial: AnalyzerChoice = 'none',
  ) {
    this.choice = initial;
    this.unsubscribe = input.onKindChange(() => this.ensure());
    this.ensure();
  }

  get selected(): AnalyzerChoice {
    return this.choice;
  }

  get analyzer(): VisemeAnalyzer | null {
    return this.current;
  }

  get status(): string {
    if (this.choice === 'none') return 'off';
    if (this.failed) return `error: ${this.failed}`;
    if (this.current) return this.current.healthy ? 'ready' : 'error: worklet failed';
    if (this.pending) return 'loading';
    return 'waits for audio';
  }

  select(choice: AnalyzerChoice): void {
    if (choice === this.choice && !this.failed) return;
    this.release();
    this.choice = choice;
    this.ensure();
  }

  /** Resolves once the pending creation (if any) has settled. For tests and the dev API. */
  async whenSettled(): Promise<void> {
    await this.pending;
  }

  dispose(): void {
    this.unsubscribe();
    this.release();
  }

  private ensure(): void {
    const ctx = this.input.context;
    if (this.choice === 'none' || this.current || this.pending || this.failed || !ctx) return;
    const generation = this.generation;
    const choice = this.choice;
    this.pending = this.factories[choice](ctx).then(
      (analyzer) => {
        if (generation !== this.generation) {
          analyzer.dispose();
          return;
        }
        this.pending = null;
        this.current = analyzer;
        this.untap = this.input.addTap(analyzer.input);
        this.lipSync.setAnalyzer(analyzer);
      },
      (error: unknown) => {
        if (generation !== this.generation) return;
        this.pending = null;
        this.failed = error instanceof Error ? error.message : String(error);
        console.warn(`[LipSync] ${choice} analyser unavailable, using amplitude:`, error);
      },
    );
  }

  private release(): void {
    this.generation++;
    this.pending = null;
    this.failed = null;
    this.untap?.();
    this.untap = null;
    this.lipSync.setAnalyzer(null);
    this.current?.dispose();
    this.current = null;
  }
}
