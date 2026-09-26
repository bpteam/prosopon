import { describe, expect, it } from 'vitest';
import { NEUTRAL_EMOTION } from '../../src/audio/emotion/EmotionFrame';
import { EMPTY_PROCEDURAL_POSE } from '../../src/avatar/Avatar';
import { STATE_PROFILES } from '../../src/avatar/AvatarStateProfiles';
import { ATTRIBUTED_CHANNELS, BehaviorMixer } from '../../src/avatar/BehaviorMixer';
import { POSE_LIMITS } from '../../src/avatar/BodyPose';
import { NEUTRAL_EMOTION_INPUTS } from '../../src/avatar/EmotionExpression';
import { createGestureFrame, seededRandom } from '../../src/avatar/gesture/Gesture';
import { GESTURE_LIMITS } from '../../src/avatar/gesture/GestureConfig';
import { GESTURE_PRIORITY, GestureEngine } from '../../src/avatar/gesture/GestureEngine';
import { NEUTRAL_REACTION } from '../../src/avatar/UserReaction';

const idlePose = { ...EMPTY_PROCEDURAL_POSE, headYaw: 0.02, headPitch: 0.01, headRoll: -0.01, breath: 0.5, lean: 0.01 };
const assistant = { ...NEUTRAL_EMOTION, active: true, arousal: 0.8, pitchLift: 0.5, confidence: 0.9 };
const reaction = { ...NEUTRAL_REACTION, engagement: 0.6, pitchLift: 0.4, speaking: true };

function gesture(yaw: number, lean = 0) {
  const g = createGestureFrame();
  g.active = true;
  g.type = 'head-shake';
  g.head.yaw = yaw;
  g.body.lean = lean;
  return g;
}

describe('BehaviorMixer attribution (calibration)', () => {
  it('is off by default and does not change the composed pose when on', () => {
    const off = new BehaviorMixer();
    const on = new BehaviorMixer();
    on.setAttributionEnabled(true);
    expect(off.attribution).toBeNull();
    const args = [idlePose, STATE_PROFILES.speaking, 0, reaction, { ...NEUTRAL_EMOTION_INPUTS, assistant }, gesture(0.05)] as const;
    expect({ ...on.compose(...args) }).toEqual({ ...off.compose(...args) });
    on.setAttributionEnabled(false);
    expect(on.attribution).toBeNull();
  });

  it('sources add up to the final value when nothing is clamped', () => {
    const mixer = new BehaviorMixer();
    mixer.setAttributionEnabled(true);
    const out = mixer.compose(idlePose, STATE_PROFILES.thinking, 0, reaction, { ...NEUTRAL_EMOTION_INPUTS, assistant }, gesture(0.05, 0.01));
    const a = mixer.attribution!;
    for (const ch of ATTRIBUTED_CHANNELS) {
      const s = a[ch].sources;
      expect(a[ch].sum, ch).toBeCloseTo(s.idle + s.state + s.reaction + s.emotion + s.gesture, 12);
      expect(a[ch].final, ch).toBeCloseTo(a[ch].sum, 9);
    }
    expect(a.headYaw.final).toBe(out.headYaw);
    expect(a.headYaw.sources.gesture).toBeCloseTo(0.05, 12);
    expect(a.headYaw.sources.state).toBeCloseTo(STATE_PROFILES.thinking.headYawOffset, 12);
    expect(a.headYaw.sources.emotion).not.toBe(0);
    expect(a.headYaw.sources.reaction).not.toBe(0);
  });

  it('shows what the gesture asked for, what its limit let through and what the pose clamp kept', () => {
    const mixer = new BehaviorMixer();
    mixer.setAttributionEnabled(true);
    mixer.compose(idlePose, STATE_PROFILES.speaking, 0, NEUTRAL_REACTION, NEUTRAL_EMOTION_INPUTS, gesture(10));
    const h = mixer.attribution!.headYaw;
    expect(h.gestureRequested).toBe(10);
    expect(h.sources.gesture).toBeCloseTo(GESTURE_LIMITS.headYaw, 12);
    expect(Math.abs(h.final)).toBeLessThanOrEqual(POSE_LIMITS.headYaw + 1e-12);
    expect(h.sum).toBeGreaterThanOrEqual(h.final);
  });
});

describe('GestureEngine.currentPriority', () => {
  it('names who started the running gesture and is null when none runs', () => {
    const e = new GestureEngine({ random: seededRandom(1) });
    e.auto = false;
    expect(e.currentPriority).toBeNull();
    expect(e.trigger('nod')).toBe(true);
    const ctx = { conversationState: 'idle', userSpeaking: false, assistantSpeaking: false, userEmotion: NEUTRAL_EMOTION, assistantEmotion: NEUTRAL_EMOTION, utteranceEnds: 0, lastUtteranceDuration: 0 } as const;
    e.update(1 / 60, ctx);
    expect(e.currentPriority).toBe(GESTURE_PRIORITY.forced);
    for (let i = 0; i < 600; i++) e.update(1 / 60, ctx);
    expect(e.currentPriority).toBeNull();
  });
});
