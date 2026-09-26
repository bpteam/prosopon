import { NEUTRAL_EMOTION, type EmotionFrame } from '../audio/emotion/EmotionFrame';

/**
 * Emotion layer contract on the avatar side. Kept free of three.js/VRM imports like MouthShape.
 *
 * Expression ownership (Avatar composes them in this order, each owner writing only its own presets):
 *   aa ih ou ee oh                          → lip sync (MouthSource), never emotion
 *   happy relaxed sad angry surprised       → emotion layer (EmotionSource via BehaviorMixer)
 *   blink                                   → idle, max() with manual
 *   anything                                → manual/debug layer, max() with the procedural value
 */
export const EMOTION_EXPRESSIONS = ['happy', 'relaxed', 'sad', 'angry', 'surprised'] as const;
export type EmotionExpressionName = (typeof EMOTION_EXPRESSIONS)[number];
export type EmotionExpressions = Record<EmotionExpressionName, number>;

export const NO_EMOTION_EXPRESSIONS: Readonly<EmotionExpressions> = Object.freeze({
  happy: 0,
  relaxed: 0,
  sad: 0,
  angry: 0,
  surprised: 0,
});

const EMOTION_SET: ReadonlySet<string> = new Set(EMOTION_EXPRESSIONS);

export function isEmotionExpression(name: string): name is EmotionExpressionName {
  return EMOTION_SET.has(name);
}

/** What BehaviorMixer receives each frame from the emotion side: both channels and their on/off gains. */
export interface EmotionInputs {
  user: Readonly<EmotionFrame>;
  assistant: Readonly<EmotionFrame>;
  /** Debug switch "User emotion reactions", faded, [0, 1]. */
  userGain: number;
  /** Debug switch "Assistant emotion expression", faded, [0, 1]. */
  assistantGain: number;
}

export const NEUTRAL_EMOTION_INPUTS: Readonly<EmotionInputs> = Object.freeze({
  user: NEUTRAL_EMOTION,
  assistant: NEUTRAL_EMOTION,
  userGain: 1,
  assistantGain: 1,
});

/** Procedural source of emotion inputs, sampled by AvatarController once per frame. */
export interface EmotionSource {
  update(deltaTime: number): Readonly<EmotionInputs>;
}
