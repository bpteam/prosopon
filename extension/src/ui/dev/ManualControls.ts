import type { AvatarController } from '@avatar/avatar/AvatarController';
import type { EmotionChannel } from '@avatar/audio/emotion/EmotionFrame';
import { REST_POSE } from '@avatar/config';
import { NEUTRAL_POSE_OFFSETS, type PoseOffsets } from './DevBridge';

/** The subset of AvatarController the manual (debug) layer uses. */
export type ManualAvatarApi = Pick<
  AvatarController,
  'setExpression' | 'resetExpressions' | 'hasExpression' | 'listExpressions' | 'setHeadRotation' | 'setBoneRotation' | 'resetPose'
>;

/**
 * The only place in the extension that writes Avatar's manual layer (expressions, bone rotations), and only for
 * Developer Mode tests. It goes through AvatarController's public manual API, which Avatar composes with the
 * procedural layer (rotations add, expressions max()), so the behaviour system is never overwritten or bypassed.
 *
 * Expression preview is explicit: while it is on, both emotion channels are faded out (the procedural emotion would
 * otherwise win the max()); turning it off clears the manual expressions and restores the channels as the user left
 * them.
 */
export class ManualControls {
  private previewValue = false;
  private offsets: PoseOffsets = { ...NEUTRAL_POSE_OFFSETS };
  private readonly wanted: Record<EmotionChannel, boolean> = { user: true, assistant: true };

  constructor(
    private readonly avatar: ManualAvatarApi,
    /** EmotionChannels.setEnabled (fades). */
    private readonly setChannel: (channel: EmotionChannel, enabled: boolean) => void,
  ) {}

  get expressionPreview(): boolean {
    return this.previewValue;
  }

  get poseOffsets(): Readonly<PoseOffsets> {
    return this.offsets;
  }

  /** The Developer Tools emotion switches: remembered, and applied unless a preview mutes the channel. */
  setEmotionEnabled(channel: EmotionChannel, enabled: boolean): void {
    this.wanted[channel] = enabled;
    this.setChannel(channel, enabled && !this.previewValue);
  }

  setExpressionPreview(active: boolean): void {
    if (active === this.previewValue) return;
    this.previewValue = active;
    if (!active) this.avatar.resetExpressions();
    for (const ch of ['user', 'assistant'] as const) this.setChannel(ch, this.wanted[ch] && !active);
  }

  /** Manual expression weight; ignored outside a preview, so a stray call can't pin a face. */
  previewExpression(name: string, value: number): boolean {
    return this.previewValue ? this.avatar.setExpression(name, value) : false;
  }

  clearExpressions(): void {
    this.avatar.resetExpressions();
  }

  setPoseOffsets(change: Partial<PoseOffsets>): void {
    this.offsets = { ...this.offsets, ...change };
    const o = this.offsets;
    const rad = (deg: number) => (deg * Math.PI) / 180;
    this.avatar.setHeadRotation(rad(o.headYaw), rad(o.headPitch), rad(o.headRoll));
    this.avatar.setBoneRotation('spine', { x: rad(o.lean) * 0.5 });
    this.avatar.setBoneRotation('chest', { x: rad(o.lean) * 0.5 });
    // Same signs as the procedural shoulder shift: left lifts on +z, right on −z.
    this.avatar.setBoneRotation('leftShoulder', { z: rad(o.shoulders) });
    this.avatar.setBoneRotation('rightShoulder', { z: -rad(o.shoulders) });
    // Arms: offsets from the rest pose (arms down), raised away from the body.
    this.avatar.setBoneRotation('leftUpperArm', { z: (REST_POSE.leftUpperArm?.z ?? 0) + rad(o.arms) });
    this.avatar.setBoneRotation('rightUpperArm', { z: (REST_POSE.rightUpperArm?.z ?? 0) - rad(o.arms) });
  }

  resetPoseOffsets(): void {
    this.offsets = { ...NEUTRAL_POSE_OFFSETS };
    this.avatar.resetPose();
  }

  /** Leaving Developer Mode: preview off, pose back to rest. The procedural layer owns the avatar again. */
  release(): void {
    this.setExpressionPreview(false);
    this.resetPoseOffsets();
  }
}
