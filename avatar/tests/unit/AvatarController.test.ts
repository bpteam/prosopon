import { NEUTRAL_BODY_POSE } from '../../src/avatar/BodyPose';
import { NO_EMOTION_EXPRESSIONS } from '../../src/avatar/EmotionExpression';
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { Avatar } from '../../src/avatar/Avatar';
import { AvatarController } from '../../src/avatar/AvatarController';
import { AvatarIdleController, type IdleConfig } from '../../src/avatar/AvatarIdleController';
import {
  AVATAR_STATES,
  PROFILE_KEYS,
  STATE_PROFILES,
  STATE_TRANSITION_DURATION,
  type AvatarStateProfile,
} from '../../src/avatar/AvatarStateProfiles';
import { BehaviorMixer } from '../../src/avatar/BehaviorMixer';
import { ConversationStateMachine } from '../../src/avatar/ConversationStateMachine';
import { createFakeVrm, silentLogger } from './fakeVrm';

/** Deterministic PRNG (mulberry32). */
function seeded(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeIdle(config: Partial<IdleConfig> = {}, seed = 7) {
  return new AvatarIdleController({ config: { doubleBlinkChance: 0, ...config }, random: seeded(seed) });
}

function setup(config: Partial<IdleConfig> = {}) {
  const vrm = createFakeVrm();
  const logger = silentLogger();
  const avatar = new Avatar(vrm, { logger });
  const idle = makeIdle(config);
  const controller = new AvatarController({ avatar, idle });
  return { vrm, avatar, idle, controller, logger };
}

function run(controller: AvatarController, seconds: number, dt: number) {
  const frames = Math.round(seconds / dt);
  for (let i = 0; i < frames; i++) controller.update(dt);
}

function headEuler(vrm: ReturnType<typeof createFakeVrm>) {
  return new THREE.Euler().setFromQuaternion(vrm.bones.get('head')!.quaternion, 'YXZ');
}

function expectProfile(actual: Readonly<AvatarStateProfile>, expected: Readonly<AvatarStateProfile>, digits = 9) {
  for (const key of PROFILE_KEYS) expect(actual[key], key).toBeCloseTo(expected[key], digits);
}

describe('state machine', () => {
  it('starts in idle with the idle profile', () => {
    const { controller } = setup();
    expect(controller.getState()).toBe('idle');
    expect(controller.isTransitioning).toBe(false);
    expectProfile(controller.stateProfile, STATE_PROFILES.idle);
  });

  it('setState starts a transition, not a jump', () => {
    const { controller } = setup();
    controller.setState('listening');
    expect(controller.getState()).toBe('listening');
    expect(controller.isTransitioning).toBe(true);
    // Nothing has elapsed yet: still exactly at the idle profile.
    controller.update(0);
    expectProfile(controller.stateProfile, STATE_PROFILES.idle);

    controller.update(STATE_TRANSITION_DURATION / 2);
    const mid = controller.stateProfile.gazeMotionMultiplier;
    expect(mid).toBeLessThan(STATE_PROFILES.idle.gazeMotionMultiplier);
    expect(mid).toBeGreaterThan(STATE_PROFILES.listening.gazeMotionMultiplier);
  });

  it('reaches the target profile exactly once the transition is over', () => {
    const { controller } = setup();
    for (const state of AVATAR_STATES) {
      controller.setState(state);
      run(controller, STATE_TRANSITION_DURATION + 0.05, 1 / 60);
      expect(controller.isTransitioning).toBe(false);
      expectProfile(controller.stateProfile, STATE_PROFILES[state], 12);
    }
  });

  it('allows any state to go to any other state', () => {
    for (const from of AVATAR_STATES) {
      for (const to of AVATAR_STATES) {
        const machine = new ConversationStateMachine({ initialState: from });
        machine.setState(to);
        machine.update(1);
        expect(machine.getState()).toBe(to);
        expectProfile(machine.profile, STATE_PROFILES[to], 12);
      }
    }
  });

  it('a repeated setState does not restart the transition', () => {
    const a = new ConversationStateMachine();
    const b = new ConversationStateMachine();
    a.setState('thinking');
    b.setState('thinking');
    a.update(0.1);
    b.update(0.1);
    expect(b.setState('thinking')).toBe(false);
    a.update(0.1);
    b.update(0.1);
    expect(b.progress).toBeCloseTo(a.progress, 12);
    expectProfile(b.profile, a.profile, 12);
  });

  it('retargeting mid-transition is continuous', () => {
    const m = new ConversationStateMachine();
    m.setState('thinking');
    m.update(STATE_TRANSITION_DURATION * 0.4);
    const before = { ...m.profile };
    m.setState('speaking');
    m.update(0);
    expectProfile(m.profile, before, 12);
    // Small step → small change (no discontinuity).
    m.update(1 / 120);
    for (const key of PROFILE_KEYS) expect(Math.abs(m.profile[key] - before[key])).toBeLessThan(0.5);
  });

  it('is frame-rate independent', () => {
    const results = [60, 30, 120].map((fps) => {
      const m = new ConversationStateMachine();
      m.setState('thinking');
      const dt = 1 / fps;
      // Sample half way through, then at the end.
      for (let i = 0; i < Math.round(fps * 0.2); i++) m.update(dt);
      const mid = { ...m.profile };
      for (let i = 0; i < Math.round(fps * 0.8); i++) m.update(dt);
      return { mid, end: { ...m.profile } };
    });
    for (const r of results.slice(1)) {
      expectProfile(r.mid, results[0]!.mid, 6);
      expectProfile(r.end, results[0]!.end, 12);
    }
  });

  it('frame-rate independent through the full controller pipeline', () => {
    const poses = [60, 30, 120].map((fps) => {
      const { controller, avatar } = setup();
      controller.setState('speaking');
      const dt = 1 / fps;
      for (let i = 0; i < fps * 2; i++) controller.update(dt);
      return { ...avatar.getProcedural() };
    });
    for (const p of poses.slice(1)) {
      expect(p.headYaw).toBeCloseTo(poses[0]!.headYaw, 6);
      expect(p.headRoll).toBeCloseTo(poses[0]!.headRoll, 6);
      expect(p.breath).toBeCloseTo(poses[0]!.breath, 6);
      expect(p.lean).toBeCloseTo(poses[0]!.lean, 9);
      expect(p.gazeYaw).toBeCloseTo(poses[0]!.gazeYaw, 3);
    }
  });

  it('transitionDuration 0 switches instantly', () => {
    const m = new ConversationStateMachine({ transitionDuration: 0 });
    m.setState('thinking');
    expectProfile(m.profile, STATE_PROFILES.thinking, 12);
  });
});

describe('state change events', () => {
  it('notifies subscribers once per actual change', () => {
    const { controller } = setup();
    const seen: string[] = [];
    const off = controller.onStateChange((s, prev) => seen.push(`${prev}->${s}`));
    controller.setState('listening');
    controller.setState('listening');
    controller.setState('thinking');
    off();
    controller.setState('speaking');
    expect(seen).toEqual(['idle->listening', 'listening->thinking']);
  });

  it('a throwing listener does not break the state change or other listeners', () => {
    const errors: unknown[] = [];
    const avatar = new Avatar(createFakeVrm(), { logger: silentLogger() });
    const controller = new AvatarController({ avatar, idle: makeIdle(), onListenerError: (e) => errors.push(e) });
    const other = vi.fn();
    controller.onStateChange(() => {
      throw new Error('boom');
    });
    controller.onStateChange(other);
    controller.setState('speaking');
    expect(controller.getState()).toBe('speaking');
    expect(other).toHaveBeenCalledWith('speaking', 'idle');
    expect(errors).toHaveLength(1);
  });
});

describe('composition', () => {
  it('controller is the only procedural writer (idle sink is detached)', () => {
    const vrm = createFakeVrm();
    const avatar = new Avatar(vrm, { logger: silentLogger() });
    const idle = new AvatarIdleController({ sink: avatar, random: seeded(1) });
    new AvatarController({ avatar, idle });
    const spy = vi.spyOn(avatar, 'setProcedural');
    idle.update(0.1);
    expect(spy).not.toHaveBeenCalled();
  });

  it('manual head rotation + state offset + idle micro-motion all add up on the head bone', () => {
    const { controller, vrm, idle } = setup();
    controller.setHeadRotation(0.2, 0.1, 0);
    controller.setState('thinking');
    run(controller, 1.5, 1 / 60);

    const profile = STATE_PROFILES.thinking;
    const expectedYaw = 0.2 + profile.headYawOffset + idle.state.headYaw * profile.headMotionMultiplier;
    const expectedPitch = 0.1 + profile.headPitchOffset + idle.state.headPitch * profile.headMotionMultiplier;
    const expectedRoll = profile.headRollOffset + idle.state.headRoll * profile.headMotionMultiplier;
    // Each term is non-trivial, so the sum proves all three are present.
    expect(Math.abs(idle.state.headYaw)).toBeGreaterThan(1e-4);
    expect(profile.headYawOffset).not.toBe(0);

    const e = headEuler(vrm);
    expect(e.y).toBeCloseTo(expectedYaw, 6);
    expect(e.x).toBeCloseTo(expectedPitch, 6);
    expect(e.z).toBeCloseTo(expectedRoll, 6);
  });

  it('state behaviour does not overwrite the manual layer', () => {
    const { controller, avatar } = setup();
    controller.setHeadRotation(0.3, 0, 0);
    controller.setExpression('happy', 0.7);
    for (const s of AVATAR_STATES) {
      controller.setState(s);
      run(controller, 0.5, 1 / 60);
    }
    expect(avatar.getBoneRotation('head')!.y).toBeCloseTo(0.3);
    expect(controller.getExpression('happy')).toBeCloseTo(0.7);
  });

  it('scales idle motion and adds gaze offsets per profile', () => {
    const mixer = new BehaviorMixer();
    const idlePose = { ...NO_EMOTION_EXPRESSIONS, ...NEUTRAL_BODY_POSE, headYaw: 0.02, headPitch: 0.01, headRoll: -0.01, breath: 0.5, lean: 0, blink: 0.4, gazeYaw: 4, gazePitch: 2, aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 };
    const p = STATE_PROFILES.thinking;
    const out = mixer.compose(idlePose, p);
    expect(out.headYaw).toBeCloseTo(0.02 * p.headMotionMultiplier + p.headYawOffset);
    expect(out.gazeYaw).toBeCloseTo(4 * p.gazeMotionMultiplier + p.gazeYawOffset);
    expect(out.gazePitch).toBeCloseTo(2 * p.gazeMotionMultiplier + p.gazePitchOffset);
    expect(out.breath).toBeCloseTo(0.5 * p.breathingMultiplier);
    expect(out.blink).toBe(0.4);
    // Idle profile is the identity.
    expect({ ...mixer.compose(idlePose, STATE_PROFILES.idle) }).toEqual(idlePose);
  });

  it('listening reduces gaze wandering compared to idle', () => {
    const measure = (state: 'idle' | 'listening') => {
      const { controller, avatar } = setup();
      controller.setState(state);
      let max = 0;
      for (let i = 0; i < 60 * 30; i++) {
        controller.update(1 / 60);
        max = Math.max(max, Math.abs(avatar.getProcedural().gazeYaw - STATE_PROFILES[state].gazeYawOffset));
      }
      return max;
    };
    expect(measure('listening')).toBeLessThan(measure('idle') * 0.5);
  });

  it('keeps the gaze proxy: offsets move the look-at target, not eye bones', () => {
    const { controller, vrm } = setup();
    const camera = new THREE.Object3D();
    camera.position.set(0, 1.4, 1);
    controller.setLookAtTarget(camera);
    expect(vrm.lookAt.target).toBeInstanceOf(THREE.Object3D);
    expect(vrm.lookAt.target).not.toBe(camera);

    controller.setIdleEnabled(false);
    controller.setState('thinking');
    run(controller, 3, 1 / 60);
    const target = vrm.lookAt.target!.position;
    // Thinking gaze is offset aside/down from the camera.
    expect(Math.abs(target.x - camera.position.x)).toBeGreaterThan(0.01);
    expect(target.y).toBeLessThan(camera.position.y);
  });
});

describe('idle preservation', () => {
  it('state changes do not alter breathing, blink or gaze of the idle generator', () => {
    const reference = makeIdle({ blinkIntervalMin: 0.8, blinkIntervalMax: 1.6 });
    const { controller, idle } = setup({ blinkIntervalMin: 0.8, blinkIntervalMax: 1.6 });
    const states = ['listening', 'thinking', 'speaking', 'idle', 'thinking'] as const;
    const dt = 1 / 60;
    for (let i = 0; i < 60 * 10; i++) {
      if (i % 97 === 0) controller.setState(states[(i / 97) % states.length]!);
      controller.update(dt);
      reference.update(dt);
      expect(idle.state.breath).toBe(reference.state.breath);
      expect(idle.state.blink).toBe(reference.state.blink);
      expect(idle.state.blinkPhase).toBe(reference.state.blinkPhase);
      expect(idle.state.gazeYaw).toBe(reference.state.gazeYaw);
      expect(idle.state.gazePhase).toBe(reference.state.gazePhase);
    }
  });

  it('switching state mid-blink does not open the eyes', () => {
    const { controller, idle, vrm } = setup({ blinkIntervalMin: 5, blinkIntervalMax: 5 });
    controller.update(0.1);
    controller.triggerBlink();
    controller.update(0.08); // into 'closed'
    expect(idle.state.blinkPhase).toBe('closed');
    const before = vrm.values.get('blink')!;
    controller.setState('speaking');
    controller.update(0.01);
    expect(idle.state.blinkPhase).toBe('closed');
    expect(vrm.values.get('blink')).toBe(1);
    expect(before).toBe(1);
  });
});

describe('manual proxies', () => {
  it('manual blink combines with automatic blink via max()', () => {
    const { controller, vrm } = setup({ blinkEnabled: false });
    controller.setExpression('blink', 0.3);
    controller.update(0.016);
    expect(vrm.values.get('blink')).toBeCloseTo(0.3);

    controller.triggerBlink();
    controller.idle.config.blinkEnabled = true;
    run(controller, 0.1, 0.01);
    expect(vrm.values.get('blink')).toBe(1);
  });

  it('missing expressions warn once, return false, never throw', () => {
    const { controller, logger } = setup();
    expect(controller.setExpression('nope', 1)).toBe(false);
    expect(() => controller.setExpression('nope', 1)).not.toThrow();
    expect(logger.messages.filter((m) => m.includes('nope'))).toHaveLength(1);
  });

  it('setIdleEnabled fades idle but keeps state posture', () => {
    const { controller, avatar } = setup();
    controller.setIdleEnabled(false);
    controller.setState('listening');
    run(controller, 3, 1 / 60);
    const p = avatar.getProcedural();
    expect(p.breath).toBeCloseTo(0, 9);
    expect(p.headPitch).toBeCloseTo(STATE_PROFILES.listening.headPitchOffset, 9);
    expect(p.lean).toBeCloseTo(STATE_PROFILES.listening.leanOffset, 9);
  });
});

describe('avatar attached after construction (model still loading)', () => {
  it('keeps state set before the avatar exists and applies it once attached', () => {
    const controller = new AvatarController({ idle: makeIdle() });
    expect(controller.avatar).toBeNull();
    const seen: string[] = [];
    controller.onStateChange((s) => seen.push(s));

    controller.setState('speaking');
    run(controller, 1, 1 / 60); // frames before the VRM arrives must not throw
    expect(seen).toEqual(['speaking']);
    expect(controller.setExpression('happy', 1)).toBe(false);

    const vrm = createFakeVrm();
    const avatar = new Avatar(vrm, { logger: silentLogger() });
    controller.attachAvatar(avatar);
    expect(controller.avatar).toBe(avatar);
    expect(controller.getState()).toBe('speaking');
    expect(controller.isTransitioning).toBe(false);
    expectProfile(controller.stateProfile, STATE_PROFILES.speaking);

    controller.setMouthSource({ update: () => 0.5 });
    controller.update(1 / 60);
    expect(vrm.values.get('aa')).toBeCloseTo(0.5);
    expect(vrm.updates.length).toBeGreaterThan(0);
  });

  it('applies a look-at target set before the avatar is attached', () => {
    const controller = new AvatarController({ idle: makeIdle() });
    const target = new THREE.Object3D();
    controller.setLookAtTarget(target);
    const vrm = createFakeVrm();
    controller.attachAvatar(new Avatar(vrm, { logger: silentLogger() }));
    controller.update(1 / 60);
    expect(vrm.lookAt.target).not.toBeNull();
  });
});
