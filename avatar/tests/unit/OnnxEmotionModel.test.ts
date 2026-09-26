import { resolve } from 'node:path';
import * as ort from 'onnxruntime-web';
import { describe, expect, it } from 'vitest';
import { EmotionModelHost } from '../../src/audio/emotion/EmotionModelHost';
import type { EmotionModelSpec } from '../../src/audio/emotion/EmotionModel';
import { onnxEmotionLoader } from '../../src/audio/emotion/OnnxEmotionModel';
import { ProsodyEmotionAnalyzer } from '../../src/audio/emotion/ProsodyEmotionAnalyzer';
import { SILENT_USER_VOICE_FRAME } from '../../src/audio/user/UserVoiceFrame';
import { silentLogger } from './fakeVrm';

// The fixture maps loudness to "arousal" (it is not an emotion model; see scripts/make-probe-model.py).
const spec: EmotionModelSpec = {
  url: resolve(__dirname, '../fixtures/loudness-probe.onnx'),
  sampleRate: 16000,
  windowSeconds: 0.5,
  arousalIndex: 0,
  valenceIndex: 2,
  outputRange: [0, 1],
  trust: 0.6,
  inferInterval: 0.25,
  preferWebGpu: true,
};

describe('OnnxEmotionModel (real ONNX Runtime, WASM backend)', () => {
  it('falls back from WebGPU to WASM and reads the model output', async () => {
    const log = silentLogger();
    // No adapter here: the loader must skip WebGPU and still load.
    const load = onnxEmotionLoader({ ort, hasWebGpu: async () => false, logger: log });
    const model = await load(spec);
    expect(model.backend).toBe('wasm');
    const loud = new Float32Array(8000).fill(0.2);
    const quiet = new Float32Array(8000).fill(0.01);
    expect((await model.infer(loud)).arousal).toBeCloseTo(0.8, 4);
    expect((await model.infer(quiet)).arousal).toBeCloseTo(0.04, 4);
    expect((await model.infer(quiet)).valence).toBeCloseTo(0, 4);
    model.dispose();
  });

  it('a WebGPU failure is logged and WASM is used instead', async () => {
    const log = silentLogger();
    const model = await onnxEmotionLoader({ ort, hasWebGpu: async () => true, logger: log })(spec);
    // Node has no WebGPU execution provider: the first attempt fails, the second succeeds.
    expect(model.backend).toBe('wasm');
    expect(log.messages.join('\n')).toMatch(/webgpu backend unavailable/);
    model.dispose();
  });

  it('host: audio → model → analyser mode ml-wasm; a missing file → fallback', async () => {
    const host = new EmotionModelHost(spec, onnxEmotionLoader({ ort, hasWebGpu: async () => false }), { logger: silentLogger() });
    const p = new ProsodyEmotionAnalyzer();
    for (let i = 0; i < 25; i++) p.push({ ...SILENT_USER_VOICE_FRAME, speaking: true, energy: 0.5, rmsDb: -20, pitchHz: 150 }, 0.04);
    host.attach('assistant', p);
    expect(await host.load()).toBe('ready');
    expect(p.mode).toBe('ml-wasm');
    host.pushAudio('assistant', new Float32Array(48000).fill(0.2), 48000);
    await new Promise((r) => setTimeout(r, 50));
    expect(host.inferenceCount).toBe(1);

    const broken = new EmotionModelHost({ ...spec, url: '/nonexistent/model.onnx' }, onnxEmotionLoader({ ort, hasWebGpu: async () => false }), { logger: silentLogger() });
    const q = new ProsodyEmotionAnalyzer();
    broken.attach('user', q);
    expect(await broken.load()).toBe('failed');
    expect(q.mode).toBe('fallback');
  });
});
