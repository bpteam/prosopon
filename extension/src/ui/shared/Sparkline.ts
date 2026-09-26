import type { RingBuffer } from './RingBuffer';

export interface SparklineOptions {
  /** Fixed value range; otherwise the buffer's own range (with a minimum span). */
  min?: number;
  max?: number;
  /** Smallest auto range, so noise on a flat signal doesn't fill the chart. */
  minSpan?: number;
  color?: string;
  height?: number;
}

/**
 * Canvas-2D line chart of a RingBuffer, drawn only when asked (the owner calls draw() at ≤ 15 Hz). No chart
 * library, no per-point DOM. NaN samples are gaps (e.g. pitch while unvoiced).
 */
export class Sparkline {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;

  constructor(doc: Document, private readonly buffer: RingBuffer, private readonly options: SparklineOptions = {}) {
    this.canvas = doc.createElement('canvas');
    this.canvas.className = 'spark';
    this.canvas.height = options.height ?? 32;
    this.canvas.style.height = `${options.height ?? 32}px`;
    this.ctx = this.canvas.getContext('2d');
  }

  draw(): void {
    const ctx = this.ctx;
    const c = this.canvas;
    if (!ctx) return;
    // Match the drawing buffer to the laid-out width (0 while hidden: skip).
    const width = Math.round(c.clientWidth * (globalThis.devicePixelRatio || 1));
    if (width <= 0) return;
    const height = Math.round((this.options.height ?? 32) * (globalThis.devicePixelRatio || 1));
    if (c.width !== width) c.width = width;
    if (c.height !== height) c.height = height;
    ctx.clearRect(0, 0, width, height);
    const n = this.buffer.length;
    if (n < 2) return;
    let { min, max } = this.options;
    if (min === undefined || max === undefined) {
      const r = this.buffer.range();
      if (!r) return;
      const span = Math.max(this.options.minSpan ?? 0.1, r.max - r.min);
      const mid = (r.max + r.min) / 2;
      min ??= mid - span / 2;
      max ??= mid + span / 2;
    }
    const cap = this.buffer.capacity;
    const x = (i: number) => ((cap - n + i) / (cap - 1)) * (width - 1);
    const y = (v: number) => height - 2 - ((v - min!) / (max! - min! || 1)) * (height - 4);
    ctx.lineWidth = Math.max(1, (globalThis.devicePixelRatio || 1) * 1.25);
    ctx.strokeStyle = this.options.color ?? '#2684ff';
    ctx.beginPath();
    let drawing = false;
    for (let i = 0; i < n; i++) {
      const v = this.buffer.at(i);
      if (!Number.isFinite(v)) {
        drawing = false;
        continue;
      }
      const py = Math.min(height - 1, Math.max(1, y(v)));
      if (drawing) ctx.lineTo(x(i), py);
      else ctx.moveTo(x(i), py);
      drawing = true;
    }
    ctx.stroke();
  }
}
