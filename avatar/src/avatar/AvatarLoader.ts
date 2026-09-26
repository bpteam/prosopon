import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm';
import { Avatar, type AvatarOptions } from './Avatar';

export class AvatarLoadError extends Error {
  constructor(
    message: string,
    readonly url: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'AvatarLoadError';
  }
}

export interface LoadProgress {
  loaded: number;
  total: number;
}

export interface AvatarLoaderOptions extends AvatarOptions {
  onProgress?: (progress: LoadProgress) => void;
}

/** Loads a .vrm file into an Avatar. The only place that knows about GLTFLoader / VRMLoaderPlugin. */
export class AvatarLoader {
  private readonly gltfLoader: GLTFLoader;

  constructor(gltfLoader: GLTFLoader = new GLTFLoader()) {
    this.gltfLoader = gltfLoader;
    this.gltfLoader.register((parser) => new VRMLoaderPlugin(parser));
  }

  async loadVRM(url: string, onProgress?: (p: LoadProgress) => void): Promise<VRM> {
    let gltf;
    try {
      gltf = await this.gltfLoader.loadAsync(url, (e) => onProgress?.({ loaded: e.loaded, total: e.total }));
    } catch (cause) {
      throw new AvatarLoadError(`Failed to load "${url}": ${describe(cause)}`, url, { cause });
    }

    const vrm = gltf.userData.vrm as VRM | undefined;
    if (!vrm) {
      throw new AvatarLoadError(`"${url}" is a glTF file but contains no VRM extension`, url);
    }

    optimize(vrm);
    return vrm;
  }

  async load(url: string, options: AvatarLoaderOptions = {}): Promise<Avatar> {
    const vrm = await this.loadVRM(url, options.onProgress);
    return new Avatar(vrm, options);
  }
}

/** Frees the GPU resources (geometries, materials, textures) of a VRM that is no longer rendered. */
export function disposeVRM(vrm: VRM): void {
  VRMUtils.deepDispose(vrm.scene);
}

function optimize(vrm: VRM): void {
  const steps: Array<[string, () => void]> = [
    ['removeUnnecessaryVertices', () => VRMUtils.removeUnnecessaryVertices(vrm.scene)],
    ['combineSkeletons', () => VRMUtils.combineSkeletons(vrm.scene)],
    ['combineMorphs', () => VRMUtils.combineMorphs(vrm)],
  ];
  if (vrm.meta.metaVersion === '0') {
    // VRM 0.x faces -Z; VRM 1.0 faces +Z. Normalize so framing works for both.
    steps.push(['rotateVRM0', () => VRMUtils.rotateVRM0(vrm)]);
  }
  for (const [name, step] of steps) {
    try {
      step();
    } catch (error) {
      // An optimization is not worth failing the load for.
      console.warn(`[AvatarLoader] VRMUtils.${name} failed, skipping:`, error);
    }
  }

  // Skinned meshes are culled by their bind-pose bounds, which leads to popping. One avatar: just disable.
  vrm.scene.traverse((obj) => {
    obj.frustumCulled = false;
  });
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'target' in error) {
    // XHR ProgressEvent from FileLoader
    const target = (error as { target?: { status?: number; statusText?: string } }).target;
    if (target?.status) return `HTTP ${target.status} ${target.statusText ?? ''}`.trim();
  }
  return String(error);
}
