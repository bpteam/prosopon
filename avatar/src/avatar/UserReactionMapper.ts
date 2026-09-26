import { follow } from '../audio/AmplitudeLipSync';
import type { UserVoiceFrame } from '../audio/user/UserVoiceFrame';
import type { ReactionSource, UserReactionFrame } from './UserReaction';

export interface UserReactionConfig {
  /** Engagement while the user talks at zero energy; energy adds the rest up to 1. */
  engagementBase: number;
  engagementAttack: number;
  engagementRelease: number;
  /** Semitones above baseline that give pitchLift 1. */
  pitchLiftRange: number;
  pitchLiftAttack: number;
  pitchLiftRelease: number;
  /** Frames older than this count as silence (sender stalled or gone), seconds. */
  staleAfter: number;
}

export const DEFAULT_USER_REACTION_CONFIG: Readonly<UserReactionConfig> = Object.freeze({
  engagementBase: 0.5,
  engagementAttack: 0.4,
  engagementRelease: 1.5,
  pitchLiftRange: 6,
  pitchLiftAttack: 0.3,
  pitchLiftRelease: 0.8,
  staleAfter: 0.5,
});

/**
 * UserVoiceFrames → UserReactionFrame. Not mirroring: the user's energy and pitch only nudge a slow, bounded
 * attentiveness (and BehaviorMixer applies that with small gains); a loud or high voice never makes the avatar
 * loud or animated. Utterance ends are reported (count + length) for GestureEngine, which owns the nod.
 */
export class UserReactionMapper implements ReactionSource {
  readonly config: UserReactionConfig;
  private readonly out: UserReactionFrame = { engagement: 0, pitchLift: 0, speaking: false, utteranceEnds: 0, lastUtteranceDuration: 0 };
  private last: UserVoiceFrame | null = null;
  private age = Infinity;
  private wasSpeaking = false;
  private suppressed = false;

  constructor(config: Partial<UserReactionConfig> = {}) {
    this.config = { ...DEFAULT_USER_REACTION_CONFIG, ...config };
  }

  get value(): Readonly<UserReactionFrame> {
    return this.out;
  }

  /**
   * While suppressed (the assistant is talking) the voice on the mic is as likely to be the assistant's echo as the
   * user: no engagement, not speaking, and its end is no utterance boundary.
   */
  setSuppressed(suppressed: boolean): void {
    this.suppressed = suppressed;
  }

  push(frame: UserVoiceFrame): void {
    if (this.wasSpeaking && !frame.speaking && !this.suppressed) {
      this.out.utteranceEnds++;
      this.out.lastUtteranceDuration = Number.isFinite(frame.segmentDuration) ? Math.max(0, frame.segmentDuration) : 0;
    }
    this.wasSpeaking = frame.speaking;
    this.last = frame;
    this.age = 0;
  }

  update(delta: number): Readonly<UserReactionFrame> {
    const c = this.config;
    const dt = delta > 0 && Number.isFinite(delta) ? delta : 0;
    this.age += dt;
    const f = this.age > c.staleAfter ? null : this.last;
    const talking = !!f?.speaking && !this.suppressed;
    this.out.speaking = talking;

    const engagement = talking ? c.engagementBase + (1 - c.engagementBase) * f!.energy : 0;
    this.out.engagement = follow(this.out.engagement, clamp01(engagement), dt, c.engagementAttack, c.engagementRelease);

    const lift = talking && f!.pitchHz !== null ? f!.relativePitch / c.pitchLiftRange : 0;
    this.out.pitchLift = follow(this.out.pitchLift, clamp01(lift), dt, c.pitchLiftAttack, c.pitchLiftRelease);
    return this.out;
  }

  reset(): void {
    this.last = null;
    this.age = Infinity;
    this.wasSpeaking = false;
    // utteranceEnds stays monotonic across resets: consumers detect a change, not a value.
    this.out.speaking = false;
    this.out.engagement = this.out.pitchLift = 0;
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : Number.isFinite(v) ? v : 0;
}
