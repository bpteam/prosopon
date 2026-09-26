import type { EnumerationRole, RulePosition, RuleTier, SemanticLocale } from './SemanticCue';
import type { LocaleRules, RuleGroup, RuleKind } from './rules/RuleData';
import { EN_RULES } from './rules/en';
import { ES_RULES } from './rules/es';
import { RU_RULES } from './rules/ru';
import { UK_RULES } from './rules/uk';

/** Vocabulary of the MVP: one multilingual ruleset, no language detection (a script hint only re-weights). */
export const SEMANTIC_LOCALE_RULES: readonly LocaleRules[] = [EN_RULES, RU_RULES, UK_RULES, ES_RULES];

/** Where a kind's markers count unless a group says otherwise. */
const DEFAULT_POSITION: Record<RuleKind, RulePosition> = {
  question: 'segment-start',
  enumeration: 'segment-start',
  contrast: 'clause-start',
  conclusion: 'clause-start',
  agreement: 'segment-start',
  disagreement: 'segment-start',
  emphasis: 'any',
  example: 'clause-start',
  cause: 'any',
  clarification: 'any',
  none: 'any',
};

export interface CompiledRule {
  kind: RuleKind;
  role?: EnumerationRole;
  tier: RuleTier;
  locale: SemanticLocale;
  position: RulePosition;
  standalone: boolean;
  negatable: boolean;
  /** Group override; the tier default applies when undefined. */
  confidence?: number;
  strength?: number;
  phrase: string;
  /** Token count: longer phrases win overlaps. */
  words: number;
}

/**
 * Phrase trie over tokens (words and single punctuation marks). Matching walks it from each token of a segment,
 * so word boundaries are exact by construction ("да" never matches inside "даже") and the cost does not grow
 * with the vocabulary size.
 */
export interface TrieNode {
  next: Map<string, TrieNode>;
  /** Rules whose phrase ends at this node. */
  rules: CompiledRule[];
  /** Rules whose last word is a stem ("ключев*"): any token starting with `prefix` completes them. */
  stems: { prefix: string; rules: CompiledRule[] }[];
}

export interface CompiledRuleSet {
  rules: readonly CompiledRule[];
  root: TrieNode;
  /** Union of every locale's negators (single words), lowercase. */
  negators: ReadonlySet<string>;
  /** Rule count per kind (enumeration split by role) and locale: the report and the tests read it. */
  counts: Readonly<Record<string, Readonly<Record<string, number>>>>;
}

export interface Token {
  text: string;
  start: number;
  end: number;
  word: boolean;
}

/** Words keep inner apostrophes and hyphens ("don't", "во-первых", "п'ять"); every other non-space is one token. */
const TOKEN = /[\p{L}\p{N}]+(?:['\-][\p{L}\p{N}]+)*|[^\s\p{L}\p{N}]/gu;
const WORD = /^[\p{L}\p{N}]/u;

export function tokenize(s: string): Token[] {
  const out: Token[] = [];
  for (const m of s.matchAll(TOKEN)) out.push({ text: m[0], start: m.index, end: m.index + m[0].length, word: WORD.test(m[0]) });
  return out;
}

function node(): TrieNode {
  return { next: new Map(), rules: [], stems: [] };
}

function insert(root: TrieNode, rule: CompiledRule): void {
  const raw = rule.phrase;
  const stem = raw.endsWith('*');
  const tokens = tokenize(stem ? raw.slice(0, -1) : raw).map((t) => t.text);
  if (tokens.length === 0) return;
  let n = root;
  const last = stem ? tokens.length - 1 : tokens.length;
  for (let i = 0; i < last; i++) {
    const t = tokens[i]!;
    let child = n.next.get(t);
    if (!child) n.next.set(t, (child = node()));
    n = child;
  }
  if (!stem) {
    n.rules.push(rule);
    return;
  }
  const prefix = tokens[tokens.length - 1]!;
  let entry = n.stems.find((s) => s.prefix === prefix);
  if (!entry) n.stems.push((entry = { prefix, rules: [] }));
  entry.rules.push(rule);
}

function compileGroup(locale: SemanticLocale, g: RuleGroup, out: CompiledRule[], seen: Set<string>): void {
  const position = g.position ?? DEFAULT_POSITION[g.kind];
  for (const raw of g.phrases) {
    const phrase = raw.trim().toLowerCase().replace(/ё/g, 'е').replace(/’/g, "'").replace(/\s+/g, ' ');
    if (!phrase) continue;
    // One entry per (locale, kind, role, position, phrase): lists may repeat a phrase harmlessly.
    const key = `${locale}|${g.kind}|${g.role ?? ''}|${position}|${phrase}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      kind: g.kind,
      role: g.role,
      tier: g.tier,
      locale,
      position,
      standalone: g.standalone ?? false,
      negatable: g.negatable ?? false,
      confidence: g.confidence,
      strength: g.strength,
      phrase,
      words: tokenize(phrase.replace(/\*$/, '')).length,
    });
  }
}

export function compileRules(locales: readonly LocaleRules[] = SEMANTIC_LOCALE_RULES): CompiledRuleSet {
  const rules: CompiledRule[] = [];
  const seen = new Set<string>();
  const negators = new Set<string>();
  for (const l of locales) {
    for (const g of l.groups) compileGroup(l.locale, g, rules, seen);
    for (const n of l.negators) if (!n.includes(' ')) negators.add(n.toLowerCase());
  }
  const root = node();
  const counts: Record<string, Record<string, number>> = {};
  for (const r of rules) {
    insert(root, r);
    const k = r.kind === 'enumeration' && r.role ? `enumeration-${r.role}` : r.kind;
    (counts[k] ??= {})[r.locale] = (counts[k]![r.locale] ?? 0) + 1;
  }
  return { rules, root, negators, counts };
}

let defaultSet: CompiledRuleSet | null = null;

/** The built-in vocabulary, compiled on first use and shared by every analyser. */
export function defaultRuleSet(): CompiledRuleSet {
  return (defaultSet ??= compileRules());
}
