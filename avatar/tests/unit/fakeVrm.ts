import * as THREE from 'three';
import type { AvatarRuntime, HumanBoneName } from '../../src/avatar/Avatar';

export interface FakeVrm extends AvatarRuntime {
  readonly bones: Map<HumanBoneName, THREE.Object3D>;
  readonly values: Map<string, number>;
  readonly lookAt: { target?: THREE.Object3D | null; autoUpdate: boolean };
  updates: number[];
}

const DEFAULT_BONES: HumanBoneName[] = [
  'hips',
  'spine',
  'chest',
  'upperChest',
  'neck',
  'head',
  'leftShoulder',
  'rightShoulder',
  'leftUpperArm',
  'rightUpperArm',
];

export const DEFAULT_EXPRESSIONS = [
  'happy', 'angry', 'sad', 'relaxed', 'surprised',
  'blink', 'blinkLeft', 'blinkRight',
  'aa', 'ih', 'ou', 'ee', 'oh',
];

/** Minimal structural stand-in for @pixiv/three-vrm's VRM. */
export function createFakeVrm(options: { expressions?: string[]; bones?: HumanBoneName[] } = {}): FakeVrm {
  const scene = new THREE.Group();
  const bones = new Map<HumanBoneName, THREE.Object3D>();
  let parent: THREE.Object3D = scene;
  for (const name of options.bones ?? DEFAULT_BONES) {
    const node = new THREE.Object3D();
    node.name = name;
    if (name === 'head') node.position.y = 1.4;
    parent.add(node);
    parent = node;
    bones.set(name, node);
  }

  const values = new Map<string, number>();
  const expressions = (options.expressions ?? DEFAULT_EXPRESSIONS).map((expressionName) => ({ expressionName }));

  const fake: FakeVrm = {
    scene,
    bones,
    values,
    updates: [],
    meta: { metaVersion: '1' },
    humanoid: {
      getNormalizedBoneNode: (name) => bones.get(name) ?? null,
      getRawBoneNode: (name) => bones.get(name) ?? null,
    },
    expressionManager: {
      expressions,
      setValue: (name, weight) => void values.set(name, weight),
    },
    lookAt: { target: null, autoUpdate: true },
    update(delta) {
      fake.updates.push(delta);
    },
  };
  return fake;
}

export function silentLogger() {
  const messages: string[] = [];
  return { messages, warn: (m: string) => void messages.push(m) };
}
