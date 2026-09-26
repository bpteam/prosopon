import { RingBuffer } from '../shared/RingBuffer';
import type { DevSample } from './DevBridge';

/** Diagnostics sampling rate while Developer Mode is on (Hz), and how far back the charts reach. */
export const SAMPLE_HZ = 10;
export const HISTORY_SECONDS = 30;
/** Fixed size of every series: 300 samples at 10 Hz. Never grows. */
export const HISTORY_CAPACITY = SAMPLE_HZ * HISTORY_SECONDS;

export const SERIES = [
  'assistant.valence',
  'assistant.arousal',
  'assistant.energy',
  'assistant.tension',
  'assistant.confidence',
  'user.valence',
  'user.arousal',
  'user.energy',
  'user.tension',
  'user.confidence',
  'user.rmsDb',
  'user.pitchHz',
  'user.pitchConfidence',
  'user.noiseFloorDb',
  'assistant.volume',
  'assistant.rmsDb',
  'render.fps',
  'render.frameMs',
] as const;
export type SeriesKey = (typeof SERIES)[number];

/**
 * Ring buffers for the charts, allocated once when Developer Mode turns on and dropped with it. push() is the only
 * writer; charts only read.
 */
export class DevHistory {
  private readonly buffers = new Map<SeriesKey, RingBuffer>();

  constructor(readonly capacity = HISTORY_CAPACITY) {
    for (const key of SERIES) this.buffers.set(key, new RingBuffer(capacity));
  }

  get(key: SeriesKey): RingBuffer {
    return this.buffers.get(key)!;
  }

  /** Total samples held across all series (bounded by capacity × series). */
  get size(): number {
    let n = 0;
    for (const b of this.buffers.values()) n += b.length;
    return n;
  }

  push(s: DevSample): void {
    for (const ch of ['assistant', 'user'] as const) {
      const e = s.emotion[ch];
      this.get(`${ch}.valence`).push(e.valence);
      this.get(`${ch}.arousal`).push(e.arousal);
      this.get(`${ch}.energy`).push(e.energy);
      this.get(`${ch}.tension`).push(e.tension);
      this.get(`${ch}.confidence`).push(e.confidence);
    }
    const u = s.userVoice;
    const micOn = s.mic.state === 'on';
    this.get('user.rmsDb').push(micOn ? u.rmsDb : Number.NaN);
    this.get('user.pitchHz').push(micOn && u.pitchHz !== null ? u.pitchHz : Number.NaN);
    this.get('user.pitchConfidence').push(micOn ? u.pitchConfidence : Number.NaN);
    this.get('user.noiseFloorDb').push(micOn ? u.noiseFloorDb : Number.NaN);
    this.get('assistant.volume').push(s.lipSync.volume);
    this.get('assistant.rmsDb').push(s.telemetry?.assistantRmsDb ?? Number.NaN);
    this.get('render.fps').push(s.render.fps);
    this.get('render.frameMs').push(s.render.frameMs);
  }
}
