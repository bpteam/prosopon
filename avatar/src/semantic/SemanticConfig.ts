import type { RuleTier } from './SemanticCue';

/**
 * How detection is scored and aggregated. What is detected lives in rules/ (vocabulary data); how the avatar
 * reacts lives in SemanticGestureConfig (gesture side). Numbers here are about text only.
 */
export interface SemanticConfig {
  /** A cue is emitted only at this aggregated confidence or above. Weak markers stay below it on their own. */
  minConfidence: number;
  /** …and its strongest single marker at least this (two weak markers never make a cue together). */
  minMarkerConfidence: number;
  /** Early (mid-sentence) emission needs this much confidence and a punctuated marker at the segment start… */
  earlyMinConfidence: number;
  /** …within this many characters of it (the open segment is re-checked only while it is this short). */
  earlyWindow: number;

  tierConfidence: Record<RuleTier, number>;
  tierStrength: Record<RuleTier, number>;

  // Context scoring, added to a marker's base confidence.
  segmentStartBonus: number;
  /** Marker followed by `,` `:` `—` (a discourse connector, not a word inside a phrase). */
  punctuationBonus: number;
  /** Marker followed by `:` or `—` ("Главное: …", "The point is — …"). */
  announceBonus: number;
  /** Marker inside **bold**. */
  boldBonus: number;
  /** The whole segment is the marker ("Да.", "Exactly!"). */
  standaloneBonus: number;
  /** Position-free markers in long segments are more likely incidental. */
  longSegment: number;
  longSegmentPenalty: number;
  /** Rules of the other Cyrillic language when the message's script clearly says ru or uk. */
  otherCyrillicFactor: number;
  /** English rules in a message with Spanish letters (ñ, ¿, á …). */
  englishInSpanishFactor: number;

  /** Structural signals: punctuation and Markdown. */
  structural: {
    questionMark: number;
    invertedQuestion: number;
    orderedItem: number;
    bulletItem: number;
    /** A paragraph ending with ":" right before a list. */
    listIntro: number;
    heading: number;
    bold: number;
    italic: number;
    caps: number;
    exclamation: number;
    /** A one-sentence paragraph (not the first) of at most shortParagraphChars. */
    shortParagraph: number;
    shortParagraphChars: number;
  };

  /** Non-emphasis cues get this × emphasis confidence added to their strength. */
  emphasisStrengthBoost: number;
  /** Each modifier (example, cause, clarification) adds this to the strength of the segment's cues. */
  modifierStrengthBoost: number;
  /** Debug text of an intent is cut to this many characters. */
  debugTextChars: number;
}

export const SEMANTIC_CONFIG: Readonly<SemanticConfig> = Object.freeze({
  minConfidence: 0.55,
  minMarkerConfidence: 0.5,
  earlyMinConfidence: 0.75,
  earlyWindow: 48,
  tierConfidence: { strong: 0.92, medium: 0.78, weak: 0.5 },
  tierStrength: { strong: 1, medium: 0.8, weak: 0.55 },
  segmentStartBonus: 0.04,
  punctuationBonus: 0.05,
  announceBonus: 0.05,
  boldBonus: 0.08,
  standaloneBonus: 0.06,
  longSegment: 220,
  longSegmentPenalty: 0.1,
  otherCyrillicFactor: 0.6,
  englishInSpanishFactor: 0.7,
  structural: {
    questionMark: 0.9,
    invertedQuestion: 0.9,
    orderedItem: 0.9,
    bulletItem: 0.7,
    listIntro: 0.85,
    heading: 0.55,
    bold: 0.72,
    italic: 0.5,
    caps: 0.5,
    exclamation: 0.45,
    shortParagraph: 0.45,
    shortParagraphChars: 60,
  },
  emphasisStrengthBoost: 0.2,
  modifierStrengthBoost: 0.08,
  debugTextChars: 140,
}) as Readonly<SemanticConfig>;

export type SemanticConfigOverrides = Partial<Omit<SemanticConfig, 'structural' | 'tierConfidence' | 'tierStrength'>> & {
  structural?: Partial<SemanticConfig['structural']>;
  tierConfidence?: Partial<SemanticConfig['tierConfidence']>;
  tierStrength?: Partial<SemanticConfig['tierStrength']>;
};

export function semanticConfig(o: SemanticConfigOverrides = {}): SemanticConfig {
  const b = SEMANTIC_CONFIG;
  return {
    ...b,
    ...o,
    structural: { ...b.structural, ...o.structural },
    tierConfidence: { ...b.tierConfidence, ...o.tierConfidence },
    tierStrength: { ...b.tierStrength, ...o.tierStrength },
  };
}
