import type * as THREE from 'three';
import { CLOSED_MOUTH, type Avatar, type BoneRotation, type HumanBoneName, type MouthShape } from './Avatar';
import { AvatarIdleController } from './AvatarIdleController';
import type { AvatarState, AvatarStateProfile } from './AvatarStateProfiles';
import { BehaviorMixer } from './BehaviorMixer';
import { ConversationStateMachine, type ConversationStateMachineOptions } from './ConversationStateMachine';

/**
 * Anything that drives the mouth once per frame (amplitude lip sync, viseme analysers).
 * Pulled by AvatarController.update(), so it runs on the render loop's delta.
 */
export interface MouthSource {
  /** @returns mouth openness on "aa", [0, 1], or a weight per viseme preset */
  update(deltaTime: number): number | Readonly<MouthShape>;
}

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

  update(deltaTime: number): void;
}

export interface AvatarControllerOptions extends ConversationStateMachineOptions {
  avatar: Avatar;
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
  /** Low-level runtime. For scene integration and debug tooling, not for behaviour. */
  readonly avatar: Avatar;
  /** Idle generator. Exposed for debug tuning of its config. */
  readonly idle: AvatarIdleController;

  private readonly machine: ConversationStateMachine;
  private readonly mixer = new BehaviorMixer();
  private readonly listeners = new Set<StateChangeListener>();
  private readonly onListenerError: (error: unknown) => void;
  private mouthSource: MouthSource | null = null;

  constructor(options: AvatarControllerOptions) {
    this.avatar = options.avatar;
    this.idle = options.idle ?? new AvatarIdleController();
    // The controller is the only writer of the procedural layer.
    this.idle.setSink(null);
    this.machine = new ConversationStateMachine(options);
    this.onListenerError = options.onListenerError ?? ((e) => console.error('[AvatarController] state listener failed:', e));
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
    return this.avatar.setExpression(name, value);
  }

  getExpression(name: string): number {
    return this.avatar.getExpression(name);
  }

  hasExpression(name: string): boolean {
    return this.avatar.hasExpression(name);
  }

  listExpressions(): readonly string[] {
    return this.avatar.listExpressions();
  }

  resetExpressions(): void {
    this.avatar.resetExpressions();
  }

  setHeadRotation(yaw: number, pitch: number, roll: number): boolean {
    return this.avatar.setHeadRotation(yaw, pitch, roll);
  }

  setBoneRotation(name: HumanBoneName, rotation: Partial<BoneRotation>): boolean {
    return this.avatar.setBoneRotation(name, rotation);
  }

  // --- Gaze / idle ----------------------------------------------------------

  /** Anchor for the eyes (typically the camera). State only offsets gaze around it. */
  setLookAtTarget(target: THREE.Object3D | null): void {
    this.avatar.setLookAtTarget(target);
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

  // --- Frame -----------------------------------------------------------------

  update(deltaTime: number): void {
    const profile = this.machine.update(deltaTime);
    const idlePose = this.idle.update(deltaTime);
    const mouth = this.mouthSource?.update(deltaTime) ?? CLOSED_MOUTH;
    this.avatar.setProcedural(this.mixer.compose(idlePose, profile, mouth));
    this.avatar.update(deltaTime);
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
