import { CLOSED_MOUTH, VISEMES, type MouthShape } from '../avatar/MouthShape';
import type { VisemeLipSync } from './VisemeLipSync';

// Contract only (plus its sampler): imported by every extension context, so it must stay dependency-free.

/**
 * Compact lip-sync state, the only thing that crosses from an audio runtime to an avatar runtime when they live in
 * different contexts (extension offscreen document → content script, worker → page). No PCM, no nodes.
 */
export interface LipSyncFrame {
  /** The signal is above the noise floor. */
  active: boolean;
  /** Unsmoothed loudness mapped to [0, maxOpen]. */
  volume: number;
  /** Final mouth shape, [0, 1] per VRM viseme preset (amplitude mode puts everything on "aa"). */
  visemes: MouthShape;
}

export const SILENT_FRAME: Readonly<LipSyncFrame> = Object.freeze({
  active: false,
  volume: 0,
  visemes: CLOSED_MOUTH,
});

/** Advances `lipSync` by `delta` and captures its output as a frame (a fresh object: it gets serialised). */
export function sampleLipSyncFrame(lipSync: VisemeLipSync, delta: number): LipSyncFrame {
  const shape = lipSync.update(delta);
  const volume = lipSync.amplitude.targetValue;
  return {
    active: volume > 0,
    volume,
    visemes: { aa: shape.aa, ih: shape.ih, ou: shape.ou, ee: shape.ee, oh: shape.oh },
  };
}

/** Structural check for frames received from another context. Clamps nothing: rejects anything off-contract. */
export function isLipSyncFrame(value: unknown): value is LipSyncFrame {
  if (!value || typeof value !== 'object') return false;
  const f = value as Record<string, unknown>;
  if (typeof f.active !== 'boolean' || !isUnit(f.volume)) return false;
  const v = f.visemes as Record<string, unknown> | null | undefined;
  if (!v || typeof v !== 'object') return false;
  return VISEMES.every((name) => isUnit(v[name]));
}

function isUnit(v: unknown): v is number {
  return typeof v === 'number' && v >= 0 && v <= 1;
}
