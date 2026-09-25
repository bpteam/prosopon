export type FrameCallback = (delta: number, now: number) => void;

/**
 * The single requestAnimationFrame loop of the app.
 * Delta is in seconds, clamped to `maxDelta` (tab switches produce huge gaps).
 */
export class RenderLoop {
  private handle: number | null = null;
  private last = 0;
  private readonly callback: FrameCallback;
  private readonly maxDelta: number;

  constructor(callback: FrameCallback, maxDelta = 0.1) {
    this.callback = callback;
    this.maxDelta = maxDelta;
  }

  get running(): boolean {
    return this.handle !== null;
  }

  start(): void {
    if (this.handle !== null) return;
    this.last = performance.now();
    this.handle = requestAnimationFrame(this.tick);
  }

  stop(): void {
    if (this.handle !== null) cancelAnimationFrame(this.handle);
    this.handle = null;
  }

  private readonly tick = (now: number): void => {
    this.handle = requestAnimationFrame(this.tick);
    const delta = Math.min(Math.max((now - this.last) / 1000, 0), this.maxDelta);
    this.last = now;
    this.callback(delta, now);
  };
}
