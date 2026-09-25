import * as THREE from 'three';
import { AVATAR_VIEW } from '../config';
import type { Avatar } from '../avatar/Avatar';

export type ViewConfig = typeof AVATAR_VIEW;

/**
 * Scene, camera, renderer, lights, resize and framing. Knows about Avatar only as a scene object.
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
  /** Head position captured when the avatar was set: moving the avatar later must not drag the camera. */
  private framedHead: THREE.Vector3 | null = null;

  constructor(container: HTMLElement, view: ViewConfig = AVATAR_VIEW) {
    this.container = container;
    this.view = view;

    this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
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

    this.lookTarget.fromArray(view.fallback.target);
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
    this.framedHead = avatar?.getHeadWorldPosition(new THREE.Vector3()) ?? null;
    this.frame();
  }

  /** Recompute camera placement from the current avatar and aspect ratio. */
  frame(): void {
    const v = this.view;
    const head = this.framedHead;
    if (!head) {
      this.camera.position.fromArray(v.fallback.cameraPosition);
      this.lookTarget.fromArray(v.fallback.target);
    } else {
      this.lookTarget.set(
        head.x + v.targetOffsetFromHead[0],
        head.y + v.targetOffsetFromHead[1],
        head.z + v.targetOffsetFromHead[2],
      );
      const distance = fitDistance(v.frameWidth, v.frameHeight, v.fov, this.camera.aspect);
      this.camera.position.set(this.lookTarget.x, this.lookTarget.y + v.cameraHeightOffset, this.lookTarget.z + distance);
    }
    this.camera.lookAt(this.lookTarget);
    this.camera.updateMatrixWorld();
  }

  resize(): void {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.frame();
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.resizeObserver.disconnect();
    if (this.avatar) this.scene.remove(this.avatar.object3D);
    this.avatar = null;
    this.framedHead = null;
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }
}

/** Camera distance so that a width×height rectangle fits into the frustum at the given aspect. */
export function fitDistance(width: number, height: number, fovDeg: number, aspect: number): number {
  const tanHalf = Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2);
  const byHeight = height / (2 * tanHalf);
  const byWidth = width / (2 * tanHalf * aspect);
  return Math.max(byHeight, byWidth);
}
