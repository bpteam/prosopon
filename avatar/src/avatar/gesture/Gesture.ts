// Contract only: renderer-independent. No three.js, no three-vrm, no Avatar/AvatarController imports (checked by
// tests/unit/architecture.test.ts). Type imports of other dependency-free contracts are fine.
import type { EmotionFrame } from '../../audio/emotion/EmotionFrame';
import type { AvatarState } from '../AvatarStateProfiles';

/**
 * `head-shake` (one small yaw oscillation) and `lean-in` exist for semantic performance (correction, conclusion):
 * the prosody scheduler never picks them (rate 0), only semantic intents and manual triggers do.
 */
export const GESTURE_TYPES = ['nod', 'double-nod', 'head-tilt', 'body-shift', 'shoulder-shift', 'hand-emphasis', 'head-shake', 'lean-in'] as const;
export type GestureType = (typeof GESTURE_TYPES)[number];

export function isGestureType(value: unknown): value is GestureType {
  return typeof value === 'string' && (GESTURE_TYPES as readonly string[]).includes(value);
}

/** Lifecycle of the one primary gesture. `release` also covers a cancel (short fade from wherever it was). */
export type GesturePhase = 'none' | 'prepare' | 'attack' | 'hold' | 'release' | 'done';

/** Offset added to a normalized bone's rotation (on top of the rest/manual pose), radians, Euler YXZ axes. */
export interface RotationOffset {
  x: number;
  y: number;
  z: number;
}

/**
 * One frame of gesture output: offsets relative to the base pose, never absolute rotations. Every group is always
 * present (zeros when unused) so a source can reuse one object per frame.
 *
 * Signs follow ProceduralPose: head pitch > 0 = chin down, roll > 0 = tilt to the model's left; lean > 0 = towards
 * the camera; shoulder > 0 = lifted.
 */
export interface GestureFrame {
  active: boolean;
  type: GestureType | null;
  phase: GesturePhase;
  /** Progress through the gesture's duration, [0, 1]. */
  progress: number;
  /** Scale of the configured amplitude this gesture runs at, [0, 1]. */
  intensity: number;

  head: { yaw: number; pitch: number; roll: number };
  body: { lean: number; yaw: number; roll: number };
  shoulders: { left: number; right: number };
  arms: {
    leftUpperArm: RotationOffset;
    leftLowerArm: RotationOffset;
    rightUpperArm: RotationOffset;
    rightLowerArm: RotationOffset;
  };
}

export const ARM_BONES = ['leftUpperArm', 'leftLowerArm', 'rightUpperArm', 'rightLowerArm'] as const;
export type ArmBone = (typeof ARM_BONES)[number];

export function createGestureFrame(): GestureFrame {
  return {
    active: false,
    type: null,
    phase: 'none',
    progress: 0,
    intensity: 0,
    head: { yaw: 0, pitch: 0, roll: 0 },
    body: { lean: 0, yaw: 0, roll: 0 },
    shoulders: { left: 0, right: 0 },
    arms: {
      leftUpperArm: { x: 0, y: 0, z: 0 },
      leftLowerArm: { x: 0, y: 0, z: 0 },
      rightUpperArm: { x: 0, y: 0, z: 0 },
      rightLowerArm: { x: 0, y: 0, z: 0 },
    },
  };
}

/** Zeroes every offset in place (keeps the object, no allocation). */
export function clearGestureOffsets(f: GestureFrame): void {
  f.head.yaw = f.head.pitch = f.head.roll = 0;
  f.body.lean = f.body.yaw = f.body.roll = 0;
  f.shoulders.left = f.shoulders.right = 0;
  for (const bone of ARM_BONES) {
    const a = f.arms[bone];
    a.x = a.y = a.z = 0;
  }
}

function freezeDeep<T extends object>(o: T): Readonly<T> {
  for (const v of Object.values(o)) if (v && typeof v === 'object') freezeDeep(v);
  return Object.freeze(o);
}

export const NEUTRAL_GESTURE: Readonly<GestureFrame> = freezeDeep(createGestureFrame());

/** What a gesture source sees each frame. Built by AvatarController; one object, mutated in place. */
export interface GestureContext {
  conversationState: AvatarState;
  userSpeaking: boolean;
  assistantSpeaking: boolean;
  userEmotion: Readonly<EmotionFrame>;
  assistantEmotion: Readonly<EmotionFrame>;
  /**
   * Monotonic count of finished user utterances (from UserReaction). A counter, not a per-frame boolean: an edge
   * that arrives between two update() calls can neither be lost nor seen twice.
   */
  utteranceEnds: number;
  /** Duration of the last finished user utterance, seconds. */
  lastUtteranceDuration: number;
}

/** Source of gestures (procedural and semantic). Only BehaviorMixer turns its output into a pose. */
export interface GestureSource {
  update(deltaTime: number, context: Readonly<GestureContext>): Readonly<GestureFrame>;
  /** Graceful: a short release from the current offsets, never a snap to rest. */
  cancel(): void;
  /** Hard reset to neutral (source went away, avatar swapped). */
  reset(): void;
}

/** Injectable randomness: Math.random in production, a seeded generator in tests. */
export interface RandomSource {
  /** Uniform in [0, 1). */
  next(): number;
}

export const mathRandom: RandomSource = { next: () => Math.random() };

/** mulberry32: tiny, fast, good enough for scheduling; same seed → same sequence. */
export function seededRandom(seed: number): RandomSource {
  let s = seed >>> 0;
  return {
    next() {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}
