import type { AvatarState } from './AvatarStateProfiles';
import type { ProceduralPose } from './Avatar';
import type { GestureFrame } from './gesture/Gesture';

/**
 * Read-only diagnostics of one frame of behaviour composition: why the avatar looks the way it does. Filled from the
 * values AvatarController and BehaviorMixer actually used in the last update(), never re-derived by a UI. Writing to
 * it changes nothing: it is a copy.
 *
 * BehaviorMixer multiplies and adds its sources rather than blending them with weights, so each "weight" here is the
 * effective gain that source had on this frame:
 *  - idle: the idle generator's enable fade (0..1);
 *  - state: progress of the conversation-state transition (1 = settled in `state`);
 *  - assistantEmotion / userEmotion: EmotionMixState (state weight × channel gain × confidence);
 *  - userReaction: the reaction's engagement (0..1), what scales head motion, gaze and lean;
 *  - gesture: the active gesture's intensity (0 when none runs);
 *  - mouth: the largest viseme weight lip sync asked for.
 */
export interface BehaviorDebugSnapshot {
  state: AvatarState;
  weights: {
    idle: number;
    state: number;
    assistantEmotion: number;
    userEmotion: number;
    userReaction: number;
    gesture: number;
    mouth: number;
  };
  /** Composed procedural pose (after clamping), a copy. */
  pose: ProceduralPose;
  gesture: {
    type: GestureFrame['type'];
    phase: GestureFrame['phase'];
    progress: number;
    intensity: number;
  };
  /** Final procedural expression weights of the frame. */
  expressions: {
    blink: number;
    aa: number;
    ih: number;
    ou: number;
    ee: number;
    oh: number;
    happy: number;
    sad: number;
    angry: number;
    relaxed: number;
    surprised: number;
  };
}
