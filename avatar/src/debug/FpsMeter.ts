/**
 * Averages frame statistics over a fixed window of time.
 */
export class FpsMeter {
  fps = 0;
  /** Average frame time in ms over the last window. */
  frameTime = 0;

  private frames = 0;
  private elapsed = 0;
  private readonly window: number;

  constructor(windowSeconds = 0.5) {
    this.window = windowSeconds;
  }

  /** @returns true when a new sample has been published */
  tick(delta: number): boolean {
    this.frames++;
    this.elapsed += delta;
    if (this.elapsed < this.window) return false;
    this.fps = this.frames / this.elapsed;
    this.frameTime = (this.elapsed / this.frames) * 1000;
    this.frames = 0;
    this.elapsed = 0;
    return true;
  }
}
