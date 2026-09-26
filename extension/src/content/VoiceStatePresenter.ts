import type { AvatarControllerApi } from '@avatar/avatar/AvatarController';
import type { AvatarState } from '@avatar/avatar/AvatarStateProfiles';

export interface VoiceStatePresenterConfig {
  /** Audio must stay inactive this long before speaking ends: bridges pauses between words, seconds. */
  releaseHold: number;
}

export const DEFAULT_PRESENTER_CONFIG: Readonly<VoiceStatePresenterConfig> = Object.freeze({ releaseHold: 0.45 });

/**
 * ChatGPT integration layer: turns "voice UI open" and "captured assistant audio is active" into conversation
 * states for the avatar. A presentation hint for the demo, not a source of truth: ChatGPT's own listening/thinking
 * state is not read. Lip sync itself never sets states; this is the only place in the extension that does.
 *
 *   voice UI closed               → idle
 *   voice UI open, audio silent   → listening
 *   audio active                  → speaking (held for releaseHold after the audio stops)
 */
export class VoiceStatePresenter {
  readonly config: VoiceStatePresenterConfig;
  private voiceUi = false;
  private audioActive = false;
  private silentFor = Infinity;

  constructor(
    private readonly controller: Pick<AvatarControllerApi, 'getState' | 'setState'>,
    config: Partial<VoiceStatePresenterConfig> = {},
  ) {
    this.config = { ...DEFAULT_PRESENTER_CONFIG, ...config };
  }

  setVoiceUiActive(active: boolean): void {
    this.voiceUi = active;
    this.apply();
  }

  setAudioActive(active: boolean): void {
    this.audioActive = active;
    if (active) this.silentFor = 0;
    this.apply();
  }

  update(delta: number): void {
    if (!this.audioActive && delta > 0) this.silentFor += delta;
    this.apply();
  }

  get target(): AvatarState {
    if (this.audioActive || this.silentFor < this.config.releaseHold) return 'speaking';
    return this.voiceUi ? 'listening' : 'idle';
  }

  private apply(): void {
    const target = this.target;
    if (this.controller.getState() !== target) this.controller.setState(target);
  }
}
