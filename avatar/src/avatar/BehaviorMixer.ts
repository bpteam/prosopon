import { EMPTY_PROCEDURAL_POSE, type ProceduralPose } from './Avatar';
import type { AvatarStateProfile } from './AvatarStateProfiles';

/**
 * The single place where behaviour sources are merged into the one ProceduralPose that Avatar receives.
 *
 * Current sources: idle (base signal), conversation state (scales and biases it) and mouth (lip sync).
 * Future sources (emotion → expressions/posture, gestures) are added here as further
 * inputs of compose(), never as additional writers of Avatar.setProcedural().
 */
export class BehaviorMixer {
  private readonly out: ProceduralPose = { ...EMPTY_PROCEDURAL_POSE };

  /** Result of the last compose(). Mutated in place every frame. */
  get pose(): Readonly<ProceduralPose> {
    return this.out;
  }

  compose(idle: Readonly<ProceduralPose>, state: Readonly<AvatarStateProfile>, mouthOpen = 0): Readonly<ProceduralPose> {
    const o = this.out;
    const head = state.headMotionMultiplier;
    o.headYaw = idle.headYaw * head + state.headYawOffset;
    o.headPitch = idle.headPitch * head + state.headPitchOffset;
    o.headRoll = idle.headRoll * head + state.headRollOffset;

    o.breath = idle.breath * state.breathingMultiplier;
    o.lean = idle.lean + state.leanOffset;

    // Blink is owned by idle; state never modulates it, so a state switch cannot interrupt a blink.
    o.blink = idle.blink;

    const gaze = state.gazeMotionMultiplier;
    o.gazeYaw = idle.gazeYaw * gaze + state.gazeYawOffset;
    o.gazePitch = idle.gazePitch * gaze + state.gazePitchOffset;

    // Mouth is owned by lip sync; neither idle nor state has an opinion about it.
    o.mouthOpen = mouthOpen;
    return o;
  }
}
