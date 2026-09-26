// Text preparation for the semantic analyser: normalization and segmentation. Pure functions on strings.

/**
 * Canonical form of a message: NFC, one kind of quote, dash and hyphen, collapsed spaces, at most one blank line.
 * Punctuation is kept (it carries discourse structure) and so is case (uppercase emphasis). Local rewrites only,
 * so a streamed message normalizes to a growing prefix of the finished one.
 */
export function normalizeText(input: string): string {
  return input
    .normalize('NFC')
    .replace(/[​-‍﻿­]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[‘’‚‛ʼ′]/g, "'")
    .replace(/[«»„“”‟″]/g, '"')
    .replace(/[‐‑]/g, '-')
    .replace(/[‒–—―−]/g, '—')
    .replace(/[ \t  -   　]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s+/, '');
}

/**
 * Lowercase for lexical matching with the same length as the input, so match offsets stay valid in the original
 * (`toLowerCase` can change length for a few characters, e.g. "İ"). `ё` becomes `е`.
 */
export function lowerSameLength(s: string): string {
  let lower = s.toLowerCase();
  if (lower.length !== s.length) {
    let out = '';
    for (const ch of s) {
      const l = ch.toLowerCase();
      out += l.length === ch.length ? l : ch;
    }
    lower = out;
  }
  return lower.replace(/ё/g, 'е');
}

export type BlockKind = 'paragraph' | 'ordered' | 'bullet' | 'heading';

/** One sentence (or list item, or heading) of a message. Offsets are into the normalized message text. */
export interface TextSegment {
  /** Index among the message's segments; stable while the message streams (segments only ever get appended). */
  ordinal: number;
  start: number;
  end: number;
  /** Normalized text of the segment (no list marker, no heading hashes). */
  text: string;
  /** `text` for matching: same length, lowercase, Markdown syntax and inline code blanked out. */
  lexical: string;
  /** First letter or digit of `lexical` (skips opening quotes, ¿, dashes). */
  lexStart: number;
  /** Starts of clauses in `lexical` (lexStart first): after , ; : ( — and spaced hyphens. */
  clauseStarts: number[];
  block: BlockKind;
  /** Index of the block within the message and of the segment within the block. */
  blockIndex: number;
  indexInBlock: number;
  /** Segments of this block known so far (final once the segment is closed and the block ended). */
  blockSize: number;
  /** Number of an ordered list item ("2." → 2). */
  listNumber?: number;
  /** The block is a paragraph ending with ":" and a list block follows it. */
  introducesList: boolean;
  /** More text follows (or the message is complete): the segment will not change any more. */
  closed: boolean;
}

interface Block {
  kind: BlockKind;
  start: number;
  end: number;
  listNumber?: number;
}

const HEADING = /^#{1,6}\s+/;
const ORDERED = /^(\d{1,3}|[IVXLC]{1,5}|[ivx]{1,4})[.)]\s+/;
const BULLET = /^[-*•+]\s+/;
const QUOTE = /^>\s?/;
const FENCE = /^(```|~~~)/;
const TERMINAL = /[.!?…]/;
/** After a sentence terminal: characters that belong to it (closing quotes, brackets, Markdown). */
const CLOSERS = /[.!?…"')\]»*_]/;
/** What may start a new sentence after a terminal. Lowercase does not: "т. е. это", "e.g. this", "3.5". */
const SENTENCE_START = /[\p{Lu}\p{N}"'¿¡(«—\-*_#]/u;
const WORD = /[\p{L}\p{N}]/u;

function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let inFence = false;
  let para: Block | null = null;
  let pos = 0;
  for (const line of text.split('\n')) {
    const lineStart = pos;
    const lineEnd = pos + line.length;
    pos = lineEnd + 1;
    const trimmed = line.trimStart();
    if (FENCE.test(trimmed)) {
      // Code is not speech: fenced blocks produce no segments (an open fence swallows the rest while streaming).
      inFence = !inFence;
      para = null;
      continue;
    }
    if (inFence) continue;
    if (trimmed.length === 0) {
      para = null;
      continue;
    }
    const lead = lineStart + (line.length - trimmed.length);
    let m: RegExpExecArray | null;
    if ((m = HEADING.exec(trimmed))) {
      blocks.push({ kind: 'heading', start: lead + m[0].length, end: lineEnd });
      para = null;
    } else if ((m = ORDERED.exec(trimmed))) {
      blocks.push({ kind: 'ordered', start: lead + m[0].length, end: lineEnd, listNumber: listNumber(m[1]!) });
      para = null;
    } else if ((m = BULLET.exec(trimmed))) {
      blocks.push({ kind: 'bullet', start: lead + m[0].length, end: lineEnd });
      para = null;
    } else {
      const q = QUOTE.exec(trimmed);
      const start = lead + (q ? q[0].length : 0);
      if (para) para.end = lineEnd;
      else blocks.push((para = { kind: 'paragraph', start, end: lineEnd }));
    }
  }
  return blocks;
}

function listNumber(token: string): number {
  if (/^\d+$/.test(token)) return Number(token);
  const roman: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100 };
  let n = 0;
  const t = token.toLowerCase();
  for (let i = 0; i < t.length; i++) {
    const v = roman[t[i]!] ?? 0;
    const next = roman[t[i + 1]!] ?? 0;
    n += v < next ? -v : v;
  }
  return n;
}

/** Sentence ranges inside [start, end). */
function sentences(text: string, start: number, end: number): [number, number][] {
  const out: [number, number][] = [];
  let s = start;
  let i = start;
  while (i < end) {
    if (!TERMINAL.test(text[i]!)) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < end && CLOSERS.test(text[j]!)) j++;
    const sentenceEnd = j;
    while (j < end && (text[j] === ' ' || text[j] === '\n')) j++;
    if (j >= end) break;
    if (j > sentenceEnd && SENTENCE_START.test(text[j]!)) {
      out.push([s, sentenceEnd]);
      s = j;
    }
    i = j;
  }
  out.push([s, end]);
  return out;
}

/** Same-length lexical view: lowercase, `ё`→`е`, Markdown emphasis and inline code blanked. */
function lexicalOf(text: string): string {
  const blanked = text.replace(/`[^`]*`?/g, (m) => ' '.repeat(m.length)).replace(/[*#]|__/g, (m) => ' '.repeat(m.length));
  return lowerSameLength(blanked);
}

function clauseStartsOf(lexical: string, lexStart: number): number[] {
  const starts = [lexStart];
  for (let i = lexStart; i < lexical.length; i++) {
    const c = lexical[i]!;
    const spacedHyphen = c === '-' && lexical[i - 1] === ' ' && lexical[i + 1] === ' ';
    if (c === ',' || c === ';' || c === ':' || c === '(' || c === '—' || c === '\n' || spacedHyphen) {
      let j = i + 1;
      while (j < lexical.length && !WORD.test(lexical[j]!)) {
        if (TERMINAL.test(lexical[j]!)) break;
        j++;
      }
      if (j < lexical.length && WORD.test(lexical[j]!) && starts[starts.length - 1] !== j) starts.push(j);
    }
  }
  return starts;
}

/**
 * Splits a normalized message into segments: paragraphs, list items and headings, then sentences. Fenced code is
 * skipped. The last segment is open (still streaming) unless `complete`.
 */
export function segmentText(text: string, complete = false): TextSegment[] {
  const blocks = parseBlocks(text);
  const out: TextSegment[] = [];
  for (let b = 0; b < blocks.length; b++) {
    const block = blocks[b]!;
    const ranges = sentences(text, block.start, block.end);
    const first = out.length;
    let index = 0;
    for (const [rs, re] of ranges) {
      let s = rs;
      let e = re;
      while (s < e && (text[s] === ' ' || text[s] === '\n')) s++;
      while (e > s && (text[e - 1] === ' ' || text[e - 1] === '\n')) e--;
      const segText = text.slice(s, e);
      const lexical = lexicalOf(segText);
      let lexStart = 0;
      while (lexStart < lexical.length && !WORD.test(lexical[lexStart]!)) lexStart++;
      if (lexStart >= lexical.length) continue; // no words: "---", a bare "1."
      const seg: TextSegment = {
        ordinal: out.length,
        start: s,
        end: e,
        text: segText,
        lexical,
        lexStart,
        clauseStarts: clauseStartsOf(lexical, lexStart),
        block: block.kind,
        blockIndex: b,
        indexInBlock: index++,
        blockSize: 0,
        introducesList: false,
        closed: true,
      };
      if (block.listNumber !== undefined && seg.indexInBlock === 0) seg.listNumber = block.listNumber;
      out.push(seg);
    }
    for (let i = first; i < out.length; i++) out[i]!.blockSize = out.length - first;
    const next = blocks[b + 1];
    if (block.kind === 'paragraph' && next && (next.kind === 'ordered' || next.kind === 'bullet') && out.length > first) {
      const last = out[out.length - 1]!;
      if (/:\s*\**$/.test(last.text)) last.introducesList = true;
    }
  }
  if (!complete && out.length > 0) out[out.length - 1]!.closed = false;
  return out;
}

export type ScriptHint = 'ru' | 'uk' | 'es' | null;

/** Which language the letters say, where they can: Ukrainian vs Russian Cyrillic, Spanish vs other Latin. */
export function scriptHint(lowerText: string): ScriptHint {
  let uk = 0;
  let ru = 0;
  let es = 0;
  for (const ch of lowerText) {
    if (ch === 'і' || ch === 'ї' || ch === 'є' || ch === 'ґ') uk++;
    else if (ch === 'ы' || ch === 'э' || ch === 'ъ' || ch === 'ё') ru++;
    else if (ch === 'ñ' || ch === '¿' || ch === '¡' || ch === 'á' || ch === 'é' || ch === 'í' || ch === 'ó' || ch === 'ú') es++;
  }
  if (uk >= 2 && uk > ru * 2) return 'uk';
  if (ru >= 2 && ru > uk * 2) return 'ru';
  if (es >= 2) return 'es';
  return null;
}
