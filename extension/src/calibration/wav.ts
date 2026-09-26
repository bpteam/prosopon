/** 16-bit PCM mono WAV from Int16 chunks (calibration audio). */
export function encodeWav(chunks: readonly Int16Array[], sampleRate: number): Uint8Array {
  const samples = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(44 + samples * 2);
  const v = new DataView(out.buffer);
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i);
  };
  ascii(0, 'RIFF');
  v.setUint32(4, 36 + samples * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  ascii(36, 'data');
  v.setUint32(40, samples * 2, true);
  let at = 44;
  for (const c of chunks) {
    for (let i = 0; i < c.length; i++, at += 2) v.setInt16(at, c[i]!, true);
  }
  return out;
}

/** Float samples [−1, 1] → 16-bit PCM (clipped). */
export function toInt16(samples: ArrayLike<number>): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] || 0));
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
  }
  return out;
}
