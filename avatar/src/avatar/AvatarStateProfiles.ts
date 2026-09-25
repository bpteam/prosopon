/**
 * Conversation states and how each one shapes the procedural (idle) pose.
 *
 * Conversation state is not emotion: no profile touches expressions. An emotion layer is a separate source.
 */
export const AVATAR_STATES = ['idle', 'listening', 'thinking', 'speaking'] as const;

export type AvatarState = (typeof AVATAR_STATES)[number];

export const INITIAL_AVATAR_STATE: AvatarState = 'idle';

/** Seconds for a full blend from one profile to another. */
export const STATE_TRANSITION_DURATION = 0.35;

/**
 * Modifiers applied on top of the idle pose.
 * Multipliers scale the idle signal; offsets are added after scaling.
 * Angles: head/lean in radians, gaze in degrees (same units as ProceduralPose).
 */
export interface AvatarStateProfile {
  headMotionMultiplier: number;
  gazeMotionMultiplier: number;
  breathingMultiplier: number;

  headYawOffset: number;
  headPitchOffset: number;
  headRollOffset: number;

  gazeYawOffset: number;
  gazePitchOffset: number;

  /** Upper-body forward lean, radians. */
  leanOffset: number;
}

export const PROFILE_KEYS = [
  'headMotionMultiplier',
  'gazeMotionMultiplier',
  'breathingMultiplier',
  'headYawOffset',
  'headPitchOffset',
  'headRollOffset',
  'gazeYawOffset',
  'gazePitchOffset',
  'leanOffset',
] as const satisfies readonly (keyof AvatarStateProfile)[];

const NEUTRAL: AvatarStateProfile = {
  headMotionMultiplier: 1,
  gazeMotionMultiplier: 1,
  breathingMultiplier: 1,
  headYawOffset: 0,
  headPitchOffset: 0,
  headRollOffset: 0,
  gazeYawOffset: 0,
  gazePitchOffset: 0,
  leanOffset: 0,
};

function profile(overrides: Partial<AvatarStateProfile>): Readonly<AvatarStateProfile> {
  return Object.freeze({ ...NEUTRAL, ...overrides });
}

/**
 * Tuned by eye on the sample model. Head pitch > 0 = chin down, roll > 0 = tilt to the model's left.
 * Gaze pitch < 0 = below the camera.
 */
export const STATE_PROFILES: Readonly<Record<AvatarState, Readonly<AvatarStateProfile>>> = Object.freeze({
  idle: profile({}),

  // Attentive: steady eye contact, calmer head, a hint of chin-down and forward lean.
  listening: profile({
    headMotionMultiplier: 0.65,
    gazeMotionMultiplier: 0.25,
    headPitchOffset: 0.025,
    headRollOffset: 0.02,
    leanOffset: 0.02,
  }),

  // Inward: small tilt, gaze slightly aside and down, less movement overall.
  thinking: profile({
    headMotionMultiplier: 0.45,
    gazeMotionMultiplier: 0.35,
    headYawOffset: -0.035,
    headPitchOffset: 0.01,
    headRollOffset: 0.045,
    gazeYawOffset: -7,
    gazePitchOffset: -2.5,
    breathingMultiplier: 0.9,
  }),

  // Engaged: mostly eye contact, a bit livelier head and posture.
  speaking: profile({
    headMotionMultiplier: 1.3,
    gazeMotionMultiplier: 0.4,
    breathingMultiplier: 1.1,
    headPitchOffset: -0.01,
    leanOffset: 0.03,
  }),
});

export function isAvatarState(value: unknown): value is AvatarState {
  return typeof value === 'string' && (AVATAR_STATES as readonly string[]).includes(value);
}
