import type { MouthShape } from '../../avatar/MouthShape';
import { assertAudioWorklet, writeShape, type VisemeAnalyzer, type VisemeAnalyzerFactory } from '../VisemeAnalyzer';

/**
 * Oculus viseme (HeadAudio's output, by name) → VRM mouth shape.
 *
 * VRM has only the five vowels, so consonants are approximated: bilabials (PP) and silence close the mouth,
 * which is the most visible cue; the rest are small, mostly spread (ih) or rounded (ou) openings.
 */
export const OCULUS_TO_VRM: Readonly<Record<string, Readonly<Partial<MouthShape>>>> = {
  viseme_aa: { aa: 1 },
  viseme_E: { ee: 1 },
  viseme_I: { ih: 1 },
  viseme_O: { oh: 1 },
  viseme_U: { ou: 1 },
  viseme_PP: {},
  viseme_SS: { ih: 0.4 },
  viseme_TH: { aa: 0.2, ih: 0.2 },
  viseme_DD: { aa: 0.15, ih: 0.3 },
  viseme_FF: { ih: 0.25 },
  viseme_kk: { aa: 0.3, ih: 0.1 },
  viseme_nn: { aa: 0.1, ih: 0.25 },
  viseme_RR: { ou: 0.4 },
  viseme_CH: { ih: 0.3, ou: 0.3 },
  viseme_sil: {},
};

export interface HeadAudioOptions {
  workletUrl?: string;
  modelUrl?: string;
  /** VAD gate: level above which speech starts, dBFS. HeadAudio's default is -40. */
  vadGateActiveDb?: number;
  /** VAD gate: level below which speech ends, dBFS. HeadAudio's default is -50. */
  vadGateInactiveDb?: number;
  /** Mean pitch of the speaker, Hz (vocal tract normalisation). HeadAudio's default is 150. */
  speakerMeanHz?: number;
}

const BASE = `${import.meta.env.BASE_URL}lipsync/headaudio/`;

/**
 * HeadAudio (met4citizen, MIT): MFCC + Gaussian prototypes in an AudioWorklet, ~50 ms latency, 14 kB English
 * model. It reports one active viseme at a time; blending/smoothing is left to VisemeLipSync, so HeadAudio's own
 * update()/onvalue animation is not used.
 */
export function headAudioFactory(options: HeadAudioOptions = {}): VisemeAnalyzerFactory {
  return async (context) => {
    assertAudioWorklet(context);
    // Imported lazily: the module subclasses AudioWorkletNode at load time.
    const [{ HeadAudio }] = await Promise.all([
      import('../../vendor/headaudio/headaudio.min.mjs'),
      context.audioWorklet.addModule(options.workletUrl ?? `${BASE}headworklet.min.mjs`),
    ]);
    const parameterData: Record<string, number> = {};
    if (options.vadGateActiveDb !== undefined) parameterData.vadGateActiveDb = options.vadGateActiveDb;
    if (options.vadGateInactiveDb !== undefined) parameterData.vadGateInactiveDb = options.vadGateInactiveDb;
    if (options.speakerMeanHz !== undefined) parameterData.speakerMeanHz = options.speakerMeanHz;

    const node = new HeadAudio(context, { parameterData });
    try {
      await node.loadModel(options.modelUrl ?? `${BASE}model-en-mixed.bin`);
    } catch (error) {
      node.disconnect();
      throw error;
    }
    node.start();
    return new HeadAudioAnalyzer(node);
  };
}

interface HeadAudioNode extends AudioNode {
  readonly visemeActive: number;
  readonly visemeNames: readonly string[];
  stop(): void;
}

export class HeadAudioAnalyzer implements VisemeAnalyzer {
  readonly name = 'headaudio' as const;
  private failed = false;
  private readonly onError = () => {
    this.failed = true;
    console.warn('[HeadAudio] worklet processor failed; falling back to amplitude lip sync');
  };

  constructor(private readonly node: HeadAudioNode) {
    node.addEventListener('processorerror', this.onError);
  }

  get input(): AudioNode {
    return this.node;
  }

  get healthy(): boolean {
    return !this.failed;
  }

  /** Name of the viseme HeadAudio currently reports, or null for silence. */
  get active(): string | null {
    return this.node.visemeNames[this.node.visemeActive] ?? null;
  }

  read(out: MouthShape): void {
    const name = this.active;
    writeShape(out, name ? OCULUS_TO_VRM[name] : undefined);
  }

  dispose(): void {
    this.node.removeEventListener('processorerror', this.onError);
    this.node.stop();
    this.node.disconnect();
  }
}
