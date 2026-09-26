import { NEUTRAL_BODY_POSE } from '../../src/avatar/BodyPose';
import { NO_EMOTION_EXPRESSIONS } from '../../src/avatar/EmotionExpression';
import { describe, expect, it } from 'vitest';
import { SILENT_USER_VOICE_FRAME, type UserVoiceFrame } from '../../src/audio/user/UserVoiceFrame';
import { Avatar } from '../../src/avatar/Avatar';
import { AvatarController } from '../../src/avatar/AvatarController';
import { AvatarIdleController } from '../../src/avatar/AvatarIdleController';
import { STATE_PROFILES } from '../../src/avatar/AvatarStateProfiles';
import { BehaviorMixer } from '../../src/avatar/BehaviorMixer';
import { NEUTRAL_REACTION, REACTION_LIMITS } from '../../src/avatar/UserReaction';
import { UserReactionMapper } from '../../src/avatar/UserReactionMapper';
import { GestureEngine } from '../../src/avatar/gesture/GestureEngine';
import { seededRandom } from '../../src/avatar/gesture/Gesture';
import { createFakeVrm, silentLogger } from './fakeVrm';

const FPS = 1 / 60;
const voice = (over: Partial<UserVoiceFrame>): UserVoiceFrame => ({ ...SILENT_USER_VOICE_FRAME, ...over });

/** Pushes `frame` at 25 Hz while updating at 60 Hz for `seconds`; returns the max of each output. */
function drive(m: UserReactionMapper, frame: UserVoiceFrame, seconds: number) {
  const max = { engagement: 0, pitchLift: 0 };
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
  }
  return max;
}

describe('UserReactionMapper', () => {
  it('silence: neutral', () => {
    const m = new UserReactionMapper();
    expect(drive(m, SILENT_USER_VOICE_FRAME, 2)).toEqual({ engagement: 0, pitchLift: 0 });
    expect(m.value.speaking).toBe(false);
    expect(m.value.utteranceEnds).toBe(0);
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

  it('reports every utterance end with its length; owns no nod', () => {
    const m = new UserReactionMapper();
    drive(m, voice({ speaking: true, segmentDuration: 1 }), 1);
    expect(m.value.speaking).toBe(true);
    drive(m, voice({ speaking: false, segmentDuration: 1.2 }), 0.3);
    expect(m.value).toMatchObject({ speaking: false, utteranceEnds: 1, lastUtteranceDuration: 1.2 });
    // A short one is reported too: GestureEngine decides what deserves a nod.
    drive(m, voice({ speaking: true, segmentDuration: 0.2 }), 0.2);
    drive(m, voice({ speaking: false, segmentDuration: 0.2 }), 0.2);
    expect(m.value).toMatchObject({ utteranceEnds: 2, lastUtteranceDuration: 0.2 });
    expect('nod' in m.value).toBe(false);
    // reset() keeps the counter monotonic.
    m.reset();
    expect(m.value.utteranceEnds).toBe(2);
  });

  it('while suppressed (assistant talking): no engagement, not speaking, no utterance boundary', () => {
    const s = new UserReactionMapper();
    s.setSuppressed(true);
    expect(drive(s, voice({ speaking: true, segmentDuration: 1, energy: 1 }), 1).engagement).toBe(0);
    expect(s.value.speaking).toBe(false);
    drive(s, voice({ speaking: false, segmentDuration: 1 }), 1);
    expect(s.value.utteranceEnds).toBe(0);
  });

  it('stale frames decay to neutral', () => {
    const m = new UserReactionMapper();
    drive(m, voice({ speaking: true, energy: 1 }), 2);
    for (let t = 0; t < 8; t += FPS) m.update(FPS);
    expect(m.value.engagement).toBeLessThan(0.01);
  });
});

describe('BehaviorMixer reaction input', () => {
  const idlePose = { ...NO_EMOTION_EXPRESSIONS, ...NEUTRAL_BODY_POSE, headYaw: 0.02, headPitch: 0.01, headRoll: -0.01, breath: 0.5, lean: 0, blink: 0, gazeYaw: 4, gazePitch: 2, aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 };

  it('neutral reaction is the identity', () => {
    const mixer = new BehaviorMixer();
    const a = { ...mixer.compose(idlePose, STATE_PROFILES.listening, 0) };
    const b = { ...mixer.compose(idlePose, STATE_PROFILES.listening, 0, NEUTRAL_REACTION) };
    expect(b).toEqual(a);
  });

  it('is bounded whatever the source asks for, and never touches the mouth', () => {
    const mixer = new BehaviorMixer();
    const base = { ...mixer.compose(idlePose, STATE_PROFILES.listening, 0) };
    const out = { ...mixer.compose(idlePose, STATE_PROFILES.listening, 0, { ...NEUTRAL_REACTION, engagement: 50, pitchLift: 50 }) };
    expect(base.headPitch - out.headPitch).toBeCloseTo(REACTION_LIMITS.pitchLift);
    expect(out.lean - base.lean).toBeCloseTo(REACTION_LIMITS.lean);
    expect(Math.abs(out.headYaw / base.headYaw - 1)).toBeLessThanOrEqual(REACTION_LIMITS.headMotionGain + 1e-9);
    expect([out.aa, out.ih, out.ou, out.ee, out.oh]).toEqual([0, 0, 0, 0, 0]);
    const nan = { ...mixer.compose(idlePose, STATE_PROFILES.listening, 0, { ...NEUTRAL_REACTION, engagement: NaN, pitchLift: NaN }) };
    expect(nan).toEqual(base);
  });
});

describe('AvatarController reaction source', () => {
  it('utterance ends reach the gesture source; the nod reaches the head through the mixer only', () => {
    const avatar = new Avatar(createFakeVrm(), { logger: silentLogger() });
    const idle = new AvatarIdleController({ config: { enabled: false, blinkEnabled: false } });
    const controller = new AvatarController({ avatar, idle, transitionDuration: 0 });
    controller.setState('listening');
    const reaction = new UserReactionMapper();
    controller.setReactionSource(reaction);
    const gestures = new GestureEngine({ random: seededRandom(1), config: { nodOnUtteranceChance: 1, rateScale: 0 } });
    controller.setGestureSource(gestures);
    for (let i = 0; i < 60; i++) controller.update(FPS);
    const before = controller.pose.headPitch;
    reaction.push(voice({ speaking: true, segmentDuration: 1 }));
    controller.update(FPS);
    reaction.push(voice({ speaking: false, segmentDuration: 1 }));
    let peak = 0;
    for (let i = 0; i < 60; i++) {
      controller.update(FPS);
      peak = Math.max(peak, controller.pose.headPitch - before);
    }
    expect(gestures.nods).toBe(1);
    expect(peak).toBeGreaterThan(0.02);
    expect(controller.pose.headPitch).toBeCloseTo(before, 9);
    expect(controller.getState()).toBe('listening');
  });
});
