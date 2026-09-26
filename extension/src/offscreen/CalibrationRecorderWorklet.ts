/**
 * AudioWorklet module of the calibration recorder (Developer Mode wizard): copies its mono input to the offscreen
 * document in chunks of ~0.25 s. 0 outputs, so it can never reach the speakers. It exists only while a calibration
 * session runs; normal operation never loads it.
 *
 * Built as a standalone module (no imports at runtime) and loaded with audioWorklet.addModule().
 */

declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: new (options: { processorOptions?: unknown }) => unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

export const CALIBRATION_RECORDER_PROCESSOR = 'prosopon-calibration-recorder';

if (typeof registerProcessor === 'function') {
  class CalibrationRecorderProcessor extends AudioWorkletProcessor {
    private readonly size = Math.round(sampleRate / 4);
    private buffer = new Float32Array(this.size);
    private filled = 0;
    private alive = true;

    constructor() {
      super();
      this.port.onmessage = (event: MessageEvent) => {
        if ((event.data as { type?: string } | null)?.type === 'stop') this.alive = false;
      };
    }

    process(inputs: Float32Array[][]): boolean {
      const channel = inputs[0]?.[0];
      if (channel) {
        for (let i = 0; i < channel.length; i++) {
          this.buffer[this.filled++] = channel[i]!;
          if (this.filled === this.size) {
            // Transferred, not copied: the buffer is detached afterwards (length 0), hence a new one of `size`.
            this.port.postMessage({ type: 'chunk', samples: this.buffer, sampleRate }, [this.buffer.buffer]);
            this.buffer = new Float32Array(this.size);
            this.filled = 0;
          }
        }
      }
      return this.alive;
    }
  }
  registerProcessor(CALIBRATION_RECORDER_PROCESSOR, CalibrationRecorderProcessor);
}
