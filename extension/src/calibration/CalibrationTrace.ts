import type { SemanticDecision } from '@avatar/avatar/gesture/SemanticGesturePolicy';
import type { SemanticIntent } from '@avatar/semantic/SemanticCue';
import {
  ATTRIBUTED_CHANNELS,
  GESTURE_FAMILY,
  type CalibrationEvent,
  type CalibrationEventType,
  type CalibrationHost,
  type ProbeFrame,
  type RecordedGesture,
  type RecordedIntent,
} from './types';

/** Continuous trace rows per second (events are detected every frame). */
export const TRACE_HZ = 15;

/** GESTURE_PRIORITY values → names (mirrors GestureEngine; kept here so the Dev UI doesn't import the engine). */
const PRIORITY_NAMES = ['ambient', 'emphasis', 'semantic', 'boundary', 'forced'] as const;

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const r4 = (v: number) => Math.round(v * 10000) / 10000;

/**
 * The causal chain of one calibration session, recorded from the host every frame:
 * audio activity → emotion → semantics → gesture policy → gesture engine → BehaviorMixer (per-source attribution) →
 * final pose. Events are detected on every frame (edges, counters); the continuous trace is sampled at TRACE_HZ.
 * Everything is plain JSON; no audio (that stays in the offscreen document).
 */
export class CalibrationTrace {
  readonly events: CalibrationEvent[] = [];
  readonly rows: string[] = [];
  readonly intents: RecordedIntent[] = [];
  readonly released: RecordedIntent[] = [];
  readonly decisions: (SemanticDecision & { t: number; step: string | null })[] = [];
  readonly gestures: RecordedGesture[] = [];
  /** Assistant/user speech seconds per step (from the resolver's signals). */
  readonly speech = new Map<string, { assistant: number; user: number }>();
  step: string | null = null;
  private prev: ProbeFrame | null = null;
  private sinceRow = Infinity;
  private seenDecisions = new Set<string>();
  private running: RecordedGesture | null = null;
  private runningPhase = 'none';

  constructor(private readonly host: CalibrationHost) {}

  start(): void {
    this.host.setAttribution(true);
    this.host.semantic.observe({
      analyzed: (intent) => this.intents.push(this.record(intent)),
      released: (intent) => {
        const rec = this.record(intent);
        this.released.push(rec);
        this.event('semantic-intent', { segmentId: rec.segmentId, messageId: rec.messageId, cues: rec.cues.map((c) => c.type) });
      },
    });
    // Decisions already on record belong to before the session.
    for (const d of this.host.semantic.decisions()) this.seenDecisions.add(decisionKey(d));
  }

  stop(): void {
    this.host.semantic.observe(null);
    this.host.setAttribution(false);
    if (this.running) this.finishGesture(this.prev?.t ?? Date.now());
  }

  event(type: CalibrationEventType, data?: Record<string, unknown>, t = this.host.read().t): CalibrationEvent {
    const e: CalibrationEvent = { t: Math.round(t), step: this.step, type, ...(data ? { data } : {}) };
    this.events.push(e);
    return e;
  }

  /** Called every frame while the session runs. */
  update(delta: number): void {
    const f = this.host.read();
    const p = this.prev;
    const s = this.step;
    if (s) {
      const sp = this.speech.get(s) ?? { assistant: 0, user: 0 };
      if (f.signals.assistantSpeaking) sp.assistant += delta;
      if (f.signals.userSpeaking) sp.user += delta;
      this.speech.set(s, sp);
    }
    if (p) {
      if (f.state !== p.state) {
        this.event('state-transition', { from: p.state, to: f.state }, f.t);
        // The user took the turn from a speaking assistant: an interruption as the resolver saw it.
        if (p.state === 'speaking' && f.state === 'listening' && f.signals.userSpeaking) this.event('interrupt-detected', {}, f.t);
      }
      if (f.signals.assistantSpeaking !== p.signals.assistantSpeaking) this.event(f.signals.assistantSpeaking ? 'assistant-audio-start' : 'assistant-audio-end', undefined, f.t);
      if (f.signals.userSpeaking !== p.signals.userSpeaking) this.event(f.signals.userSpeaking ? 'utterance-start' : 'utterance-end', { energy: r3(f.user.energy) }, f.t);
    }
    this.updateDecisions(f.t);
    this.updateGesture(f, p);
    this.prev = f;
    this.sinceRow += delta;
    if (this.sinceRow >= 1 / TRACE_HZ - 1e-6) {
      this.sinceRow = 0;
      this.rows.push(JSON.stringify(row(f, s)));
    }
  }

  private record(intent: SemanticIntent): RecordedIntent {
    return {
      t: Math.round(this.host.read().t),
      step: this.step,
      messageId: intent.messageId,
      segmentId: intent.segmentId,
      cues: intent.cues.map((c) => ({ type: c.type, confidence: r3(c.confidence), strength: r3(c.strength) })),
      text: intent.text,
    };
  }

  private updateDecisions(t: number): void {
    for (const d of this.host.semantic.decisions()) {
      const key = decisionKey(d);
      if (this.seenDecisions.has(key)) continue;
      this.seenDecisions.add(key);
      this.decisions.push({ ...d, cues: [...d.cues], t: Math.round(t), step: this.step });
      this.event('gesture-decision', { segmentId: d.segmentId, cue: d.cue, accepted: d.accepted, gesture: d.gesture, reason: d.reason, probability: r3(d.probability) }, t);
      for (const cue of d.cues) this.event('semantic-cue', { segmentId: d.segmentId, cue }, t);
    }
  }

  private updateGesture(f: ProbeFrame, p: ProbeFrame | null): void {
    const g = f.gesture;
    if (p && g.count > p.gesture.count && g.type) {
      if (this.running) this.finishGesture(f.t);
      const source = g.priority === null ? 'unknown' : (PRIORITY_NAMES[g.priority] ?? 'unknown');
      this.running = {
        step: this.step,
        type: g.type,
        family: GESTURE_FAMILY[g.type],
        source,
        startedAt: Math.round(f.t),
        endedAt: null,
        intensity: r3(g.intensity),
        peakRequested: 0,
        peakApplied: 0,
        peakFinal: 0,
        channel: '',
      };
      this.runningPhase = g.phase;
      this.event('gesture-start', { type: g.type, family: GESTURE_FAMILY[g.type], source, intensity: r3(g.intensity) }, f.t);
    }
    const run = this.running;
    if (!run) return;
    const a = f.attribution;
    if (a) {
      for (const ch of ATTRIBUTED_CHANNELS) {
        const c = a[ch];
        const requested = Math.abs(c.gestureRequested);
        const applied = Math.abs(c.sources.gesture);
        // The part of the final value the gesture accounts for: final minus everything else.
        const effect = Math.abs(c.final - (c.sum - c.sources.gesture));
        if (requested > run.peakRequested) run.peakRequested = r4(requested);
        if (applied > run.peakApplied) run.peakApplied = r4(applied);
        if (effect > run.peakFinal) {
          run.peakFinal = r4(effect);
          run.channel = ch;
        }
      }
      if (a.arms.gestureRequested > run.peakRequested) run.peakRequested = r4(a.arms.gestureRequested);
      if (a.arms.final > run.peakApplied) run.peakApplied = r4(a.arms.final);
      if (a.arms.final > run.peakFinal) {
        run.peakFinal = r4(a.arms.final);
        run.channel = 'arms';
      }
    }
    if (g.phase !== this.runningPhase) {
      if (g.phase === 'hold') this.event('gesture-peak', { type: run.type, peakFinal: run.peakFinal, channel: run.channel }, f.t);
      if (g.phase === 'release') this.event('gesture-release', { type: run.type }, f.t);
      this.runningPhase = g.phase;
    }
    if (!g.type || g.phase === 'none' || g.phase === 'done') this.finishGesture(f.t);
  }

  private finishGesture(t: number): void {
    const run = this.running;
    if (!run) return;
    this.running = null;
    this.runningPhase = 'none';
    run.endedAt = Math.round(t);
    this.gestures.push(run);
    this.event('gesture-end', { ...run } as unknown as Record<string, unknown>, t);
  }
}

function decisionKey(d: SemanticDecision): string {
  return `${d.messageId}|${d.segmentId}|${d.at.toFixed(4)}`;
}

/** One compact trace row: the whole chain for one instant. */
function row(f: ProbeFrame, step: string | null): Record<string, unknown> {
  const e = (x: ProbeFrame['emotion']['assistant']) => ({
    active: x.active,
    arousal: r3(x.arousal),
    valence: r3(x.valence),
    energy: r3(x.energy),
    tension: r3(x.tension),
    pitchLift: r3(x.pitchLift),
    pitchVariation: r3(x.pitchVariation),
    speechRate: r3(x.speechRate),
    confidence: r3(x.confidence),
    mode: x.mode,
  });
  const a = f.attribution;
  const attribution: Record<string, unknown> = {};
  if (a) {
    for (const ch of ATTRIBUTED_CHANNELS) {
      const c = a[ch];
      attribution[ch] = {
        final: r4(c.final),
        sources: { idle: r4(c.sources.idle), state: r4(c.sources.state), reaction: r4(c.sources.reaction), emotion: r4(c.sources.emotion), gesture: r4(c.sources.gesture) },
        gestureRequested: r4(c.gestureRequested),
      };
    }
    attribution.arms = { final: r4(a.arms.final), gestureRequested: r4(a.arms.gestureRequested) };
  }
  const u = f.user;
  return {
    t: Math.round(f.t),
    step,
    state: f.state,
    signals: f.signals,
    assistantAudio: { active: f.lipSync.active, volume: r3(f.lipSync.volume) },
    user: {
      speaking: u.speaking,
      energy: r3(u.energy),
      rmsDb: Math.round(u.rmsDb * 10) / 10,
      pitchHz: u.pitchHz === null ? null : Math.round(u.pitchHz),
      relativePitch: r3(u.relativePitch),
      pitchVariation: r3(u.pitchVariation),
      spectralCentroid: Math.round(u.spectralCentroid),
      spectralRolloff: Math.round(u.spectralRolloff),
      zcr: r3(u.zeroCrossingRate),
    },
    emotion: { assistant: e(f.emotion.assistant), user: e(f.emotion.user) },
    mix: { assistant: r3(f.mix.assistant), user: r3(f.mix.user) },
    reaction: { engagement: r3(f.reaction.engagement), pitchLift: r3(f.reaction.pitchLift), speaking: f.reaction.speaking },
    gesture: { type: f.gesture.type, phase: f.gesture.phase, intensity: r3(f.gesture.intensity), progress: r3(f.gesture.progress), cooldown: r3(f.gesture.cooldown) },
    semantic: f.semantic,
    attribution,
  };
}
