// Contracts of the semantic (discourse) layer. Plain data: no DOM, no audio, no renderer (checked by
// tests/unit/architecture.test.ts). A cue is a signal about what a part of the reply *does* (asks, contrasts,
// concludes …), never an animation command: GestureEngine decides whether anything moves.

export const SEMANTIC_CUE_TYPES = ['question', 'enumeration', 'contrast', 'conclusion', 'agreement', 'disagreement', 'emphasis'] as const;
export type SemanticCueType = (typeof SEMANTIC_CUE_TYPES)[number];

/**
 * Precedence when a segment carries several cues: the more specific discourse act decides the gesture; emphasis
 * mostly modulates the others.
 */
export const CUE_RANK: readonly SemanticCueType[] = ['disagreement', 'agreement', 'question', 'enumeration', 'conclusion', 'contrast', 'emphasis'];

/** Enumeration refined: "there are three options" / "firstly" / "finally". */
export type EnumerationRole = 'intro' | 'item' | 'final';

/**
 * Discourse markers that are not cues of their own ("for example", "because", "in other words"). They only nudge
 * the strength of the segment's cues (a slightly more explanatory gesture), never start anything alone.
 */
export const SEMANTIC_MODIFIERS = ['example', 'cause', 'clarification'] as const;
export type SemanticModifier = (typeof SEMANTIC_MODIFIERS)[number];

export type SemanticLocale = 'en' | 'ru' | 'uk' | 'es';
export type RuleTier = 'strong' | 'medium' | 'weak';

/** Where a marker counts. `clause-start` includes the segment start. */
export type RulePosition = 'segment-start' | 'clause-start' | 'any';

export interface SemanticCue {
  /** `${segmentId}:${type}`: one cue per type per segment. */
  id: string;
  type: SemanticCueType;
  role?: EnumerationRole;
  /** How sure the analyser is that the segment has this function, [0, 1] (aggregated over its markers). */
  confidence: number;
  /** How big the rhetorical move is, [0, 1] ("in conclusion" > "so"). */
  strength: number;
  segmentId: string;
  /** Strongest marker's span in the normalized message text. */
  charStart: number;
  charEnd: number;
  /** Emission order within the analyser (diagnostics). */
  sequence: number;
  /** Matched text of the strongest marker (diagnostics only). */
  marker?: string;
}

/** One rule hit, for the debug view. */
export interface SemanticMatchInfo {
  kind: SemanticCueType | SemanticModifier;
  role?: EnumerationRole;
  marker: string;
  /** null: a structural marker (punctuation, Markdown), not a vocabulary entry. */
  locale: SemanticLocale | null;
  tier: RuleTier;
  /** Score after context (position, punctuation, negation, script hint). */
  confidence: number;
  start: number;
  end: number;
}

/**
 * What the analyser emits for one segment (sentence, list item, heading): its new cues, all together, so the
 * gesture side sees the combined intent ("but the important part" = contrast + emphasis) instead of three events.
 * A segment emits at most twice: early (a strong marker at its start, before the sentence is complete) and
 * final (only cue types the early event did not have).
 */
export interface SemanticIntent {
  messageId: string;
  segmentId: string;
  /** Segment start in the normalized message text (pacing against speech). */
  charStart: number;
  charEnd: number;
  cues: SemanticCue[];
  modifiers: SemanticModifier[];
  early: boolean;
  /** Debug: the segment text (truncated) and every match, including the ones below the emission threshold. */
  text: string;
  matches: SemanticMatchInfo[];
}
