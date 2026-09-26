// What the developer UI may see and do, as a narrow interface the avatar runtime implements. Types only: the Dev UI
// never imports AvatarController, AvatarStage, three.js or three-vrm, and never reaches a bone or an expression
// manager. Reads are snapshots; the only writes are the manual/debug layers the core already exposes.
import type { BehaviorDebugSnapshot } from '@avatar/avatar/BehaviorSnapshot';
import type { MouthShape } from '@avatar/avatar/MouthShape';
import type { EmotionChannel, EmotionFrame } from '@avatar/audio/emotion/EmotionFrame';
import type { UserVoiceFrame } from '@avatar/audio/user/UserVoiceFrame';
import type { GestureType } from '@avatar/avatar/gesture/Gesture';
import type { CameraAdjust, CameraPreset } from '@avatar/renderer/CameraFraming';
import type { SceneHelpers } from '@avatar/renderer/AvatarStage';
import type { DevTelemetry, EmotionStatus, MicStatus } from '../../shared/messages';
import type { AvatarViewSettingsV1, DevWindowsSettingsV1 } from '../../shared/settings';
import type { UiLayer } from '../shared/UiLayer';

/** One diagnostics sample (taken at 10 Hz while Developer Mode is on). Plain numbers, no live references. */
export interface DevSample {
  /** performance.now() of the sample, ms. */
  time: number;
  avatarLoaded: boolean | 'error';
  voiceUi: boolean;
  offscreenConnected: boolean;
  /** Conversation state the resolver decided. */
  state: string;
  signals: { voiceUi: boolean; userSpeaking: boolean; assistantSpeaking: boolean; crosstalk: boolean };
  lipSync: {
    mode: string;
    analyzer: string;
    active: boolean;
    volume: number;
    visemes: MouthShape;
    /** Frames received per second. */
    frameHz: number;
    /** Age of the last LipSyncFrame at the content script, ms (Infinity before the first). */
    frameAgeMs: number;
  };
  mic: MicStatus;
  userVoice: UserVoiceFrame;
  /** Emotion as followed by the avatar (smoothed) and the analyser mode per channel. */
  emotion: Record<EmotionChannel, EmotionFrame & { active: boolean; enabled: boolean }>;
  emotionStatus: EmotionStatus;
  behavior: BehaviorDebugSnapshot;
  gesture: {
    type: GestureType | null;
    phase: string;
    progress: number;
    intensity: number;
    cooldown: number;
    count: number;
    nods: number;
    auto: boolean;
    enabled: boolean;
  };
  render: { fps: number; frameMs: number; drawCalls: number; triangles: number; pixelRatio: number; memoryMb: number | null };
  /** Offscreen telemetry (audio contexts, inference time); null until the first arrives. */
  telemetry: DevTelemetry | null;
}

export interface DevBridge {
  readonly doc: Document;
  /** The isolated in-page UI root (shadow DOM). */
  readonly layer: UiLayer;
  sample(): DevSample;

  // Persisted UI state
  readonly windows: {
    readonly value: DevWindowsSettingsV1;
    set(value: DevWindowsSettingsV1, persist: 'debounced' | 'now'): void;
  };
  readonly view: {
    readonly value: AvatarViewSettingsV1;
    /** Applied to the stage at once and persisted (debounced unless 'now'). */
    update(change: { camera?: Partial<AvatarViewSettingsV1['camera']>; placement?: Partial<AvatarViewSettingsV1['placement']> }, persist?: 'debounced' | 'now'): void;
    resetCamera(): void;
    onChange(listener: () => void): () => void;
  };
  /** Placement mode (drag the avatar's box). */
  setPlacementMode(active: boolean): void;
  readonly placementMode: boolean;
  /** Turn Developer Mode off (persisted), e.g. from the Dev Tools settings tab. */
  setDeveloperMode(enabled: boolean): void;

  readonly camera: {
    /** Current camera preset and corrections (mirrors view.value.camera). */
    readonly preset: CameraPreset;
    readonly adjust: Readonly<CameraAdjust>;
  };

  readonly scene: {
    helpers(): SceneHelpers;
    setHelpers(helpers: Partial<SceneHelpers>): void;
    readonly transparent: boolean;
    setTransparent(transparent: boolean): void;
  };

  /** Manual (debug) layers of the avatar, through AvatarController's public API. */
  readonly avatar: {
    listExpressions(): readonly string[];
    hasExpression(name: string): boolean;
    /**
     * Expression preview: while on, both emotion channels are faded out (EmotionChannels.setEnabled) so the manual
     * expression is what shows; off clears the manual expressions and gives the face back to the procedural layer.
     */
    setExpressionPreview(active: boolean): void;
    readonly expressionPreview: boolean;
    /** Manual expression weight (only while the preview is on). */
    previewExpression(name: string, value: number): boolean;
    clearExpressions(): void;
    /** Manual pose offsets in degrees, applied on top of the rest pose: lean, shoulders, arms. */
    setPoseOffsets(offsets: Partial<PoseOffsets>): void;
    readonly poseOffsets: Readonly<PoseOffsets>;
    /** Pose offsets to zero: the rest pose (arms down), not the T-pose. */
    resetPoseOffsets(): void;
  };

  readonly emotion: {
    setEnabled(channel: EmotionChannel, enabled: boolean): void;
  };

  readonly gestures: {
    readonly types: readonly GestureType[];
    trigger(type: GestureType): boolean;
    cancel(): void;
    setAuto(on: boolean): void;
    setEnabled(on: boolean): void;
  };

  /** Ask the offscreen document for telemetry (only while Developer Mode is on). */
  setTelemetry(enabled: boolean): void;
}

/** Manual pose controls of the Poses tab, degrees. Head rotation is separate (setHeadRotation). */
export interface PoseOffsets {
  headYaw: number;
  headPitch: number;
  headRoll: number;
  /** Forward lean of spine + chest. */
  lean: number;
  /** Shoulder lift, both sides. */
  shoulders: number;
  /** Arms raised away from the rest pose (upper arm Z), both sides. */
  arms: number;
}

export const NEUTRAL_POSE_OFFSETS: Readonly<PoseOffsets> = Object.freeze({
  headYaw: 0,
  headPitch: 0,
  headRoll: 0,
  lean: 0,
  shoulders: 0,
  arms: 0,
});

/** Handle the runtime keeps while Developer Mode is on. */
export interface DevToolsHandle {
  /** Called from the RenderLoop every frame: samples at 10 Hz, draws charts at ≤ 10 Hz. Nothing else ticks. */
  frame(delta: number): void;
  /** Offscreen telemetry arrived. */
  pushTelemetry(t: DevTelemetry): void;
  /** Placement mode changed (quick toolbar / Avatar Controls reflect it). */
  refresh(): void;
  dispose(): void;
}
