import type { EnumerationRole, RulePosition, RuleTier, SemanticCueType, SemanticLocale, SemanticModifier } from '../SemanticCue';

/**
 * What a vocabulary entry says about a segment. `none` occupies its span and says nothing: it exists to keep a
 * shorter marker from matching inside a longer neutral phrase ("but also", "так же", "sino también").
 */
export type RuleKind = SemanticCueType | SemanticModifier | 'none';

/**
 * A group of phrases with the same meaning and the same matching constraints. Pure data: SemanticRuleSet compiles
 * it once into regular expressions.
 *
 * Phrase syntax: lowercase words separated by single spaces (any whitespace matches), `ё` written as `е`,
 * apostrophes as `'`. A trailing `*` on a word matches any letters after it ("ключев*"). Everything else is literal.
 */
export interface RuleGroup {
  kind: RuleKind;
  role?: EnumerationRole;
  tier: RuleTier;
  /** Default: see DEFAULT_POSITION in SemanticRuleSet. */
  position?: RulePosition;
  /**
   * Counts only when punctuation follows (or the finished segment ends): "Да." and "Да, именно" yes, "Да это"
   * no; never before a `?` ("Правильно?" is a question).
   */
  standalone?: boolean;
  /** Rejected when a negation stands right before it in the clause ("not important", "не важно"). */
  negatable?: boolean;
  /** Overrides the tier's default confidence / strength (SemanticConfig.tierConfidence / tierStrength). */
  confidence?: number;
  strength?: number;
  phrases: readonly string[];
}

export interface LocaleRules {
  locale: SemanticLocale;
  /** Words that negate the marker right after them (checked for `negatable` groups). */
  negators: readonly string[];
  groups: readonly RuleGroup[];
}

/** Every "a b" for a in `heads`, b in `tails`: numbers × nouns without typing the cross product by hand. */
export function combos(heads: readonly string[], tails: readonly string[]): string[] {
  return heads.flatMap((h) => tails.map((t) => `${h} ${t}`));
}
