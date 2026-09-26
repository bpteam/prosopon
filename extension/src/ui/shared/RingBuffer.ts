/**
 * Fixed-capacity numeric history for diagnostics charts. Allocated once; push() overwrites the oldest sample, so
 * memory never grows however long the session runs.
 */
export class RingBuffer {
  private readonly data: Float32Array;
  private start = 0;
  private count = 0;

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) throw new Error('RingBuffer capacity must be a positive integer');
    this.data = new Float32Array(capacity);
  }

  get length(): number {
    return this.count;
  }

  push(value: number): void {
    const v = Number.isFinite(value) ? value : Number.NaN;
    if (this.count < this.capacity) {
      this.data[(this.start + this.count) % this.capacity] = v;
      this.count++;
    } else {
      this.data[this.start] = v;
      this.start = (this.start + 1) % this.capacity;
    }
  }

  /** i-th sample, oldest first. */
  at(i: number): number {
    return this.data[(this.start + i) % this.capacity]!;
  }

  get last(): number {
    return this.count ? this.at(this.count - 1) : Number.NaN;
  }

  /** Min and max of the finite samples (null when there are none). */
  range(): { min: number; max: number } | null {
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < this.count; i++) {
      const v = this.at(i);
      if (!Number.isFinite(v)) continue;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    return min <= max ? { min, max } : null;
  }

  clear(): void {
    this.start = 0;
    this.count = 0;
  }
}
