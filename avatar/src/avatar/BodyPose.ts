// Contract only, like MouthShape: no three.js/VRM imports.

/**
 * Upper-body offsets of the procedural pose beyond head/lean/breath (US-008: gestures). Radians, added on top of
 * the manual layer (REST_POSE included) by Avatar, never replacing it.
 *
 * bodyYaw/bodyRoll are split over spine and chest like lean. shoulderLeft/Right > 0 lifts that shoulder (falls
 * back to a chest roll on models without shoulder bones). Arm offsets are Euler YXZ components of the normalized
 * upper/lower arm bones.
 */
export interface BodyPose {
  bodyYaw: number;
  bodyRoll: number;
  shoulderLeft: number;
  shoulderRight: number;
  leftUpperArmX: number;
  leftUpperArmY: number;
  leftUpperArmZ: number;
  leftLowerArmX: number;
  leftLowerArmY: number;
  leftLowerArmZ: number;
  rightUpperArmX: number;
  rightUpperArmY: number;
  rightUpperArmZ: number;
  rightLowerArmX: number;
  rightLowerArmY: number;
  rightLowerArmZ: number;
}

export const BODY_POSE_KEYS = [
  'bodyYaw',
  'bodyRoll',
  'shoulderLeft',
  'shoulderRight',
  'leftUpperArmX',
  'leftUpperArmY',
  'leftUpperArmZ',
  'leftLowerArmX',
  'leftLowerArmY',
  'leftLowerArmZ',
  'rightUpperArmX',
  'rightUpperArmY',
  'rightUpperArmZ',
  'rightLowerArmX',
  'rightLowerArmY',
  'rightLowerArmZ',
] as const satisfies readonly (keyof BodyPose)[];

export const NEUTRAL_BODY_POSE: Readonly<BodyPose> = Object.freeze(
  Object.fromEntries(BODY_POSE_KEYS.map((k) => [k, 0])) as unknown as BodyPose,
);

/**
 * Safety bounds of the final procedural pose (all layers summed), radians. BehaviorMixer clamps to these after
 * composition. The manual/debug layer is deliberately not clamped: REST_POSE and debug sliders need full range.
 */
export const POSE_LIMITS = Object.freeze({
  headYaw: 0.35,
  headPitch: 0.3,
  headRoll: 0.25,
  lean: 0.12,
  bodyYaw: 0.12,
  bodyRoll: 0.08,
  shoulder: 0.12,
  arm: 0.5,
});
