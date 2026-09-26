import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** Gesture and semantic-layer boundaries, checked on the sources. */

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../../src');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}

const IMPORT_RE = /(?:import|export)\s+(?:type\s)?[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Every import specifier of a file, `import type` included (the story forbids knowing about these at all). */
function imports(file: string): string[] {
  return [...readFileSync(file, 'utf8').matchAll(IMPORT_RE)].map((m) => (m[1] ?? m[2])!);
}

const rel = (f: string) => relative(SRC, f);
const all = files(SRC);

describe('GestureEngine and gesture contracts', () => {
  const gesture = all.filter((f) => rel(f).startsWith('avatar/gesture/'));

  it('exist', () => {
    expect(gesture.map(rel).sort()).toEqual([
      'avatar/gesture/Gesture.ts',
      'avatar/gesture/GestureConfig.ts',
      'avatar/gesture/GestureEngine.ts',
      'avatar/gesture/SemanticGestureConfig.ts',
      'avatar/gesture/SemanticGesturePolicy.ts',
    ]);
  });

  it('never import Avatar, AvatarController, three or three-vrm (not even as types)', () => {
    const bad = gesture.flatMap((f) =>
      imports(f)
        .filter((s) => s === 'three' || s.startsWith('three/') || s.startsWith('@pixiv/') || /\/(Avatar|AvatarController|AvatarLoader)$/.test(s))
        .map((s) => `${rel(f)} → ${s}`),
    );
    expect(bad).toEqual([]);
  });
});

describe('single writer of bones', () => {
  // Manual layer: Avatar itself, its controller's proxies and the sandbox debug panel. Everything procedural
  // (idle, reaction, emotion, gestures) goes through BehaviorMixer → Avatar.setProcedural().
  const ALLOWED = new Set(['avatar/Avatar.ts', 'avatar/AvatarController.ts', 'avatar/AvatarDebugPanel.ts']);
  const BONE_API = /getNormalizedBoneNode|getRawBoneNode|setBoneRotation|setHeadRotation|\.quaternion\b|\.rotation\.(?:x|y|z|set)\b/;

  it('no other module touches bones (UserReaction → head, EmotionMapper → hands, GestureEngine → Avatar …)', () => {
    const writers = all.filter((f) => !ALLOWED.has(rel(f)) && !rel(f).startsWith('renderer/') && BONE_API.test(readFileSync(f, 'utf8')));
    expect(writers.map(rel)).toEqual([]);
  });

  it('behaviour sources do not import Avatar', () => {
    const sources = all.filter((f) => /avatar\/(UserReaction|UserReactionMapper|EmotionChannels|EmotionExpression|BehaviorMixer|BodyPose)\.ts$/.test(f));
    expect(sources.length).toBe(6);
    const bad = sources
      .filter((f) => !f.endsWith('BehaviorMixer.ts'))
      .flatMap((f) => imports(f).filter((s) => /\/Avatar(Controller)?$/.test(s)).map((s) => `${rel(f)} → ${s}`));
    expect(bad).toEqual([]);
    // BehaviorMixer uses Avatar's pose type and constants (ProceduralPose); it never holds an Avatar.
    expect(readFileSync(join(SRC, 'avatar/BehaviorMixer.ts'), 'utf8')).not.toMatch(/new Avatar|: Avatar\b/);
  });

  it('there is one nod implementation (GestureEngine)', () => {
    const nodders = all.filter((f) => /nodDuration|nodTime|REACTION_LIMITS\.nod\b|\.nod\s*=/.test(readFileSync(f, 'utf8')));
    expect(nodders.map(rel)).toEqual([]);
    expect(readFileSync(join(SRC, 'avatar/UserReactionMapper.ts'), 'utf8')).not.toMatch(/this\.nod|nodCount|nods\b/);
  });
});

describe('semantic layer (text → cues) is renderer- and audio-free', () => {
  const semantic = all.filter((f) => rel(f).startsWith('semantic/'));

  it('exists', () => {
    expect(semantic.map(rel)).toEqual(expect.arrayContaining(['semantic/SemanticAnalyzer.ts', 'semantic/SemanticCue.ts', 'semantic/SemanticMatcher.ts', 'semantic/SemanticPacer.ts']));
  });

  it('imports only itself: no avatar, renderer, audio, debug, three or VRM (not even as types)', () => {
    const bad = semantic.flatMap((f) =>
      imports(f)
        .filter((s) => !s.startsWith('./') && !s.startsWith('../') ? true : /\/(avatar|renderer|audio|debug)\//.test(s) || /^\.\.\/(avatar|renderer|audio|debug)\b/.test(s) || /^\.\.\/\.\./.test(s))
        .map((s) => `${rel(f)} → ${s}`),
    );
    expect(bad).toEqual([]);
  });

  it('touches no DOM, audio API, bones, expressions or procedural pose', () => {
    const API = /\b(?:document|window|navigator|MutationObserver|HTMLElement|AudioContext|AnalyserNode|MediaStream|requestAnimationFrame|setTimeout|setInterval)\b|setProcedural|setExpression|getNormalizedBoneNode|expressionManager|fetch\(/;
    const bad = semantic.filter((f) => API.test(readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')));
    expect(bad.map(rel)).toEqual([]);
  });

  it('the gesture side reads cues only through SemanticCue (no vocabulary, matcher or analyzer)', () => {
    const bad = gestureSemanticImports();
    expect(bad).toEqual([]);
  });
});

function gestureSemanticImports(): string[] {
  return all
    .filter((f) => rel(f).startsWith('avatar/'))
    .flatMap((f) => imports(f).filter((s) => /semantic\/(?!SemanticCue$)/.test(s)).map((s) => `${rel(f)} → ${s}`));
}
