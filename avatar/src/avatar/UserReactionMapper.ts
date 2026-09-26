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
  /** A segment shorter than this ends without a nod (noise, a cough, "uh"), seconds. */
  nodMinSegment: number;
  /** Minimum time between two nods, seconds. */
  nodCooldown: number;
  /** Length of one nod (down and back up), seconds. */
  nodDuration: number;
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
  nodMinSegment: 0.5,
  nodCooldown: 2,
  nodDuration: 0.5,
  staleAfter: 0.5,
});

/**
 * UserVoiceFrames → UserReactionFrame. Not mirroring: the user's energy and pitch only nudge a slow, bounded
 * attentiveness (and BehaviorMixer applies that with small gains); a loud or high voice never makes the avatar
 * loud or animated. The one discrete reaction is a small nod at the end of a meaningful utterance.
 */
export class UserReactionMapper implements ReactionSource {
  readonly config: UserReactionConfig;
  private readonly out: UserReactionFrame = { engagement: 0, pitchLift: 0, nod: 0 };
  private last: UserVoiceFrame | null = null;
  private age = Infinity;
  private wasSpeaking = false;
  private suppressed = false;
  /** Seconds into the current nod, null when not nodding. */
  private nodTime: number | null = null;
  private sinceNod = Infinity;
  private nodCount = 0;

  constructor(config: Partial<UserReactionConfig> = {}) {
    this.config = { ...DEFAULT_USER_REACTION_CONFIG, ...config };
  }

  get value(): Readonly<UserReactionFrame> {
    return this.out;
  }

  /** Nods started so far (diagnostics). */
  get nods(): number {
    return this.nodCount;
  }

  /**
   * While suppressed (the assistant is talking) the voice on the mic is as likely to be the assistant's echo as the
   * user: no engagement and no nod.
   */
  setSuppressed(suppressed: boolean): void {
    this.suppressed = suppressed;
  }

  push(frame: UserVoiceFrame): void {
    const c = this.config;
    if (this.wasSpeaking && !frame.speaking && !this.suppressed) {
      if (frame.segmentDuration >= c.nodMinSegment && this.sinceNod >= c.nodCooldown && this.nodTime === null) {
        this.nodTime = 0;
        this.sinceNod = 0;
        this.nodCount++;
      }
    }
    this.wasSpeaking = frame.speaking;
    this.last = frame;
    this.age = 0;
  }

  update(delta: number): Readonly<UserReactionFrame> {
    const c = this.config;
    const dt = delta > 0 && Number.isFinite(delta) ? delta : 0;
    this.age += dt;
    this.sinceNod += dt;
    const f = this.age > c.staleAfter ? null : this.last;
    const talking = !!f?.speaking && !this.suppressed;

    const engagement = talking ? c.engagementBase + (1 - c.engagementBase) * f!.energy : 0;
    this.out.engagement = follow(this.out.engagement, clamp01(engagement), dt, c.engagementAttack, c.engagementRelease);

    const lift = talking && f!.pitchHz !== null ? f!.relativePitch / c.pitchLiftRange : 0;
    this.out.pitchLift = follow(this.out.pitchLift, clamp01(lift), dt, c.pitchLiftAttack, c.pitchLiftRelease);

    if (this.nodTime !== null) {
      this.nodTime += dt;
      if (this.nodTime >= c.nodDuration) {
        this.nodTime = null;
        this.out.nod = 0;
      } else {
        // sin²: starts and ends with zero velocity, so it blends into whatever the head is doing.
        this.out.nod = Math.sin((Math.PI * this.nodTime) / c.nodDuration) ** 2;
      }
    }
    return this.out;
  }

  reset(): void {
    this.last = null;
    this.age = Infinity;
    this.wasSpeaking = false;
    this.nodTime = null;
    this.out.engagement = this.out.pitchLift = this.out.nod = 0;
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : Number.isFinite(v) ? v : 0;
}
