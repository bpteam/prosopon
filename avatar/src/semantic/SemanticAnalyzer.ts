import { semanticConfig, type SemanticConfig, type SemanticConfigOverrides } from './SemanticConfig';
import type { SemanticCue, SemanticIntent } from './SemanticCue';
import { analyzeSegment, type SegmentAnalysis } from './SemanticMatcher';
import { defaultRuleSet, type CompiledRuleSet } from './SemanticRuleSet';
import { normalizeText, scriptHint, segmentText, type TextSegment } from './SemanticText';

export interface SemanticAnalyzerOptions {
  config?: SemanticConfigOverrides;
  /** Defaults to the built-in multilingual vocabulary (compiled once per page). */
  rules?: CompiledRuleSet;
}

interface SegmentState {
  early: boolean;
  final: boolean;
  types: Set<string>;
}

export interface SemanticAnalyzerStats {
  messages: number;
  segments: number;
  cues: number;
  intents: number;
  /** Total time spent in update(), ms (performance budget check). */
  busyMs: number;
}

/**
 * Streaming discourse analyser: the growing text of the assistant's current reply in, `SemanticIntent`s out.
 *
 * Incremental by construction: a message is re-segmented on each update (cheap, linear), but a segment is scored
 * at most twice — once early, when a strong marker opens it ("Однако," "Firstly,"), and once when it is closed
 * (more text follows it, or the message is complete). Segments are identified by their ordinal in the message,
 * which does not change while text is appended or Markdown inside a segment re-renders. Each cue type is emitted
 * once per segment: "Но" → "Но здесь" → … → "Но здесь есть важный нюанс." is one contrast, not five.
 *
 * No DOM, no audio, no renderer: text in, typed data out.
 */
export class SemanticAnalyzer {
  readonly config: SemanticConfig;
  private readonly rules: CompiledRuleSet;
  private messageId: string | null = null;
  private readonly segments = new Map<number, SegmentState>();
  private sequence = 0;
  private readonly counters: SemanticAnalyzerStats = { messages: 0, segments: 0, cues: 0, intents: 0, busyMs: 0 };

  constructor(options: SemanticAnalyzerOptions = {}) {
    this.config = semanticConfig(options.config);
    this.rules = options.rules ?? defaultRuleSet();
  }

  get stats(): Readonly<SemanticAnalyzerStats> {
    return this.counters;
  }

  get currentMessage(): string | null {
    return this.messageId;
  }

  /** Forget the current message (its remaining segments will never emit). */
  reset(): void {
    this.messageId = null;
    this.segments.clear();
  }

  /**
   * @param messageId identity of the reply; a new id starts a new message
   * @param text the reply's full text so far (Markdown-ish: list markers, **bold**, headings, fenced code)
   * @param complete the reply is finished: its last segment is closed too
   * @returns intents for segments that gained cues since the last call (usually none)
   */
  update(messageId: string, text: string, complete = false): SemanticIntent[] {
    const t0 = now();
    if (messageId !== this.messageId) {
      this.reset();
      this.messageId = messageId;
      this.counters.messages++;
    }
    const normalized = normalizeText(text);
    const segs = segmentText(normalized, complete);
    const hint = scriptHint(normalized.toLowerCase());
    const out: SemanticIntent[] = [];
    for (const seg of segs) {
      let st = this.segments.get(seg.ordinal);
      if (st?.final) continue;
      if (!st) {
        st = { early: false, final: false, types: new Set() };
        this.segments.set(seg.ordinal, st);
        this.counters.segments++;
      }
      if (seg.closed) {
        st.final = true;
        const analysis = analyzeSegment(seg, this.rules, this.config, hint, 'full');
        const intent = this.intent(messageId, seg, analysis, st, false);
        if (intent) out.push(intent);
      } else if (!st.early && seg.lexStart < this.config.earlyWindow && seg.lexical.length <= this.config.earlyWindow + seg.lexStart) {
        const analysis = analyzeSegment(seg, this.rules, this.config, hint, 'early');
        const intent = this.intent(messageId, seg, analysis, st, true);
        if (intent) {
          st.early = true;
          out.push(intent);
        }
      }
    }
    this.counters.intents += out.length;
    this.counters.busyMs += now() - t0;
    return out;
  }

  private intent(messageId: string, seg: TextSegment, a: SegmentAnalysis, st: SegmentState, early: boolean): SemanticIntent | null {
    const segmentId = `${messageId}#${seg.ordinal}`;
    const cues: SemanticCue[] = [];
    for (const c of a.cues) {
      if (st.types.has(c.type)) continue;
      st.types.add(c.type);
      cues.push({
        id: `${segmentId}:${c.type}`,
        type: c.type,
        role: c.role,
        confidence: c.confidence,
        strength: c.strength,
        segmentId,
        charStart: seg.start + c.start,
        charEnd: seg.start + c.end,
        sequence: this.sequence++,
        marker: c.marker,
      });
    }
    if (cues.length === 0) return null;
    this.counters.cues += cues.length;
    const max = this.config.debugTextChars;
    return {
      messageId,
      segmentId,
      charStart: seg.start,
      charEnd: seg.end,
      cues,
      modifiers: a.modifiers,
      early,
      text: seg.text.length > max ? `${seg.text.slice(0, max - 1)}…` : seg.text,
      matches: a.matches.map((m) => ({ ...m, start: seg.start + m.start, end: seg.start + m.end })),
    };
  }
}

/** Convenience for tests and tools: every intent of a finished text, as if it arrived in one piece. */
export function analyzeText(text: string, options?: SemanticAnalyzerOptions): SemanticIntent[] {
  return new SemanticAnalyzer(options).update('text', text, true);
}

const now: () => number = typeof performance !== 'undefined' ? () => performance.now() : () => Date.now();
