/**
 * Reaction contract: how much the avatar responds to the user's voice, as a few bounded scalars. Kept free of
 * three.js/VRM imports like MouthShape. Not emotion and not mirroring: BehaviorMixer turns these into small offsets
 * with hard limits (REACTION_LIMITS), whatever the source asks for. No head/bone offsets of its own: nods are
 * gestures (GestureEngine), fed by `utteranceEnds`.
 */
export interface UserReactionFrame {
  /** Attentiveness while the user talks, [0, 1]. */
  engagement: number;
  /** User's voice is higher than their baseline, [0, 1]. */
  pitchLift: number;
  /** The user is talking right now (and it isn't the assistant's echo). */
  speaking: boolean;
  /**
   * Finished user utterances so far, any length (monotonic). The nod itself belongs to GestureEngine (US-008): the
   * reaction side only reports the boundary and its length, the engine decides which deserve a nod.
   */
  utteranceEnds: number;
  /** Length of the last finished utterance, seconds. */
  lastUtteranceDuration: number;
}

export const NEUTRAL_REACTION: Readonly<UserReactionFrame> = Object.freeze({
  engagement: 0,
  pitchLift: 0,
  speaking: false,
  utteranceEnds: 0,
  lastUtteranceDuration: 0,
});

/** Procedural source of reactions, sampled by AvatarController once per frame. */
export interface ReactionSource {
  update(deltaTime: number): Readonly<UserReactionFrame>;
}

/** What a full-scale (1.0) reaction does to the pose. Deliberately small. */
export const REACTION_LIMITS = Object.freeze({
  /** Extra head motion at engagement 1: × (1 + this). */
  headMotionGain: 0.12,
  /** Gaze gets steadier at engagement 1: × (1 − this). */
  gazeSteadyGain: 0.25,
  /** Forward lean at engagement 1, radians. */
  lean: 0.012,
  /** Chin up at pitchLift 1, radians. */
  pitchLift: 0.012,
});
