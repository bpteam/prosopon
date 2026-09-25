import type { BoneRotation, HumanBoneName } from './avatar/Avatar';

export type Vec3Tuple = readonly [number, number, number];

/**
 * Portrait ("voice assistant") framing: head, shoulders, upper torso.
 *
 * Positions are relative to the head bone instead of absolute world
 * coordinates, so framing survives a different model height.
 */
export const AVATAR_VIEW = {
  fov: 30,
  near: 0.05,
  far: 20,
  /** Point the camera looks at, relative to the head bone origin (meters). */
  targetOffsetFromHead: [0, -0.02, 0] as Vec3Tuple,
  /** Camera height relative to the look target (slightly above = looking a bit down). */
  cameraHeightOffset: 0.03,
  /** Minimum visible area around the target, in meters. Distance is fitted to the aspect ratio. */
  frameHeight: 0.72,
  frameWidth: 0.48,
  /** Used when the model has no head bone. */
  fallback: {
    cameraPosition: [0, 1.45, 1.8] as Vec3Tuple,
    target: [0, 1.4, 0] as Vec3Tuple,
  },
} as const;

/**
 * VRM rest pose is a T-pose, which puts the arms into a portrait frame.
 * Lower them (normalized bones, radians).
 */
export const REST_POSE: Partial<Record<HumanBoneName, BoneRotation>> = {
  leftUpperArm: { x: 0, y: 0, z: -1.2 },
  rightUpperArm: { x: 0, y: 0, z: 1.2 },
  leftLowerArm: { x: 0, y: -0.15, z: 0 },
  rightLowerArm: { x: 0, y: 0.15, z: 0 },
};

export const MODEL_URL = `${import.meta.env.BASE_URL}models/avatar.vrm`;

/** Hard cap for a single frame delta: avoids animation jumps after a hidden tab resumes. */
export const MAX_FRAME_DELTA = 0.1;
