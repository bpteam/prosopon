import { EMPTY_PROCEDURAL_POSE, type MouthShape, type ProceduralPose } from './Avatar';
import type { AvatarStateProfile } from './AvatarStateProfiles';
import { EMOTION_EXPRESSIONS, NEUTRAL_EMOTION_INPUTS, type EmotionExpressions, type EmotionInputs } from './EmotionExpression';
import { NEUTRAL_REACTION, REACTION_LIMITS, type UserReactionFrame } from './UserReaction';
import { POSE_LIMITS } from './BodyPose';
import { NEUTRAL_GESTURE, type GestureFrame } from './gesture/Gesture';
import { GESTURE_LIMITS } from './gesture/GestureConfig';

/**
 * How far the emotion layer may move the avatar. Everything is subtle on purpose: full-scale values of every input
 * (arousal 1, valence 1, tension 1, confidence 1) stay inside these bounds.
 */
export interface EmotionMixConfig {
  // Assistant: self-expression while it speaks.
  /** Head motion × (1 ± this) at arousal 1/0. */
  assistantHeadMotion: number;
  /** Gaze wandering × (1 ± this) at arousal 1/0. */
  assistantGazeMotion: number;
  /** Breathing × (1 ± this) at arousal 1/0 ("body motion"). */
  assistantBodyMotion: number;
  /** Extra forward lean at arousal 1, radians. */
  assistantLean: number;
  /** Gaze gets steadier at tension 1: × (1 − this). */
  assistantTensionFocus: number;
  /** Expression weights at full scale. */
  smile: number;
  relaxed: number;
  surprised: number;
  brows: number;
  sad: number;

  // User: reaction layer while the user speaks (never mirroring).
  /** Head steadier at user arousal 1: × (1 − this). */
  userHeadStability: number;
  /** Head motion softer at user arousal 0 (calm voice): × (1 − this). */
  userCalmSoftening: number;
  /** Gaze steadier at user arousal 1 or tension 1: × (1 − this). */
  userGazeFocus: number;
  /** Forward lean (attention) at user arousal 1, radians. */
  userLean: number;
  /** Reciprocal smile at user valence 1 (and full valence confidence). */
  userSmile: number;
  /** User tension neutralises the avatar's own expression by up to this share. */
  userTensionNeutralize: number;

  /** Upper bound of the sum of emotion expression weights (keeps the face readable and the mouth free). */
  expressionBudget: number;
}

export const DEFAULT_EMOTION_MIX: Readonly<EmotionMixConfig> = Object.freeze({
  assistantHeadMotion: 0.35,
  assistantGazeMotion: 0.3,
  assistantBodyMotion: 0.15,
  assistantLean: 0.015,
  assistantTensionFocus: 0.3,
  smile: 0.35,
  relaxed: 0.25,
  surprised: 0.15,
  brows: 0.12,
  sad: 0.12,
  userHeadStability: 0.25,
  userCalmSoftening: 0.15,
  userGazeFocus: 0.3,
  userLean: 0.012,
  userSmile: 0.15,
  userTensionNeutralize: 0.6,
  expressionBudget: 0.45,
});

/** Pose channels whose sources are attributed (see PoseAttribution). */
export const ATTRIBUTED_CHANNELS = [
  'headYaw',
  'headPitch',
  'headRoll',
  'lean',
  'bodyYaw',
  'bodyRoll',
  'shoulderLeft',
  'shoulderRight',
] as const;
export type AttributedChannel = (typeof ATTRIBUTED_CHANNELS)[number];

/**
 * Where one pose channel's value came from, radians. The sources add up to `sum`; `final` is what Avatar received
 * after the POSE_LIMITS clamp. BehaviorMixer multiplies idle by the state, reaction and emotion gains, so their
 * shares are the differences those gains made, applied in that order:
 *   idle     = idle × state multiplier
 *   reaction = the reaction gain's share of the scaled idle, plus its own offsets (lean, chin lift)
 *   emotion  = the emotion gain's share of the scaled idle, plus its own offsets (lean)
 *   state    = the state profile's fixed offset
 *   gesture  = the gesture after its GESTURE_LIMITS clamp; `gestureRequested` is before that clamp
 */
export interface ChannelAttribution {
  final: number;
  sum: number;
  gestureRequested: number;
  sources: { idle: number; state: number; reaction: number; emotion: number; gesture: number };
}

export type PoseAttribution = Record<AttributedChannel, ChannelAttribution> & {
  /** Largest absolute arm offset (all arm bones and axes): gestures only. */
  arms: { final: number; gestureRequested: number };
};

function createAttribution(): PoseAttribution {
  const channel = (): ChannelAttribution => ({
    final: 0,
    sum: 0,
    gestureRequested: 0,
    sources: { idle: 0, state: 0, reaction: 0, emotion: 0, gesture: 0 },
  });
  const a = Object.fromEntries(ATTRIBUTED_CHANNELS.map((c) => [c, channel()])) as Record<AttributedChannel, ChannelAttribution>;
  return { ...a, arms: { final: 0, gestureRequested: 0 } };
}

/** Effective weights of the last compose(), for diagnostics and tests. */
export interface EmotionMixState {
  /** State weight × debug gain × confidence of the assistant channel. */
  assistant: number;
  /** State weight × debug gain × confidence of the user channel. */
  user: number;
}

/**
 * The single place where behaviour sources are merged into the one ProceduralPose that Avatar receives.
 *
 * Sources: idle (base signal), conversation state (scales and biases it), mouth (lip sync), the user reaction
 * (small, bounded modulation from the user's voice), emotion (assistant self-expression and the user reaction
 * layer, weighted per conversation state) and gestures (transient head/body/shoulder/arm offsets, US-008). New
 * sources are added here as further inputs of compose(), never as additional writers of Avatar.setProcedural().
 *
 * Ownership: the mouth visemes come from `mouth` only; emotion writes happy/relaxed/sad/angry/surprised, head/gaze
 * motion and posture, never a viseme; gestures write head/body/shoulder/arm offsets only (no expression, no blink,
 * no gaze). Each gesture channel is clamped to GESTURE_LIMITS, then the summed procedural pose to POSE_LIMITS.
 */
export class BehaviorMixer {
  readonly emotionConfig: EmotionMixConfig;
  private readonly out: ProceduralPose = { ...EMPTY_PROCEDURAL_POSE };
  private readonly mix: EmotionMixState = { assistant: 0, user: 0 };
  private attributionOut: PoseAttribution | null = null;

  constructor(emotionConfig: Partial<EmotionMixConfig> = {}) {
    this.emotionConfig = { ...DEFAULT_EMOTION_MIX, ...emotionConfig };
  }

  /** Effective emotion weights of the last compose(). */
  get emotionMix(): Readonly<EmotionMixState> {
    return this.mix;
  }

  /**
   * Per-source attribution of the head/body channels (calibration). Off by default: compose() then does no extra
   * work. Diagnostics only: it never changes the pose.
   */
  setAttributionEnabled(on: boolean): void {
    this.attributionOut = on ? (this.attributionOut ?? createAttribution()) : null;
  }

  /** Attribution of the last compose(), mutated in place; null while disabled. */
  get attribution(): Readonly<PoseAttribution> | null {
    return this.attributionOut;
  }

  /** Result of the last compose(). Mutated in place every frame. */
  get pose(): Readonly<ProceduralPose> {
    return this.out;
  }

  /**
   * @param mouth lip sync output: openness on "aa", or a weight per viseme preset
   * @param reaction user reaction; clamped here, so no source can exceed REACTION_LIMITS
   * @param emotion both voice channels' emotion; clamped here, so no source can exceed the EmotionMixConfig bounds
   * @param gesture the primary gesture's offsets; clamped here to GESTURE_LIMITS
   */
  compose(
    idle: Readonly<ProceduralPose>,
    state: Readonly<AvatarStateProfile>,
    mouth: number | Readonly<MouthShape> = 0,
    reaction: Readonly<UserReactionFrame> = NEUTRAL_REACTION,
    emotion: Readonly<EmotionInputs> = NEUTRAL_EMOTION_INPUTS,
    gesture: Readonly<GestureFrame> = NEUTRAL_GESTURE,
  ): Readonly<ProceduralPose> {
    const o = this.out;
    const c = this.emotionConfig;
    const engagement = clamp(reaction.engagement, 0, 1);
    const lift = clamp(reaction.pitchLift, 0, 1);

    // Emotion weights: conversation state decides whose voice counts (priority rules), the debug switches can turn
    // either off, and confidence scales both, so an unsure analyser leaves the avatar near neutral.
    const a = emotion.assistant;
    const u = emotion.user;
    const wa = clamp(state.assistantEmotionWeight, 0, 1) * clamp(emotion.assistantGain, 0, 1);
    const wu = clamp(state.userEmotionWeight, 0, 1) * clamp(emotion.userGain, 0, 1);
    const aConf = clamp(a.confidence, 0, 1);
    const uConf = clamp(u.confidence, 0, 1);
    const ea = wa * aConf;
    const eu = wu * uConf;
    this.mix.assistant = ea;
    this.mix.user = eu;
    // Arousal centred on 0.5, [−1, 1]: above livelier, below calmer.
    const aArousal = (clamp(a.arousal, 0, 1) - 0.5) * 2;
    const uArousal = (clamp(u.arousal, 0, 1) - 0.5) * 2;
    const aTension = clamp(a.tension, 0, 1);
    const uTension = clamp(u.tension, 0, 1);

    const emotionHead =
      (1 + c.assistantHeadMotion * aArousal * ea) *
      (1 - c.userHeadStability * Math.max(0, uArousal) * eu) *
      (1 - c.userCalmSoftening * Math.max(0, -uArousal) * eu);
    const emotionGaze =
      (1 + c.assistantGazeMotion * aArousal * ea) *
      (1 - c.assistantTensionFocus * aTension * ea) *
      (1 - c.userGazeFocus * Math.max(Math.max(0, uArousal), uTension) * eu);

    const head = state.headMotionMultiplier * (1 + REACTION_LIMITS.headMotionGain * engagement) * emotionHead;
    const L = GESTURE_LIMITS;
    const P = POSE_LIMITS;
    const gh = gesture.head;
    const gb = gesture.body;
    o.headYaw = sym(idle.headYaw * head + state.headYawOffset + sym(gh.yaw, L.headYaw), P.headYaw);
    // Pitch > 0 is chin down: a nod (gesture) dips, a raised voice lifts the chin a touch.
    o.headPitch = sym(
      idle.headPitch * head + state.headPitchOffset - REACTION_LIMITS.pitchLift * lift + sym(gh.pitch, L.headPitch),
      P.headPitch,
    );
    o.headRoll = sym(idle.headRoll * head + state.headRollOffset + sym(gh.roll, L.headRoll), P.headRoll);

    o.breath = idle.breath * state.breathingMultiplier * (1 + c.assistantBodyMotion * aArousal * ea);
    o.lean =
      idle.lean +
      state.leanOffset +
      REACTION_LIMITS.lean * engagement +
      c.assistantLean * Math.max(0, aArousal) * ea +
      c.userLean * Math.max(0, uArousal) * eu;
    o.lean = sym(o.lean + sym(gb.lean, L.bodyLean), P.lean);

    // Body, shoulders, arms: gestures only (idle breathes through `breath`, handled by Avatar).
    o.bodyYaw = sym(sym(gb.yaw, L.bodyYaw), P.bodyYaw);
    o.bodyRoll = sym(sym(gb.roll, L.bodyRoll), P.bodyRoll);
    o.shoulderLeft = sym(sym(gesture.shoulders.left, L.shoulder), P.shoulder);
    o.shoulderRight = sym(sym(gesture.shoulders.right, L.shoulder), P.shoulder);
    const arms = gesture.arms;
    const arm = Math.min(L.arm, P.arm);
    o.leftUpperArmX = sym(arms.leftUpperArm.x, arm);
    o.leftUpperArmY = sym(arms.leftUpperArm.y, arm);
    o.leftUpperArmZ = sym(arms.leftUpperArm.z, arm);
    o.leftLowerArmX = sym(arms.leftLowerArm.x, arm);
    o.leftLowerArmY = sym(arms.leftLowerArm.y, arm);
    o.leftLowerArmZ = sym(arms.leftLowerArm.z, arm);
    o.rightUpperArmX = sym(arms.rightUpperArm.x, arm);
    o.rightUpperArmY = sym(arms.rightUpperArm.y, arm);
    o.rightUpperArmZ = sym(arms.rightUpperArm.z, arm);
    o.rightLowerArmX = sym(arms.rightLowerArm.x, arm);
    o.rightLowerArmY = sym(arms.rightLowerArm.y, arm);
    o.rightLowerArmZ = sym(arms.rightLowerArm.z, arm);

    // Blink is owned by idle; state never modulates it, so a state switch cannot interrupt a blink.
    o.blink = idle.blink;

    const gaze = state.gazeMotionMultiplier * (1 - REACTION_LIMITS.gazeSteadyGain * engagement) * emotionGaze;
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

    this.composeExpressions(o, emotion, wa, wu, ea, eu, aArousal, aTension, uTension);
    const at = this.attributionOut;
    if (at) {
      // Same terms as above, split by source (see ChannelAttribution). Only runs while calibration asked for it.
      const base = state.headMotionMultiplier;
      const react = base * (1 + REACTION_LIMITS.headMotionGain * engagement);
      const head3 = [
        ['headYaw', idle.headYaw, state.headYawOffset, 0, gh.yaw, L.headYaw],
        ['headPitch', idle.headPitch, state.headPitchOffset, -REACTION_LIMITS.pitchLift * lift, gh.pitch, L.headPitch],
        ['headRoll', idle.headRoll, state.headRollOffset, 0, gh.roll, L.headRoll],
      ] as const;
      for (const [key, i, offset, reactionOffset, g, limit] of head3) {
        const idleShare = finite(i * base);
        attribute(at[key], o[key], idleShare, offset, finite(i * react) - idleShare + reactionOffset, finite(i * react * emotionHead) - finite(i * react), g, limit);
      }
      attribute(
        at.lean,
        o.lean,
        idle.lean,
        state.leanOffset,
        REACTION_LIMITS.lean * engagement,
        c.assistantLean * Math.max(0, aArousal) * ea + c.userLean * Math.max(0, uArousal) * eu,
        gb.lean,
        L.bodyLean,
      );
      attribute(at.bodyYaw, o.bodyYaw, 0, 0, 0, 0, gb.yaw, L.bodyYaw);
      attribute(at.bodyRoll, o.bodyRoll, 0, 0, 0, 0, gb.roll, L.bodyRoll);
      attribute(at.shoulderLeft, o.shoulderLeft, 0, 0, 0, 0, gesture.shoulders.left, L.shoulder);
      attribute(at.shoulderRight, o.shoulderRight, 0, 0, 0, 0, gesture.shoulders.right, L.shoulder);
      let armFinal = 0;
      let armRequested = 0;
      for (const bone of ['leftUpperArm', 'leftLowerArm', 'rightUpperArm', 'rightLowerArm'] as const) {
        for (const axis of ['x', 'y', 'z'] as const) {
          armRequested = Math.max(armRequested, Math.abs(finite(arms[bone][axis])));
          const axisKey = `${bone}${axis.toUpperCase()}` as keyof ProceduralPose;
          armFinal = Math.max(armFinal, Math.abs(o[axisKey]));
        }
      }
      at.arms.final = armFinal;
      at.arms.gestureRequested = armRequested;
    }
    return o;
  }

  private composeExpressions(
    o: EmotionExpressions,
    emotion: Readonly<EmotionInputs>,
    wa: number,
    wu: number,
    ea: number,
    eu: number,
    aArousal: number,
    aTension: number,
    uTension: number,
  ): void {
    const c = this.emotionConfig;
    const a = emotion.assistant;
    const u = emotion.user;
    // Valence counts only as far as the analyser trusts it (heuristics cap that low).
    const aValence = clamp(a.valence, -1, 1) * clamp(a.valenceConfidence, 0, 1) * wa;
    const uValence = clamp(u.valence, -1, 1) * clamp(u.valenceConfidence, 0, 1) * wu;
    const unTense = 1 - aTension * ea;
    // The user's tension makes the avatar more neutral and attentive, not tense back.
    const neutralize = 1 - c.userTensionNeutralize * uTension * eu;

    o.happy = (c.smile * Math.max(0, aValence) * unTense + c.userSmile * Math.max(0, uValence) * (1 - uTension)) * neutralize;
    o.relaxed = c.relaxed * (Math.max(0, -aArousal) * ea + 0.5 * Math.max(0, aValence)) * unTense * neutralize;
    o.surprised = c.surprised * Math.max(0, aArousal) * clamp(a.pitchLift, 0, 1) * ea * neutralize;
    o.angry = c.brows * aTension * ea * neutralize;
    o.sad = c.sad * Math.max(0, -aValence) * neutralize;

    let sum = 0;
    for (const e of EMOTION_EXPRESSIONS) {
      o[e] = clamp(o[e], 0, 1);
      sum += o[e];
    }
    if (sum > c.expressionBudget) {
      const k = c.expressionBudget / sum;
      for (const e of EMOTION_EXPRESSIONS) o[e] *= k;
    }
  }
}

function attribute(
  a: ChannelAttribution,
  final: number,
  idle: number,
  state: number,
  reaction: number,
  emotion: number,
  gestureRequested: number,
  gestureLimit: number,
): void {
  const s = a.sources;
  s.idle = finite(idle);
  s.state = finite(state);
  s.reaction = finite(reaction);
  s.emotion = finite(emotion);
  s.gesture = sym(gestureRequested, gestureLimit);
  a.gestureRequested = finite(gestureRequested);
  a.sum = s.idle + s.state + s.reaction + s.emotion + s.gesture;
  a.final = final;
}

function finite(v: number): number {
  return Number.isFinite(v) ? v : 0;
}

/** Clamp to [−limit, limit]; NaN/±Infinity → 0. */
function sym(v: number, limit: number): number {
  return Number.isFinite(v) ? (v < -limit ? -limit : v > limit ? limit : v) : 0;
}

function clamp(v: number, min: number, max: number): number {
  return Number.isFinite(v) ? (v < min ? min : v > max ? max : v) : 0;
}
