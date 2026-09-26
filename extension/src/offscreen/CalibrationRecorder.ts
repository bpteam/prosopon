import type { VoiceFeatureFrame } from '@avatar/audio/user/UserVoiceFrame';
import { buildZip, type ZipEntry } from '../calibration/zip';
import { encodeWav, toInt16 } from '../calibration/wav';
import type { CalibrationBundleInfo, CalibrationChannel } from '../shared/messages';
import { CALIBRATION_RECORDER_PROCESSOR } from './CalibrationRecorderWorklet';

/**
 * Calibration recording (Developer Mode wizard only), inside the offscreen document:
 *
 *   tab capture ─ AudioInput tap ─► recorder worklet (0 outputs) ─┐
 *   microphone ─ UserVoicePipeline tap ─► recorder worklet ───────┼─► clips in memory ─► WAV ─► ZIP ─► blob URL
 *   feature frames (both channels, numbers) ──────────────────────┘                       text files from content ┘
 *
 * Exists only between calibration:begin and discard/build. Samples are kept only while a clip is open, never
 * written to any storage, never posted to another context: the only thing that leaves is the blob URL of the finished
 * ZIP, which the export page downloads. Building drops the recordings; discard drops everything.
 */

/** Longest clip kept, seconds; the rest of a clip is dropped (marked truncated). */
const MAX_CLIP_SECONDS = 120;
/** All clips together, samples (16-bit): ~300 MB. */
const MAX_TOTAL_SAMPLES = 150_000_000;

export interface RecorderTap {
  /** The channel's AudioContext, or null when that channel is not running. */
  context(): BaseAudioContext | null;
  /** Connects `node` to the channel's audio. @returns disconnect */
  connect(node: AudioNode): () => void;
}

interface Clip {
  id: string;
  channel: CalibrationChannel;
  sampleRate: number;
  startedAt: number;
  stoppedAt: number | null;
  chunks: Int16Array[];
  samples: number;
  truncated: boolean;
}

interface Attached {
  ctx: BaseAudioContext;
  node: AudioWorkletNode;
  disconnect: () => void;
}

export interface ClipInfo {
  clipId: string;
  channel: CalibrationChannel;
  sampleRate: number;
  startedAt: number;
  seconds: number;
  truncated: boolean;
}

export class CalibrationRecorder {
  private readonly clips = new Map<string, Clip>();
  private readonly open: Record<CalibrationChannel, Clip | null> = { assistant: null, user: null };
  private readonly attached: Record<CalibrationChannel, Attached | null> = { assistant: null, user: null };
  private readonly files = new Map<string, string[]>();
  private readonly features: string[] = [];
  private totalSamples = 0;
  private bundle: (CalibrationBundleInfo & { blob: Blob }) | null = null;
  private disposed = false;

  constructor(
    private readonly taps: Record<CalibrationChannel, RecorderTap>,
    private readonly workletUrl: string,
    private readonly now: () => number = () => performance.timeOrigin + performance.now(),
    private readonly createObjectURL: (blob: Blob) => string = (b) => URL.createObjectURL(b),
    private readonly revokeObjectURL: (url: string) => void = (u) => URL.revokeObjectURL(u),
  ) {}

  get built(): CalibrationBundleInfo | null {
    return this.bundle ? { name: this.bundle.name, url: this.bundle.url, bytes: this.bundle.bytes } : null;
  }

  sampleRate(channel: CalibrationChannel): number | null {
    return this.taps[channel].context()?.sampleRate ?? null;
  }

  async startClip(clipId: string, channel: CalibrationChannel): Promise<ClipInfo> {
    this.assertAlive();
    const ctx = await this.ensureAttached(channel);
    if (this.open[channel]) this.stopClip(this.open[channel]!.id);
    const clip: Clip = {
      id: clipId,
      channel,
      sampleRate: ctx.sampleRate,
      startedAt: this.now(),
      stoppedAt: null,
      chunks: [],
      samples: 0,
      truncated: false,
    };
    this.clips.set(clipId, clip);
    this.open[channel] = clip;
    return info(clip);
  }

  stopClip(clipId: string): ClipInfo | null {
    const clip = this.clips.get(clipId);
    if (!clip) return null;
    if (clip.stoppedAt === null) clip.stoppedAt = this.now();
    if (this.open[clip.channel] === clip) this.open[clip.channel] = null;
    return info(clip);
  }

  /** Feature frames of either channel while one of its clips is open (numbers only). */
  pushFeatures(channel: CalibrationChannel, frame: Readonly<VoiceFeatureFrame>): void {
    const clip = this.open[channel];
    if (!clip || this.disposed) return;
    this.features.push(JSON.stringify({ t: Math.round(this.now()), channel, clip: clip.id, ...frame }));
  }

  addFile(name: string, text: string, append: boolean): void {
    this.assertAlive();
    const parts = append ? (this.files.get(name) ?? []) : [];
    parts.push(text);
    this.files.set(name, parts);
  }

  /** Packs everything into the ZIP, drops the recordings, keeps only the bundle (until discard). */
  async build(fileName: string): Promise<CalibrationBundleInfo> {
    this.assertAlive();
    for (const channel of ['assistant', 'user'] as const) if (this.open[channel]) this.stopClip(this.open[channel]!.id);
    this.detachAll();
    const encoder = new TextEncoder();
    const entries: ZipEntry[] = [];
    const root = 'calibration/';
    for (const [name, parts] of this.files) entries.push({ path: root + name, data: encoder.encode(parts.join('')), compress: true });
    entries.push({ path: `${root}features.jsonl`, data: encoder.encode(this.features.join('\n') + (this.features.length ? '\n' : '')), compress: true });
    const index = [...this.clips.values()].map(info);
    entries.push({ path: `${root}audio/index.json`, data: encoder.encode(JSON.stringify(index, null, 2)), compress: true });
    for (const clip of this.clips.values()) {
      entries.push({ path: `${root}audio/${clip.id}.wav`, data: encodeWav(clip.chunks, clip.sampleRate) });
    }
    const blob = await buildZip(entries);
    this.dropRecordings();
    this.revoke();
    this.bundle = { name: fileName, url: this.createObjectURL(blob), bytes: blob.size, blob };
    return this.built!;
  }

  /** Recordings, files and any built bundle are gone; the recorder can't be used again. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.detachAll();
    this.dropRecordings();
    this.revoke();
  }

  private revoke(): void {
    if (this.bundle) this.revokeObjectURL(this.bundle.url);
    this.bundle = null;
  }

  private dropRecordings(): void {
    this.clips.clear();
    this.open.assistant = this.open.user = null;
    this.files.clear();
    this.features.length = 0;
    this.totalSamples = 0;
  }

  private assertAlive(): void {
    if (this.disposed) throw new Error('calibration session ended');
  }

  /** The recorder worklet on the channel's current context (the mic's context changes when it restarts). */
  private async ensureAttached(channel: CalibrationChannel): Promise<BaseAudioContext> {
    const tap = this.taps[channel];
    const ctx = tap.context();
    if (!ctx) throw new Error(channel === 'user' ? 'microphone is not running' : 'tab audio is not captured');
    const current = this.attached[channel];
    if (current?.ctx === ctx) return ctx;
    this.detach(channel);
    await ctx.audioWorklet.addModule(this.workletUrl);
    const node = new AudioWorkletNode(ctx, CALIBRATION_RECORDER_PROCESSOR, {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
      channelCountMode: 'explicit',
    });
    node.port.onmessage = (event: MessageEvent<{ type: string; samples: Float32Array; sampleRate: number }>) => {
      if (event.data?.type === 'chunk') this.onChunk(channel, event.data.samples);
    };
    this.attached[channel] = { ctx, node, disconnect: tap.connect(node) };
    return ctx;
  }

  private onChunk(channel: CalibrationChannel, samples: Float32Array): void {
    const clip = this.open[channel];
    if (!clip || this.disposed) return;
    if (clip.samples >= clip.sampleRate * MAX_CLIP_SECONDS || this.totalSamples >= MAX_TOTAL_SAMPLES) {
      clip.truncated = true;
      return;
    }
    const pcm = toInt16(samples);
    clip.chunks.push(pcm);
    clip.samples += pcm.length;
    this.totalSamples += pcm.length;
  }

  private detach(channel: CalibrationChannel): void {
    const a = this.attached[channel];
    this.attached[channel] = null;
    if (!a) return;
    a.node.port.onmessage = null;
    a.node.port.postMessage({ type: 'stop' });
    a.disconnect();
    a.node.disconnect();
  }

  private detachAll(): void {
    this.detach('assistant');
    this.detach('user');
  }
}

function info(clip: Clip): ClipInfo {
  return {
    clipId: clip.id,
    channel: clip.channel,
    sampleRate: clip.sampleRate,
    startedAt: clip.startedAt,
    seconds: clip.samples / clip.sampleRate,
    truncated: clip.truncated,
  };
}
