import type { SemanticIntent } from './SemanticCue';

export interface SemanticPacerConfig {
  /**
   * Speaking rate of the voice, characters of text per second of assistant audio. Only an estimate (ChatGPT's
   * voices speak ~12–16 chars/s); calibrate by eye (docs/semantic-calibration.md).
   */
  charsPerSecond: number;
  /** A due intent whose moment passed more than this many seconds ago is dropped instead of played late. */
  staleSeconds: number;
  /**
   * Assistant silence longer than this starts a new turn: the spoken-position estimate of the next reply starts
   * from the speech that began before its text appeared, not from an old reply.
   */
  turnGap: number;
  /** Intents waiting for their moment, at most (oldest dropped). */
  maxPending: number;
}

export const SEMANTIC_PACER_CONFIG: Readonly<SemanticPacerConfig> = Object.freeze({
  charsPerSecond: 14,
  staleSeconds: 3,
  turnGap: 1.5,
  maxPending: 64,
});

export interface SemanticPacerStatus {
  mode: 'speech' | 'immediate';
  /** Estimated characters of the current reply already spoken. */
  spokenChars: number;
  pending: number;
  dropped: number;
}

/**
 * Optional audio-assisted timing without STT or alignment: a text clock. In voice mode ChatGPT's text can run
 * ahead of (or behind) its audio by seconds, so an intent is released when the estimated spoken position —
 * seconds of assistant audio in this turn × charsPerSecond — reaches the intent's segment. Intents the audio
 * already passed by more than staleSeconds are dropped. Without a voice session (text chat) or with pacing off,
 * intents are released as they arrive: the text-only path does not depend on any of this.
 *
 * Inputs are two booleans per frame (voice session active, assistant audio active); no audio data.
 */
export class SemanticPacer {
  readonly config: SemanticPacerConfig;
  /** Off: every intent is released immediately (text-only mode). */
  enabled = true;
  private queue: SemanticIntent[] = [];
  private message: string | null = null;
  /** Assistant audio seconds in the current turn (reset after a silence longer than turnGap). */
  private turnSpeech = 0;
  private silence = Infinity;
  private spoken = 0;
  private mode: 'speech' | 'immediate' = 'immediate';
  private droppedCount = 0;

  constructor(config: Partial<SemanticPacerConfig> = {}) {
    this.config = { ...SEMANTIC_PACER_CONFIG, ...config };
  }

  get status(): SemanticPacerStatus {
    return { mode: this.mode, spokenChars: this.spoken, pending: this.queue.length, dropped: this.droppedCount };
  }

  push(intent: SemanticIntent): void {
    if (intent.messageId !== this.message) {
      this.message = intent.messageId;
      this.queue = this.queue.filter((q) => q.messageId === intent.messageId);
      // The reply's speech may have started before its text reached the page: count this turn's audio so far
      // (none if the assistant has been silent since the last turn).
      this.spoken = this.silence > this.config.turnGap ? 0 : this.turnSpeech * this.config.charsPerSecond;
    }
    this.queue.push(intent);
    while (this.queue.length > this.config.maxPending) {
      this.queue.shift();
      this.droppedCount++;
    }
  }

  clear(): void {
    this.queue.length = 0;
  }

  /**
   * @param voiceActive a voice session is running (else: text chat, release immediately)
   * @param assistantSpeaking assistant audio is playing now
   * @returns intents due now, in order
   */
  update(deltaTime: number, voiceActive: boolean, assistantSpeaking: boolean): SemanticIntent[] {
    const dt = deltaTime > 0 && Number.isFinite(deltaTime) ? deltaTime : 0;
    const c = this.config;
    if (assistantSpeaking) {
      if (this.silence > c.turnGap) this.turnSpeech = 0;
      this.silence = 0;
      this.turnSpeech += dt;
      this.spoken += dt * c.charsPerSecond;
    } else {
      this.silence += dt;
    }
    this.mode = this.enabled && voiceActive ? 'speech' : 'immediate';
    if (this.queue.length === 0) return [];
    if (this.mode === 'immediate') {
      const all = this.queue;
      this.queue = [];
      return all;
    }
    const due: SemanticIntent[] = [];
    const staleChars = c.staleSeconds * c.charsPerSecond;
    while (this.queue.length && this.queue[0]!.charStart <= this.spoken) {
      const intent = this.queue.shift()!;
      if (this.spoken - intent.charStart > staleChars) this.droppedCount++;
      else due.push(intent);
    }
    return due;
  }
}
