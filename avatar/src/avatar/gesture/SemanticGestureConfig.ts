import type { SemanticCueType } from '../../semantic/SemanticCue';
import type { AvatarState } from '../AvatarStateProfiles';
import type { GestureType } from './Gesture';
import type { Range } from './GestureConfig';

/** A candidate gesture for a cue and its relative weight among the cue's candidates. */
export type WeightedGesture = readonly [GestureType, number];

export interface SemanticCueGestureConfig {
  /** Chance that a fully confident, full-strength cue moves anything (before state, cooldown, repetition). */
  base: number;
  gestures: readonly WeightedGesture[];
  /** Side rule: `alternate` flips relative to the last semantic gesture (contrast, list items), `random` otherwise. */
  side: 'alternate' | 'random';
}

/**
 * How the avatar reacts to semantic cues: probabilities, cooldowns and gesture candidates. Kept apart from the
 * vocabulary (semantic/rules) and from detection thresholds (SemanticConfig).
 *
 * The numbers aim at "100 detected cues → 15–30 visible accents": base chances below 0.6, a global cooldown of a
 * few seconds, a longer per-type one and a repeat penalty. Not visually tuned yet (docs/semantic-calibration.md).
 */
export interface SemanticGestureConfig {
  enabled: boolean;
  /** Global multiplier of every base chance (debug tuning: 0 = no semantic gestures). */
  probabilityScale: number;
  /** A cue below this confidence never moves anything. */
  minConfidence: number;
  /** Seconds between two semantic gestures. */
  globalCooldown: number;
  /** Seconds before the same cue type may move the avatar again. */
  typeCooldown: number;
  /** Chance multiplier when the cue type is the same as the last accepted one ("but … however …"). */
  repeatCuePenalty: number;
  /** Weight multiplier of the gesture type the engine played last (vary, don't repeat). */
  repeatGesturePenalty: number;
  /** Per conversation state: 0 = never (the user has the floor while listening). */
  stateFactor: Record<AvatarState, number>;
  /** Intents older than this when the engine sees them are dropped (text raced ahead of the moment), seconds. */
  maxAge: number;
  /** At most this many intents wait for the next update(); older ones are dropped. */
  maxQueue: number;
  /**
   * While semantic intents keep arriving (within `ambientWindow` s), the prosody scheduler's speaking rates are
   * scaled by this: meaningful accents replace random ones instead of adding to them.
   */
  ambientRateScale: number;
  ambientWindow: number;
  /** Intensity from confidence × strength, compressed into this range (like GestureConfig.intensity). */
  intensity: Range;
  /** Emphasis in the same segment: chance × (1 + this × emphasis) and intensity × (1 + this/2 × emphasis). */
  emphasisBoost: number;
  /**
   * Prosody refinement while speaking: chance and intensity × lerp(1 − gain, 1 + gain, assistant activity). Calm
   * voice → smaller, rarer accents; animated voice → a little more. Semantic cues never depend on it.
   */
  prosodyGain: number;
  /** Modifiers (example, cause, clarification): chance of hand candidates × (1 + this). */
  explanatoryHandBoost: number;
  /** Diagnostics: decisions kept for the debug view. */
  historySize: number;
  cues: Record<SemanticCueType, SemanticCueGestureConfig>;
  /** Enumeration refined by role: base chance per role (items get the beat). */
  enumerationBase: { intro: number; item: number; final: number };
}

export const SEMANTIC_GESTURE_CONFIG: Readonly<SemanticGestureConfig> = {
  enabled: true,
  probabilityScale: 1,
  minConfidence: 0.55,
  globalCooldown: 2.5,
  typeCooldown: 6,
  repeatCuePenalty: 0.5,
  repeatGesturePenalty: 0.35,
  stateFactor: { speaking: 1, idle: 0.5, thinking: 0.25, listening: 0 },
  maxAge: 4,
  maxQueue: 4,
  ambientRateScale: 0.5,
  ambientWindow: 8,
  intensity: [0.5, 0.9],
  emphasisBoost: 0.35,
  prosodyGain: 0.15,
  explanatoryHandBoost: 0.2,
  historySize: 16,
  cues: {
    agreement: { base: 0.6, gestures: [['nod', 3], ['double-nod', 1]], side: 'random' },
    disagreement: { base: 0.5, gestures: [['head-shake', 3], ['head-tilt', 1]], side: 'random' },
    question: { base: 0.5, gestures: [['head-tilt', 4], ['lean-in', 1]], side: 'random' },
    contrast: { base: 0.4, gestures: [['body-shift', 2], ['head-tilt', 1], ['hand-emphasis', 2], ['shoulder-shift', 1]], side: 'alternate' },
    enumeration: { base: 0.45, gestures: [['hand-emphasis', 4], ['body-shift', 1]], side: 'alternate' },
    conclusion: { base: 0.5, gestures: [['lean-in', 3], ['nod', 1], ['hand-emphasis', 1]], side: 'random' },
    emphasis: { base: 0.3, gestures: [['hand-emphasis', 2], ['lean-in', 1], ['nod', 1]], side: 'random' },
  },
  enumerationBase: { intro: 0.3, item: 0.5, final: 0.4 },
};

export type SemanticGestureConfigOverrides = Partial<Omit<SemanticGestureConfig, 'cues' | 'stateFactor' | 'enumerationBase'>> & {
  cues?: Partial<Record<SemanticCueType, Partial<SemanticCueGestureConfig>>>;
  stateFactor?: Partial<Record<AvatarState, number>>;
  enumerationBase?: Partial<SemanticGestureConfig['enumerationBase']>;
};

/** Deep copy with overrides. */
export function semanticGestureConfig(o: SemanticGestureConfigOverrides = {}): SemanticGestureConfig {
  const b = SEMANTIC_GESTURE_CONFIG;
  const cues = {} as SemanticGestureConfig['cues'];
  for (const [k, v] of Object.entries(b.cues) as [SemanticCueType, SemanticCueGestureConfig][]) {
    cues[k] = { ...v, gestures: [...v.gestures], ...o.cues?.[k] };
  }
  const { cues: _c, stateFactor, enumerationBase, ...rest } = o;
  return {
    ...b,
    intensity: [...b.intensity],
    ...rest,
    stateFactor: { ...b.stateFactor, ...stateFactor },
    enumerationBase: { ...b.enumerationBase, ...enumerationBase },
    cues,
  };
}
