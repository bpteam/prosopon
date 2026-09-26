/**
 * Synthetic "voices" for prosody tests: a glottal-like sawtooth through a one-pole low-pass (brightness), a syllable
 * envelope (rate) with pauses between phrases, and an F0 contour with a controllable swing (intonation). Not speech,
 * but it moves the same cues the analyser reads, so rules can be checked deterministically.
 */
export interface VoiceStyle {
  seconds: number;
  /** Mean F0, Hz. */
  f0: number;
  /** F0 swing, ± semitones, following a slow contour. */
  swing: number;
  /** Peak amplitude (linear). */
  amp: number;
  /** Syllables per second. */
  rate: number;
  /** Low-pass coefficient per sample at 48 kHz, (0, 1]: higher = brighter. */
  brightness: number;
  /** Pause after every this many syllables, seconds (0 = none). */
  pause?: number;
}

export const CALM: VoiceStyle = { seconds: 6, f0: 140, swing: 0.5, amp: 0.06, rate: 3, brightness: 0.12, pause: 0.35 };
export const EXCITED: VoiceStyle = { seconds: 6, f0: 190, swing: 5, amp: 0.35, rate: 6.5, brightness: 0.8, pause: 0 };
export const NORMAL: VoiceStyle = { seconds: 6, f0: 160, swing: 2, amp: 0.15, rate: 4.5, brightness: 0.3, pause: 0.25 };

export function rng(seed = 1): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32 - 0.5;
  };
}

export function voice(style: VoiceStyle, sr = 48000, seed = 3): Float32Array {
  const n = Math.round(style.seconds * sr);
  const out = new Float32Array(n);
  const noise = rng(seed);
  let phase = 0;
  let lp = 0;
  const syll = 1 / style.rate;
  const phraseLen = 5 * syll + (style.pause ?? 0);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const inPhrase = t % phraseLen;
    const speaking = inPhrase < 5 * syll;
    // Syllable envelope: never quite zero inside a phrase (like connected speech), silent in pauses.
    const env = speaking ? 0.3 + 0.7 * Math.sin((Math.PI * (inPhrase % syll)) / syll) ** 2 : 0;
    const contour = Math.sin(2 * Math.PI * 0.7 * t) * 0.6 + Math.sin(2 * Math.PI * 1.9 * t) * 0.4;
    const hz = style.f0 * 2 ** ((style.swing * contour) / 12);
    phase = (phase + hz / sr) % 1;
    lp += (2 * phase - 1 - lp) * style.brightness;
    out[i] = noise() * 0.002 + lp * style.amp * env;
  }
  return out;
}

export function silence(seconds: number, sr = 48000, seed = 5): Float32Array {
  const out = new Float32Array(Math.round(seconds * sr));
  const noise = rng(seed);
  for (let i = 0; i < out.length; i++) out[i] = noise() * 0.002;
  return out;
}

export function concat(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
