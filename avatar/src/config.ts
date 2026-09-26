import type { BoneRotation, HumanBoneName } from './avatar/Avatar';
import type { CameraPreset } from './renderer/CameraFraming';

export type Vec3Tuple = readonly [number, number, number];

/**
 * Camera lens and default framing. What a preset puts in frame is defined in renderer/CameraFraming.ts relative to
 * the model's own bones and bounding box, so framing survives a different model height.
 */
export const AVATAR_VIEW = {
  fov: 30,
  near: 0.05,
  far: 20,
  /** Preset the stage starts with. */
  preset: 'waist' as CameraPreset,
  /**
   * Upper bound of drawing-buffer pixels (width × height × pixelRatio²). A full-viewport transparent canvas at DPR 2
   * on a 4K screen is ~33 M pixels; above this budget the pixel ratio is lowered instead.
   */
  maxPixels: 4_500_000,
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
