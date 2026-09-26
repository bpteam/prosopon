import type { AvatarControllerApi } from '@avatar/avatar/AvatarController';
import type { AvatarState } from '@avatar/avatar/AvatarStateProfiles';

/** What the resolver decides from. Every producer (ChatGPT DOM, assistant lip sync, user VAD) only sets signals. */
export interface ConversationSignals {
  voiceUiActive: boolean;
  userSpeaking: boolean;
  /** Assistant audio active, including the release hold that bridges pauses between words. */
  assistantSpeaking: boolean;
}

export interface ConversationResolverConfig {
  /** Assistant audio must stay inactive this long before it stops counting as speaking, seconds. */
  assistantReleaseHold: number;
  /**
   * The user must have been speaking this long before they count as interrupting the assistant, seconds. The mic
   * hears the speakers when echo cancellation falls short; a real barge-in lasts, an echo fragment usually doesn't.
   */
  interruptionMinDuration: number;
  /** After the user stops, stay in listening this long before thinking (hides a reply that starts at once), s. */
  thinkingDelay: number;
  /** No assistant audio this long after the user stopped: back to listening (nothing is coming), seconds. */
  thinkingTimeout: number;
}

export const DEFAULT_RESOLVER_CONFIG: Readonly<ConversationResolverConfig> = Object.freeze({
  assistantReleaseHold: 0.45,
  interruptionMinDuration: 0.3,
  thinkingDelay: 0.2,
  thinkingTimeout: 6,
});

export interface ResolverDiagnostics {
  signals: Readonly<ConversationSignals>;
  resolved: AvatarState;
  /** Both user and assistant are active right now (possible echo, or a real barge-in). */
  crosstalk: boolean;
  /** Times crosstalk started. */
  crosstalkEvents: number;
  /** User activity during assistant speech that was too short to count as an interruption. */
  suppressedInterruptions: number;
}

/**
 * ChatGPT integration layer: the only place that decides the conversation state. Neither lip sync nor the user
 * voice analyser call setState; they report signals here.
 *
 *   voice UI closed                          → idle
 *   user speaking (beats the assistant)      → listening
 *   assistant speaking                       → speaking
 *   user just stopped, assistant not yet     → thinking (after thinkingDelay, until thinkingTimeout)
 *   otherwise (waiting for the user)         → listening
 *
 * A presentation hint, not a source of truth: ChatGPT's own turn state is not read.
 */
export class ConversationSignalResolver {
  readonly config: ConversationResolverConfig;
  private voiceUi = false;
  private assistantRaw = false;
  private assistantSilentFor = Infinity;
  private user = false;
  private userFor = 0;
  /** Seconds since the user's last counted utterance ended; null when no reply is pending. */
  private sinceUserStopped: number | null = null;
  private wasUserCounted = false;
  private wasCrosstalk = false;
  private crosstalkEvents = 0;
  private suppressedInterruptions = 0;
  private suppressedThisSegment = false;
  private resolvedState: AvatarState = 'idle';

  constructor(
    private readonly controller: Pick<AvatarControllerApi, 'getState' | 'setState'>,
    config: Partial<ConversationResolverConfig> = {},
  ) {
    this.config = { ...DEFAULT_RESOLVER_CONFIG, ...config };
  }

  get signals(): ConversationSignals {
    return {
      voiceUiActive: this.voiceUi,
      userSpeaking: this.user,
      assistantSpeaking: this.assistantSpeaking,
    };
  }

  get resolved(): AvatarState {
    return this.resolvedState;
  }

  get diagnostics(): ResolverDiagnostics {
    return {
      signals: this.signals,
      resolved: this.resolvedState,
      crosstalk: this.wasCrosstalk,
      crosstalkEvents: this.crosstalkEvents,
      suppressedInterruptions: this.suppressedInterruptions,
    };
  }

  setVoiceUiActive(active: boolean): void {
    this.voiceUi = active;
    this.apply();
  }

  setAssistantAudioActive(active: boolean): void {
    this.assistantRaw = active;
    if (active) this.assistantSilentFor = 0;
    this.apply();
  }

  /** @param segmentDuration seconds the current user segment has lasted (from the VAD) */
  setUserSpeaking(speaking: boolean, segmentDuration = 0): void {
    if (speaking && !this.user) this.suppressedThisSegment = false;
    this.user = speaking;
    this.userFor = speaking ? Math.max(this.userFor, segmentDuration) : 0;
    this.apply();
  }

  update(delta: number): void {
    const dt = delta > 0 && Number.isFinite(delta) ? delta : 0;
    if (!this.assistantRaw) this.assistantSilentFor += dt;
    if (this.user) this.userFor += dt;
    if (this.sinceUserStopped !== null) this.sinceUserStopped += dt;
    this.apply();
  }

  private get assistantSpeaking(): boolean {
    return this.assistantRaw || this.assistantSilentFor < this.config.assistantReleaseHold;
  }

  private resolve(): AvatarState {
    const c = this.config;
    if (!this.voiceUi) {
      this.sinceUserStopped = null;
      this.wasUserCounted = false;
      return 'idle';
    }
    const assistant = this.assistantSpeaking;
    const crosstalk = this.user && assistant;
    if (crosstalk && !this.wasCrosstalk) this.crosstalkEvents++;
    this.wasCrosstalk = crosstalk;

    // User over assistant (interruption), but only once the user's voice has lasted: see interruptionMinDuration.
    const counted = this.user && (!assistant || this.userFor >= c.interruptionMinDuration);
    if (this.user && assistant && !counted && !this.suppressedThisSegment) {
      this.suppressedThisSegment = true;
      this.suppressedInterruptions++;
    }
    if (this.wasUserCounted && !counted && !this.user) this.sinceUserStopped = 0;
    this.wasUserCounted = counted;

    if (counted) {
      this.sinceUserStopped = null;
      return 'listening';
    }
    if (assistant) {
      this.sinceUserStopped = null;
      return 'speaking';
    }
    const since = this.sinceUserStopped;
    if (since !== null && since >= c.thinkingDelay && since < c.thinkingTimeout) return 'thinking';
    if (since !== null && since >= c.thinkingTimeout) this.sinceUserStopped = null;
    return 'listening';
  }

  private apply(): void {
    this.resolvedState = this.resolve();
    if (this.controller.getState() !== this.resolvedState) this.controller.setState(this.resolvedState);
  }
}
