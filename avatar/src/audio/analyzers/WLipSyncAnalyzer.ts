import type { MouthShape } from '../../avatar/MouthShape';
import { assertAudioWorklet, type VisemeAnalyzer, type VisemeAnalyzerFactory } from '../VisemeAnalyzer';

/** uLipSync phoneme (profile entry name) → VRM mouth shape. The sample profile uses A/I/U/E/O/S. */
export const ULIPSYNC_TO_VRM: Readonly<Record<string, Readonly<Partial<MouthShape>>>> = {
  A: { aa: 1 },
  I: { ih: 1 },
  U: { ou: 1 },
  E: { ee: 1 },
  O: { oh: 1 },
  S: { ih: 0.4 },
};

export interface WLipSyncOptions {
  profileUrl?: string;
  /**
   * Load the worklet processor and the WASM module from these URLs instead of the package's single-file build,
   * which registers its worklet from a data: URL. Needed where CSP only allows 'self' scripts (extension pages).
   * Copy them from wlipsync/dist/audio-processor.js and wlipsync/dist/wlipsync.wasm.
   */
  assets?: { processorUrl: string; wasmUrl: string };
  /** wLipSync's own smooth-damp time, seconds. Kept short because VisemeLipSync smooths again. */
  smoothness?: number;
}

const DEFAULT_PROFILE_URL = `${import.meta.env.BASE_URL}lipsync/wlipsync/profile.bin`;

/**
 * wLipSync (mrxz, MIT; WASM port of hecomi's uLipSync): MFCC matched against a calibrated profile.
 * The shipped profile is wLipSync's example (one calibrated voice); other voices need a profile made with
 * uLipSync's calibration in Unity, which is this option's main cost.
 */
export function wLipSyncFactory(options: WLipSyncOptions = {}): VisemeAnalyzerFactory {
  return async (context) => {
    assertAudioWorklet(context);
    const [{ createWLipSyncNode, parseBinaryProfile }, response] = await Promise.all([
      options.assets ? loadSplitBuild(context, options.assets) : import('wlipsync'),
      fetch(options.profileUrl ?? DEFAULT_PROFILE_URL),
    ]);
    if (!response.ok) throw new Error(`wLipSync profile: HTTP ${response.status}`);
    const profile = parseBinaryProfile(await response.arrayBuffer());
    const node = await createWLipSyncNode(context, profile);
    node.smoothness = options.smoothness ?? 0.02;
    return new WLipSyncAnalyzer(node);
  };
}

async function loadSplitBuild(context: AudioContext, assets: { processorUrl: string; wasmUrl: string }) {
  const [lib, wasmModule] = await Promise.all([
    import('wlipsync/wlipsync.js'),
    WebAssembly.compileStreaming(fetch(assets.wasmUrl)),
    context.audioWorklet.addModule(assets.processorUrl),
  ]);
  lib.configuration.wasmModule = wasmModule;
  return lib;
}

interface WLipSyncNode extends AudioNode {
  readonly weights: Readonly<Record<string, number>>;
}

export class WLipSyncAnalyzer implements VisemeAnalyzer {
  readonly name = 'wlipsync' as const;
  private failed = false;
  private readonly onError = () => {
    this.failed = true;
    console.warn('[wLipSync] worklet processor failed; falling back to amplitude lip sync');
  };

  constructor(private readonly node: WLipSyncNode) {
    node.addEventListener('processorerror', this.onError);
  }

  get input(): AudioNode {
    return this.node;
  }

  get healthy(): boolean {
    return !this.failed;
  }

  read(out: MouthShape): void {
    mapWeights(this.node.weights, out);
  }

  dispose(): void {
    this.node.removeEventListener('processorerror', this.onError);
    this.node.disconnect();
  }
}

/** Weighted sum of the phoneme rows, normalised so the total stays ≤ 1 (smooth-damp can overshoot). */
export function mapWeights(weights: Readonly<Record<string, number>>, out: MouthShape): void {
  let aa = 0, ih = 0, ou = 0, ee = 0, oh = 0, total = 0;
  for (const key in weights) {
    const w = weights[key]!;
    const row = ULIPSYNC_TO_VRM[key];
    if (!row || !(w > 0)) continue;
    total += w;
    aa += w * (row.aa ?? 0);
    ih += w * (row.ih ?? 0);
    ou += w * (row.ou ?? 0);
    ee += w * (row.ee ?? 0);
    oh += w * (row.oh ?? 0);
  }
  const k = total > 1 ? 1 / total : 1;
  out.aa = aa * k;
  out.ih = ih * k;
  out.ou = ou * k;
  out.ee = ee * k;
  out.oh = oh * k;
}
