import * as THREE from 'three';
import { AVATAR_VIEW } from '../config';
import type { Avatar, HumanBoneName } from '../avatar/Avatar';
import {
  DEFAULT_CAMERA_ADJUST,
  DEFAULT_PRESENTATION,
  NOMINAL_BOUNDS,
  clampCameraAdjust,
  computeFraming,
  isCameraPreset,
  resolveBounds,
  type AvatarBounds,
  type CameraAdjust,
  type CameraPreset,
  type Framing,
  type Presentation,
} from './CameraFraming';

export type ViewConfig = typeof AVATAR_VIEW;

export type { CameraAdjust, CameraPreset, Presentation } from './CameraFraming';

/** Development helpers; none exists in the scene until turned on. */
export interface SceneHelpers {
  grid: boolean;
  skeleton: boolean;
  axes: boolean;
}

/** Renderer counters of the last frame (diagnostics). */
export interface RenderStats {
  drawCalls: number;
  triangles: number;
  /** Drawing-buffer size and the pixel ratio the budget allowed. */
  width: number;
  height: number;
  pixelRatio: number;
}

/**
 * Scene, camera, renderer, lights, resize and framing. Knows about Avatar only as a scene object.
 *
 * Camera API: a preset says what is in frame (face, waist, full body: measured from the model's bones and box), manual
 * corrections adjust it in relative units, and the presentation says where on the canvas that frame sits and how
 * tall it is. None of it changes the avatar's behaviour: framing only moves the camera.
 */
export class AvatarStage {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;

  private readonly container: HTMLElement;
  private readonly view: ViewConfig;
  private readonly resizeObserver: ResizeObserver;
  private readonly lookTarget = new THREE.Vector3();
  private avatar: Avatar | null = null;
  /** Measured when the avatar is set: moving the avatar later must not drag the camera. */
  private bounds: AvatarBounds = { ...NOMINAL_BOUNDS };
  private preset: CameraPreset;
  private adjust: CameraAdjust = { ...DEFAULT_CAMERA_ADJUST };
  private presentationValue: Presentation = { ...DEFAULT_PRESENTATION };
  private framingValue: Framing | null = null;
  private viewport = { width: 1, height: 1 };
  private helpers: { grid: THREE.GridHelper | null; skeleton: THREE.SkeletonHelper | null; axes: THREE.AxesHelper | null } = {
    grid: null,
    skeleton: null,
    axes: null,
  };
  private skeletonWanted = false;
  private readonly framingListeners = new Set<(framing: Readonly<Framing>) => void>();

  constructor(container: HTMLElement, view: ViewConfig = AVATAR_VIEW) {
    this.container = container;
    this.view = view;
    this.preset = view.preset;

    this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(view.fov, 1, view.near, view.far);
    this.scene.add(this.camera); // so it has a valid matrixWorld as a lookAt anchor

    const ambient = new THREE.AmbientLight(0xffffff, 1.2);
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(0.6, 1.8, 1.4);
    const fill = new THREE.DirectionalLight(0xdfe8ff, 0.5);
    fill.position.set(-1, 1.2, 0.8);
    this.scene.add(ambient, key, fill);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
  }

  get isWebGL2(): boolean {
    return typeof WebGL2RenderingContext !== 'undefined' && this.renderer.getContext() instanceof WebGL2RenderingContext;
  }

  setAvatar(avatar: Avatar | null): void {
    if (this.avatar) this.scene.remove(this.avatar.object3D);
    this.avatar = avatar;
    if (avatar) {
      this.scene.add(avatar.object3D);
      avatar.setLookAtTarget(this.camera);
    }
    this.bounds = avatar ? measureBounds(avatar) : { ...NOMINAL_BOUNDS };
    this.syncSkeletonHelper();
    this.frame();
  }

  /** Model landmarks the presets are computed from (world meters). */
  get avatarBounds(): Readonly<AvatarBounds> {
    return this.bounds;
  }

  // --- Camera -----------------------------------------------------------------------------------------------------

  get cameraPreset(): CameraPreset {
    return this.preset;
  }

  /** Frames the avatar for `preset`; the manual corrections are kept (resetCamera() clears them). */
  setCameraPreset(preset: CameraPreset): void {
    if (!isCameraPreset(preset)) return;
    this.preset = preset;
    this.frame();
  }

  get cameraAdjust(): Readonly<CameraAdjust> {
    return this.adjust;
  }

  /** Manual corrections on top of the preset; clamped to CAMERA_ADJUST_LIMITS. */
  setCameraAdjust(adjust: Partial<CameraAdjust>): void {
    this.adjust = clampCameraAdjust(adjust, this.adjust);
    this.frame();
  }

  /** Back to the current preset's default framing. */
  resetCamera(): void {
    this.adjust = { ...DEFAULT_CAMERA_ADJUST };
    this.frame();
  }

  get presentation(): Readonly<Presentation> {
    return this.presentationValue;
  }

  /** Where on the canvas the framed avatar sits and how tall its box is (see Presentation). */
  setPresentation(presentation: Partial<Presentation>): void {
    const p = { ...this.presentationValue };
    if (Number.isFinite(presentation.x)) p.x = Math.min(1, Math.max(0, presentation.x!));
    if (Number.isFinite(presentation.y)) p.y = Math.min(1, Math.max(0, presentation.y!));
    if (Number.isFinite(presentation.height)) p.height = Math.min(4, Math.max(0.05, presentation.height!));
    this.presentationValue = p;
    this.frame();
  }

  /** Result of the last framing (camera, lens shift, presentation box in canvas pixels). */
  get framing(): Readonly<Framing> | null {
    return this.framingValue;
  }

  /** Called after every reframe (preset, corrections, presentation, resize). @returns unsubscribe */
  onFraming(listener: (framing: Readonly<Framing>) => void): () => void {
    this.framingListeners.add(listener);
    return () => void this.framingListeners.delete(listener);
  }

  /** Recompute camera placement from the preset, corrections, presentation and canvas size. */
  frame(): void {
    const f = computeFraming(this.bounds, this.preset, this.adjust, this.presentationValue, this.viewport, this.view.fov);
    this.framingValue = f;
    this.lookTarget.fromArray(f.target);
    this.camera.position.fromArray(f.position);
    // The camera must reach the model at any zoom: near/far follow the distance.
    this.camera.near = Math.max(0.01, Math.min(this.view.near, f.distance * 0.1));
    this.camera.far = Math.max(this.view.far, f.distance * 4);
    const { width, height } = this.viewport;
    this.camera.setViewOffset(width, height, f.offsetX, f.offsetY, width, height);
    this.camera.lookAt(this.lookTarget);
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
    for (const listener of this.framingListeners) listener(f);
  }

  // --- Scene (development) ----------------------------------------------------------------------------------------

  /** Opaque background colour (CSS/hex), or null for a transparent canvas (the default). */
  setBackground(color: string | number | null): void {
    if (color === null) {
      this.scene.background = null;
      this.renderer.setClearColor(0x000000, 0);
    } else {
      this.scene.background = new THREE.Color(color);
    }
  }

  get sceneHelpers(): SceneHelpers {
    return { grid: !!this.helpers.grid, skeleton: this.skeletonWanted, axes: !!this.helpers.axes };
  }

  /** Development helpers. Off by default; turning one off removes and disposes it. */
  setSceneHelpers(helpers: Partial<SceneHelpers>): void {
    if (helpers.grid !== undefined && helpers.grid !== !!this.helpers.grid) {
      if (helpers.grid) {
        this.helpers.grid = new THREE.GridHelper(4, 16, 0x5a6573, 0x2a323d);
        this.scene.add(this.helpers.grid);
      } else this.removeHelper('grid');
    }
    if (helpers.axes !== undefined && helpers.axes !== !!this.helpers.axes) {
      if (helpers.axes) {
        this.helpers.axes = new THREE.AxesHelper(0.5);
        this.scene.add(this.helpers.axes);
      } else this.removeHelper('axes');
    }
    if (helpers.skeleton !== undefined && helpers.skeleton !== this.skeletonWanted) {
      this.skeletonWanted = helpers.skeleton;
      this.syncSkeletonHelper();
    }
  }

  get renderStats(): RenderStats {
    const info = this.renderer.info.render;
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    return { drawCalls: info.calls, triangles: info.triangles, width: size.x, height: size.y, pixelRatio: this.renderer.getPixelRatio() };
  }

  resize(): void {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.viewport = { width, height };
    this.renderer.setPixelRatio(budgetPixelRatio(window.devicePixelRatio || 1, width, height, this.view.maxPixels));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.frame();
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.resizeObserver.disconnect();
    this.framingListeners.clear();
    this.setSceneHelpers({ grid: false, skeleton: false, axes: false });
    if (this.avatar) this.scene.remove(this.avatar.object3D);
    this.avatar = null;
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }

  /** The skeleton helper follows the current avatar; it exists only while wanted and an avatar is set. */
  private syncSkeletonHelper(): void {
    this.removeHelper('skeleton');
    if (!this.skeletonWanted || !this.avatar) return;
    const helper = new THREE.SkeletonHelper(this.avatar.object3D);
    this.helpers.skeleton = helper;
    this.scene.add(helper);
  }

  private removeHelper(name: keyof SceneHelpers): void {
    const helper = this.helpers[name];
    if (!helper) return;
    this.scene.remove(helper);
    helper.dispose();
    this.helpers[name] = null;
  }
}

/**
 * Pixel ratio for a canvas of width×height CSS pixels: the device ratio (at most 2), lowered so the drawing buffer
 * stays within `maxPixels`. Never below 0.5.
 */
export function budgetPixelRatio(devicePixelRatio: number, width: number, height: number, maxPixels: number): number {
  const dpr = Math.min(Math.max(devicePixelRatio, 0.5), 2);
  const area = Math.max(1, width * height);
  const budget = Math.sqrt(maxPixels / area);
  return Math.max(0.5, Math.min(dpr, budget));
}

const FEET: readonly HumanBoneName[] = ['leftFoot', 'rightFoot', 'leftToes', 'rightToes'];

/** Model landmarks for the camera presets: head, neck, hips and feet bones plus the bounding box. */
export function measureBounds(avatar: Avatar): AvatarBounds {
  const v = new THREE.Vector3();
  const y = (name: HumanBoneName) => avatar.getBoneWorldPosition(name, v)?.y ?? null;
  const box = new THREE.Box3().setFromObject(avatar.object3D);
  const feet = FEET.map(y).filter((n): n is number => n !== null);
  const head = avatar.getBoneWorldPosition('head', new THREE.Vector3());
  const hips = avatar.getBoneWorldPosition('hips', new THREE.Vector3());
  return resolveBounds({
    boxTop: box.isEmpty() ? null : box.max.y,
    boxBottom: box.isEmpty() ? null : box.min.y,
    head: head?.y ?? null,
    neck: y('neck'),
    hips: hips?.y ?? null,
    feet: feet.length ? Math.min(...feet) : null,
    centerX: head?.x ?? hips?.x ?? null,
    centerZ: head?.z ?? hips?.z ?? null,
  });
}
