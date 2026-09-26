import { describe, expect, it } from 'vitest';
import { AvatarController } from '@avatar/avatar/AvatarController';
import { VoiceStatePresenter } from '../../src/content/VoiceStatePresenter';

describe('VoiceStatePresenter', () => {
  it('maps voice UI and audio activity to conversation states, with a hold after speech', () => {
    const controller = new AvatarController({}); // no avatar yet: states before VRM load are kept
    const presenter = new VoiceStatePresenter(controller, { releaseHold: 0.4 });

    presenter.setVoiceUiActive(true);
    expect(controller.getState()).toBe('listening');
    presenter.setAudioActive(true);
    expect(controller.getState()).toBe('speaking');
    presenter.setAudioActive(false);
    presenter.update(0.2); // a pause between words
    expect(controller.getState()).toBe('speaking');
    presenter.update(0.3);
    expect(controller.getState()).toBe('listening');
    presenter.setVoiceUiActive(false);
    expect(controller.getState()).toBe('idle');
  });
});
