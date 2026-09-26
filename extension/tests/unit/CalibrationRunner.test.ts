import { describe, expect, it } from 'vitest';
import { CalibrationRunner } from '../../src/calibration/CalibrationRunner';
import { buildScenario } from '../../src/calibration/scenarios';
import { ATTRIBUTED_CHANNELS as UI_CHANNELS } from '../../src/calibration/types';
import { ATTRIBUTED_CHANNELS } from '@avatar/avatar/BehaviorMixer';
import { createWorld, type WorldOptions } from './calibrationFakes';

async function runAll(world: ReturnType<typeof createWorld>, runner: CalibrationRunner, maxMinutes = 60) {
  let spokeFor: unknown = null;
  await world.chat.startVoice();
  const done = runner.start();
  let finished = false;
  void done.then(() => (finished = true));
  const onFrame = () => {
    const p = runner.view.prompt;
    if (p?.speakNow && !p.listening && !world.userSpeaking && spokeFor !== p) {
      spokeFor = p;
      world.speak(1500);
    }
    if (runner.view.phase === 'pick-voice') runner.pickVoice('Cove');
  };
  for (let i = 0; i < maxMinutes * 6 && !finished; i++) await world.advance(10_000, (dt) => runner.tick(dt), onFrame);
  expect(finished, `stuck in ${runner.view.phase}: ${runner.view.message}`).toBe(true);
}

function setup(options: WorldOptions = {}, scenario = buildScenario({ languages: ['ru', 'en'], userLanguages: ['ru'] })) {
  const world = createWorld(options);
  const runner = new CalibrationRunner({ host: world.host, scenario });
  return { world, runner };
}

describe('CalibrationRunner', () => {
  it('runs the whole scenario without any input but speech, and builds every bundle file', async () => {
    const { world, runner } = setup();
    await runAll(world, runner);
    expect(runner.view.phase).toBe('complete');
    expect(runner.records.every((r) => r.valid)).toBe(true);
    const files = runner.bundleFiles!;
    for (const f of ['manifest.json', 'config-before.json', 'scenarios.json', 'results.json', 'summary.json', 'trace.jsonl', 'events.jsonl', 'assistant-text.jsonl', 'REPORT.md', 'AGENT_TASK.md']) {
      expect(files.has(f), f).toBe(true);
    }
    const manifest = JSON.parse(files.get('manifest.json')!);
    expect(manifest.prosopon.commit).toBe('abc123');
    expect(manifest.chatgpt).toMatchObject({ voice: 'Sol', voiceMode: 'realtime', voiceDetection: 'aria', voiceRuntimeModel: null });
    expect(runner.view.result!.fileName).toMatch(/^prosopon-calibration-sol-\d{4}-\d{2}-\d{2}\.zip$/);
    // Every sample has voice × language metadata and the actual text next to the requested one.
    const texts = files.get('assistant-text.jsonl')!.trim().split('\n').map((l) => JSON.parse(l));
    const spoken = texts.filter((x) => x.kind === 'assistant');
    expect(spoken.length).toBe(14);
    expect(spoken.every((x) => x.actualRenderedText && x.requestedText && x.language)).toBe(true);
    // Each step recorded its own audio clip(s) in the offscreen document.
    const starts = world.requests.filter((r) => r.type === 'calibration:record' && r.action === 'start');
    expect(starts.length).toBeGreaterThanOrEqual(runner.scenario.steps.length);
    // The simple flow never touches ChatGPT's Voice or microphone controls.
    expect(world.muteCalls).toEqual([]);
  }, 60_000);

  it('measures the speech rate and finds the expected cues end to end', async () => {
    const { world, runner } = setup({}, buildScenario({ languages: ['en'], user: false }));
    await runAll(world, runner);
    const s = runner.result!.summary;
    // The simulated voice speaks 14 chars/s; the measure must land close to it.
    expect(s.pacing.measured.en).toBeGreaterThan(11);
    expect(s.pacing.measured.en).toBeLessThan(15);
    expect(s.semanticDetection).toBe(1);
    const question = runner.result!.results.find((r) => r.category === 'question.normal')!;
    expect(question.verdicts.find((v) => v.expect === 'question')?.verdict).toBe('OK');
  }, 60_000);

  it('classifies a gesture that runs but barely moves the pose as MIX_OR_AMPLITUDE_TOO_LOW', async () => {
    const { world, runner } = setup({ gestureFinal: 0.002 }, buildScenario({ languages: ['en'], user: false, categories: ['question.normal'] }));
    await runAll(world, runner);
    expect(runner.result!.results[0]!.verdicts[0]).toMatchObject({ expect: 'question', verdict: 'MIX_OR_AMPLITUDE_TOO_LOW' });
    expect(runner.result!.summary.bottleneck).toBe('MIX_OR_AMPLITUDE_TOO_LOW');
  }, 60_000);

  it('classifies declined intents as GESTURE_POLICY_SUPPRESSION with the reason', async () => {
    const { world, runner } = setup({ accept: false }, buildScenario({ languages: ['ru'], user: false, categories: ['question.normal'] }));
    await runAll(world, runner);
    expect(runner.result!.results[0]!.verdicts[0]).toMatchObject({ verdict: 'GESTURE_POLICY_SUPPRESSION', detail: 'cooldown' });
  }, 60_000);

  it('keeps a usable audio sample when the page does not render reply text', async () => {
    const { world, runner } = setup({ renderText: false }, buildScenario({ languages: ['en'], user: false, categories: ['question.normal'] }));
    await runAll(world, runner);
    const r = runner.result!.results[0]!;
    expect(r.valid).toBe(true);
    expect(r.textSource).toBe('none');
    expect(r.verdicts[0]!.verdict).toBe('NO_REPLY_TEXT');
  }, 60_000);

  it('retries once, marks the sample invalid and stops sending prompts when Voice never speaks typed messages', async () => {
    const { world, runner } = setup({ voiceSpeaksTyped: false }, buildScenario({ languages: ['en'], user: false }));
    await runAll(world, runner);
    const r = runner.records;
    expect(r.every((x) => !x.valid)).toBe(true);
    expect(r[0]!.attempts).toBe(2);
    expect(r[0]!.invalidReason).toBe('no-assistant-audio');
    expect(r.at(-1)!.invalidReason).toMatch(/^skipped/);
    const prompts = world.requests.filter((x) => x.type === 'calibration:record' && x.action === 'start').length;
    expect(prompts).toBe(6); // three samples × two attempts, then the rest is skipped
  }, 60_000);

  it('keeps an unknown Voice name rather than interrupting the run for a manual picker', async () => {
    const { world, runner } = setup({ voice: null }, buildScenario({ languages: ['en'], user: false, categories: ['question.normal'] }));
    await runAll(world, runner);
    const manifest = JSON.parse(runner.bundleFiles!.get('manifest.json')!);
    expect(manifest.chatgpt.voice).toBeNull();
    expect(manifest.chatgpt.voiceDetection).toBe('unknown');
  }, 60_000);

  it('fails immediately when Voice was not prepared before Start', async () => {
    const { world, runner } = setup({ voiceStarts: false }, buildScenario({ languages: ['en'], user: false, categories: ['question.normal'] }));
    void runner.start();
    await world.advance(3000, (dt) => runner.tick(dt));
    expect(runner.view.phase).toBe('failed');
    expect(runner.view.error).toMatch(/Open ChatGPT Voice/);
  }, 60_000);

  it('skips user and interruption samples without a microphone instead of stopping', async () => {
    const { world, runner } = setup({ micOn: false }, buildScenario({ languages: ['en'], categories: ['question.normal'] }));
    await runAll(world, runner);
    const users = runner.records.filter((r) => r.kind !== 'assistant');
    expect(users.length).toBeGreaterThan(0);
    expect(users.every((r) => !r.valid && r.invalidReason === 'microphone reactions are not on')).toBe(true);
    expect(runner.view.phase).toBe('complete');
  }, 60_000);

  it('measures interruptions from the user’s onset to the switch to listening', async () => {
    const { world, runner } = setup({}, buildScenario({ languages: ['en'], categories: [] }));
    await runAll(world, runner);
    const r = runner.result!.results.find((x) => x.kind === 'interruption')!;
    expect(r.valid).toBe(true);
    expect(r.observed.interruption!.onsetToListening).not.toBeNull();
    expect(r.verdicts[0]!.verdict).toBe('OK');
  }, 60_000);

  it('keeps manual flags without waiting for them', async () => {
    const { world, runner } = setup({}, buildScenario({ languages: ['en'], user: false, categories: ['question.normal'] }));
    let flagged = false;
    void runner.start();
    for (let i = 0; i < 60 && runner.view.phase !== 'complete'; i++) {
      await world.advance(1000, (dt) => runner.tick(dt), () => {
        if (runner.view.phase === 'preflight') void world.chat.startVoice();
        if (!flagged && runner.view.flaggable) {
          flagged = true;
          runner.flag();
          runner.flag('too-weak');
        }
      });
    }
    expect(runner.result!.summary.manualFlags).toEqual([{ step: 'en.question.normal', reason: 'too-weak' }]);
  }, 60_000);

  it('discard drops the recordings in the offscreen document', async () => {
    const { world, runner } = setup({}, buildScenario({ languages: ['en'], user: false, categories: ['question.normal'] }));
    void runner.start();
    await world.advance(2000, (dt) => runner.tick(dt));
    await runner.discard();
    expect(runner.view.phase).toBe('discarded');
    expect(world.requests.at(-1)!.type).toBe('calibration:discard');
    expect(runner.bundleFiles).toBeNull();
  });

  it('export sends every file (large ones in parts), builds the ZIP and opens the export page', async () => {
    const { world, runner } = setup({}, buildScenario({ languages: ['en'], user: false, categories: ['question.normal'] }));
    await runAll(world, runner);
    let opened = false;
    world.host.openExport = () => void (opened = true);
    await runner.export();
    expect(runner.view.phase).toBe('exported');
    expect(opened).toBe(true);
    const names = world.requests.filter((r) => r.type === 'calibration:file').map((r) => (r as { name: string }).name);
    expect(names).toContain('AGENT_TASK.md');
    expect(world.requests.at(-1)).toMatchObject({ type: 'calibration:build', fileName: runner.view.result!.fileName });
  }, 60_000);

  it('attributed channels match BehaviorMixer', () => {
    expect([...UI_CHANNELS]).toEqual([...ATTRIBUTED_CHANNELS]);
  });
});
