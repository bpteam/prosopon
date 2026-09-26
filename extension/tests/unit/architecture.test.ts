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

// --- US-005: user voice ---------------------------------------------------------------------------------------

const avatarFile = (p: string) => resolve(AVATAR_SRC, p);
const FORBIDDEN_AVATAR = /avatar\/src\/(avatar\/(Avatar|AvatarController|BehaviorMixer|AvatarLoader)\.ts|renderer\/)/;
const isThree = (p: string) => p === 'three' || p.startsWith('three/') || p.startsWith('@pixiv/');

describe('user voice analyser', () => {
  for (const entry of ['audio/user/UserVoiceAnalyzer.ts', 'audio/user/UserVoiceWorklet.ts']) {
    it(`${entry} does not import Avatar, AvatarController, BehaviorMixer, three or three-vrm`, () => {
      const { files, packages } = graph(avatarFile(entry));
      expect([...packages].filter(isThree)).toEqual([]);
      expect(rel(files).filter((f) => FORBIDDEN_AVATAR.test(f))).toEqual([]);
    });
  }

  it('stays separate from the assistant pipeline: the mic pipeline shares no audio code with lip sync', () => {
    const { files } = graph(resolve(EXT, 'src/offscreen/UserVoicePipeline.ts'));
    // LipSyncFrame (the transport contract, via messages.ts) is fine; the lip-sync engine is not.
    expect(rel(files).filter((f) => /AudioInput|LipSync(?!Frame)|analyzers\//.test(f))).toEqual([]);
  });

  it('never stores audio: no storage APIs where microphone samples exist', () => {
    const dirs = [resolve(AVATAR_SRC, 'audio/user'), resolve(EXT, 'src/offscreen')];
    for (const dir of dirs) {
      for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
        expect(readFileSync(join(dir, file), 'utf8'), file).not.toMatch(/indexedDB|localStorage|sessionStorage|chrome\.storage|showSaveFilePicker|MediaRecorder/);
      }
    }
  });
});

describe('conversation state ownership', () => {
  it('ConversationSignalResolver knows AvatarState but not VRM, three.js, bones or expressions', () => {
    const file = resolve(EXT, 'src/content/ConversationSignalResolver.ts');
    const { files, packages } = graph(file);
    expect([...packages].filter(isThree)).toEqual([]);
    // Type-only imports (AvatarControllerApi, AvatarState) are erased: at runtime it depends on nothing.
    expect(rel(files)).toEqual(['extension/src/content/ConversationSignalResolver.ts']);
    expect(rel(files).filter((f) => FORBIDDEN_AVATAR.test(f))).toEqual([]);
    expect(readFileSync(file, 'utf8')).not.toMatch(/\b(VRM|THREE|bone|Bone|setExpression|expressionManager)\b/);
  });

  it('only the resolver sets states in the content runtime; the reaction layer never does', () => {
    for (const f of ['src/content/avatar-runtime.ts', 'src/content/ContentLifecycle.ts', 'src/content/content.ts']) {
      expect(readFileSync(resolve(EXT, f), 'utf8'), f).not.toMatch(/\.setState\(/);
    }
    for (const f of ['avatar/UserReactionMapper.ts', 'avatar/UserReaction.ts']) {
      expect(readFileSync(avatarFile(f), 'utf8'), f).not.toMatch(/setState\(|setProcedural\(|setBoneRotation\(|setHeadRotation\(/);
    }
  });
});

describe('audio boundary between contexts', () => {
  it('the message protocol and the frame contract carry no audio types', () => {
    for (const file of [resolve(EXT, 'src/shared/messages.ts'), avatarFile('audio/user/UserVoiceFrame.ts')]) {
      const code = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      expect(code, file).not.toMatch(/\b(Float32Array|ArrayBuffer|MediaStream|AudioNode|AudioBuffer|PCM)\b/);
    }
  });

  it('the worklet posts frames, and samples only when a local model asked for them', () => {
    const code = readFileSync(avatarFile('audio/user/UserVoiceWorklet.ts'), 'utf8');
    const posts = [...code.matchAll(/postMessage\(([^;]*)\)/g)].map((m) => m[1]);
    expect(posts).toHaveLength(2);
    expect(posts[0]).toMatch(/type: 'frame', frame: this\.analyzer\.frame\(\)/);
    // PCM comes only from takePcm(), which stays empty unless enablePcm() ran, which needs pcmChunkSeconds.
    expect(posts[1]).toMatch(/^message, \[pcm\.buffer\]/);
    expect(code).toMatch(/if \(opts\.pcmChunkSeconds && opts\.pcmChunkSeconds > 0\) this\.analyzer\.enablePcm/);
    expect(readFileSync(resolve(EXT, 'src/offscreen/audio-runtime.ts'), 'utf8')).toMatch(
      /pcmChunkSeconds: \(\) => \(emotionHost \? PCM_CHUNK_SECONDS : undefined\)/,
    );
  });

  it('PCM never leaves the offscreen document: it only reaches the model host', () => {
    for (const file of ['src/offscreen/audio-runtime.ts', 'src/offscreen/ProsodyChannel.ts', 'src/offscreen/UserVoicePipeline.ts']) {
      const code = readFileSync(resolve(EXT, file), 'utf8');
      // Every broadcast/port message is built from a typed payload; none mentions samples.
      for (const m of code.matchAll(/(?:broadcast|broadcastAll|send|postMessage)\(([^;]*)\)/g)) {
        expect(m[1], `${file}: ${m[1]}`).not.toMatch(/samples|pcm/i);
      }
    }
  });
});

// --- US-006: dual-channel prosody & emotion -------------------------------------------------------------------

/** Source without comments (docs may name what the code must not do). */
const code = (file: string) => readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

describe('prosody/emotion analyser', () => {
  const EMOTION_DIR = resolve(AVATAR_SRC, 'audio/emotion');
  const files = readdirSync(EMOTION_DIR).filter((f) => f.endsWith('.ts'));

  it('ProsodyEmotionAnalyzer (and all of audio/emotion) imports no Avatar, AvatarController, BehaviorMixer, three or three-vrm', () => {
    expect(files).toContain('ProsodyEmotionAnalyzer.ts');
    for (const f of files) {
      const { files: reached, packages } = graph(join(EMOTION_DIR, f));
      expect([...packages].filter(isThree), f).toEqual([]);
      expect(rel(reached).filter((x) => FORBIDDEN_AVATAR.test(x) || /avatar\/src\/avatar\//.test(x)), f).toEqual([]);
      // Type-only imports are skipped by graph(); the source must not name them at all.
      expect(readFileSync(join(EMOTION_DIR, f), 'utf8'), f).not.toMatch(/from '[^']*(avatar\/Avatar|AvatarController|BehaviorMixer|three|@pixiv)[^']*'/);
    }
  });

  it('the analyser never drives the avatar or the conversation state', () => {
    for (const f of [...files.map((x) => join(EMOTION_DIR, x)), resolve(EXT, 'src/offscreen/ProsodyChannel.ts')]) {
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/setExpression\(|setState\(|setProcedural\(|setBoneRotation\(|setHeadRotation\(/);
    }
  });

  it('one analyser class for both channels: no per-channel analyser copies', () => {
    const all = [
      ...readdirSync(resolve(AVATAR_SRC), { recursive: true }).map((f) => resolve(AVATAR_SRC, String(f))),
      ...['src/offscreen', 'src/content', 'src/shared'].flatMap((d) => readdirSync(resolve(EXT, d)).map((f) => resolve(EXT, d, f))),
    ].filter((f) => f.endsWith('.ts'));
    for (const f of all) expect(readFileSync(f, 'utf8'), f).not.toMatch(/class\s+(User|Assistant)\w*(Emotion|Prosody)\w*Analy[sz]er/);
    const runtime = readFileSync(resolve(EXT, 'src/offscreen/audio-runtime.ts'), 'utf8');
    expect(runtime.match(/new ProsodyChannel\(/g)).toHaveLength(2); // user, and assistant per capture session
  });

  // Text analysis exists only as the rule-based semantic layer over the reply's visible text (below); there is no
  // speech-to-text, transcript or NLP/ML text package anywhere.
  it('no speech-to-text, transcripts or NLP packages anywhere', () => {
    const pkgs = [resolve(EXT, 'package.json'), resolve(AVATAR_SRC, '../package.json')].map((f) => readFileSync(f, 'utf8'));
    for (const p of pkgs) expect(p).not.toMatch(/whisper|transformers|speech-to-text|vosk|deepgram|sentiment|openai/i);
    const { packages } = graph(resolve(EXT, 'src/offscreen/audio-runtime.ts'));
    expect([...packages].filter((p) => !/^(onnxruntime-web|wlipsync)/.test(p))).toEqual([]);
    for (const dir of [resolve(AVATAR_SRC, 'audio'), resolve(EXT, 'src')]) {
      for (const f of readdirSync(dir, { recursive: true }).map(String).filter((x) => x.endsWith('.ts'))) {
        expect(code(join(dir, f)), f).not.toMatch(/SpeechRecognition|transcri(pt|be)/i);
      }
    }
  });
});

describe('semantic layer', () => {
  it('is local rules only: the semantic analyzer reaches no package at all', () => {
    for (const entry of ['SemanticAnalyzer.ts', 'SemanticPacer.ts']) {
      const { files, packages } = graph(resolve(AVATAR_SRC, 'semantic', entry));
      expect([...packages], entry).toEqual([]);
      expect(rel(files).filter((f) => !f.startsWith('avatar/src/semantic/')), entry).toEqual([]);
    }
  });

  it('SemanticFeed reads replies only through the adapter: no DOM, no selectors, no avatar or renderer', () => {
    const feed = readFileSync(resolve(EXT, 'src/content/SemanticFeed.ts'), 'utf8');
    expect(feed).not.toMatch(/\b(document|window|querySelector|MutationObserver|HTMLElement|textContent|innerText)\b/);
    const { files, packages } = graph(resolve(EXT, 'src/content/SemanticFeed.ts'));
    expect([...packages]).toEqual([]);
    expect(rel(files).filter((f) => /three|Avatar(Controller)?\.ts|BehaviorMixer|renderer\//.test(f))).toEqual([]);
  });

  it('semantic intents reach the avatar only through GestureEngine.pushSemantic', () => {
    const runtime = readFileSync(resolve(EXT, 'src/content/avatar-runtime.ts'), 'utf8');
    expect(runtime).toMatch(/sink:\s*\(?\w*\)?\s*=>\s*\w+\.pushSemantic\(/);
    const files = readdirSync(resolve(EXT, 'src'), { recursive: true }).map(String).filter((f) => f.endsWith('.ts'));
    for (const f of files) expect(readFileSync(resolve(EXT, 'src', f), 'utf8'), f).not.toMatch(/\.semantic\.decide\(|new SemanticGesturePolicy/);
  });
});

describe('behaviour ownership', () => {
  it('only BehaviorMixer maps emotion to pose/expressions; content code never writes expressions', () => {
    for (const f of readdirSync(resolve(EXT, 'src/content'))) {
      expect(readFileSync(resolve(EXT, 'src/content', f), 'utf8'), f).not.toMatch(/setExpression\(|setProcedural\(/);
    }
    const channels = code(avatarFile('avatar/EmotionChannels.ts'));
    expect(channels).not.toMatch(/\b(happy|relaxed|surprised|headYaw|gazeYaw|lean|setExpression|setProcedural)\b/);
    const mixer = readFileSync(avatarFile('avatar/BehaviorMixer.ts'), 'utf8');
    expect(mixer).toMatch(/o\.happy = /);
  });

  it('emotion never writes visemes: the mixer takes aa/ih/ou/ee/oh from the mouth source only', () => {
    const mixer = readFileSync(avatarFile('avatar/BehaviorMixer.ts'), 'utf8');
    const writes = [...mixer.matchAll(/o\.(aa|ih|ou|ee|oh)\s*=\s*([^;]+);/g)].map((m) => m[2]!.trim());
    for (const w of writes) expect(w).toMatch(/^(mouth(\.(aa|ih|ou|ee|oh))?|o\.\w+ = .*|0)$/);
  });
});

// --- In-page UI: Developer Mode, placement, popup ---------------------------------------------------------------------

describe('in-page UI and popup', () => {
  const uiFiles = readdirSync(resolve(EXT, 'src/ui'), { recursive: true })
    .map(String)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => resolve(EXT, 'src/ui', f));
  const entries = [...uiFiles, resolve(EXT, 'src/popup/popup.ts')];

  it('is a presentation layer: no three.js, VRM, Avatar, AvatarController, BehaviorMixer or AvatarStage at runtime', () => {
    expect(uiFiles.length).toBeGreaterThan(5);
    for (const entry of entries) {
      const { files, packages } = graph(entry);
      expect([...packages].filter(isThree), entry).toEqual([]);
      expect(rel(files).filter((f) => /avatar\/src\/(avatar\/(Avatar|AvatarController|BehaviorMixer|AvatarLoader)\.ts|renderer\/(AvatarStage|RenderLoop)\.ts)/.test(f)), entry).toEqual([]);
    }
  });

  it('never writes bones, expressions, the procedural layer or the conversation state directly', () => {
    for (const f of entries) {
      expect(code(f), f).not.toMatch(/setProcedural\(|expressionManager|getNormalizedBoneNode|getRawBoneNode|\.quaternion|\.rotation\.|setState\(|requestAnimationFrame|setInterval/);
    }
  });

  it('ManualControls is the only writer of the manual (debug) layer in the extension', () => {
    const all = readdirSync(resolve(EXT, 'src'), { recursive: true })
      .map(String)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => resolve(EXT, 'src', f));
    const writers = all.filter((f) => /\.(setExpression|setBoneRotation|setHeadRotation|resetPose)\(/.test(code(f)));
    expect(rel(new Set(writers))).toEqual(['extension/src/ui/dev/ManualControls.ts']);
  });

  it('knows nothing about ChatGPT’s DOM', () => {
    for (const f of entries) expect(code(f), f).not.toMatch(/querySelector|data-testid="|getElementsBy|closest\(/);
  });

  it('Developer Tools are a lazily imported chunk: the runtime never imports them statically', () => {
    const runtime = readFileSync(resolve(EXT, 'src/content/avatar-runtime.ts'), 'utf8');
    expect(runtime).toMatch(/import\('\.\.\/ui\/dev\/DevTools'\)/);
    expect(runtime).not.toMatch(/^import [^;]*from '\.\.\/ui\/dev\/DevTools'/m);
    // The type-only bridge is fine; panels, charts and history are not reachable without the dynamic import.
    const staticGraph = [...readFileSync(resolve(EXT, 'src/content/avatar-runtime.ts'), 'utf8').matchAll(/^import (?!type)[^;]*from '([^']+)'/gm)].map((m) => m[1]);
    expect(staticGraph.filter((s) => /ui\/dev\/(DevTools|panels|History|widgets|avatarControls)/.test(s!))).toEqual([]);
  });

  it('the content loader stays free of the UI kit (tokens, windows, charts)', () => {
    const { files } = graph(resolve(EXT, 'src/content/content.ts'));
    expect(rel(files).filter((f) => f.includes('/src/ui/') || f.includes('shared/settings'))).toEqual([]);
  });
});
