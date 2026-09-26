import { NEUTRAL_EMOTION, sanitizeEmotionFrame, type EmotionChannel, type EmotionFrame } from '../audio/emotion/EmotionFrame';
import type { EmotionInputs, EmotionSource } from './EmotionExpression';

export interface EmotionChannelsConfig {
  /**
   * Time constant of the interpolation towards the last frame, seconds. Frames come at ~8 Hz, already smoothed by
   * the analyser; this only hides the steps.
   */
  smoothing: number;
  /** A frame older than this counts as gone (sender stalled, capture ended), seconds… */
  staleAfter: number;
  /** …and the channel then decays to neutral with this time constant, seconds. */
  staleRelease: number;
  /** Fade of the debug on/off switches, seconds. */
  switchFade: number;
}

export const DEFAULT_EMOTION_CHANNELS_CONFIG: Readonly<EmotionChannelsConfig> = Object.freeze({
  smoothing: 0.12,
  staleAfter: 0.6,
  staleRelease: 0.8,
  switchFade: 0.3,
});

class Follower {
  readonly out: EmotionFrame = { ...NEUTRAL_EMOTION };
  private readonly target: EmotionFrame = { ...NEUTRAL_EMOTION };
  age = Infinity;

  push(frame: Readonly<EmotionFrame>): void {
    sanitizeEmotionFrame(frame, this.target);
    this.age = 0;
  }

  update(dt: number, c: EmotionChannelsConfig): void {
    this.age += dt;
    const stale = this.age > c.staleAfter;
    const t = this.target;
    if (stale) {
      Object.assign(t, NEUTRAL_EMOTION, { mode: t.mode });
    }
    const k = 1 - Math.exp(-dt / (stale ? c.staleRelease : c.smoothing));
    const o = this.out;
    o.active = t.active;
    o.mode = t.mode;
    o.valence += (t.valence - o.valence) * k;
    o.arousal += (t.arousal - o.arousal) * k;
    o.energy += (t.energy - o.energy) * k;
    o.tension += (t.tension - o.tension) * k;
    o.pitchLift += (t.pitchLift - o.pitchLift) * k;
    o.pitchVariation += (t.pitchVariation - o.pitchVariation) * k;
    o.speechRate += (t.speechRate - o.speechRate) * k;
    o.confidence += (t.confidence - o.confidence) * k;
    o.valenceConfidence = Math.min(o.confidence, o.valenceConfidence + (t.valenceConfidence - o.valenceConfidence) * k);
  }

  reset(): void {
    Object.assign(this.target, NEUTRAL_EMOTION);
    Object.assign(this.out, NEUTRAL_EMOTION);
    this.age = Infinity;
  }
}

/**
 * EmotionSource fed by EmotionFrames pushed from elsewhere (the offscreen analysers, or a local one in the sandbox):
 * one independent follower per channel, rendered at the render loop's rate, plus the two debug switches.
 * Knows nothing about transports or audio.
 */
export class EmotionChannels implements EmotionSource {
  readonly config: EmotionChannelsConfig;
  private readonly followers: Record<EmotionChannel, Follower> = { user: new Follower(), assistant: new Follower() };
  private readonly enabled: Record<EmotionChannel, boolean> = { user: true, assistant: true };
  private readonly out: EmotionInputs;

  constructor(config: Partial<EmotionChannelsConfig> = {}) {
    this.config = { ...DEFAULT_EMOTION_CHANNELS_CONFIG, ...config };
    this.out = {
      user: this.followers.user.out,
      assistant: this.followers.assistant.out,
      userGain: 1,
      assistantGain: 1,
    };
  }

  get value(): Readonly<EmotionInputs> {
    return this.out;
  }

  /** Last frame's age per channel, seconds (Infinity before the first). */
  age(channel: EmotionChannel): number {
    return this.followers[channel].age;
  }

  push(channel: EmotionChannel, frame: Readonly<EmotionFrame>): void {
    this.followers[channel].push(frame);
  }

  /** Debug switch: "User emotion reactions" / "Assistant emotion expression". Fades over switchFade. */
  setEnabled(channel: EmotionChannel, enabled: boolean): void {
    this.enabled[channel] = enabled;
  }

  isEnabled(channel: EmotionChannel): boolean {
    return this.enabled[channel];
  }

  update(delta: number): Readonly<EmotionInputs> {
    const dt = delta > 0 && Number.isFinite(delta) ? delta : 0;
    const c = this.config;
    this.followers.user.update(dt, c);
    this.followers.assistant.update(dt, c);
    const k = c.switchFade > 0 ? 1 - Math.exp(-dt / c.switchFade) : 1;
    this.out.userGain += ((this.enabled.user ? 1 : 0) - this.out.userGain) * k;
    this.out.assistantGain += ((this.enabled.assistant ? 1 : 0) - this.out.assistantGain) * k;
    return this.out;
  }

  /** Drops a channel's state (its source went away); the other channel is untouched. */
  reset(channel: EmotionChannel): void {
    this.followers[channel].reset();
  }
}
