import * as THREE from 'three';
import type { VRMHumanBoneName } from '@pixiv/three-vrm';

export type HumanBoneName = VRMHumanBoneName;

export interface BoneRotation {
  x: number;
  y: number;
  z: number;
}

/**
 * The subset of a three-vrm `VRM` that Avatar depends on.
 * A real `VRM` satisfies it structurally; tests can provide a fake.
 */
export interface AvatarRuntime {
  readonly scene: THREE.Object3D;
  readonly meta: { readonly metaVersion: string };
  readonly humanoid: {
    getNormalizedBoneNode(name: HumanBoneName): THREE.Object3D | null;
    getRawBoneNode(name: HumanBoneName): THREE.Object3D | null;
  };
  readonly expressionManager?: {
    readonly expressions: ReadonlyArray<{ readonly expressionName: string }>;
    setValue(name: string, weight: number): void;
  } | null;
  readonly lookAt?: {
    target?: THREE.Object3D | null;
    autoUpdate: boolean;
  } | null;
  update(delta: number): void;
}

/** VRM 1.0 mouth presets driven by lip sync. */
export const VISEMES = ['aa', 'ih', 'ou', 'ee', 'oh'] as const;
export type Viseme = (typeof VISEMES)[number];

/** Weight per viseme preset, [0, 1] each. */
export type MouthShape = Record<Viseme, number>;

export const CLOSED_MOUTH: Readonly<MouthShape> = Object.freeze({ aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 });

const VISEME_SET: ReadonlySet<string> = new Set(VISEMES);

export function isViseme(name: string): name is Viseme {
  return VISEME_SET.has(name);
}

/** Output of procedural animation (idle, later lip-sync etc.). Additive on top of the manual layer. */
export interface ProceduralPose extends MouthShape {
  /** Head offsets, radians. */
  headYaw: number;
  headPitch: number;
  headRoll: number;
  /** Breathing phase, roughly [-1, 1] scaled by intensity. */
  breath: number;
  /** Upper-body forward lean, radians (positive = towards the camera). Split over spine and chest. */
  lean: number;
  /** Procedural eyelid closure, [0, 1]. Combined with manual blink via max(). */
  blink: number;
  /** Gaze offset from the look target, degrees. */
  gazeYaw: number;
  gazePitch: number;
  // aa/ih/ou/ee/oh (MouthShape): procedural viseme weights from lip sync, combined with manual values via max().
}

export const EMPTY_PROCEDURAL_POSE: Readonly<ProceduralPose> = Object.freeze({
  headYaw: 0,
  headPitch: 0,
  headRoll: 0,
  breath: 0,
  lean: 0,
  blink: 0,
  gazeYaw: 0,
  gazePitch: 0,
  ...CLOSED_MOUTH,
});

export interface AvatarLogger {
  warn(message: string): void;
}

export interface AvatarOptions {
  restPose?: Partial<Record<HumanBoneName, BoneRotation>>;
  logger?: AvatarLogger;
}

/** Bones exposed as the primary control surface. Any humanoid bone is accessible via getBone(). */
export const CORE_BONES = ['head', 'neck', 'chest', 'spine', 'hips'] as const satisfies readonly HumanBoneName[];

/** How breathing maps onto bones (radians at breath = 1). */
const BREATH = {
  spinePitch: 0.006,
  chestPitch: -0.012,
  /** Compensate on the neck so the head does not bob with the chest. */
  neckPitch: 0.006,
  shoulderLift: 0.018,
} as const;

/** How the lean offset is distributed over the spine chain (fractions sum to 1). */
const LEAN = {
  spine: 0.6,
  chest: 0.4,
} as const;

const BLINK_EXPRESSION = 'blink';

interface DrivenBone {
  readonly name: HumanBoneName;
  readonly node: THREE.Object3D;
  readonly manual: THREE.Euler;
}

/**
 * Engine-facing avatar API. Nothing outside this class touches VRM internals.
 *
 * Two layers are composed once per frame in update():
 *  - manual: set via setExpression / setBoneRotation (debug UI, future controllers)
 *  - procedural: set via setProcedural (AvatarController: idle + conversation state)
 */
export class Avatar {
  private readonly vrm: AvatarRuntime;
  private readonly logger: AvatarLogger;

  private readonly expressionNames: readonly string[];
  private readonly expressionSet: ReadonlySet<string>;
  private readonly manualExpressions = new Map<string, number>();
  private readonly warnedExpressions = new Set<string>();

  private readonly drivenBones: DrivenBone[] = [];
  private readonly drivenByName = new Map<HumanBoneName, DrivenBone>();
  private readonly procedural: ProceduralPose = { ...EMPTY_PROCEDURAL_POSE };

  private readonly gazeTarget = new THREE.Object3D();
  private gazeAnchor: THREE.Object3D | null = null;

  // Scratch objects: update() must not allocate.
  private readonly scratchEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly scratchVec = new THREE.Vector3();
  private readonly scratchRight = new THREE.Vector3();
  private readonly scratchUp = new THREE.Vector3();
  private readonly scratchHead = new THREE.Vector3();

  constructor(vrm: AvatarRuntime, options: AvatarOptions = {}) {
    this.vrm = vrm;
    this.logger = options.logger ?? console;

    const expressions = vrm.expressionManager?.expressions ?? [];
    this.expressionNames = expressions.map((e) => e.expressionName);
    this.expressionSet = new Set(this.expressionNames);

    // Bones driven by procedural animation are always registered.
    for (const bone of ['head', 'neck', 'chest', 'spine', 'leftShoulder', 'rightShoulder'] as const) {
      this.ensureDriven(bone);
    }
    for (const [bone, rotation] of Object.entries(options.restPose ?? {})) {
      if (rotation) this.setBoneRotation(bone as HumanBoneName, rotation);
    }
  }

  /** Root object to add to a scene. */
  get object3D(): THREE.Object3D {
    return this.vrm.scene;
  }

  /** '1' for VRM 1.0, '0' for VRM 0.x. */
  get vrmVersion(): string {
    return this.vrm.meta.metaVersion;
  }

  get supportsLookAt(): boolean {
    return this.vrm.lookAt != null;
  }

  // --- Expressions -------------------------------------------------------

  listExpressions(): readonly string[] {
    return this.expressionNames;
  }

  hasExpression(name: string): boolean {
    return this.expressionSet.has(name);
  }

  /**
   * Set a manual expression weight. Value is clamped to [0, 1]; NaN becomes 0.
   * Missing expressions are ignored with a single warning.
   * @returns whether the model has this expression
   */
  setExpression(name: string, value: number): boolean {
    if (!this.expressionSet.has(name)) {
      if (!this.warnedExpressions.has(name)) {
        this.warnedExpressions.add(name);
        this.logger.warn(`[Avatar] expression "${name}" is not defined by this model; ignored`);
      }
      return false;
    }
    this.manualExpressions.set(name, clamp01(value));
    return true;
  }

  /** Manual weight of an expression (0 if unset or missing). */
  getExpression(name: string): number {
    return this.manualExpressions.get(name) ?? 0;
  }

  resetExpressions(): void {
    this.manualExpressions.clear();
  }

  // --- Bones -------------------------------------------------------------

  /**
   * Normalized humanoid bone node (rest pose = identity rotation).
   * Note: rotations of driven bones are overwritten by update(); use setBoneRotation() for those.
   */
  getBone(name: HumanBoneName): THREE.Object3D | null {
    return this.vrm.humanoid.getNormalizedBoneNode(name);
  }

  /** Manual rotation of a normalized bone, radians, Euler order YXZ. */
  setBoneRotation(name: HumanBoneName, rotation: Partial<BoneRotation>): boolean {
    const driven = this.ensureDriven(name);
    if (!driven) {
      this.logger.warn(`[Avatar] bone "${name}" is not present in this model; ignored`);
      return false;
    }
    driven.manual.set(
      rotation.x ?? driven.manual.x,
      rotation.y ?? driven.manual.y,
      rotation.z ?? driven.manual.z,
    );
    return true;
  }

  getBoneRotation(name: HumanBoneName): BoneRotation | null {
    const driven = this.drivenByName.get(name);
    if (!driven) return null;
    return { x: driven.manual.x, y: driven.manual.y, z: driven.manual.z };
  }

  /** Manual head rotation in radians. yaw = around Y, pitch = around X, roll = around Z. */
  setHeadRotation(yaw: number, pitch: number, roll: number): boolean {
    return this.setBoneRotation('head', { x: pitch, y: yaw, z: roll });
  }

  // --- Transform ---------------------------------------------------------

  setPosition(x: number, y: number, z: number): void {
    this.vrm.scene.position.set(x, y, z);
  }

  setRotationY(radians: number): void {
    this.vrm.scene.rotation.y = radians;
  }

  setScale(scale: number): void {
    const s = Number.isFinite(scale) && scale > 0 ? scale : 1;
    this.vrm.scene.scale.setScalar(s);
  }

  /** World position of the head bone (raw skeleton). */
  getHeadWorldPosition(target: THREE.Vector3): THREE.Vector3 | null {
    const head = this.vrm.humanoid.getRawBoneNode('head');
    if (!head) return null;
    head.updateWorldMatrix(true, false);
    return target.setFromMatrixPosition(head.matrixWorld);
  }

  // --- Procedural layer & gaze -------------------------------------------

  setProcedural(pose: Readonly<ProceduralPose>): void {
    const p = this.procedural;
    p.headYaw = pose.headYaw;
    p.headPitch = pose.headPitch;
    p.headRoll = pose.headRoll;
    p.breath = pose.breath;
    p.lean = pose.lean;
    p.blink = clamp01(pose.blink);
    p.gazeYaw = pose.gazeYaw;
    p.gazePitch = pose.gazePitch;
    for (const v of VISEMES) p[v] = clamp01(pose[v]);
  }

  getProcedural(): Readonly<ProceduralPose> {
    return this.procedural;
  }

  /**
   * Make the eyes follow an object (typically the camera). Procedural gaze offsets are applied around it.
   * Pass null to release the eyes.
   */
  setLookAtTarget(anchor: THREE.Object3D | null): void {
    this.gazeAnchor = anchor;
    const lookAt = this.vrm.lookAt;
    if (!lookAt) return;
    lookAt.target = anchor ? this.gazeTarget : null;
    lookAt.autoUpdate = anchor != null;
  }

  // --- Frame -------------------------------------------------------------

  update(delta: number): void {
    this.applyBones();
    this.applyExpressions();
    this.applyGaze();
    this.vrm.update(delta);
  }

  // --- internals -----------------------------------------------------------

  private ensureDriven(name: HumanBoneName): DrivenBone | null {
    const existing = this.drivenByName.get(name);
    if (existing) return existing;
    const node = this.vrm.humanoid.getNormalizedBoneNode(name);
    if (!node) return null;
    const driven: DrivenBone = { name, node, manual: new THREE.Euler(0, 0, 0, 'YXZ') };
    this.drivenBones.push(driven);
    this.drivenByName.set(name, driven);
    return driven;
  }

  private applyBones(): void {
    const p = this.procedural;
    const e = this.scratchEuler;
    for (let i = 0; i < this.drivenBones.length; i++) {
      const bone = this.drivenBones[i]!;
      e.copy(bone.manual);
      switch (bone.name) {
        case 'head':
          e.x += p.headPitch;
          e.y += p.headYaw;
          e.z += p.headRoll;
          break;
        case 'neck':
          e.x += p.breath * BREATH.neckPitch;
          break;
        case 'chest':
          e.x += p.breath * BREATH.chestPitch + p.lean * LEAN.chest;
          break;
        case 'spine':
          e.x += p.breath * BREATH.spinePitch + p.lean * LEAN.spine;
          break;
        case 'leftShoulder':
          e.z += p.breath * BREATH.shoulderLift;
          break;
        case 'rightShoulder':
          e.z -= p.breath * BREATH.shoulderLift;
          break;
        default:
          break;
      }
      bone.node.quaternion.setFromEuler(e);
    }
  }

  private applyExpressions(): void {
    const manager = this.vrm.expressionManager;
    if (!manager) return;
    const names = this.expressionNames;
    for (let i = 0; i < names.length; i++) {
      const name = names[i]!;
      let value = this.manualExpressions.get(name) ?? 0;
      if (name === BLINK_EXPRESSION) value = Math.max(value, this.procedural.blink);
      else if (isViseme(name)) value = Math.max(value, this.procedural[name]);
      manager.setValue(name, value);
    }
  }

  private applyGaze(): void {
    const anchor = this.gazeAnchor;
    if (!anchor || !this.vrm.lookAt) return;

    anchor.updateWorldMatrix(true, false);
    const anchorPos = this.scratchVec.setFromMatrixPosition(anchor.matrixWorld);
    const head = this.getHeadWorldPosition(this.scratchHead);
    const distance = head ? head.distanceTo(anchorPos) : 1;

    // Offset the target in the anchor's own plane (camera right/up axes).
    this.scratchRight.setFromMatrixColumn(anchor.matrixWorld, 0).normalize();
    this.scratchUp.setFromMatrixColumn(anchor.matrixWorld, 1).normalize();
    const dx = Math.tan(this.procedural.gazeYaw * THREE.MathUtils.DEG2RAD) * distance;
    const dy = Math.tan(this.procedural.gazePitch * THREE.MathUtils.DEG2RAD) * distance;

    this.gazeTarget.position
      .copy(anchorPos)
      .addScaledVector(this.scratchRight, dx)
      .addScaledVector(this.scratchUp, dy);
  }
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return value === Infinity ? 1 : 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
