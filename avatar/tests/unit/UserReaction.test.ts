import { describe, expect, it } from 'vitest';
import { SILENT_USER_VOICE_FRAME, type UserVoiceFrame } from '../../src/audio/user/UserVoiceFrame';
import { Avatar } from '../../src/avatar/Avatar';
import { AvatarController } from '../../src/avatar/AvatarController';
import { AvatarIdleController } from '../../src/avatar/AvatarIdleController';
import { STATE_PROFILES } from '../../src/avatar/AvatarStateProfiles';
import { BehaviorMixer } from '../../src/avatar/BehaviorMixer';
import { NEUTRAL_REACTION, REACTION_LIMITS } from '../../src/avatar/UserReaction';
import { UserReactionMapper } from '../../src/avatar/UserReactionMapper';
import { createFakeVrm, silentLogger } from './fakeVrm';

const FPS = 1 / 60;
const voice = (over: Partial<UserVoiceFrame>): UserVoiceFrame => ({ ...SILENT_USER_VOICE_FRAME, ...over });

/** Pushes `frame` at 25 Hz while updating at 60 Hz for `seconds`; returns the max of each output. */
function drive(m: UserReactionMapper, frame: UserVoiceFrame, seconds: number) {
  const max = { engagement: 0, pitchLift: 0, nod: 0 };
  let sincePush = Infinity;
  for (let t = 0; t < seconds; t += FPS) {
    sincePush += FPS;
    if (sincePush >= 0.04) {
      m.push(frame);
      sincePush = 0;
    }
    const v = m.update(FPS);
    max.engagement = Math.max(max.engagement, v.engagement);
    max.pitchLift = Math.max(max.pitchLift, v.pitchLift);
    max.nod = Math.max(max.nod, v.nod);
  }
  return max;
}

describe('UserReactionMapper', () => {
  it('silence: neutral', () => {
    const m = new UserReactionMapper();
    expect(drive(m, SILENT_USER_VOICE_FRAME, 2)).toEqual({ engagement: 0, pitchLift: 0, nod: 0 });
  });

  it('speech raises engagement slowly and within [0, 1]; energy only modulates it', () => {
    const quiet = drive(new UserReactionMapper(), voice({ speaking: true, energy: 0.1 }), 3).engagement;
    const loud = drive(new UserReactionMapper(), voice({ speaking: true, energy: 1 }), 3).engagement;
    expect(quiet).toBeGreaterThan(0.4);
    expect(loud).toBeLessThanOrEqual(1);
    expect(loud - quiet).toBeLessThan(0.5);
    // Not instant: after 100 ms it is still far from its target.
    expect(drive(new UserReactionMapper(), voice({ speaking: true, energy: 1 }), 0.1).engagement).toBeLessThan(0.3);
  });

  it('relative pitch, not raw Hz, drives pitchLift', () => {
    const high = drive(new UserReactionMapper(), voice({ speaking: true, pitchHz: 150, relativePitch: 6 }), 2);
    const lowVoiceHighHz = drive(new UserReactionMapper(), voice({ speaking: true, pitchHz: 320, relativePitch: 0 }), 2);
    expect(high.pitchLift).toBeGreaterThan(0.9);
    expect(lowVoiceHighHz.pitchLift).toBe(0);
  });

  it('nods once at the end of a meaningful utterance, respecting the cooldown', () => {
    const m = new UserReactionMapper();
    drive(m, voice({ speaking: true, segmentDuration: 1 }), 1);
    expect(drive(m, voice({ speaking: false, segmentDuration: 1 }), 0.6).nod).toBeGreaterThan(0.9);
    expect(m.nods).toBe(1);
    expect(m.value.nod).toBe(0);
    // Another phrase right away: inside the cooldown, no second nod.
    drive(m, voice({ speaking: true, segmentDuration: 0.6 }), 0.6);
    drive(m, voice({ speaking: false, segmentDuration: 0.6 }), 0.3);
    expect(m.nods).toBe(1);
    // After the cooldown it nods again.
    drive(m, voice({ speaking: false }), 2);
    drive(m, voice({ speaking: true, segmentDuration: 0.8 }), 0.8);
    drive(m, voice({ speaking: false, segmentDuration: 0.8 }), 0.6);
    expect(m.nods).toBe(2);
  });

  it('no nod after a short segment or while suppressed (assistant talking)', () => {
    const m = new UserReactionMapper();
    drive(m, voice({ speaking: true, segmentDuration: 0.3 }), 0.3);
    drive(m, voice({ speaking: false, segmentDuration: 0.3 }), 1);
    expect(m.nods).toBe(0);
    const s = new UserReactionMapper();
    s.setSuppressed(true);
    expect(drive(s, voice({ speaking: true, segmentDuration: 1, energy: 1 }), 1).engagement).toBe(0);
    drive(s, voice({ speaking: false, segmentDuration: 1 }), 1);
    expect(s.nods).toBe(0);
  });

  it('stale frames decay to neutral', () => {
    const m = new UserReactionMapper();
    drive(m, voice({ speaking: true, energy: 1 }), 2);
    for (let t = 0; t < 8; t += FPS) m.update(FPS);
    expect(m.value.engagement).toBeLessThan(0.01);
  });
});

describe('BehaviorMixer reaction input', () => {
  const idlePose = { headYaw: 0.02, headPitch: 0.01, headRoll: -0.01, breath: 0.5, lean: 0, blink: 0, gazeYaw: 4, gazePitch: 2, aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 };

  it('neutral reaction is the identity', () => {
    const mixer = new BehaviorMixer();
    const a = { ...mixer.compose(idlePose, STATE_PROFILES.listening, 0) };
    const b = { ...mixer.compose(idlePose, STATE_PROFILES.listening, 0, NEUTRAL_REACTION) };
    expect(b).toEqual(a);
  });

  it('is bounded whatever the source asks for, and never touches the mouth', () => {
    const mixer = new BehaviorMixer();
    const base = { ...mixer.compose(idlePose, STATE_PROFILES.listening, 0) };
    const out = { ...mixer.compose(idlePose, STATE_PROFILES.listening, 0, { engagement: 50, pitchLift: 50, nod: 50 }) };
    expect(out.headPitch - base.headPitch).toBeLessThanOrEqual(REACTION_LIMITS.nod + 1e-9);
    expect(out.lean - base.lean).toBeCloseTo(REACTION_LIMITS.lean);
    expect(Math.abs(out.headYaw / base.headYaw - 1)).toBeLessThanOrEqual(REACTION_LIMITS.headMotionGain + 1e-9);
    expect([out.aa, out.ih, out.ou, out.ee, out.oh]).toEqual([0, 0, 0, 0, 0]);
    const nan = { ...mixer.compose(idlePose, STATE_PROFILES.listening, 0, { engagement: NaN, pitchLift: NaN, nod: NaN }) };
    expect(nan).toEqual(base);
  });
});

describe('AvatarController reaction source', () => {
  it('nod reaches the head through the mixer only, and the state is unchanged', () => {
    const avatar = new Avatar(createFakeVrm(), { logger: silentLogger() });
    const idle = new AvatarIdleController({ config: { enabled: false, blinkEnabled: false } });
    const controller = new AvatarController({ avatar, idle, transitionDuration: 0 });
    controller.setState('listening');
    const poses: number[] = [];
    const setProcedural = avatar.setProcedural.bind(avatar);
    avatar.setProcedural = (pose) => {
      poses.push(pose.headPitch ?? 0);
      setProcedural(pose);
    };
    for (let i = 0; i < 60; i++) controller.update(FPS);
    const before = poses.at(-1)!;
    controller.setReactionSource({ update: () => ({ engagement: 0, pitchLift: 0, nod: 1 }) });
    controller.update(FPS);
    expect(poses.at(-1)! - before).toBeCloseTo(REACTION_LIMITS.nod, 4);
    expect(controller.getState()).toBe('listening');
  });
});
