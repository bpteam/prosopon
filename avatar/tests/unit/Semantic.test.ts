import { describe, expect, it } from 'vitest';
import { SemanticAnalyzer, analyzeText } from '../../src/semantic/SemanticAnalyzer';
import { SEMANTIC_CUE_TYPES, type SemanticCueType, type SemanticIntent } from '../../src/semantic/SemanticCue';
import { SemanticPacer } from '../../src/semantic/SemanticPacer';
import { compileRules, defaultRuleSet, SEMANTIC_LOCALE_RULES, tokenize } from '../../src/semantic/SemanticRuleSet';
import { normalizeText, scriptHint, segmentText } from '../../src/semantic/SemanticText';
import { DEMO_REPLIES } from '../../src/semantic/demoReplies';
import { CONFLICTS, MULTI, NEGATIVE, POSITIVE } from './semanticFixtures';

const cuesOf = (text: string): SemanticCueType[] => analyzeText(text).flatMap((i) => i.cues.map((c) => c.type));
const LOCALES = ['en', 'ru', 'uk', 'es'] as const;

describe('vocabulary', () => {
  const counts = defaultRuleSet().counts;

  it('covers every cue category in all four languages', () => {
    for (const type of SEMANTIC_CUE_TYPES) {
      for (const locale of LOCALES) {
        const n = type === 'enumeration' ? (counts['enumeration-intro']?.[locale] ?? 0) + (counts['enumeration-item']?.[locale] ?? 0) : (counts[type]?.[locale] ?? 0);
        expect(n, `${type}/${locale}`).toBeGreaterThanOrEqual(15);
      }
    }
  });

  it('is well beyond the minimal set: at least 20 constructions per category and language where it matters', () => {
    for (const type of ['contrast', 'conclusion', 'agreement', 'disagreement', 'emphasis', 'question'] as const) {
      for (const locale of LOCALES) expect(counts[type]?.[locale] ?? 0, `${type}/${locale}`).toBeGreaterThanOrEqual(20);
    }
    expect(defaultRuleSet().rules.length).toBeGreaterThan(1500);
  });

  it('phrases are clean data: lowercase, no stray whitespace, no duplicates within a group', () => {
    for (const l of SEMANTIC_LOCALE_RULES) {
      for (const g of l.groups) {
        const seen = new Set<string>();
        for (const p of g.phrases) {
          expect(p, `${l.locale}: "${p}"`).toBe(p.trim());
          expect(p, `${l.locale}: "${p}"`).toBe(p.toLowerCase());
          expect(p).not.toMatch(/\s{2,}|ё|’/);
          expect(seen.has(p), `${l.locale}/${g.kind}: duplicate "${p}"`).toBe(false);
          seen.add(p);
        }
      }
    }
  });

  it('compiles once, fast, into a token trie (no per-mutation RegExp)', () => {
    const t0 = performance.now();
    compileRules();
    expect(performance.now() - t0).toBeLessThan(250);
    expect(defaultRuleSet()).toBe(defaultRuleSet());
  });
});

describe('normalization and segmentation', () => {
  it('unifies quotes, dashes, apostrophes and whitespace; keeps punctuation and case', () => {
    expect(normalizeText('  «Так» —  это “да”…  не‑обов’язково\r\n')).toBe('"Так" — это "да"… не-обов\'язково\n');
    expect(normalizeText('a\n\n\n\nb')).toBe('a\n\nb');
  });

  it('tokenizes Unicode words with inner hyphens and apostrophes', () => {
    expect(tokenize('во-первых, don\'t п\'ять ¿qué?').map((t) => t.text)).toEqual(['во-первых', ',', "don't", "п'ять", '¿', 'qué', '?']);
  });

  it('splits paragraphs, list items, headings and sentences; skips fenced code', () => {
    const segs = segmentText(normalizeText('# Итог\n\nДа. Но есть нюанс: т. е. не всё.\n\n1. Первое\n2. Второе\n\n```\nif (a) { return "Но"; }\n```\n\nКонец'), true);
    expect(segs.map((s) => [s.block, s.text])).toEqual([
      ['heading', 'Итог'],
      ['paragraph', 'Да.'],
      ['paragraph', 'Но есть нюанс: т. е. не всё.'],
      ['ordered', 'Первое'],
      ['ordered', 'Второе'],
      ['paragraph', 'Конец'],
    ]);
    expect(segs[3]!.listNumber).toBe(1);
    expect(segs.every((s) => s.closed)).toBe(true);
  });

  it('marks a paragraph ending with ":" before a list as a list intro', () => {
    const segs = segmentText('Варианты такие:\n- быстрый\n- дешёвый', true);
    expect(segs[0]!.introducesList).toBe(true);
    expect(cuesOf('Смотри:\n- быстрый\n- дешёвый')).toContain('enumeration');
  });

  it('keeps the last segment open while streaming', () => {
    const segs = segmentText('Да. Но', false);
    expect(segs.map((s) => s.closed)).toEqual([true, false]);
  });

  it('script hint separates Ukrainian from Russian and spots Spanish', () => {
    expect(scriptHint('це дуже цікаво, і ще є')).toBe('uk');
    expect(scriptHint('это были съёмки')).toBe('ru');
    expect(scriptHint('¿qué opción elegirías?')).toBe('es');
    expect(scriptHint('plain english')).toBeNull();
  });
});

describe('rules: positive fixtures (table-driven, every category × language)', () => {
  const rows = Object.entries(POSITIVE).flatMap(([type, byLocale]) =>
    Object.entries(byLocale).flatMap(([locale, texts]) => texts.map((text) => [type as SemanticCueType, locale, text] as const)),
  );
  it.each(rows)('%s / %s: %s', (type, _locale, text) => {
    expect(cuesOf(text)).toContain(type);
  });
});

describe('rules: false positives, negation and word boundaries', () => {
  it.each(NEGATIVE)('%s → not %s', (text, type) => {
    expect(cuesOf(text)).not.toContain(type);
  });

  it('spec pairs', () => {
    expect(cuesOf('Да.')).toContain('agreement');
    expect(cuesOf('Правильно.')).toContain('agreement');
    expect(cuesOf('No.')).toContain('disagreement');
    expect(cuesOf('No obstante, sí.')).toContain('contrast');
    expect(cuesOf('Так.')).toContain('agreement');
    expect(cuesOf('Right.')).toContain('agreement');
    expect(cuesOf('Claro.')).toContain('agreement');
  });

  it('"Да." scores higher than a bare weak marker; "Да, именно." is certain', () => {
    const conf = (t: string) => analyzeText(t)[0]!.cues.find((c) => c.type === 'agreement')!.confidence;
    expect(conf('Да.')).toBeGreaterThan(0.85);
    expect(conf('Да, именно.')).toBeGreaterThanOrEqual(0.99);
    expect(conf('Да, именно.')).toBeGreaterThan(conf('Так.'));
  });

  it('a Russian "Так," is not Ukrainian "yes" once the script says Russian', () => {
    expect(cuesOf('Так, давайте разберёмся, что тут происходит. Это был сложный вопрос, и ответ на него тоже непростой.')).not.toContain('agreement');
    expect(cuesOf('Так, це правильний підхід, і він працює. Є ще кілька деталей, які варто врахувати.')).toContain('agreement');
  });

  it('weak markers never make a cue on their own', () => {
    expect(cuesOf('You need to restart it.')).toEqual([]);
    expect(cuesOf('Нужно перезапустить.')).toEqual([]);
    expect(cuesOf('Hay que reiniciarlo.')).toEqual([]);
  });
});

describe('rules: multi-word precedence, aggregation and conflicts', () => {
  it.each(MULTI)('%s → %j', (text, types) => {
    const c = cuesOf(text);
    for (const t of types) expect(c).toContain(t);
  });

  it.each(CONFLICTS)('%s → %s, not %s', (text, win, lose) => {
    const c = cuesOf(text);
    expect(c).toContain(win);
    expect(c).not.toContain(lose);
  });

  it('several markers of one type aggregate into one cue, not three events', () => {
    const intents = analyzeText('Но главное: этого делать нельзя.');
    expect(intents).toHaveLength(1);
    const cues = intents[0]!.cues;
    expect(cues.map((c) => c.type).sort()).toEqual(['contrast', 'emphasis']);
    const emphasis = cues.find((c) => c.type === 'emphasis')!;
    expect(emphasis.confidence).toBeGreaterThan(0.88);
    // Emphasis in the segment strengthens the contrast.
    expect(cues.find((c) => c.type === 'contrast')!.strength).toBeGreaterThan(0.8);
    expect(intents[0]!.matches.filter((m) => m.kind === 'emphasis').length).toBeGreaterThanOrEqual(2);
  });

  it('agreement and disagreement in one segment: the opening one wins', () => {
    expect(cuesOf('Нет, это правильно только для малых данных.')).not.toContain('agreement');
    expect(cuesOf('Yes, no other option works here.')).not.toContain('disagreement');
  });

  it('modifiers (example, cause, clarification) strengthen cues but never start one', () => {
    expect(analyzeText('For example, a cache.')).toEqual([]);
    const [intent] = analyzeText('But, for example, a cache helps because it is local.');
    expect(intent!.modifiers.sort()).toEqual(['cause', 'example']);
  });

  it('structural signals: ?, ¿, list items, bold, headings, CAPS', () => {
    expect(cuesOf('Это работает?')).toEqual(['question']);
    expect(cuesOf('¿Funciona')).toContain('question');
    expect(cuesOf('Intro.\n\n1. Alpha beta.\n2. Gamma delta.')).toEqual(['enumeration', 'enumeration']);
    expect(cuesOf('Ok then.\n\nThis is **the only safe option** here.')).toContain('emphasis');
    expect(cuesOf('Start.\n\nDo NOT EVER skip tests.')).toContain('emphasis');
  });

  it('code is not speech: markers inside fenced or inline code are ignored', () => {
    expect(cuesOf('```\nbut however therefore\n```')).toEqual([]);
    expect(cuesOf('Call `however()` now.')).not.toContain('contrast');
  });
});

describe('streaming', () => {
  function stream(text: string, step: number): SemanticIntent[] {
    const a = new SemanticAnalyzer();
    const out: SemanticIntent[] = [];
    for (let n = 1; n <= text.length; n += step) out.push(...a.update('m', text.slice(0, n)));
    out.push(...a.update('m', text, true));
    return out;
  }
  const types = (intents: SemanticIntent[]) => intents.flatMap((i) => i.cues.map((c) => c.type));

  it('"По" … "Поэтому я бы сделал иначе." is one conclusion cue', () => {
    const a = new SemanticAnalyzer();
    const steps = ['По', 'Поэтому', 'Поэтому я', 'Поэтому я бы', 'Поэтому я бы сделал иначе.'];
    const got = steps.flatMap((s, i) => a.update('m', s, i === steps.length - 1));
    expect(types(got)).toEqual(['conclusion']);
  });

  it('"Но" → "Но здесь есть важный нюанс." is one contrast (+ emphasis), not five events', () => {
    const got = stream('Но здесь есть важный нюанс. Дальше.', 1);
    expect(types(got).filter((t) => t === 'contrast')).toHaveLength(1);
  });

  it('a strong marker at the start emits early, before the sentence ends, and only once', () => {
    const a = new SemanticAnalyzer();
    expect(a.update('m', 'Во-первых')).toEqual([]); // could still become something else
    const early = a.update('m', 'Во-первых,');
    expect(early).toHaveLength(1);
    expect(early[0]!.early).toBe(true);
    expect(early[0]!.cues[0]!.type).toBe('enumeration');
    expect(a.update('m', 'Во-первых, это быстро. Во-вторых')).toEqual([]);
    for (const s of ['Однако,', 'Но,', 'Поэтому,', 'Exactly.', 'Sin embargo,', 'However,']) {
      expect(new SemanticAnalyzer().update('m', s).flatMap((i) => i.cues), s).toHaveLength(1);
    }
  });

  it('"No" does not fire early when it may become "No obstante"', () => {
    const a = new SemanticAnalyzer();
    expect(a.update('m', 'No ')).toEqual([]);
    expect(a.update('m', 'No obs')).toEqual([]);
    expect(types(a.update('m', 'No obstante, sirve.', true))).toEqual(['contrast']);
  });

  it.each(Object.keys(DEMO_REPLIES))('demo %s streamed char by char = analysed at once, no duplicate cue ids', (locale) => {
    const text = DEMO_REPLIES[locale as keyof typeof DEMO_REPLIES];
    const streamed = stream(text, 1);
    const ids = streamed.flatMap((i) => i.cues.map((c) => c.id));
    expect(new Set(ids).size).toBe(ids.length);
    const whole = analyzeText(text).flatMap((i) => i.cues.map((c) => `${i.segmentId.split('#')[1]}:${c.type}`)).sort();
    expect(streamed.flatMap((i) => i.cues.map((c) => `${i.segmentId.split('#')[1]}:${c.type}`)).sort()).toEqual(whole);
  });

  it('Markdown re-rendering inside a segment (literal ** → bold) does not duplicate cues', () => {
    const a = new SemanticAnalyzer();
    const got = [
      ...a.update('m', 'Однако, **важ'),
      ...a.update('m', 'Однако, **важно**'),
      ...a.update('m', 'Однако, **важно** помнить. Дальше', false),
      ...a.update('m', 'Однако, **важно** помнить. Дальше.', true),
    ];
    const ids = got.flatMap((i) => i.cues.map((c) => c.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((id) => id.endsWith(':contrast'))).toHaveLength(1);
  });

  it('a new message id starts over', () => {
    const a = new SemanticAnalyzer();
    expect(types(a.update('a', 'Да.', true))).toEqual(['agreement']);
    expect(types(a.update('b', 'Да.', true))).toEqual(['agreement']);
    expect(a.stats.messages).toBe(2);
  });

  it('segment ids are message-scoped ordinals, cue ids are segment × type', () => {
    const [first, second] = new SemanticAnalyzer().update('msg', 'Да. Но есть нюанс. Ок', false);
    expect(first!.segmentId).toBe('msg#0');
    expect(second!.segmentId).toBe('msg#1');
    expect(second!.cues[0]!.id).toBe('msg#1:contrast');
    expect(second!.charStart).toBe(4);
  });
});

describe('performance', () => {
  it('a long reply streamed in small steps costs well under a frame per update', () => {
    const text = Object.values(DEMO_REPLIES).join('\n\n');
    const a = new SemanticAnalyzer();
    const updates = Math.ceil(text.length / 20);
    for (let n = 20; n < text.length + 20; n += 20) a.update('m', text.slice(0, n));
    expect(a.stats.busyMs / updates).toBeLessThan(2);
  });
});

describe('SemanticPacer (text clock)', () => {
  const intent = (charStart: number, messageId = 'm'): SemanticIntent => ({
    messageId,
    segmentId: `${messageId}#${charStart}`,
    charStart,
    charEnd: charStart + 10,
    cues: [],
    modifiers: [],
    early: false,
    text: '',
    matches: [],
  });

  it('text chat (no voice session): releases as the text arrives', () => {
    const p = new SemanticPacer();
    p.push(intent(0));
    p.push(intent(500));
    expect(p.update(0.016, false, false)).toHaveLength(2);
  });

  it('voice: releases when the estimated spoken position reaches the segment', () => {
    const p = new SemanticPacer({ charsPerSecond: 10 });
    p.push(intent(0));
    p.push(intent(30));
    expect(p.update(0.016, true, true)).toHaveLength(1);
    let released = 0;
    for (let t = 0; t < 2.5; t += 0.1) released += p.update(0.1, true, true).length;
    expect(released).toBe(0);
    for (let t = 0; t < 1; t += 0.1) released += p.update(0.1, true, true).length;
    expect(released).toBe(1);
  });

  it('does not advance while the assistant is silent', () => {
    const p = new SemanticPacer({ charsPerSecond: 10 });
    p.push(intent(20));
    for (let t = 0; t < 5; t += 0.1) expect(p.update(0.1, true, false)).toEqual([]);
    expect(p.status.pending).toBe(1);
  });

  it('drops intents the speech already passed by more than staleSeconds', () => {
    const p = new SemanticPacer({ charsPerSecond: 10, staleSeconds: 1 });
    for (let t = 0; t < 5; t += 0.1) p.update(0.1, true, true);
    p.push(intent(0)); // same turn, 50 chars already spoken
    expect(p.update(0.016, true, true)).toEqual([]);
    expect(p.status.dropped).toBe(1);
  });

  it('a new reply after a silence starts from zero; one whose speech started first counts that speech', () => {
    const p = new SemanticPacer({ charsPerSecond: 10 });
    for (let t = 0; t < 3; t += 0.1) p.update(0.1, true, true);
    for (let t = 0; t < 3; t += 0.1) p.update(0.1, true, false); // turn over
    p.push(intent(5, 'b'));
    expect(p.update(0.016, true, false)).toEqual([]);
    expect(p.status.spokenChars).toBe(0);
    for (let t = 0; t < 1; t += 0.1) p.update(0.1, true, true); // speech of reply c starts before its text
    p.push(intent(5, 'c'));
    expect(p.update(0.016, true, true)).toHaveLength(1);
  });

  it('pacing off: immediate even in voice mode', () => {
    const p = new SemanticPacer();
    p.enabled = false;
    p.push(intent(1000));
    expect(p.update(0.016, true, true)).toHaveLength(1);
  });
});
