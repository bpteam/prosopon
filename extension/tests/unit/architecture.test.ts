import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Hard boundaries of US-004, checked on the source import graph that ends up in each bundle (`import type` is
 * erased and skipped; `import { x, type Y }` counts).
 */

const EXT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const AVATAR_SRC = resolve(EXT, '../avatar/src');

function resolveImport(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('@avatar/')) base = join(AVATAR_SRC, spec.slice('@avatar/'.length));
  else if (spec.startsWith('.')) base = resolve(dirname(from), spec);
  else return null; // package
  for (const candidate of [base, `${base}.ts`, join(base, 'index.ts')]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // try next
    }
  }
  return null;
}

const IMPORT_RE = /(?:import|export)\s+(type\s)?[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Every module and package reachable from `entry`. */
function graph(entry: string): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    if (!file.endsWith('.ts')) continue;
    for (const m of readFileSync(file, 'utf8').matchAll(IMPORT_RE)) {
      if (m[1]) continue; // import type / export type
      const spec = (m[2] ?? m[3])!;
      const target = resolveImport(file, spec);
      if (target) queue.push(target);
      else if (!spec.startsWith('.')) packages.add(spec);
    }
  }
  return { files, packages };
}

const rel = (files: Set<string>) => [...files].map((f) => relative(resolve(EXT, '..'), f));

describe('audio runtime (offscreen)', () => {
  const { files, packages } = graph(resolve(EXT, 'src/offscreen/audio-runtime.ts'));

  it('does not import three, three-vrm, Avatar or AvatarController', () => {
    expect([...packages].filter((p) => p === 'three' || p.startsWith('three/') || p.startsWith('@pixiv/'))).toEqual([]);
    expect(rel(files).filter((f) => /avatar\/src\/(avatar\/(Avatar|AvatarController|AvatarLoader)|renderer\/)/.test(f))).toEqual([]);
  });

  it('reuses the existing lip-sync pipeline instead of its own', () => {
    const names = rel(files);
    for (const core of ['AudioInput.ts', 'AmplitudeLipSync.ts', 'VisemeLipSync.ts', 'HeadAudioAnalyzer.ts', 'WLipSyncAnalyzer.ts']) {
      expect(names.some((f) => f.endsWith(`avatar/src/audio/${core}`) || f.endsWith(`analyzers/${core}`)), core).toBe(true);
    }
  });
});

describe('service worker', () => {
  it('does no rendering or audio analysis', () => {
    const { files, packages } = graph(resolve(EXT, 'src/background/service-worker.ts'));
    expect([...packages].filter((p) => p.includes('three') || p.includes('wlipsync'))).toEqual([]);
    // The mouth/frame contracts (MouthShape, LipSyncFrame) are fine; the renderer and the audio engine are not.
    expect(rel(files).filter((f) => /\/renderer\/|\/avatar\/(?!MouthShape)|AudioInput|LipSync\.ts|analyzers/.test(f))).toEqual([]);
  });
});

describe('content script loader', () => {
  it('stays thin: three.js and the avatar are only reached through the runtime-loaded chunk', () => {
    const { files, packages } = graph(resolve(EXT, 'src/content/content.ts'));
    expect([...packages].filter((p) => p.includes('three'))).toEqual([]);
    expect(rel(files).filter((f) => f.includes('avatar-runtime') || f.includes('/renderer/'))).toEqual([]);
  });
});

describe('content runtime', () => {
  const source = (p: string) => readFileSync(resolve(EXT, p), 'utf8');

  it('never receives audio objects: no AudioContext, AudioNode, MediaStream or PCM in content code', () => {
    for (const file of readdirSync(resolve(EXT, 'src/content'))) {
      const code = source(`src/content/${file}`);
      expect(code, file).not.toMatch(/\b(AudioContext|AudioNode|MediaStream|Float32Array|getUserMedia)\b/);
    }
  });

  it('keeps every ChatGPT selector in ChatGPTAdapter', () => {
    const selectorLike = /querySelector|data-testid|getElementsBy|closest\(/;
    const dirs = ['src/content', 'src/offscreen', 'src/background', 'src/shared'];
    for (const dir of dirs) {
      for (const file of readdirSync(resolve(EXT, dir))) {
        if (file === 'ChatGPTAdapter.ts' || !file.endsWith('.ts')) continue;
        expect(source(`${dir}/${file}`), `${dir}/${file}`).not.toMatch(selectorLike);
      }
    }
  });

  it('does not copy Avatar Core: no Extension* clones of core classes', () => {
    for (const dir of ['src/content', 'src/offscreen', 'src/background', 'src/shared']) {
      for (const file of readdirSync(resolve(EXT, dir))) {
        expect(source(`${dir}/${file}`), file).not.toMatch(/class\s+Extension(Avatar|BehaviorMixer|LipSync|Controller)/);
      }
    }
  });
});

describe('lip-sync engine', () => {
  it('never sets conversation state itself', () => {
    const dir = resolve(AVATAR_SRC, 'audio');
    const files = readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith('.ts'));
    for (const f of files) expect(readFileSync(join(dir, f), 'utf8'), f).not.toMatch(/setState\(/);
  });
});
