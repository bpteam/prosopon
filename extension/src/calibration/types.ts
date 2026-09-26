// Contracts of the calibration wizard (Developer Mode → Calibration). Types only: the wizard reaches the avatar,
// ChatGPT and the offscreen recorder through CalibrationHost, which the avatar runtime implements. Nothing here knows
// three.js, bones or ChatGPT's DOM.
import type { EmotionFrame } from '@avatar/audio/emotion/EmotionFrame';
import type { UserVoiceFrame } from '@avatar/audio/user/UserVoiceFrame';
import type { PoseAttribution } from '@avatar/avatar/BehaviorMixer';
import type { GestureType } from '@avatar/avatar/gesture/Gesture';
import type { SemanticDecision } from '@avatar/avatar/gesture/SemanticGesturePolicy';
import type { SemanticCueType } from '@avatar/semantic/SemanticCue';
import type { AssistantReply, ConversationAutomation } from '../content/ChatGPTAdapter';
import type { SemanticFeedObserver } from '../content/SemanticFeed';
import type { CalibrationChannel, CalibrationReply, EmotionStatus, MicStatus } from '../shared/messages';
import type { ScenarioOptions } from './scenarios';

export const CALIBRATION_LANGUAGES = ['ru', 'uk', 'en', 'es'] as const;
export type CalibrationLanguage = (typeof CALIBRATION_LANGUAGES)[number];

/** Gesture types grouped the way expectations are written (a nod and a double nod are one family). */
export const GESTURE_FAMILIES = ['nod', 'headTilt', 'headShake', 'leanIn', 'bodyShift', 'shoulderShift', 'hand'] as const;
export type GestureFamily = (typeof GESTURE_FAMILIES)[number];

export const GESTURE_FAMILY: Readonly<Record<GestureType, GestureFamily>> = Object.freeze({
  nod: 'nod',
  'double-nod': 'nod',
  'head-tilt': 'headTilt',
  'head-shake': 'headShake',
  'lean-in': 'leanIn',
  'body-shift': 'bodyShift',
  'shoulder-shift': 'shoulderShift',
  'hand-emphasis': 'hand',
});

/**
 * Pose channels BehaviorMixer attributes to sources. Mirrors BehaviorMixer's ATTRIBUTED_CHANNELS (a unit test keeps
 * them equal): the Dev UI chunk must not import the mixer at runtime.
 */
export const ATTRIBUTED_CHANNELS = ['headYaw', 'headPitch', 'headRoll', 'lean', 'bodyYaw', 'bodyRoll', 'shoulderLeft', 'shoulderRight'] as const;

// --- Scenario -----------------------------------------------------------------------------------------------------

export type SpeakingStyle = 'natural' | 'energetic' | 'calm' | 'question';

/** Machine-readable expectation of one assistant sample: what should (and must not) happen. */
export interface StepExpectation {
  /** Cue types the semantic layer should find in the reply. Empty for a negative control. */
  semantic: SemanticCueType[];
  preferredGestureFamilies: GestureFamily[];
  forbiddenGestureFamilies: GestureFamily[];
  /** Relative prosody of an energy pair: compared with the other member of the pair in the same language. */
  prosody?: 'high' | 'low';
  /** No semantic cue and no semantic gesture should appear. */
  negativeControl?: boolean;
}

export type CalibrationStepKind = 'assistant' | 'user' | 'interruption';

export interface CalibrationStep {
  /** `<lang>.<kind>.<name>`, e.g. "ru.question.normal". Unique within a run. */
  id: string;
  kind: CalibrationStepKind;
  language: CalibrationLanguage;
  /** Category of behaviour this sample tests (same set per language). */
  category: string;
  style: SpeakingStyle;
  /** The text the assistant (or the user) is asked to say. */
  requestedText: string;
  /** Assistant/interruption steps: the full message sent to ChatGPT. */
  prompt?: string;
  /** User/interruption steps: what the wizard shows the user. */
  instruction?: string;
  expected: StepExpectation;
}

export interface CalibrationScenario {
  id: string;
  languages: CalibrationLanguage[];
  steps: CalibrationStep[];
}

// --- Host (implemented by the avatar runtime) ---------------------------------------------------------------------

/** What the wizard reads every frame. Plain values; `attribution` is a live object (copy what you keep). */
export interface ProbeFrame {
  /** Epoch milliseconds (performance.timeOrigin + performance.now()). */
  t: number;
  state: string;
  signals: { voiceUi: boolean; userSpeaking: boolean; assistantSpeaking: boolean };
  crosstalkEvents: number;
  suppressedInterruptions: number;
  lipSync: { active: boolean; volume: number; mode: string };
  mic: MicStatus['state'];
  user: Readonly<UserVoiceFrame>;
  /** Last EmotionFrames as received from the offscreen analysers. */
  emotion: Record<'assistant' | 'user', Readonly<EmotionFrame>>;
  /** Effective emotion weights of the mixer (state × gain × confidence). */
  mix: { assistant: number; user: number };
  reaction: { engagement: number; pitchLift: number; speaking: boolean; utteranceEnds: number };
  gesture: {
    type: GestureType | null;
    phase: string;
    progress: number;
    intensity: number;
    /** GESTURE_PRIORITY of the running gesture (who started it), null when none runs. */
    priority: number | null;
    /** Gestures started so far (monotonic). */
    count: number;
    cooldown: number;
  };
  attribution: Readonly<PoseAttribution> | null;
  semantic: { available: boolean; pending: number; dropped: number; spokenChars: number; mode: string; intents: number; accepted: number };
}

export interface HostEnvironment {
  avatarLoaded: boolean | 'error';
  /** Packaged URL of the VRM (for its hash). */
  modelUrl: string;
  modelName: string;
  offscreenConnected: boolean;
  mic: MicStatus;
  emotionStatus: EmotionStatus;
  lipSyncMode: string;
  analyzer: string;
  voiceUi: boolean;
}

export interface BuildInfo {
  commit: string;
  dirty: boolean | null;
  mode: string;
  builtAt: string;
  version: string;
}

/** Calibration requests to the offscreen recorder (requestId is added by the host). */
export type CalibrationRequest =
  | { type: 'calibration:begin' }
  | { type: 'calibration:record'; clipId: string; channel: CalibrationChannel; action: 'start' | 'stop' }
  | { type: 'calibration:file'; name: string; text: string; append: boolean }
  | { type: 'calibration:build'; fileName: string }
  | { type: 'calibration:discard' };

export type CalibrationChat = ConversationAutomation & {
  readLatestReply(): AssistantReply | null;
  isVoiceModeActive(): boolean;
};

export interface CalibrationHost {
  read(): ProbeFrame;
  setAttribution(on: boolean): void;
  readonly semantic: {
    observe(observer: SemanticFeedObserver | null): void;
    /** Last policy decisions, newest last. */
    decisions(): readonly SemanticDecision[];
  };
  readonly chat: CalibrationChat;
  offscreen(request: CalibrationRequest): Promise<CalibrationReply>;
  /** Turns "Microphone reactions" on (same as the popup switch). */
  requestMicReactions(): Promise<void>;
  openExport(): void;
  /** Every tunable the behaviour depends on, as the running code has it (defaults and live values). */
  configSnapshot(): Record<string, unknown>;
  environment(): HostEnvironment;
  readonly build: BuildInfo;
  /** SHA-256 of the packaged VRM, hex; null if it cannot be read. */
  modelHash(): Promise<string | null>;
  /** Development builds (E2E): a reduced scenario for the next Start; undefined = the full default. */
  readonly scenarioOptions?: ScenarioOptions;
}

// --- Recording -----------------------------------------------------------------------------------------------------

export type CalibrationEventType =
  | 'session-start'
  | 'step-start'
  | 'step-end'
  | 'step-retry'
  | 'step-invalid'
  | 'prompt-sent'
  | 'reply-text'
  | 'state-transition'
  | 'assistant-audio-start'
  | 'assistant-audio-end'
  | 'utterance-start'
  | 'utterance-end'
  | 'semantic-cue'
  | 'semantic-intent'
  | 'gesture-decision'
  | 'gesture-start'
  | 'gesture-peak'
  | 'gesture-release'
  | 'gesture-end'
  | 'interrupt-detected'
  | 'countdown'
  | 'manual-flag'
  | 'recovery';

export interface CalibrationEvent {
  /** Epoch ms. */
  t: number;
  /** Step id when the event happened inside one. */
  step: string | null;
  type: CalibrationEventType;
  data?: Record<string, unknown>;
}

/** Semantic intent as recorded (what the analyser found in a segment). */
export interface RecordedIntent {
  t: number;
  step: string | null;
  messageId: string;
  segmentId: string;
  cues: { type: SemanticCueType; confidence: number; strength: number }[];
  text: string;
}

export interface RecordedGesture {
  step: string | null;
  type: GestureType;
  family: GestureFamily;
  /** Who started it: semantic, boundary, emphasis, ambient, forced. */
  source: string;
  startedAt: number;
  endedAt: number | null;
  intensity: number;
  /** Largest gesture offset asked for, radians (before GESTURE_LIMITS). */
  peakRequested: number;
  /** Largest gesture offset after GESTURE_LIMITS. */
  peakApplied: number;
  /** Largest part of the final pose the gesture accounts for (after POSE_LIMITS), radians. */
  peakFinal: number;
  /** Channel of peakFinal (headYaw, lean, arms, …). */
  channel: string;
}

export type TextSource = 'dom' | 'none';

/** What the runner recorded for one step (analysis works from this plus the events and the trace). */
export interface StepRecord {
  stepId: string;
  kind: CalibrationStepKind;
  language: CalibrationLanguage;
  category: string;
  requestedText: string;
  prompt: string | null;
  actualRenderedText: string | null;
  textSource: TextSource;
  startedAt: number;
  endedAt: number | null;
  attempts: number;
  valid: boolean;
  invalidReason: string | null;
  /** Assistant audio seconds inside the step (resolver's assistantSpeaking). */
  assistantSpeechSeconds: number;
  /** User speech seconds inside the step (VAD). */
  userSpeechSeconds: number;
  clips: { clipId: string; channel: CalibrationChannel; seconds: number; sampleRate: number; truncated: boolean }[];
  manualFlags: { t: number; reason: 'unspecified' | 'too-weak' | 'too-much' | 'wrong-timing' }[];
  /** Interruption steps: when the wizard told the user to speak (epoch ms). */
  speakCueAt?: number;
}
