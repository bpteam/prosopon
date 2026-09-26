import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** One stretch of the fake microphone's recording. */
export interface MicSegment {
  kind: 'silence' | 'speech';
  seconds: number;
  /** Speech F0, Hz. */
  hz?: number;
}

/**
 * Writes a 16-bit mono 48 kHz WAV for Chromium's --use-file-for-fake-audio-capture: low room noise, and "speech"
 * segments of a voiced buzz with a gliding F0 and a syllable-rate envelope (never fully silent inside a segment).
 * Chromium plays it from the start each time a capture opens.
 */
export function writeFakeMicWav(segments: MicSegment[], sampleRate = 48000): string {
  const total = Math.round(segments.reduce((a, s) => a + s.seconds, 0) * sampleRate);
  const pcm = new Int16Array(total);
  let seed = 12345;
  const noise = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32 - 0.5;
  };
  let i = 0;
  let phase = 0;
  let lp = 0;
  for (const seg of segments) {
    const n = Math.round(seg.seconds * sampleRate);
    for (let k = 0; k < n; k++, i++) {
      const t = k / sampleRate;
      let v = noise() * 0.003;
      if (seg.kind === 'speech') {
        const f0 = (seg.hz ?? 150) * (1 + 0.08 * Math.sin(2 * Math.PI * 0.7 * t));
        phase = (phase + f0 / sampleRate) % 1;
        // Glottal-ish pulse train through a one-pole lowpass: harmonics like a voice, not a pure tone.
        lp += ((phase < 0.4 ? Math.sin((Math.PI * phase) / 0.4) : 0) - lp) * 0.25;
        const env = 0.6 + 0.4 * Math.sin(2 * Math.PI * 4.5 * t);
        v += (lp - 0.25) * 0.6 * env;
      }
      pcm[i] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
    }
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.byteLength, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.byteLength, 40);
  const path = join(mkdtempSync(join(tmpdir(), 'prosopon-mic-')), 'mic.wav');
  writeFileSync(path, Buffer.concat([header, Buffer.from(pcm.buffer)]));
  return path;
}
