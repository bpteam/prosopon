import { CLOSED_MOUTH, VISEMES, type MouthShape, type MouthSource } from '../avatar/MouthShape';
import { follow } from './AmplitudeLipSync';
import { SILENT_FRAME, type LipSyncFrame } from './LipSyncFrame';

export interface FrameMouthSourceConfig {
  /**
   * Time constant of the interpolation towards the last frame, seconds. Frames arrive at 20–30 Hz and are
   * already smoothed, so this only hides the steps; keep it below the frame interval.
   */
  smoothing: number;
  /** A frame older than this is treated as silence (sender stalled or gone), seconds. */
  staleAfter: number;
}

export const DEFAULT_FRAME_MOUTH_CONFIG: Readonly<FrameMouthSourceConfig> = Object.freeze({
  smoothing: 0.025,
  staleAfter: 0.25,
});

/**
 * MouthSource fed by LipSyncFrames pushed from elsewhere; renders them at the render loop's rate by following the
 * last frame. Knows nothing about where frames come from (it is not tied to a transport).
 */
export class FrameMouthSource implements MouthSource {
  readonly config: FrameMouthSourceConfig;
  private readonly target: MouthShape = { ...CLOSED_MOUTH };
  private readonly out: MouthShape = { ...CLOSED_MOUTH };
  private last: LipSyncFrame = SILENT_FRAME;
  /** Seconds since the last push, advanced by update(). */
  private age = Infinity;

  constructor(config: Partial<FrameMouthSourceConfig> = {}) {
    this.config = { ...DEFAULT_FRAME_MOUTH_CONFIG, ...config };
  }

  /** The last frame received, or silence once it is stale. */
  get frame(): Readonly<LipSyncFrame> {
    return this.age > this.config.staleAfter ? SILENT_FRAME : this.last;
  }

  get value(): Readonly<MouthShape> {
    return this.out;
  }

  push(frame: LipSyncFrame): void {
    this.last = frame;
    this.age = 0;
  }

  update(delta: number): Readonly<MouthShape> {
    if (delta > 0) this.age += delta;
    const shape = this.frame.visemes;
    const tau = this.config.smoothing;
    for (const v of VISEMES) {
      this.target[v] = shape[v];
      this.out[v] = follow(this.out[v], this.target[v], delta, tau, tau);
    }
    return this.out;
  }

  reset(): void {
    this.last = SILENT_FRAME;
    this.age = Infinity;
    Object.assign(this.target, CLOSED_MOUTH);
    Object.assign(this.out, CLOSED_MOUTH);
  }
}
