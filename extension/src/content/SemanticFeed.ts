import { SemanticAnalyzer } from '@avatar/semantic/SemanticAnalyzer';
import { SemanticPacer, type SemanticPacerStatus } from '@avatar/semantic/SemanticPacer';
import type { SemanticIntent } from '@avatar/semantic/SemanticCue';
import type { AssistantReply, ConversationUiAdapter } from './ChatGPTAdapter';

export type ReplySource = Pick<ConversationUiAdapter, 'readLatestReply' | 'observeReplies'>;

export interface SemanticFeedOptions {
  source: ReplySource;
  /** Where due intents go (GestureEngine.pushSemantic). */
  sink: (intent: SemanticIntent) => void;
  /** Reads of the reply text at most this often while it changes, seconds. */
  readInterval?: number;
  /** A reply whose text has not changed for this long is complete (its last sentence is analysed), seconds. */
  settleSeconds?: number;
  onError?: (error: unknown) => void;
}

export interface SemanticFeedStatus {
  enabled: boolean;
  error: string | null;
  messages: number;
  segments: number;
  cues: number;
  intents: number;
  /** Total analysis time, ms. */
  busyMs: number;
  pacer: SemanticPacerStatus;
  pacing: boolean;
  /** Last intents produced (newest last), before pacing. */
  recent: readonly SemanticIntent[];
}

const RECENT = 12;

/** Watches the feed without changing it (calibration): every analysed intent, and each one the pacer released. */
export interface SemanticFeedObserver {
  analyzed?(intent: SemanticIntent): void;
  released?(intent: SemanticIntent): void;
}

/**
 * Integration glue of the semantic layer: the adapter's reply text → SemanticAnalyzer → SemanticPacer →
 * GestureEngine. Runs from the render loop (`update`), reads the DOM only through the adapter, only after a
 * mutation and at most every `readInterval`. The reply that was on the page at activation is history and never
 * analysed. Any exception switches the feed off (the avatar keeps running without semantics).
 */
export class SemanticFeed {
  readonly analyzer = new SemanticAnalyzer();
  readonly pacer = new SemanticPacer();
  private readonly readInterval: number;
  private readonly settleSeconds: number;
  private readonly stop: () => void;
  private readonly baseline: string | null;
  private current: AssistantReply | null = null;
  private complete = false;
  private dirty = true;
  private sinceRead = Infinity;
  private sinceChange = 0;
  private on = true;
  private failure: string | null = null;
  private readonly recent: SemanticIntent[] = [];
  /** Optional observer (calibration); null in normal use. Its exceptions are swallowed, never the feed's. */
  observer: SemanticFeedObserver | null = null;

  constructor(private readonly options: SemanticFeedOptions) {
    this.readInterval = options.readInterval ?? 0.125;
    this.settleSeconds = options.settleSeconds ?? 2.5;
    this.baseline = options.source.readLatestReply()?.id ?? null;
    this.stop = options.source.observeReplies(() => (this.dirty = true));
  }

  get enabled(): boolean {
    return this.on;
  }

  /** Off: nothing is read or analysed; queued intents are dropped. */
  setEnabled(on: boolean): void {
    if (on && this.failure) return;
    this.on = on;
    if (!on) this.pacer.clear();
    else this.dirty = true;
  }

  /** Text clock on (voice mode) or off: intents go out as their text arrives. */
  setPacing(on: boolean): void {
    this.pacer.enabled = on;
  }

  get status(): SemanticFeedStatus {
    const s = this.analyzer.stats;
    return {
      enabled: this.on,
      error: this.failure,
      messages: s.messages,
      segments: s.segments,
      cues: s.cues,
      intents: s.intents,
      busyMs: s.busyMs,
      pacer: this.pacer.status,
      pacing: this.pacer.enabled,
      recent: this.recent,
    };
  }

  update(deltaTime: number, voiceActive: boolean, assistantSpeaking: boolean): void {
    if (!this.on) return;
    try {
      const dt = deltaTime > 0 && Number.isFinite(deltaTime) ? deltaTime : 0;
      this.sinceRead += dt;
      this.sinceChange += dt;
      if (this.dirty && this.sinceRead >= this.readInterval) {
        this.dirty = false;
        this.sinceRead = 0;
        this.read();
      } else if (this.current && !this.complete && this.sinceChange >= this.settleSeconds) {
        this.complete = true;
        this.feed(this.current, true);
      }
      for (const intent of this.pacer.update(dt, voiceActive, assistantSpeaking)) {
        this.options.sink(intent);
        this.observe('released', intent);
      }
    } catch (error) {
      this.failure = error instanceof Error ? error.message : String(error);
      this.on = false;
      this.pacer.clear();
      this.options.onError?.(error);
    }
  }

  dispose(): void {
    this.stop();
    this.on = false;
    this.pacer.clear();
  }

  private read(): void {
    const reply = this.options.source.readLatestReply();
    if (!reply || reply.id === this.baseline || !reply.text) return;
    const cur = this.current;
    if (cur && cur.id === reply.id && cur.text === reply.text) return;
    this.current = reply;
    this.complete = false;
    this.sinceChange = 0;
    this.feed(reply, false);
  }

  private feed(reply: AssistantReply, complete: boolean): void {
    for (const intent of this.analyzer.update(reply.id, reply.text, complete)) {
      this.recent.push(intent);
      if (this.recent.length > RECENT) this.recent.shift();
      this.pacer.push(intent);
      this.observe('analyzed', intent);
    }
  }

  private observe(kind: keyof SemanticFeedObserver, intent: SemanticIntent): void {
    try {
      this.observer?.[kind]?.(intent);
    } catch {
      // A diagnostics observer must not switch the semantic layer off.
    }
  }
}
