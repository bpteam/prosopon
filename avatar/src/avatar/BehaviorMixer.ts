import { EMPTY_PROCEDURAL_POSE, type MouthShape, type ProceduralPose } from './Avatar';
import type { AvatarStateProfile } from './AvatarStateProfiles';
import { NEUTRAL_REACTION, REACTION_LIMITS, type UserReactionFrame } from './UserReaction';

/**
 * The single place where behaviour sources are merged into the one ProceduralPose that Avatar receives.
 *
 * Current sources: idle (base signal), conversation state (scales and biases it), mouth (lip sync) and the user
 * reaction (small, bounded modulation from the user's voice, including the nod). Future sources (emotion → expressions/posture, gestures) are added here as further
 * inputs of compose(), never as additional writers of Avatar.setProcedural().
 */
export class BehaviorMixer {
  private readonly out: ProceduralPose = { ...EMPTY_PROCEDURAL_POSE };

  /** Result of the last compose(). Mutated in place every frame. */
  get pose(): Readonly<ProceduralPose> {
    return this.out;
  }

  /**
   * @param mouth lip sync output: openness on "aa", or a weight per viseme preset
   * @param reaction user reaction; clamped here, so no source can exceed REACTION_LIMITS
   */
  compose(
    idle: Readonly<ProceduralPose>,
    state: Readonly<AvatarStateProfile>,
    mouth: number | Readonly<MouthShape> = 0,
    reaction: Readonly<UserReactionFrame> = NEUTRAL_REACTION,
  ): Readonly<ProceduralPose> {
    const o = this.out;
    const engagement = clamp(reaction.engagement, 0, 1);
    const lift = clamp(reaction.pitchLift, 0, 1);
    const nod = clamp(reaction.nod, 0, 1);

    const head = state.headMotionMultiplier * (1 + REACTION_LIMITS.headMotionGain * engagement);
    o.headYaw = idle.headYaw * head + state.headYawOffset;
    // Pitch > 0 is chin down: the nod dips, a raised voice lifts the chin a touch.
    o.headPitch =
      idle.headPitch * head + state.headPitchOffset + REACTION_LIMITS.nod * nod - REACTION_LIMITS.pitchLift * lift;
    o.headRoll = idle.headRoll * head + state.headRollOffset;

    o.breath = idle.breath * state.breathingMultiplier;
    o.lean = idle.lean + state.leanOffset + REACTION_LIMITS.lean * engagement;

    // Blink is owned by idle; state never modulates it, so a state switch cannot interrupt a blink.
    o.blink = idle.blink;

    const gaze = state.gazeMotionMultiplier * (1 - REACTION_LIMITS.gazeSteadyGain * engagement);
    o.gazeYaw = idle.gazeYaw * gaze + state.gazeYawOffset;
    o.gazePitch = idle.gazePitch * gaze + state.gazePitchOffset;

    // Mouth is owned by lip sync; neither idle nor state has an opinion about it.
    if (typeof mouth === 'number') {
      o.aa = mouth;
      o.ih = o.ou = o.ee = o.oh = 0;
    } else {
      o.aa = mouth.aa;
      o.ih = mouth.ih;
      o.ou = mouth.ou;
      o.ee = mouth.ee;
      o.oh = mouth.oh;
    }
    return o;
  }
}

function clamp(v: number, min: number, max: number): number {
  return Number.isFinite(v) ? (v < min ? min : v > max ? max : v) : 0;
}
