import {
  INITIAL_AVATAR_STATE,
  PROFILE_KEYS,
  STATE_PROFILES,
  STATE_TRANSITION_DURATION,
  type AvatarState,
  type AvatarStateProfile,
} from './AvatarStateProfiles';

export interface ConversationStateMachineOptions {
  initialState?: AvatarState;
  /** Seconds. 0 = instant switch. */
  transitionDuration?: number;
  profiles?: Readonly<Record<AvatarState, Readonly<AvatarStateProfile>>>;
}

/**
 * Discrete conversation state + a continuous blend between state profiles.
 *
 * A transition blends from the profile *as it currently is* (possibly mid-transition) to the target
 * profile with a smoothstep over accumulated delta time, so retargeting never jumps and the result
 * does not depend on frame rate.
 */
export class ConversationStateMachine {
  readonly transitionDuration: number;

  private readonly profiles: Readonly<Record<AvatarState, Readonly<AvatarStateProfile>>>;
  private state: AvatarState;
  private elapsed: number;

  private readonly from: AvatarStateProfile;
  private readonly current: AvatarStateProfile;

  constructor(options: ConversationStateMachineOptions = {}) {
    this.profiles = options.profiles ?? STATE_PROFILES;
    this.transitionDuration = Math.max(0, options.transitionDuration ?? STATE_TRANSITION_DURATION);
    this.state = options.initialState ?? INITIAL_AVATAR_STATE;
    const initial = this.profiles[this.state];
    this.from = { ...initial };
    this.current = { ...initial };
    this.elapsed = this.transitionDuration;
  }

  getState(): AvatarState {
    return this.state;
  }

  /** Blended profile for the current frame. Mutated in place by update(); do not keep a reference across frames. */
  get profile(): Readonly<AvatarStateProfile> {
    return this.current;
  }

  /** 0..1, 1 when the target profile is fully reached. */
  get progress(): number {
    return this.transitionDuration > 0 ? Math.min(1, this.elapsed / this.transitionDuration) : 1;
  }

  get isTransitioning(): boolean {
    return this.progress < 1;
  }

  /**
   * Start a transition to `state`. Re-requesting the current target is a no-op (no restart).
   * @returns whether the target state changed
   */
  setState(state: AvatarState): boolean {
    if (state === this.state) return false;
    this.state = state;
    copyProfile(this.current, this.from);
    this.elapsed = 0;
    if (this.transitionDuration === 0) this.blend();
    return true;
  }

  /** Advance the transition. Negative / NaN deltas are treated as 0. */
  update(delta: number): Readonly<AvatarStateProfile> {
    const dt = Number.isFinite(delta) && delta > 0 ? delta : 0;
    if (this.elapsed < this.transitionDuration) {
      this.elapsed = Math.min(this.transitionDuration, this.elapsed + dt);
      this.blend();
    }
    return this.current;
  }

  private blend(): void {
    const target = this.profiles[this.state];
    const w = smoothstep(this.progress);
    const from = this.from;
    const out = this.current;
    for (let i = 0; i < PROFILE_KEYS.length; i++) {
      const key = PROFILE_KEYS[i]!;
      out[key] = w >= 1 ? target[key] : from[key] + (target[key] - from[key]) * w;
    }
  }
}

function copyProfile(src: Readonly<AvatarStateProfile>, dst: AvatarStateProfile): void {
  for (let i = 0; i < PROFILE_KEYS.length; i++) {
    const key = PROFILE_KEYS[i]!;
    dst[key] = src[key];
  }
}

function smoothstep(x: number): number {
  const t = x < 0 ? 0 : x > 1 ? 1 : x;
  return t * t * (3 - 2 * t);
}
