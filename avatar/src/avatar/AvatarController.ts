import type * as THREE from 'three';
import type { Avatar, BoneRotation, HumanBoneName, ProceduralPose } from './Avatar';
import { CLOSED_MOUTH, type MouthSource } from './MouthShape';
import { AvatarIdleController } from './AvatarIdleController';
import type { AvatarState, AvatarStateProfile } from './AvatarStateProfiles';
import { BehaviorMixer, type EmotionMixConfig, type EmotionMixState } from './BehaviorMixer';
import { NEUTRAL_EMOTION_INPUTS, type EmotionInputs, type EmotionSource } from './EmotionExpression';
import { ConversationStateMachine, type ConversationStateMachineOptions } from './ConversationStateMachine';
import { NEUTRAL_REACTION, type ReactionSource } from './UserReaction';

export type { MouthSource } from './MouthShape';
export type { ReactionSource } from './UserReaction';
export type { EmotionSource } from './EmotionExpression';

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
 * Owns procedural composition: idle pose → conversation-state profile → Avatar.setProcedural().
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

  /** Composed procedural pose of the last frame, also without an avatar (diagnostics, tests). */
  get pose(): Readonly<ProceduralPose> {
    return this.mixer.pose;
  }

  // --- Frame -----------------------------------------------------------------

  update(deltaTime: number): void {
    const profile = this.machine.update(deltaTime);
    const idlePose = this.idle.update(deltaTime);
    const mouth = this.mouthSource?.update(deltaTime) ?? CLOSED_MOUTH;
    const reaction = this.reactionSource?.update(deltaTime) ?? NEUTRAL_REACTION;
    const emotion = this.emotionSource?.update(deltaTime) ?? NEUTRAL_EMOTION_INPUTS;
    this.lastEmotion = emotion;
    const pose = this.mixer.compose(idlePose, profile, mouth, reaction, emotion);
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
