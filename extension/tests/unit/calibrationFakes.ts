import { SemanticAnalyzer } from '@avatar/semantic/SemanticAnalyzer';
import { NEUTRAL_EMOTION, type EmotionFrame } from '@avatar/audio/emotion/EmotionFrame';
import { SILENT_USER_VOICE_FRAME } from '@avatar/audio/user/UserVoiceFrame';
import type { SemanticDecision } from '@avatar/avatar/gesture/SemanticGesturePolicy';
import type { GestureType } from '@avatar/avatar/gesture/Gesture';
import type { PoseAttribution } from '@avatar/avatar/BehaviorMixer';
import type { SemanticFeedObserver } from '../../src/content/SemanticFeed';
import type { AssistantReply } from '../../src/content/ChatGPTAdapter';
import type { CalibrationChat, CalibrationHost, CalibrationRequest, ProbeFrame } from '../../src/calibration/types';
import { ATTRIBUTED_CHANNELS } from '../../src/calibration/types';
import type { CalibrationReply } from '../../src/shared/messages';

/**
 * A simulated ChatGPT + avatar for the calibration runner: typed prompts are "spoken" at 14 chars/s, the reply text
 * appears in the thread, the real SemanticAnalyzer finds cues, every first cue of a segment is accepted and starts a
 * gesture whose amplitude the test chooses. The user speaks whenever the wizard shows "speak now".
 */
export interface WorldOptions {
  voice?: string | null;
  /** Voice speaks typed prompts (the main unverified assumption). */
  voiceSpeaksTyped?: boolean;
  /** Reply text rendered in the DOM. */
  renderText?: boolean;
  micOn?: boolean;
  /** Gesture amplitude reaching the final pose, radians. */
  gestureFinal?: number;
  /** The policy accepts semantic intents. */
  accept?: boolean;
  /** startVoice works. */
  voiceStarts?: boolean;
  /** The user answers "speak now" prompts. */
  userSpeaks?: boolean;
}

const GESTURE_FOR: Record<string, GestureType> = {
  question: 'head-tilt',
  agreement: 'nod',
  disagreement: 'head-shake',
  contrast: 'body-shift',
  enumeration: 'hand-emphasis',
  conclusion: 'lean-in',
  emphasis: 'nod',
};

export function createWorld(o: WorldOptions = {}) {
  const opts = { voice: 'Sol', voiceSpeaksTyped: true, renderText: true, micOn: true, gestureFinal: 0.05, accept: true, voiceStarts: true, userSpeaks: true, ...o };
  let t = 1_000_000;
  let voice = false;
  let messages: AssistantReply[] = [];
  let userMessages = 0;
  let assistantUntil = -1;
  let assistantFrom = Infinity;
  let userFrom = Infinity;
  let userUntil = -1;
  let observer: SemanticFeedObserver | null = null;
  const decisions: SemanticDecision[] = [];
  const pendingIntents: { at: number; run: () => void }[] = [];
  let gesture: { type: GestureType; until: number } | null = null;
  let gestureCount = 0;
  let state = 'idle';
  let attributionOn = false;
  const requests: CalibrationRequest[] = [];
  const muteCalls: boolean[] = [];
  let nextId = 0;
  let analyzer = new SemanticAnalyzer();

  const attribution = (): PoseAttribution => {
    const g = gesture ? opts.gestureFinal : 0;
    const ch = () => ({ final: g, sum: g, gestureRequested: g, sources: { idle: 0, state: 0, reaction: 0, emotion: 0, gesture: g } });
    const a = Object.fromEntries(ATTRIBUTED_CHANNELS.map((c) => [c, ch()])) as unknown as PoseAttribution;
    a.arms = { final: 0, gestureRequested: 0 };
    return a;
  };

  const speaking = () => t >= assistantFrom && t < assistantUntil;
  const userSpeaking = () => t >= userFrom && t < userUntil;

  const reply = (text: string) => {
    const id = `msg-${++nextId}`;
    const start = t + 500;
    const duration = (text.length / 14) * 1000;
    if (voice && opts.voiceSpeaksTyped) {
      assistantFrom = start;
      assistantUntil = start + duration;
    }
    // The text arrives with the start of speech (or at once in text mode).
    pendingIntents.push({
      at: start,
      run: () => {
        if (opts.renderText) messages = [...messages, { id, text }];
        analyzer = new SemanticAnalyzer();
        const intents = analyzer.update(id, text, true);
        intents.forEach((intent, i) => {
          observer?.analyzed?.(intent);
          pendingIntents.push({
            at: start + (intent.charStart / 14) * 1000,
            run: () => {
              observer?.released?.(intent);
              const first = intent.cues[0]?.type ?? null;
              const accepted = opts.accept && first !== null && !gesture;
              const type = first ? GESTURE_FOR[first]! : null;
              decisions.push({
                at: t / 1000 + i * 1e-6,
                messageId: id,
                segmentId: intent.segmentId,
                early: false,
                cues: intent.cues.map((c) => c.type),
                cue: first,
                confidence: 1,
                strength: 1,
                probability: accepted ? 0.5 : 0,
                accepted,
                gesture: accepted ? type : null,
                intensity: accepted ? 0.8 : 0,
                side: 1,
                reason: accepted ? null : 'cooldown',
              } as SemanticDecision);
              if (accepted && type) {
                gesture = { type, until: t + 900 };
                gestureCount++;
              }
            },
          });
        });
      },
    });
  };

  const chat: CalibrationChat = {
    knownVoices: ['Arbor', 'Sol'],
    detectSelectedVoice: () => (voice && opts.voice ? { name: opts.voice, from: 'aria' } : null),
    detectVoiceMode: () => (voice ? 'realtime' : null),
    detectVoiceEnvironment: () => ({ voiceName: voice ? opts.voice : null, voiceMode: voice ? 'realtime' : null, uiLanguage: 'en', detectedFrom: voice && opts.voice ? 'aria' : 'unknown' }),
    isConversationEmpty: () => messages.length === 0 && userMessages === 0,
    isComposerReady: () => true,
    countAssistantMessages: () => messages.length,
    ensureFreshChat: async () => {
      messages = [];
      userMessages = 0;
      voice = false;
      return true;
    },
    startVoice: async () => {
      if (opts.voiceStarts) voice = true;
      return voice;
    },
    isVoiceReady: () => voice,
    isVoiceMicMuted: () => true,
    setVoiceMicMuted: async (m) => {
      muteCalls.push(m);
      return true;
    },
    sendMessage: async (text) => {
      userMessages++;
      const quoted = /"([\s\S]*)"\s*$/.exec(text)?.[1];
      reply(quoted ?? 'Ready.');
      return true;
    },
    waitForAssistantMessage: async () => messages.at(-1) ?? null,
    readLatestReply: () => messages.at(-1) ?? null,
    isVoiceModeActive: () => voice,
  };

  const emotion = (on: boolean, arousal: number): EmotionFrame => ({ ...NEUTRAL_EMOTION, active: on, arousal, energy: arousal, confidence: on ? 0.8 : 0 });

  const host: CalibrationHost = {
    build: { commit: 'abc123', dirty: false, mode: 'development', builtAt: '2026-09-26T00:00:00Z', version: '0.1.0' },
    read(): ProbeFrame {
      const a = speaking();
      const u = userSpeaking();
      return {
        t,
        state,
        signals: { voiceUi: voice, userSpeaking: u, assistantSpeaking: a },
        crosstalkEvents: 0,
        suppressedInterruptions: 0,
        lipSync: { active: a, volume: a ? 0.4 : 0, mode: 'viseme' },
        mic: opts.micOn ? 'on' : 'off',
        user: { ...SILENT_USER_VOICE_FRAME, speaking: u, energy: u ? 0.5 : 0 },
        emotion: { assistant: emotion(a, 0.6), user: emotion(u, 0.4) },
        mix: { assistant: a ? 0.8 : 0, user: u ? 0.8 : 0 },
        reaction: { engagement: 0, pitchLift: 0, speaking: u, utteranceEnds: 0 },
        gesture: { type: gesture?.type ?? null, phase: gesture ? 'hold' : 'none', progress: 0.5, intensity: gesture ? 0.8 : 0, priority: gesture ? 2 : null, count: gestureCount, cooldown: 0 },
        attribution: attributionOn ? attribution() : null,
        semantic: { available: true, pending: 0, dropped: 0, spokenChars: 0, mode: 'speech', intents: decisions.length, accepted: 0 },
      };
    },
    setAttribution: (on) => void (attributionOn = on),
    semantic: { observe: (obs) => void (observer = obs), decisions: () => decisions },
    chat,
    async offscreen(request): Promise<CalibrationReply> {
      requests.push(request);
      if (request.type === 'calibration:begin') return { requestId: 1, ok: true, data: { assistantSampleRate: 48000, micSampleRate: 48000 } };
      if (request.type === 'calibration:record' && request.action === 'stop') {
        return { requestId: 1, ok: true, data: { seconds: 2, sampleRate: 48000, truncated: false } };
      }
      return { requestId: 1, ok: true };
    },
    requestMicReactions: async () => undefined,
    openExport: () => undefined,
    configSnapshot: () => ({ SEMANTIC_PACER_CONFIG: { charsPerSecond: 14 } }),
    environment: () => ({
      avatarLoaded: true,
      modelUrl: 'x',
      modelName: 'avatar.vrm',
      offscreenConnected: true,
      mic: { state: opts.micOn ? 'on' : 'off' },
      emotionStatus: { model: 'off', mode: 'heuristic', inferences: 0 },
      lipSyncMode: 'viseme',
      analyzer: 'ready',
      voiceUi: voice,
    }),
    modelHash: async () => 'hash',
  };

  return {
    host,
    chat,
    requests,
    muteCalls,
    closeVoice: () => void (voice = false),
    /** The user speaks for `ms` starting now. */
    speak(ms = 1500) {
      userFrom = t;
      userUntil = t + ms;
      // ChatGPT stops talking when interrupted.
      if (speaking()) assistantUntil = t + 300;
    },
    get userSpeaking() {
      return userSpeaking();
    },
    get now() {
      return t;
    },
    /** Advances the world by `ms` in 1/30 s frames, ticking `tick`. */
    async advance(ms: number, tick: (dt: number) => void, onFrame?: () => void) {
      const step = 1000 / 30;
      for (let e = 0; e < ms; e += step) {
        t += step;
        for (const p of pendingIntents.filter((x) => x.at <= t)) {
          pendingIntents.splice(pendingIntents.indexOf(p), 1);
          p.run();
        }
        if (gesture && t >= gesture.until) gesture = null;
        state = userSpeaking() ? 'listening' : speaking() ? 'speaking' : voice ? 'listening' : 'idle';
        onFrame?.();
        tick(step / 1000);
        // Let promise continuations run between frames.
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      }
    },
  };
}
