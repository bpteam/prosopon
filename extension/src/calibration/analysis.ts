import type { SemanticDecision } from '@avatar/avatar/gesture/SemanticGesturePolicy';
import type { SemanticCueType } from '@avatar/semantic/SemanticCue';
import type {
  CalibrationEvent,
  CalibrationLanguage,
  CalibrationScenario,
  CalibrationStep,
  RecordedGesture,
  RecordedIntent,
  StepRecord,
} from './types';

/**
 * Automatic failure analysis of a calibration session: for every expectation of every sample, where along
 * text → cue → release → policy → engine → mixer → pose the behaviour was lost. Rule-based and deterministic; no
 * model, no network. The categories are what the next coding agent triages on (AGENT_TASK.md).
 */

export const VERDICTS = {
  OK: 'expected behaviour happened',
  INVALID_SAMPLE: 'the sample was not recorded (see invalidReason)',
  NO_REPLY_TEXT: 'no reply text in the page: the semantic layer had nothing to read',
  SEMANTIC_MISS: 'the reply text was there but the analyser found no such cue',
  PACING_DROP: 'the cue was found but the text clock never released it (dropped as late, or still pending)',
  GESTURE_POLICY_SUPPRESSION: 'the cue reached SemanticGesturePolicy, which declined every time',
  GESTURE_NOT_STARTED: 'the policy accepted but no semantic gesture started',
  FORBIDDEN_GESTURE: 'a gesture of a forbidden family ran',
  WRONG_GESTURE_FAMILY: 'a semantic gesture ran, but not of a preferred family',
  GESTURE_CLAMPED: 'the gesture asked for much more than GESTURE_LIMITS allowed',
  MIX_OR_AMPLITUDE_TOO_LOW: 'the gesture ran but its part of the final pose stayed below the visible threshold',
  FALSE_POSITIVE_SEMANTIC: 'a negative-control text produced semantic cues',
  FALSE_POSITIVE_GESTURE: 'a negative-control text produced a semantic gesture',
  PROSODY_NOT_SEPARATED: 'high- and low-energy replies ended with nearly the same arousal/energy',
  VAD_MISSED: 'the user spoke (asked to) but VAD did not detect speech',
  UTTERANCE_FRAGMENTED: 'one short phrase was split into several utterances (VAD hangover)',
  USER_ENERGY_NOT_SEPARATED: 'energetic and normal user speech ended with nearly the same energy',
  INTERRUPTION_MISSED: 'the user interrupted but the state never switched to listening',
  INTERRUPTION_SLOW: 'the switch to listening took longer than expected',
  GESTURE_NOT_CANCELLED: 'a gesture kept running well after the user interrupted',
} as const;
export type Verdict = keyof typeof VERDICTS;

/** Thresholds of the analysis (not of the avatar). Recorded in summary.json. */
export const ANALYSIS_THRESHOLDS = Object.freeze({
  /** A head/body gesture below this (radians, ≈1°) is not visibly meaningful. */
  visibleRad: 0.017,
  /** Arm offsets below this (radians, ≈3°) are not visibly meaningful. */
  visibleArmRad: 0.05,
  /** peakApplied / peakRequested below this: the gesture limits clamped it. */
  clampRatio: 0.7,
  /** Minimum arousal (or energy) difference between the high- and low-energy replies. */
  prosodySeparation: 0.08,
  userEnergySeparation: 0.05,
  /** Onset of the user's speech → listening, seconds (300 ms interruption minimum + a frame budget). */
  interruptionLatency: 0.6,
  interruptionMissed: 2,
  /** A gesture still running this long after the switch to listening was not cancelled. */
  gestureCancel: 0.5,
});

export interface ExpectationResult {
  expect: string;
  verdict: Verdict;
  detail?: string;
}

export interface StepResult {
  step: string;
  kind: StepRecord['kind'];
  language: CalibrationLanguage;
  category: string;
  valid: boolean;
  invalidReason: string | null;
  requestedText: string;
  actualRenderedText: string | null;
  textSource: StepRecord['textSource'];
  expected: CalibrationStep['expected'];
  observed: {
    cues: SemanticCueType[];
    intentsAnalysed: number;
    intentsReleased: number;
    decisions: { cue: SemanticCueType | null; accepted: boolean; reason: string | null; gesture: string | null; probability: number }[];
    gestures: Pick<RecordedGesture, 'type' | 'family' | 'source' | 'intensity' | 'peakRequested' | 'peakApplied' | 'peakFinal' | 'channel'>[];
    assistantSpeechSeconds: number;
    userSpeechSeconds: number;
    charsPerSecond: number | null;
    wordsPerSecond: number | null;
    prosody: { arousal: number; energy: number; pitchVariation: number; speechRate: number } | null;
    user: { energy: number; pitchHz: number | null; pitchVariation: number; utterances: number } | null;
    interruption: { onsetToListening: number | null; onsetToAssistantStop: number | null; gestureCancel: number | null } | null;
  };
  verdicts: ExpectationResult[];
  manualFlags: StepRecord['manualFlags'];
}

export interface LanguageSummary {
  samples: { valid: number; total: number };
  speechRate: { charsPerSecond: number | null; wordsPerSecond: number | null };
  assistantProsody: { arousal: number | null; energy: number | null; pitchVariation: number | null };
  energyPair: { highArousal: number | null; lowArousal: number | null; separated: boolean | null };
  gestures: { total: number; semantic: number; perMinuteOfSpeech: number | null; visible: number };
  semanticDetection: number | null;
  policyAcceptance: number | null;
  verdicts: Partial<Record<Verdict, number>>;
  user: { normalEnergy: number | null; energeticEnergy: number | null; pitchHz: number | null } | null;
  interruption: { onsetToListening: number | null; onsetToAssistantStop: number | null } | null;
}

export interface CalibrationSummary {
  voice: string;
  languages: CalibrationLanguage[];
  samples: { valid: number; total: number };
  semanticDetection: number | null;
  policyAcceptance: number | null;
  gestureStarts: number;
  semanticGestureStarts: number;
  visiblyMeaningfulGestures: number;
  verdicts: Partial<Record<Verdict, number>>;
  /** Most frequent failure among assistant expectations (null when none failed). */
  bottleneck: Verdict | null;
  bottleneckExplanation: string | null;
  pacing: {
    configuredCharsPerSecond: number;
    measured: Partial<Record<CalibrationLanguage, number | null>>;
    /** Median of the measured languages; null without reply text. */
    suggestedCharsPerSecond: number | null;
    textSource: 'dom' | 'requested' | 'none';
  };
  manualFlags: { step: string; reason: string }[];
  byLanguage: Partial<Record<CalibrationLanguage, LanguageSummary>>;
  thresholds: typeof ANALYSIS_THRESHOLDS;
}

export interface CalibrationAnalysis {
  results: StepResult[];
  summary: CalibrationSummary;
}

export interface AnalysisInput {
  scenario: CalibrationScenario;
  records: readonly StepRecord[];
  events: readonly CalibrationEvent[];
  intents: readonly RecordedIntent[];
  released: readonly RecordedIntent[];
  decisions: readonly (SemanticDecision & { t: number; step: string | null })[];
  gestures: readonly RecordedGesture[];
  /** trace.jsonl rows (JSON strings). */
  traceRows: readonly string[];
  voice: string;
  configuredCharsPerSecond: number;
}

interface TraceRow {
  t: number;
  step: string | null;
  signals: { assistantSpeaking: boolean; userSpeaking: boolean };
  emotion: { assistant: { arousal: number; energy: number; pitchVariation: number; speechRate: number; active: boolean } };
  user: { energy: number; pitchHz: number | null; pitchVariation: number; speaking: boolean };
}

const T = ANALYSIS_THRESHOLDS;

export function analyseCalibration(input: AnalysisInput): CalibrationAnalysis {
  const steps = new Map(input.scenario.steps.map((s) => [s.id, s] as const));
  const rows = new Map<string, TraceRow[]>();
  for (const line of input.traceRows) {
    const r = JSON.parse(line) as TraceRow;
    if (!r.step) continue;
    let list = rows.get(r.step);
    if (!list) rows.set(r.step, (list = []));
    list.push(r);
  }
  const by = <X extends { step: string | null }>(items: readonly X[], step: string) => items.filter((x) => x.step === step);

  const results: StepResult[] = [];
  for (const rec of input.records) {
    const step = steps.get(rec.stepId);
    if (!step) continue;
    const intents = by(input.intents, rec.stepId);
    const released = by(input.released, rec.stepId);
    const decisions = by(input.decisions, rec.stepId);
    const gestures = by(input.gestures, rec.stepId);
    const stepRows = rows.get(rec.stepId) ?? [];
    const cues = unique(intents.flatMap((i) => i.cues.map((c) => c.type)));
    const text = rec.actualRenderedText;
    const speech = rec.assistantSpeechSeconds;
    const result: StepResult = {
      step: rec.stepId,
      kind: rec.kind,
      language: rec.language,
      category: rec.category,
      valid: rec.valid,
      invalidReason: rec.invalidReason,
      requestedText: rec.requestedText,
      actualRenderedText: text,
      textSource: rec.textSource,
      expected: step.expected,
      observed: {
        cues,
        intentsAnalysed: intents.length,
        intentsReleased: released.length,
        decisions: decisions.map((d) => ({ cue: d.cue, accepted: d.accepted, reason: d.reason, gesture: d.gesture, probability: d.probability })),
        gestures: gestures.map(({ type, family, source, intensity, peakRequested, peakApplied, peakFinal, channel }) => ({
          type,
          family,
          source,
          intensity,
          peakRequested,
          peakApplied,
          peakFinal,
          channel,
        })),
        assistantSpeechSeconds: speech,
        userSpeechSeconds: rec.userSpeechSeconds,
        charsPerSecond: rec.kind === 'assistant' && text && speech > 0.5 ? round(spokenChars(text) / speech) : null,
        wordsPerSecond: rec.kind === 'assistant' && text && speech > 0.5 ? round(words(text) / speech) : null,
        prosody: rec.kind === 'assistant' ? assistantProsody(stepRows) : null,
        user: rec.kind !== 'assistant' ? userVoice(stepRows, input.events, rec.stepId) : null,
        interruption: rec.kind === 'interruption' ? interruption(rec, input.events, gestures) : null,
      },
      verdicts: [],
      manualFlags: rec.manualFlags,
    };
    result.verdicts = rec.valid ? verdictsOf(step, result, released, decisions, gestures) : [{ expect: 'sample', verdict: 'INVALID_SAMPLE', detail: rec.invalidReason ?? undefined }];
    results.push(result);
  }
  pairVerdicts(results);
  return { results, summary: summarise(input, results) };
}

function verdictsOf(
  step: CalibrationStep,
  r: StepResult,
  released: readonly RecordedIntent[],
  decisions: readonly (SemanticDecision & { t: number })[],
  gestures: readonly RecordedGesture[],
): ExpectationResult[] {
  const out: ExpectationResult[] = [];
  const e = step.expected;
  if (step.kind === 'assistant') {
    const semanticGestures = gestures.filter((g) => g.source === 'semantic');
    for (const cue of e.semantic) out.push({ expect: cue, ...semanticChain(cue, r, released, decisions, semanticGestures, e) });
    if (e.negativeControl) {
      out.push(r.observed.cues.length ? { expect: 'no cue', verdict: 'FALSE_POSITIVE_SEMANTIC', detail: r.observed.cues.join(', ') } : { expect: 'no cue', verdict: 'OK' });
      out.push(
        semanticGestures.length
          ? { expect: 'no semantic gesture', verdict: 'FALSE_POSITIVE_GESTURE', detail: semanticGestures.map((g) => g.type).join(', ') }
          : { expect: 'no semantic gesture', verdict: 'OK' },
      );
    }
  }
  if (step.kind === 'user') {
    const u = r.observed.user;
    const short = !['user.long'].includes(step.category);
    out.push(u && u.utterances > 2 && short ? { expect: 'one utterance', verdict: 'UTTERANCE_FRAGMENTED', detail: `${u.utterances} utterances` } : { expect: 'speech detected', verdict: 'OK' });
  }
  if (step.kind === 'interruption') {
    const i = r.observed.interruption!;
    if (i.onsetToListening === null || i.onsetToListening > T.interruptionMissed) out.push({ expect: 'listening', verdict: 'INTERRUPTION_MISSED' });
    else if (i.onsetToListening > T.interruptionLatency) out.push({ expect: 'listening', verdict: 'INTERRUPTION_SLOW', detail: `${i.onsetToListening}s` });
    else out.push({ expect: 'listening', verdict: 'OK', detail: `${i.onsetToListening}s` });
    if (i.gestureCancel !== null && i.gestureCancel > T.gestureCancel) out.push({ expect: 'gesture cancelled', verdict: 'GESTURE_NOT_CANCELLED', detail: `${i.gestureCancel}s` });
  }
  const forbidden = gestures.filter((g) => e.forbiddenGestureFamilies.includes(g.family));
  if (forbidden.length) out.push({ expect: 'no forbidden gesture', verdict: 'FORBIDDEN_GESTURE', detail: forbidden.map((g) => `${g.type} (${g.source})`).join(', ') });
  return out;
}

/** Where the expected cue's behaviour stopped. */
function semanticChain(
  cue: SemanticCueType,
  r: StepResult,
  released: readonly RecordedIntent[],
  decisions: readonly (SemanticDecision & { t: number })[],
  semanticGestures: readonly RecordedGesture[],
  e: CalibrationStep['expected'],
): Omit<ExpectationResult, 'expect'> {
  if (r.textSource === 'none') return { verdict: 'NO_REPLY_TEXT' };
  if (!r.observed.cues.includes(cue)) return { verdict: 'SEMANTIC_MISS', detail: `found: ${r.observed.cues.join(', ') || 'none'}` };
  if (!released.some((i) => i.cues.some((c) => c.type === cue))) return { verdict: 'PACING_DROP' };
  const mine = decisions.filter((d) => d.cues.includes(cue));
  const accepted = mine.filter((d) => d.accepted);
  if (!accepted.length) {
    const reasons = mine.map((d) => d.reason ?? 'roll');
    return { verdict: 'GESTURE_POLICY_SUPPRESSION', detail: mine.length ? mostCommon(reasons) : 'no decision' };
  }
  const gesture = accepted
    .map((d) => semanticGestures.find((g) => g.startedAt >= d.t - 150))
    .find((g): g is RecordedGesture => g !== undefined);
  if (!gesture) return { verdict: 'GESTURE_NOT_STARTED' };
  const threshold = gesture.channel === 'arms' ? T.visibleArmRad : T.visibleRad;
  if (e.forbiddenGestureFamilies.includes(gesture.family)) return { verdict: 'FORBIDDEN_GESTURE', detail: gesture.type };
  if (gesture.peakFinal < threshold) {
    if (gesture.peakRequested > 0 && gesture.peakApplied / gesture.peakRequested < T.clampRatio) {
      return { verdict: 'GESTURE_CLAMPED', detail: `requested ${gesture.peakRequested}, applied ${gesture.peakApplied}` };
    }
    return { verdict: 'MIX_OR_AMPLITUDE_TOO_LOW', detail: `intensity ${gesture.intensity}, final ${gesture.peakFinal} rad (${gesture.channel})` };
  }
  if (e.preferredGestureFamilies.length && !e.preferredGestureFamilies.includes(gesture.family)) {
    return { verdict: 'WRONG_GESTURE_FAMILY', detail: gesture.type };
  }
  return { verdict: 'OK', detail: `${gesture.type} ${gesture.peakFinal} rad` };
}

/** Energy pairs (assistant high/low, user energetic/normal) are judged against each other per language. */
function pairVerdicts(results: StepResult[]): void {
  const find = (lang: string, category: string) => results.find((r) => r.language === lang && r.category === category && r.valid);
  for (const lang of new Set(results.map((r) => r.language))) {
    const high = find(lang, 'energy.high');
    const low = find(lang, 'energy.low');
    if (high?.observed.prosody && low?.observed.prosody) {
      const dA = high.observed.prosody.arousal - low.observed.prosody.arousal;
      const dE = high.observed.prosody.energy - low.observed.prosody.energy;
      const ok = dA >= T.prosodySeparation || dE >= T.prosodySeparation;
      const v: ExpectationResult = ok
        ? { expect: 'high vs low energy', verdict: 'OK', detail: `Δarousal ${round(dA)}, Δenergy ${round(dE)}` }
        : { expect: 'high vs low energy', verdict: 'PROSODY_NOT_SEPARATED', detail: `Δarousal ${round(dA)}, Δenergy ${round(dE)}` };
      high.verdicts.push(v);
      low.verdicts.push({ ...v });
    }
    const normal = find(lang, 'user.normal');
    const energetic = find(lang, 'user.energetic');
    if (normal?.observed.user && energetic?.observed.user) {
      const d = energetic.observed.user.energy - normal.observed.user.energy;
      energetic.verdicts.push(
        d >= T.userEnergySeparation
          ? { expect: 'energetic vs normal', verdict: 'OK', detail: `Δenergy ${round(d)}` }
          : { expect: 'energetic vs normal', verdict: 'USER_ENERGY_NOT_SEPARATED', detail: `Δenergy ${round(d)}` },
      );
    }
  }
  for (const r of results) if (r.kind === 'user' && !r.valid && r.invalidReason === 'user-speech-not-detected') r.verdicts = [{ expect: 'speech detected', verdict: 'VAD_MISSED' }];
}

function summarise(input: AnalysisInput, results: StepResult[]): CalibrationSummary {
  const languages = input.scenario.languages;
  const assistant = results.filter((r) => r.kind === 'assistant');
  const verdicts = countVerdicts(results);
  const assistantFailures = countVerdicts(assistant, true);
  const bottleneck = (Object.entries(assistantFailures).sort((a, b) => b[1] - a[1])[0]?.[0] as Verdict | undefined) ?? null;
  const measured: Partial<Record<CalibrationLanguage, number | null>> = {};
  const byLanguage: Partial<Record<CalibrationLanguage, LanguageSummary>> = {};
  for (const lang of languages) {
    const mine = results.filter((r) => r.language === lang);
    const a = mine.filter((r) => r.kind === 'assistant' && r.valid);
    const cps = median(a.map((r) => r.observed.charsPerSecond));
    measured[lang] = cps;
    const gestures = a.flatMap((r) => r.observed.gestures);
    const speechMinutes = a.reduce((n, r) => n + r.observed.assistantSpeechSeconds, 0) / 60;
    const high = a.find((r) => r.category === 'energy.high')?.observed.prosody ?? null;
    const low = a.find((r) => r.category === 'energy.low')?.observed.prosody ?? null;
    const users = mine.filter((r) => r.kind === 'user' && r.valid);
    const inter = mine.find((r) => r.kind === 'interruption' && r.valid)?.observed.interruption ?? null;
    byLanguage[lang] = {
      samples: { valid: mine.filter((r) => r.valid).length, total: mine.length },
      speechRate: { charsPerSecond: cps, wordsPerSecond: median(a.map((r) => r.observed.wordsPerSecond)) },
      assistantProsody: {
        arousal: mean(a.map((r) => r.observed.prosody?.arousal ?? null)),
        energy: mean(a.map((r) => r.observed.prosody?.energy ?? null)),
        pitchVariation: mean(a.map((r) => r.observed.prosody?.pitchVariation ?? null)),
      },
      energyPair: { highArousal: high?.arousal ?? null, lowArousal: low?.arousal ?? null, separated: high && low ? high.arousal - low.arousal >= T.prosodySeparation || high.energy - low.energy >= T.prosodySeparation : null },
      gestures: {
        total: gestures.length,
        semantic: gestures.filter((g) => g.source === 'semantic').length,
        perMinuteOfSpeech: speechMinutes > 0 ? round(gestures.length / speechMinutes) : null,
        visible: gestures.filter(visible).length,
      },
      semanticDetection: detection(a),
      policyAcceptance: acceptance(a),
      verdicts: countVerdicts(mine),
      user: users.length
        ? {
            normalEnergy: users.find((r) => r.category === 'user.normal')?.observed.user?.energy ?? null,
            energeticEnergy: users.find((r) => r.category === 'user.energetic')?.observed.user?.energy ?? null,
            pitchHz: median(users.map((r) => r.observed.user?.pitchHz ?? null)),
          }
        : null,
      interruption: inter ? { onsetToListening: inter.onsetToListening, onsetToAssistantStop: inter.onsetToAssistantStop } : null,
    };
  }
  const allGestures = assistant.filter((r) => r.valid).flatMap((r) => r.observed.gestures);
  const measuredValues = Object.values(measured).filter((v): v is number => typeof v === 'number');
  const anyText = assistant.some((r) => r.textSource === 'dom');
  return {
    voice: input.voice,
    languages,
    samples: { valid: results.filter((r) => r.valid).length, total: results.length },
    semanticDetection: detection(assistant.filter((r) => r.valid)),
    policyAcceptance: acceptance(assistant.filter((r) => r.valid)),
    gestureStarts: allGestures.length,
    semanticGestureStarts: allGestures.filter((g) => g.source === 'semantic').length,
    visiblyMeaningfulGestures: allGestures.filter(visible).length,
    verdicts,
    bottleneck,
    bottleneckExplanation: bottleneck ? VERDICTS[bottleneck] : null,
    pacing: {
      configuredCharsPerSecond: input.configuredCharsPerSecond,
      measured,
      suggestedCharsPerSecond: median(measuredValues),
      textSource: anyText ? 'dom' : 'none',
    },
    manualFlags: results.flatMap((r) => r.manualFlags.map((f) => ({ step: r.step, reason: f.reason }))),
    byLanguage,
    thresholds: ANALYSIS_THRESHOLDS,
  };
}

// --- helpers --------------------------------------------------------------------------------------------------------

function assistantProsody(rows: readonly TraceRow[]): StepResult['observed']['prosody'] {
  const speaking = rows.filter((r) => r.signals.assistantSpeaking && r.emotion.assistant.active);
  if (!speaking.length) return null;
  const m = (f: (r: TraceRow) => number) => round(speaking.reduce((n, r) => n + f(r), 0) / speaking.length);
  return {
    arousal: m((r) => r.emotion.assistant.arousal),
    energy: m((r) => r.emotion.assistant.energy),
    pitchVariation: m((r) => r.emotion.assistant.pitchVariation),
    speechRate: m((r) => r.emotion.assistant.speechRate),
  };
}

function userVoice(rows: readonly TraceRow[], events: readonly CalibrationEvent[], step: string): StepResult['observed']['user'] {
  const speaking = rows.filter((r) => r.user.speaking);
  const utterances = events.filter((e) => e.step === step && e.type === 'utterance-start').length;
  if (!speaking.length) return { energy: 0, pitchHz: null, pitchVariation: 0, utterances };
  return {
    energy: round(speaking.reduce((n, r) => n + r.user.energy, 0) / speaking.length),
    pitchHz: median(speaking.map((r) => r.user.pitchHz)),
    pitchVariation: round(speaking.reduce((n, r) => n + r.user.pitchVariation, 0) / speaking.length),
    utterances,
  };
}

function interruption(rec: StepRecord, events: readonly CalibrationEvent[], gestures: readonly RecordedGesture[]): NonNullable<StepResult['observed']['interruption']> {
  const mine = events.filter((e) => e.step === rec.stepId);
  const cue = rec.speakCueAt ?? 0;
  const onset = mine.find((e) => e.type === 'utterance-start' && e.t >= cue - 500)?.t ?? null;
  if (onset === null) return { onsetToListening: null, onsetToAssistantStop: null, gestureCancel: null };
  const listening = mine.find((e) => e.type === 'state-transition' && e.t >= onset && (e.data as { to?: string } | undefined)?.to === 'listening')?.t ?? null;
  const stop = mine.find((e) => e.type === 'assistant-audio-end' && e.t >= onset)?.t ?? null;
  // A gesture running at the onset: how long after the switch to listening it still ran.
  const running = gestures.find((g) => g.startedAt <= onset && (g.endedAt === null || g.endedAt > onset));
  const cancel = running && listening !== null && running.endedAt !== null ? Math.max(0, (running.endedAt - listening) / 1000) : null;
  return {
    onsetToListening: listening === null ? null : round((listening - onset) / 1000),
    onsetToAssistantStop: stop === null ? null : round((stop - onset) / 1000),
    gestureCancel: cancel === null ? null : round(cancel),
  };
}

function detection(results: readonly StepResult[]): number | null {
  let expected = 0;
  let found = 0;
  for (const r of results) {
    if (r.textSource === 'none') continue;
    for (const cue of r.expected.semantic) {
      expected++;
      if (r.observed.cues.includes(cue)) found++;
    }
  }
  return expected ? round(found / expected) : null;
}

function acceptance(results: readonly StepResult[]): number | null {
  const decisions = results.flatMap((r) => r.observed.decisions);
  return decisions.length ? round(decisions.filter((d) => d.accepted).length / decisions.length) : null;
}

function visible(g: { peakFinal: number; channel: string }): boolean {
  return g.peakFinal >= (g.channel === 'arms' ? T.visibleArmRad : T.visibleRad);
}

function countVerdicts(results: readonly StepResult[], failuresOnly = false): Partial<Record<Verdict, number>> {
  const out: Partial<Record<Verdict, number>> = {};
  for (const r of results) {
    for (const v of r.verdicts) {
      if (failuresOnly && (v.verdict === 'OK' || v.verdict === 'INVALID_SAMPLE')) continue;
      out[v.verdict] = (out[v.verdict] ?? 0) + 1;
    }
  }
  return out;
}

/** Characters as spoken: Markdown markers and list numbering removed. */
export function spokenChars(text: string): number {
  return text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^\s*(?:[-*]|\d+\.)\s+/gm, '')
    .replace(/[*_#`]/g, '')
    .replace(/\s+/g, ' ')
    .trim().length;
}

function words(text: string): number {
  return text.split(/[^\p{L}\p{N}'’ʼ-]+/u).filter(Boolean).length;
}

function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

function mostCommon(items: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const i of items) counts.set(i, (counts.get(i) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
}

function median(values: readonly (number | null | undefined)[]): number | null {
  const v = values.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = v.length >> 1;
  return round(v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2);
}

function mean(values: readonly (number | null)[]): number | null {
  const v = values.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  return v.length ? round(v.reduce((a, b) => a + b, 0) / v.length) : null;
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}
