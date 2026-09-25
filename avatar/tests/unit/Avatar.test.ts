import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { Avatar, CORE_BONES, EMPTY_PROCEDURAL_POSE, clamp01 } from '../../src/avatar/Avatar';
import { createFakeVrm, silentLogger } from './fakeVrm';

function setup(opts: Parameters<typeof createFakeVrm>[0] = {}) {
  const vrm = createFakeVrm(opts);
  const logger = silentLogger();
  const avatar = new Avatar(vrm, { logger });
  return { vrm, logger, avatar };
}

describe('Avatar expressions', () => {
  it('clamps values into [0, 1]', () => {
    const { avatar, vrm } = setup();
    avatar.setExpression('happy', 2);
    expect(avatar.getExpression('happy')).toBe(1);
    avatar.setExpression('happy', -1);
    expect(avatar.getExpression('happy')).toBe(0);
    avatar.setExpression('aa', 0.8);
    avatar.update(0.016);
    expect(vrm.values.get('aa')).toBeCloseTo(0.8);
    expect(vrm.values.get('happy')).toBe(0);
  });

  it('normalizes non-finite values', () => {
    expect(clamp01(Number.NaN)).toBe(0);
    expect(clamp01(Number.POSITIVE_INFINITY)).toBe(1);
    expect(clamp01(Number.NEGATIVE_INFINITY)).toBe(0);
  });

  it('ignores missing expressions without throwing and warns once', () => {
    const { avatar, logger } = setup({ expressions: ['happy'] });
    expect(() => avatar.setExpression('non-existing-expression', 1)).not.toThrow();
    expect(avatar.setExpression('non-existing-expression', 1)).toBe(false);
    expect(avatar.getExpression('non-existing-expression')).toBe(0);
    expect(logger.messages).toHaveLength(1);
    expect(() => avatar.update(0.016)).not.toThrow();
  });

  it('works on a model without an expression manager', () => {
    const vrm = createFakeVrm();
    const avatar = new Avatar({ ...vrm, expressionManager: null }, { logger: silentLogger() });
    expect(avatar.listExpressions()).toEqual([]);
    expect(avatar.setExpression('happy', 1)).toBe(false);
    expect(() => avatar.update(0.016)).not.toThrow();
  });

  it('combines manual and procedural blink with max()', () => {
    const { avatar, vrm } = setup();
    avatar.setExpression('blink', 0.3);
    avatar.setProcedural({ ...EMPTY_PROCEDURAL_POSE, blink: 0.9 });
    avatar.update(0.016);
    expect(vrm.values.get('blink')).toBeCloseTo(0.9);
    avatar.setProcedural({ ...EMPTY_PROCEDURAL_POSE, blink: 0 });
    avatar.update(0.016);
    expect(vrm.values.get('blink')).toBeCloseTo(0.3);
  });

  it('resetExpressions clears manual weights', () => {
    const { avatar, vrm } = setup();
    avatar.setExpression('sad', 0.7);
    avatar.resetExpressions();
    avatar.update(0.016);
    expect(vrm.values.get('sad')).toBe(0);
  });
});

describe('Avatar bones', () => {
  it('exposes core humanoid bones', () => {
    const { avatar } = setup();
    for (const bone of CORE_BONES) expect(avatar.getBone(bone)).toBeInstanceOf(THREE.Object3D);
  });

  it('applies manual head rotation to the normalized head bone', () => {
    const { avatar, vrm } = setup();
    avatar.setHeadRotation(0.3, -0.2, 0.1);
    avatar.update(0.016);
    const e = new THREE.Euler().setFromQuaternion(vrm.bones.get('head')!.quaternion, 'YXZ');
    expect(e.y).toBeCloseTo(0.3);
    expect(e.x).toBeCloseTo(-0.2);
    expect(e.z).toBeCloseTo(0.1);
  });

  it('adds procedural head offsets on top of manual rotation', () => {
    const { avatar, vrm } = setup();
    avatar.setHeadRotation(0.2, 0, 0);
    avatar.setProcedural({ ...EMPTY_PROCEDURAL_POSE, headYaw: 0.05 });
    avatar.update(0.016);
    const e = new THREE.Euler().setFromQuaternion(vrm.bones.get('head')!.quaternion, 'YXZ');
    expect(e.y).toBeCloseTo(0.25);
  });

  it('moves chest/spine with breathing', () => {
    const { avatar, vrm } = setup();
    avatar.update(0.016);
    const rest = vrm.bones.get('chest')!.quaternion.clone();
    avatar.setProcedural({ ...EMPTY_PROCEDURAL_POSE, breath: 1 });
    avatar.update(0.016);
    expect(vrm.bones.get('chest')!.quaternion.angleTo(rest)).toBeGreaterThan(0);
    expect(vrm.bones.get('chest')!.quaternion.angleTo(rest)).toBeLessThan(0.05);
  });

  it('applies the rest pose and tolerates missing bones', () => {
    const vrm = createFakeVrm({ bones: ['hips', 'spine', 'head'] });
    const logger = silentLogger();
    const avatar = new Avatar(vrm, { logger, restPose: { leftUpperArm: { x: 0, y: 0, z: -1 } } });
    expect(avatar.getBone('leftUpperArm')).toBeNull();
    expect(() => avatar.update(0.016)).not.toThrow();
    expect(logger.messages.some((m) => m.includes('leftUpperArm'))).toBe(true);
  });

  it('calls vrm.update with the frame delta', () => {
    const { avatar, vrm } = setup();
    avatar.update(0.02);
    expect(vrm.updates).toEqual([0.02]);
  });
});

describe('Avatar transform & gaze', () => {
  it('sets position, rotation and scale on the root', () => {
    const { avatar, vrm } = setup();
    avatar.setPosition(0.1, 0.2, 0.3);
    avatar.setRotationY(Math.PI / 2);
    avatar.setScale(1.5);
    expect(vrm.scene.position.toArray()).toEqual([0.1, 0.2, 0.3]);
    expect(vrm.scene.rotation.y).toBeCloseTo(Math.PI / 2);
    expect(vrm.scene.scale.x).toBe(1.5);
    avatar.setScale(0);
    expect(vrm.scene.scale.x).toBe(1);
  });

  it('points lookAt at a proxy around the anchor and offsets it by the gaze', () => {
    const { avatar, vrm } = setup();
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(0, 1.4, 1);
    camera.updateMatrixWorld();
    avatar.setLookAtTarget(camera);
    expect(vrm.lookAt.target).toBeInstanceOf(THREE.Object3D);
    expect(vrm.lookAt.autoUpdate).toBe(true);

    avatar.update(0.016);
    const centered = vrm.lookAt.target!.position.clone();
    expect(centered.distanceTo(camera.position)).toBeLessThan(1e-6);

    avatar.setProcedural({ ...EMPTY_PROCEDURAL_POSE, gazeYaw: 5 });
    avatar.update(0.016);
    expect(vrm.lookAt.target!.position.x).toBeGreaterThan(0);

    avatar.setLookAtTarget(null);
    expect(vrm.lookAt.target).toBeNull();
  });
});
