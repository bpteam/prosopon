import type * as THREE from 'three';
import type { Avatar, BoneRotation, HumanBoneName, ProceduralPose } from './Avatar';
import { CLOSED_MOUTH, type MouthSource } from './MouthShape';
import { AvatarIdleController } from './AvatarIdleController';
import type { AvatarState, AvatarStateProfile } from './AvatarStateProfiles';
import { BehaviorMixer, type EmotionMixConfig, type EmotionMixState } from './BehaviorMixer';
import { NEUTRAL_EMOTION_INPUTS, type EmotionInputs, type EmotionSource } from './EmotionExpression';
import { ConversationStateMachine, type ConversationStateMachineOptions } from './ConversationStateMachine';
import { NEUTRAL_REACTION, type ReactionSource } from './UserReaction';
import { NEUTRAL_GESTURE, type GestureContext, type GestureFrame, type GestureSource } from './gesture/Gesture';
import { NEUTRAL_EMOTION } from '../audio/emotion/EmotionFrame';
import type { UserReactionFrame } from './UserReaction';
import type { BehaviorDebugSnapshot } from './BehaviorSnapshot';

export type { BehaviorDebugSnapshot } from './BehaviorSnapshot';

export type { MouthSource } from './MouthShape';
export type { ReactionSource } from './UserReaction';
export type { EmotionSource } from './EmotionExpression';
export type { GestureSource } from './gesture/Gesture';

export type StateChangeListener = (state: AvatarState, previous: AvatarState) => void;

export interface AvatarControllerApi {
  getState(): AvatarState;
  setState(state: AvatarState): void;
  onStateChange(listener: StateChangeListener): () => void;

  setExpression(name: string, value: number): boolean;
  setHeadRotation(yaw: number, pitch: number, roll: number): boolean;
  setLookAtTarget(target: THREE.Object3D | null): void;
  setIdleEnabled(enabled: boolean): void;
  setMouthSource(source: MouthSource | null): void;
  setReactionSource(source: ReactionSource | null): void;
  setEmotionSource(source: EmotionSource | null): void;
  setGestureSource(source: GestureSource | null): void;

  update(deltaTime: number): void;
}

export interface AvatarControllerOptions extends ConversationStateMachineOptions {
  /**
   * The avatar to drive. May be attached later with attachAvatar(): the controller (state, idle, lip sync)
   * runs without one, so providers can talk to it while the model is still loading.
   */
  avatar?: Avatar | null;
  /** Created with defaults if omitted. */
  idle?: AvatarIdleController;
  /** Receives exceptions thrown by state listeners. Defaults to console.error. */
  onListenerError?: (error: unknown) => void;
}

/**
 * Public API of the avatar subsystem. External providers (conversation adapter, audio, emotion, tracking)
 * talk to this class; they know nothing about three-vrm, bones or the idle animation.
 *
 * Owns procedural composition: idle, state profile, lip sync, reaction, emotion, gestures → BehaviorMixer →
 * Avatar.setProcedural().
 * Manual controls (expressions, bone/head rotation) are proxied to Avatar's manual layer, which Avatar
 * composes with the procedural layer, so neither overwrites the other.
 */
export class AvatarController implements AvatarControllerApi {
  private current: Avatar | null = null;
  private lookAtTarget: THREE.Object3D | null = null;
  /** Idle generator. Exposed for debug tuning of its config. */
  readonly idle: AvatarIdleController;

  private readonly machine: ConversationStateMachine;
  private readonly mixer = new BehaviorMixer();
  private readonly listeners = new Set<StateChangeListener>();
  private readonly onListenerError: (error: unknown) => void;
  private mouthSource: MouthSource | null = null;
  private reactionSource: ReactionSource | null = null;
  private emotionSource: EmotionSource | null = null;
  private lastEmotion: Readonly<EmotionInputs> = NEUTRAL_EMOTION_INPUTS;
  private gestureSource: GestureSource | null = null;
  private lastGesture: Readonly<GestureFrame> = NEUTRAL_GESTURE;
  private lastReaction: Readonly<UserReactionFrame> = NEUTRAL_REACTION;
  /** Reused every frame: no allocation in update(). */
  private readonly gestureContext: GestureContext = {
    conversationState: 'idle',
    userSpeaking: false,
    assistantSpeaking: false,
    userEmotion: NEUTRAL_EMOTION,
    assistantEmotion: NEUTRAL_EMOTION,
    utteranceEnds: 0,
    lastUtteranceDuration: 0,
  };
  /** Utterance boundaries from the user emotion channel, used when there is no reaction source (sandbox). */
  private fallbackUtterance = { active: false, duration: 0, ends: 0, last: 0 };

  constructor(options: AvatarControllerOptions) {
    this.idle = options.idle ?? new AvatarIdleController();
    // The controller is the only writer of the procedural layer.
    this.idle.setSink(null);
    this.machine = new ConversationStateMachine(options);
    this.onListenerError = options.onListenerError ?? ((e) => console.error('[AvatarController] state listener failed:', e));
    if (options.avatar) this.attachAvatar(options.avatar);
  }

  /** Low-level runtime, null until attached. For scene integration and debug tooling, not for behaviour. */
  get avatar(): Avatar | null {
    return this.current;
  }

  /**
   * Starts driving `avatar` (or stops driving any, with null). Conversation state, idle and lip sync are not
   * reset: an avatar that finishes loading mid-conversation picks up the current state on its first frame.
   */
  attachAvatar(avatar: Avatar | null): void {
    this.current = avatar;
    if (avatar && this.lookAtTarget) avatar.setLookAtTarget(this.lookAtTarget);
  }

  // --- Conversation state -------------------------------------------------

  getState(): AvatarState {
    return this.machine.getState();
  }

  setState(state: AvatarState): void {
    const previous = this.machine.getState();
    if (!this.machine.setState(state)) return;
    this.emit(state, previous);
  }

  /** @returns unsubscribe */
  onStateChange(listener: StateChangeListener): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  /** Blended state profile of the current frame (for tests and debug display). */
  get stateProfile(): Readonly<AvatarStateProfile> {
    return this.machine.profile;
  }

  get isTransitioning(): boolean {
    return this.machine.isTransitioning;
  }

  // --- Manual layer (proxied) ---------------------------------------------

  setExpression(name: string, value: number): boolean {
    return this.current?.setExpression(name, value) ?? false;
  }

  getExpression(name: string): number {
    return this.current?.getExpression(name) ?? 0;
  }

  hasExpression(name: string): boolean {
    return this.current?.hasExpression(name) ?? false;
  }

  listExpressions(): readonly string[] {
    return this.current?.listExpressions() ?? [];
  }

  resetExpressions(): void {
    this.current?.resetExpressions();
  }

  setHeadRotation(yaw: number, pitch: number, roll: number): boolean {
    return this.current?.setHeadRotation(yaw, pitch, roll) ?? false;
  }

  setBoneRotation(name: HumanBoneName, rotation: Partial<BoneRotation>): boolean {
    return this.current?.setBoneRotation(name, rotation) ?? false;
  }

  getBoneRotation(name: HumanBoneName): BoneRotation | null {
    return this.current?.getBoneRotation(name) ?? null;
  }

  /** Manual bones back to the rest pose (arms down), not to the T-pose. The procedural layer is untouched. */
  resetPose(): void {
    this.current?.resetPose();
  }

  // --- Gaze / idle ----------------------------------------------------------

  /** Anchor for the eyes (typically the camera). State only offsets gaze around it. */
  setLookAtTarget(target: THREE.Object3D | null): void {
    this.lookAtTarget = target;
    this.current?.setLookAtTarget(target);
  }

  /** Fades idle motion in/out. State offsets (posture, gaze bias) still apply while idle is off. */
  setIdleEnabled(enabled: boolean): void {
    this.idle.config.enabled = enabled;
  }

  get idleEnabled(): boolean {
    return this.idle.config.enabled;
  }

  triggerBlink(): void {
    this.idle.triggerBlink();
  }

  // --- Lip sync --------------------------------------------------------------

  /** Source of procedural mouth motion; null closes the procedural mouth (manual visemes still apply). */
  setMouthSource(source: MouthSource | null): void {
    this.mouthSource = source;
  }

  // --- User reaction -------------------------------------------------------

  /**
   * Source of reactions to the user's voice (attentiveness, nod). Mixed by BehaviorMixer like every other source;
   * it never writes bones itself and never changes the conversation state.
   */
  setReactionSource(source: ReactionSource | null): void {
    this.reactionSource = source;
  }

  // --- Emotion -------------------------------------------------------------

  /**
   * Source of both voice channels' emotion (assistant self-expression, user reaction layer). Only BehaviorMixer
   * turns it into behaviour; the source never touches the avatar, the mouth or the conversation state.
   */
  setEmotionSource(source: EmotionSource | null): void {
    this.emotionSource = source;
  }

  /** Mapping bounds of the emotion layer (mutable, for debug tuning). */
  get emotionConfig(): EmotionMixConfig {
    return this.mixer.emotionConfig;
  }

  /** Effective emotion weights of the last frame (diagnostics). */
  get emotionMix(): Readonly<EmotionMixState> {
    return this.mixer.emotionMix;
  }

  /** Emotion inputs of the last frame (diagnostics). */
  get emotionInputs(): Readonly<EmotionInputs> {
    return this.lastEmotion;
  }

  // --- Gestures ------------------------------------------------------------

  /**
   * Source of gestures (nods, tilts, body/shoulder shifts, hand emphasis). Sees conversation state, both voices'
   * emotion and user utterance boundaries; its GestureFrame goes through BehaviorMixer like every other source, it
   * never touches the avatar. Replacing it cancels nothing on the old one: reset() it yourself if you keep it.
   */
  setGestureSource(source: GestureSource | null): void {
    this.gestureSource = source;
    if (!source) this.lastGesture = NEUTRAL_GESTURE;
  }

  /** Gesture output of the last frame (diagnostics). */
  get gesture(): Readonly<GestureFrame> {
    return this.lastGesture;
  }

  /** Composed procedural pose of the last frame, also without an avatar (diagnostics, tests). */
  get pose(): Readonly<ProceduralPose> {
    return this.mixer.pose;
  }

  /**
   * Read-only copy of what the last update() composed and with which effective gains (see BehaviorDebugSnapshot).
   * For diagnostics UIs: calling it never changes behaviour, and it allocates, so sample it at a low rate.
   */
  getBehaviorSnapshot(): BehaviorDebugSnapshot {
    const pose = this.mixer.pose;
    const mix = this.mixer.emotionMix;
    const g = this.lastGesture;
    return {
      state: this.machine.getState(),
      weights: {
        idle: this.idle.state.weight,
        state: this.machine.progress,
        assistantEmotion: mix.assistant,
        userEmotion: mix.user,
        userReaction: Math.min(1, Math.max(0, this.lastReaction.engagement || 0)),
        gesture: g.active ? g.intensity : 0,
        mouth: Math.max(pose.aa, pose.ih, pose.ou, pose.ee, pose.oh),
      },
      pose: { ...pose },
      gesture: { type: g.type, phase: g.phase, progress: g.progress, intensity: g.intensity },
      expressions: {
        blink: pose.blink,
        aa: pose.aa,
        ih: pose.ih,
        ou: pose.ou,
        ee: pose.ee,
        oh: pose.oh,
        happy: pose.happy,
        sad: pose.sad,
        angry: pose.angry,
        relaxed: pose.relaxed,
        surprised: pose.surprised,
      },
    };
  }

  // --- Frame -----------------------------------------------------------------

  update(deltaTime: number): void {
    const profile = this.machine.update(deltaTime);
    const idlePose = this.idle.update(deltaTime);
    const mouth = this.mouthSource?.update(deltaTime) ?? CLOSED_MOUTH;
    const reaction = this.reactionSource?.update(deltaTime) ?? NEUTRAL_REACTION;
    this.lastReaction = reaction;
    const emotion = this.emotionSource?.update(deltaTime) ?? NEUTRAL_EMOTION_INPUTS;
    this.lastEmotion = emotion;
    let gesture: Readonly<GestureFrame> = NEUTRAL_GESTURE;
    if (this.gestureSource) {
      const ctx = this.gestureContext;
      const state = this.machine.getState();
      ctx.conversationState = state;
      // The reaction source knows about echo (suppressed while the assistant talks); without one, the user channel's
      // voice activity is all there is.
      ctx.assistantSpeaking = state === 'speaking';
      ctx.userEmotion = emotion.user;
      ctx.assistantEmotion = emotion.assistant;
      if (this.reactionSource) {
        ctx.userSpeaking = reaction.speaking;
        ctx.utteranceEnds = reaction.utteranceEnds;
        ctx.lastUtteranceDuration = reaction.lastUtteranceDuration;
      } else {
        const u = this.fallbackUtterance;
        const active = emotion.user.active && state !== 'speaking';
        if (active) u.duration = u.active ? u.duration + Math.max(0, deltaTime || 0) : 0;
        else if (u.active) {
          u.ends++;
          u.last = u.duration;
        }
        u.active = active;
        ctx.userSpeaking = active;
        ctx.utteranceEnds = u.ends;
        ctx.lastUtteranceDuration = u.last;
      }
      gesture = this.gestureSource.update(deltaTime, ctx);
    }
    this.lastGesture = gesture;
    const pose = this.mixer.compose(idlePose, profile, mouth, reaction, emotion, gesture);
    if (!this.current) return;
    this.current.setProcedural(pose);
    this.current.update(deltaTime);
  }

  dispose(): void {
    this.listeners.clear();
  }

  private emit(state: AvatarState, previous: AvatarState): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(state, previous);
      } catch (error) {
        this.onListenerError(error);
      }
    }
  }
}
