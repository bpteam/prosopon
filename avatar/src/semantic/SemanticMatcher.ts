import type { SemanticConfig } from './SemanticConfig';
import {
  CUE_RANK,
  SEMANTIC_CUE_TYPES,
  SEMANTIC_MODIFIERS,
  type EnumerationRole,
  type RuleTier,
  type SemanticCueType,
  type SemanticLocale,
  type SemanticMatchInfo,
  type SemanticModifier,
} from './SemanticCue';
import { tokenize, type CompiledRule, type CompiledRuleSet, type TrieNode } from './SemanticRuleSet';
import type { RuleKind } from './rules/RuleData';
import type { ScriptHint, TextSegment } from './SemanticText';

/** A cue of one segment after aggregation (before it gets ids and sequence numbers). */
export interface SegmentCue {
  type: SemanticCueType;
  role?: EnumerationRole;
  confidence: number;
  strength: number;
  /** Strongest marker, segment-local offsets. */
  start: number;
  end: number;
  marker: string;
}

export interface SegmentAnalysis {
  /** Every accepted match (lexical and structural), for the debug view. */
  matches: SemanticMatchInfo[];
  /** Cues at or above minConfidence, ordered by type rank. */
  cues: SegmentCue[];
  modifiers: SemanticModifier[];
}

interface Hit {
  kind: RuleKind;
  role?: EnumerationRole;
  tier: RuleTier;
  locale: SemanticLocale | null;
  marker: string;
  start: number;
  end: number;
  confidence: number;
  strength: number;
  words: number;
  specificity: number;
}

const CUE_SET = new Set<string>(SEMANTIC_CUE_TYPES);
const MODIFIER_SET = new Set<string>(SEMANTIC_MODIFIERS);
const SPECIFICITY = { 'segment-start': 2, 'clause-start': 1, any: 0 } as const;
/** Punctuation that closes a standalone marker ("Да." "Yes," "Exactly —"). `?` is not one: "Right?" asks. */
const STANDALONE_END = new Set([',', '.', '!', ';', ':', '…', '—', ')', '"']);
const WORD = /[\p{L}\p{N}]/u;

export type AnalysisMode = 'full' | 'early';

/**
 * Scores one segment: positional and free vocabulary matches (longest wins overlaps), structural signals
 * (punctuation, list markers, Markdown), then per-type aggregation and conflict resolution.
 *
 * `early`: only what can be trusted before the sentence is complete — a strong/medium marker at the very start
 * that is already followed by punctuation, a list-item marker, an opening `¿`.
 */
export function analyzeSegment(
  seg: TextSegment,
  set: CompiledRuleSet,
  config: SemanticConfig,
  hint: ScriptHint,
  mode: AnalysisMode = 'full',
): SegmentAnalysis {
  const lex = seg.lexical;
  const hits: Hit[] = [];
  const bold = boldRanges(seg.text);
  const clauses = new Set(seg.clauseStarts);
  const tokens = tokenize(lex);

  for (let i = 0; i < tokens.length; i++) {
    const first = tokens[i]!;
    if (!first.word) continue;
    const atSegmentStart = first.start === seg.lexStart;
    if (mode === 'early' && !atSegmentStart) break;
    const atClauseStart = atSegmentStart || clauses.has(first.start);
    const collect = (rules: readonly CompiledRule[], end: number): void => {
      for (const r of rules) {
        if (r.position === 'segment-start' && !atSegmentStart) continue;
        if (r.position === 'clause-start' && !atClauseStart) continue;
        if (mode === 'early' && r.tier === 'weak') continue;
        const hit = score(r, first.start, end, seg, set, config, hint, bold, mode);
        if (hit) hits.push(hit);
      }
    };
    let n: TrieNode | undefined = set.root;
    for (let j = i; j < tokens.length && n; j++) {
      const t = tokens[j]!;
      for (const stem of n.stems) {
        if (t.word && t.text.startsWith(stem.prefix)) collect(stem.rules, t.end);
      }
      n = n.next.get(t.text);
      if (n && n.rules.length) collect(n.rules, t.end);
    }
  }

  // A marker in quotes is mentioned, not used ("«но» is a conjunction"): it says nothing about this segment.
  const quotes = quoteRanges(seg.text);
  const used = quotes.length ? hits.filter((h) => !quotes.some(([s, e]) => h.start > s && h.end <= e)) : hits;
  const accepted = resolveOverlaps(used);
  if (mode === 'early') {
    for (let i = accepted.length - 1; i >= 0; i--) if (accepted[i]!.confidence < config.earlyMinConfidence) accepted.splice(i, 1);
  }
  structural(seg, config, mode, bold, accepted);
  return aggregate(accepted, config);
}

function score(
  r: CompiledRule,
  start: number,
  end: number,
  seg: TextSegment,
  set: CompiledRuleSet,
  c: SemanticConfig,
  hint: ScriptHint,
  bold: [number, number][],
  mode: AnalysisMode,
): Hit | null {
  const lex = seg.lexical;
  let k = end;
  while (k < lex.length && lex[k] === ' ') k++;
  const atEnd = k >= lex.length;
  const next = atEnd ? '' : lex[k]!;
  const spacedHyphen = next === '-' && lex[k + 1] === ' ';
  const punctuated = STANDALONE_END.has(next) || spacedHyphen;

  if (r.standalone && !(punctuated || (atEnd && seg.closed))) return null;
  if (mode === 'early' && !punctuated) return null;
  if (r.negatable && negated(lex, start, seg.clauseStarts, set.negators)) return null;

  let conf = r.confidence ?? c.tierConfidence[r.tier];
  if (start === seg.lexStart && r.position !== 'any') conf += c.segmentStartBonus;
  if (next === ',' || next === ':' || next === '—' || spacedHyphen) conf += c.punctuationBonus;
  if (next === ':' || next === '—' || spacedHyphen) conf += c.announceBonus;
  if (bold.some(([s, e]) => start >= s && end <= e)) conf += c.boldBonus;
  if (start === seg.lexStart && punctuated && !WORD.test(lex.slice(k + 1))) conf += c.standaloneBonus;
  if (r.position === 'any' && lex.length > c.longSegment) conf -= c.longSegmentPenalty;
  if (hint === 'ru' && r.locale === 'uk') conf *= c.otherCyrillicFactor;
  else if (hint === 'uk' && r.locale === 'ru') conf *= c.otherCyrillicFactor;
  else if (hint === 'es' && r.locale === 'en') conf *= c.englishInSpanishFactor;

  return {
    kind: r.kind,
    role: r.role,
    tier: r.tier,
    locale: r.locale,
    marker: seg.text.slice(start, end),
    start,
    end,
    confidence: clamp01(conf),
    strength: r.strength ?? c.tierStrength[r.tier],
    words: r.words,
    specificity: r.standalone ? 3 : SPECIFICITY[r.position],
  };
}

/** A negator among the two words right before `start`, inside the same clause ("not very important"). */
function negated(lex: string, start: number, clauseStarts: readonly number[], negators: ReadonlySet<string>): boolean {
  let clause = 0;
  for (const s of clauseStarts) if (s <= start) clause = s;
  const before = lex.slice(clause, start).match(/[\p{L}']+/gu);
  if (!before) return false;
  for (const w of before.slice(-2)) if (negators.has(w) || w.endsWith("n't")) return true;
  return false;
}

/** Longest (then most specific, then most confident) match wins; equal spans of different kinds coexist. */
function resolveOverlaps(hits: Hit[]): Hit[] {
  hits.sort(
    (a, b) =>
      b.words - a.words || b.end - b.start - (a.end - a.start) || b.specificity - a.specificity || b.confidence - a.confidence,
  );
  const out: Hit[] = [];
  for (const h of hits) {
    let ok = true;
    for (const a of out) {
      if (h.end <= a.start || h.start >= a.end) continue;
      if (h.start === a.start && h.end === a.end && h.kind !== a.kind && !out.some((x) => x.start === h.start && x.end === h.end && x.kind === h.kind)) continue;
      ok = false;
      break;
    }
    if (ok) out.push(h);
  }
  return out;
}

/** Short quoted spans ("…", '…' after normalization), [open quote, close quote]. */
function quoteRanges(text: string): [number, number][] {
  const out: [number, number][] = [];
  for (const m of text.matchAll(/"[^"\n]{1,60}"/g)) out.push([m.index, m.index + m[0].length - 1]);
  return out;
}

function boldRanges(text: string): [number, number][] {
  const out: [number, number][] = [];
  for (const m of text.matchAll(/\*\*([^*]+)\*\*|__([^_]+)__/g)) out.push([m.index, m.index + m[0].length]);
  return out;
}

function structuralHit(kind: RuleKind, confidence: number, marker: string, start: number, end: number, role?: EnumerationRole): Hit {
  return { kind, role, tier: confidence >= 0.85 ? 'strong' : confidence >= 0.65 ? 'medium' : 'weak', locale: null, marker, start, end, confidence, strength: 0.8, words: 0, specificity: 0 };
}

function structural(seg: TextSegment, c: SemanticConfig, mode: AnalysisMode, bold: [number, number][], out: Hit[]): void {
  const s = c.structural;
  const text = seg.text;
  const lead = text.slice(0, seg.lexStart);
  if (lead.includes('¿')) out.push(structuralHit('question', s.invertedQuestion, '¿', lead.indexOf('¿'), lead.indexOf('¿') + 1));
  if (seg.indexInBlock === 0 && (seg.block === 'ordered' || seg.block === 'bullet')) {
    const item = seg.block === 'ordered' ? s.orderedItem : s.bulletItem;
    const hit = structuralHit('enumeration', item, seg.block === 'ordered' ? `${seg.listNumber ?? ''}.` : '•', 0, 0, 'item');
    hit.strength = 0.7;
    out.push(hit);
  }
  if (mode === 'early') return;

  const tail = text.replace(/[\s"')\]*_»]+$/, '');
  const last = tail[tail.length - 1];
  if (last === '?') out.push(structuralHit('question', s.questionMark, '?', tail.length - 1, tail.length));
  else if (last === '!') out.push(structuralHit('emphasis', s.exclamation, '!', tail.length - 1, tail.length));
  if (seg.introducesList) out.push(structuralHit('enumeration', s.listIntro, ':', tail.length - 1, tail.length, 'intro'));
  if (seg.block === 'heading') out.push(structuralHit('emphasis', s.heading, '#', 0, text.length));
  for (const [bs, be] of bold) out.push(structuralHit('emphasis', be - bs <= 40 ? s.bold : s.bold - 0.1, text.slice(bs, be), bs, be));
  for (const m of text.matchAll(/(?<![*\p{L}])\*(?!\s)[^*\n]+?(?<!\s)\*(?![*\p{L}])/gu)) {
    out.push(structuralHit('emphasis', s.italic, m[0], m.index, m.index + m[0].length));
  }
  const caps = /(?<![\p{L}\p{N}])\p{Lu}{3,}(?:\s+\p{Lu}{3,})+(?![\p{L}\p{N}])/u.exec(text);
  if (caps) out.push(structuralHit('emphasis', s.caps, caps[0], caps.index, caps.index + caps[0].length));
  if (
    seg.block === 'paragraph' &&
    seg.closed &&
    seg.blockSize === 1 &&
    seg.blockIndex > 0 &&
    text.length <= s.shortParagraphChars &&
    (last === '.' || last === '!')
  ) {
    out.push(structuralHit('emphasis', s.shortParagraph, text, 0, text.length));
  }
}

function aggregate(hits: Hit[], c: SemanticConfig): SegmentAnalysis {
  const matches: SemanticMatchInfo[] = hits
    .filter((h) => h.kind !== 'none')
    .sort((a, b) => a.start - b.start)
    .map((h) => ({ kind: h.kind as SemanticMatchInfo['kind'], role: h.role, marker: h.marker, locale: h.locale, tier: h.tier, confidence: round3(h.confidence), start: h.start, end: h.end }));

  const modifiers: SemanticModifier[] = [];
  const byType = new Map<SemanticCueType, { miss: number; best: Hit; strength: number; first: number; final: boolean }>();
  for (const h of hits) {
    if (MODIFIER_SET.has(h.kind)) {
      if (!modifiers.includes(h.kind as SemanticModifier)) modifiers.push(h.kind as SemanticModifier);
      continue;
    }
    if (!CUE_SET.has(h.kind)) continue;
    const t = h.kind as SemanticCueType;
    const a = byType.get(t);
    if (!a) byType.set(t, { miss: 1 - h.confidence, best: h, strength: h.strength, first: h.start, final: h.role === 'final' });
    else {
      a.miss *= 1 - h.confidence;
      a.strength = Math.max(a.strength, h.strength);
      a.first = Math.min(a.first, h.start);
      if (h.role === 'final') a.final = true;
      // The structural list-item marker defines the role over a lexical "next"/"also".
      if (h.confidence > a.best.confidence || (h.role === 'item' && h.locale === null && a.best.role !== 'item')) a.best = h;
    }
  }

  // Agreement vs disagreement in one segment: whichever opens it is the answer ("Да, это неверно" is agreement +
  // a statement; "Нет, правильно так:" is disagreement).
  const ag = byType.get('agreement');
  const dis = byType.get('disagreement');
  if (ag && dis) byType.delete(ag.first <= dis.first ? 'disagreement' : 'agreement');

  const emphasis = byType.get('emphasis');
  const emphasisConf = emphasis ? 1 - emphasis.miss : 0;
  const cues: SegmentCue[] = [];
  for (const type of CUE_RANK) {
    const a = byType.get(type);
    if (!a) continue;
    const confidence = round3(1 - a.miss);
    // Weak markers add up, but never make a cue on their own: one marker must be at least minMarkerConfidence.
    if (confidence < c.minConfidence || a.best.confidence < c.minMarkerConfidence) continue;
    let strength = a.strength + modifiers.length * c.modifierStrengthBoost;
    if (type !== 'emphasis') strength += c.emphasisStrengthBoost * emphasisConf;
    cues.push({
      type,
      // "И наконец" on a "3." item is the final item; otherwise the strongest marker says intro or item.
      role: type === 'enumeration' ? (a.final ? 'final' : (a.best.role ?? 'item')) : undefined,
      confidence,
      strength: round3(clamp01(strength)),
      start: a.best.start,
      end: a.best.end,
      marker: a.best.marker,
    });
  }
  return { matches, cues, modifiers };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
