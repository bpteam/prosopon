import type { AvatarState } from '../AvatarStateProfiles';
import type { GestureType } from './Gesture';

/** Seconds, [min, max]; a value is drawn uniformly each time. */
export type Range = [number, number];

/**
 * One gesture's timing and shape. Amplitudes are radians at intensity 1 and describe the model's side "left"
 * gestures (head-tilt, body-shift, shoulder-shift, hand-emphasis pick a side at random and mirror).
 */
export interface GestureTypeConfig {
  duration: Range;
  /** Pause after this gesture before the scheduler may start another one. */
  cooldown: Range;
  /** Share of the duration spent reaching the peak (the first quarter of it is reported as `prepare`)… */
  attack: number;
  /** …and holding it; the rest is the release. */
  hold: number;
  /** Radians at intensity 1 (unused keys stay 0). */
  headPitch: number;
  headYaw: number;
  headRoll: number;
  bodyLean: number;
  bodyYaw: number;
  bodyRoll: number;
  /** Lift of the gesture-side shoulder; the other one drops by `shoulderCounter` × this. */
  shoulder: number;
  shoulderCounter: number;
  /** Upper arm forward swing. */
  armForward: number;
  /** Upper arm away from the body (towards the T-pose). */
  armOutward: number;
  /** Extra elbow bend (lower arm). */
  elbowBend: number;
}

/**
 * Base rate of each gesture per conversation state while the scheduler is out of cooldown, events per second
 * (a Poisson hazard: p = 1 − exp(−rate·dt), so the chance per second does not depend on the frame rate).
 * 0 = never in that state.
 */
export type StateRates = Record<AvatarState, Record<GestureType, number>>;

export interface GestureConfig {
  enabled: boolean;
  /** Scheduler on/off. Manual triggers work either way. */
  auto: boolean;
  /** Global multiplier of every rate (debug tuning: 0 = only event gestures, >1 = livelier). */
  rateScale: number;
  types: Record<GestureType, GestureTypeConfig>;
  rates: StateRates;

  /**
   * Intensity range of normal conversation. Emotion is compressed into it (no arousal 0.9 → intensity 0.9):
   * activity 0 → min, 1 → max.
   */
  intensity: Range;
  /** Intensity of forced (debug) triggers. */
  forcedIntensity: number;
  /** Listening gestures run at this share of the normal intensity (the user has the floor). */
  listeningIntensityScale: number;

  // Speaking: the assistant's prosody drives how often and how strongly.
  /** Assistant arousal below this counts as no activity… */
  activityArousalFrom: number;
  /** …and above this as full activity. */
  activityArousalTo: number;
  /** Share of pitch variation in the activity (the rest is arousal). */
  activityPitchVariation: number;
  /** Rates in speaking × (floor + (1 − floor) × activity): low arousal → almost no gestures. */
  speakingRateFloor: number;
  /** Hand emphasis needs at least this assistant arousal… */
  handMinArousal: number;
  /** …and this energy. */
  handMinEnergy: number;
  /** An emotion frame below this confidence counts as no activity. */
  minConfidence: number;

  // Anti-repetition.
  /** Weight of the previous gesture type when choosing the next one. */
  repeatPenalty: number;

  // User utterance end → nod (boundary gesture).
  /** A shorter utterance ends without a nod (noise, a cough, "uh"), seconds. */
  nodMinUtterance: number;
  /** Chance that a meaningful utterance end gets a nod. */
  nodOnUtteranceChance: number;
  /** Two nods never closer than this, seconds (also for listening nods). */
  nodMinInterval: number;
  /** Double nod instead of a nod needs an utterance this long… */
  doubleNodMinUtterance: number;
  /** …and user arousal (or confident positive valence) at least this… */
  doubleNodMinEngagement: number;
  /** …and then happens with this chance. */
  doubleNodChance: number;
  /** Valence counts for the double nod only with at least this valenceConfidence (heuristics stay below it). */
  doubleNodValenceConfidence: number;
  /** At most this many listening nods while the user keeps talking in one utterance. */
  listeningNodsPerUtterance: number;

  /** Assistant starts talking → chance of a small head/body gesture (boundary gesture). */
  speakStartChance: number;

  // Cancel / interruption.
  /** Graceful cancel release, seconds (100–250 ms). */
  cancelRelease: number;
  /** Interruption (assistant → user) release, seconds. */
  interruptRelease: number;
  /** Cooldown after an interruption, seconds. */
  interruptCooldown: number;
}

const type = (c: Partial<GestureTypeConfig> & Pick<GestureTypeConfig, 'duration' | 'cooldown'>): GestureTypeConfig => ({
  attack: 0.35,
  hold: 0.25,
  headPitch: 0,
  headYaw: 0,
  headRoll: 0,
  bodyLean: 0,
  bodyYaw: 0,
  bodyRoll: 0,
  shoulder: 0,
  shoulderCounter: 0,
  armForward: 0,
  armOutward: 0,
  elbowBend: 0,
  ...c,
});

/**
 * Tuned by eye on the sample model (portrait framing). Another VRM: calibrate with the Gestures debug folder and
 * pass overrides to GestureEngine.
 */
export const GESTURE_CONFIG: Readonly<GestureConfig> = {
  enabled: true,
  auto: true,
  rateScale: 1,
  types: {
    // Chin down and back (~4° at intensity 1). Same shape as the old UserReaction nod.
    nod: type({ duration: [0.45, 0.6], cooldown: [1.5, 3], attack: 0.45, hold: 0.1, headPitch: 0.075 }),
    // Two dips, the second smaller; see GestureEngine.shape.
    'double-nod': type({ duration: [0.8, 1], cooldown: [3, 5], attack: 0.45, hold: 0.1, headPitch: 0.065 }),
    'head-tilt': type({ duration: [1.6, 2.6], cooldown: [2.5, 5], attack: 0.3, hold: 0.35, headRoll: 0.07, headYaw: 0.03, headPitch: 0.012 }),
    'body-shift': type({ duration: [2, 3.2], cooldown: [3, 6], attack: 0.35, hold: 0.3, bodyYaw: 0.05, bodyLean: 0.02, bodyRoll: 0.015, headYaw: -0.02 }),
    'shoulder-shift': type({ duration: [1.2, 1.8], cooldown: [2.5, 5], attack: 0.35, hold: 0.2, shoulder: 0.07, shoulderCounter: 0.3, bodyRoll: 0.012, headRoll: -0.012 }),
    'hand-emphasis': type({ duration: [0.9, 1.3], cooldown: [3, 6], attack: 0.3, hold: 0.3, armForward: 0.28, armOutward: 0.12, elbowBend: 0.35, shoulder: 0.02 }),
    // One yaw swing each way (~2° at intensity 1), never a repeated shake; see GestureEngine.curve.
    'head-shake': type({ duration: [0.55, 0.75], cooldown: [2, 4], headYaw: 0.035, headPitch: 0.008 }),
    // Towards the camera with the chin slightly down: a settling "so, here's the point".
    'lean-in': type({ duration: [1.4, 2], cooldown: [3, 5], attack: 0.35, hold: 0.3, bodyLean: 0.035, headPitch: 0.025 }),
  },
  rates: {
    idle: { nod: 0, 'double-nod': 0, 'head-tilt': 0.02, 'body-shift': 0.03, 'shoulder-shift': 0.015, 'hand-emphasis': 0, 'head-shake': 0, 'lean-in': 0 },
    listening: { nod: 0.02, 'double-nod': 0, 'head-tilt': 0.04, 'body-shift': 0.02, 'shoulder-shift': 0, 'hand-emphasis': 0, 'head-shake': 0, 'lean-in': 0 },
    thinking: { nod: 0, 'double-nod': 0, 'head-tilt': 0.04, 'body-shift': 0.015, 'shoulder-shift': 0, 'hand-emphasis': 0, 'head-shake': 0, 'lean-in': 0 },
    speaking: { nod: 0.04, 'double-nod': 0, 'head-tilt': 0.03, 'body-shift': 0.04, 'shoulder-shift': 0.03, 'hand-emphasis': 0.1, 'head-shake': 0, 'lean-in': 0 },
  },
  intensity: [0.45, 0.9],
  forcedIntensity: 0.8,
  listeningIntensityScale: 0.7,
  activityArousalFrom: 0.35,
  activityArousalTo: 0.85,
  activityPitchVariation: 0.3,
  speakingRateFloor: 0.15,
  handMinArousal: 0.55,
  handMinEnergy: 0.25,
  minConfidence: 0.2,
  repeatPenalty: 0.3,
  nodMinUtterance: 0.5,
  nodOnUtteranceChance: 0.85,
  nodMinInterval: 2,
  doubleNodMinUtterance: 2,
  doubleNodMinEngagement: 0.6,
  doubleNodChance: 0.35,
  doubleNodValenceConfidence: 0.5,
  listeningNodsPerUtterance: 1,
  speakStartChance: 0.3,
  cancelRelease: 0.2,
  interruptRelease: 0.15,
  interruptCooldown: 1,
};

/** Deep copy with overrides (top-level keys; `types`/`rates` entries merge per type). */
export function gestureConfig(overrides: GestureConfigOverrides = {}): GestureConfig {
  const base = GESTURE_CONFIG;
  const types = {} as GestureConfig['types'];
  for (const [k, v] of Object.entries(base.types) as [GestureType, GestureTypeConfig][]) {
    types[k] = { ...v, duration: [...v.duration], cooldown: [...v.cooldown], ...overrides.types?.[k] };
  }
  const rates = {} as StateRates;
  for (const [s, v] of Object.entries(base.rates) as [AvatarState, Record<GestureType, number>][]) {
    rates[s] = { ...v, ...overrides.rates?.[s] };
  }
  const { types: _t, rates: _r, ...rest } = overrides;
  return { ...base, intensity: [...base.intensity], ...rest, types, rates };
}

export type GestureConfigOverrides = Partial<Omit<GestureConfig, 'types' | 'rates'>> & {
  types?: Partial<Record<GestureType, Partial<GestureTypeConfig>>>;
  rates?: Partial<Record<AvatarState, Partial<Record<GestureType, number>>>>;
};

/**
 * Safety bounds of the gesture layer alone, radians. BehaviorMixer clamps any GestureSource to these (a future
 * semantic source included), whatever it asks for.
 */
export const GESTURE_LIMITS = Object.freeze({
  headYaw: 0.12,
  headPitch: 0.12,
  headRoll: 0.12,
  bodyLean: 0.05,
  bodyYaw: 0.08,
  bodyRoll: 0.04,
  shoulder: 0.1,
  /** Per axis, per arm bone. */
  arm: 0.45,
});
