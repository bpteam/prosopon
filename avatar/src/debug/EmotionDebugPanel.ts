import type GUI from 'lil-gui';
import type { AudioInput } from '../audio/AudioInput';
import { EmotionModelHost } from '../audio/emotion/EmotionModelHost';
import { parseModelSpec } from '../audio/emotion/EmotionModel';
import type { EmotionChannel, EmotionFrame } from '../audio/emotion/EmotionFrame';
import { onnxEmotionLoader } from '../audio/emotion/OnnxEmotionModel';
import { DEFAULT_PROSODY_EMOTION_CONFIG, ProsodyEmotionAnalyzer } from '../audio/emotion/ProsodyEmotionAnalyzer';
import {
  USER_VOICE_PROCESSOR,
  type UserVoiceProcessorOptions,
  type UserVoiceWorkletMessage,
} from '../audio/user/UserVoiceWorkletProtocol';
import type { AvatarController } from '../avatar/AvatarController';
import { DEFAULT_EMOTION_MIX } from '../avatar/BehaviorMixer';
import type { EmotionChannels } from '../avatar/EmotionChannels';

const FRAME_RATE = 25;
const MODEL_JSON = 'emotion-model/model.json';

/**
 * "Emotion / Prosody" folder of the sandbox GUI: the calibration bench for US-006.
 *
 * Whatever the Lip Sync folder plays (an audio file, e.g. a recorded ChatGPT answer, or the microphone) goes through
 * the same feature worklet and the same ProsodyEmotionAnalyzer as in the extension, routed as the assistant's or the
 * user's channel, into the real BehaviorMixer. Sliders change the analyser and the mapping live; "copy settings"
 * puts the changed values on the clipboard to paste into the defaults.
 */
export class EmotionDebugPanel {
  readonly folder: GUI;
  readonly analyzers: Record<EmotionChannel, ProsodyEmotionAnalyzer> = {
    user: new ProsodyEmotionAnalyzer(),
    assistant: new ProsodyEmotionAnalyzer(),
  };
  private readonly view = {
    route: 'assistant' as EmotionChannel,
    followState: true,
    userEnabled: true,
    assistantEnabled: true,
    model: 'off',
  };
  private readonly readouts: Record<EmotionChannel, Record<string, number | string | boolean>> = {
    user: {},
    assistant: {},
  };
  private readonly mixView = { assistant: 0, user: 0 };
  private host: EmotionModelHost | null = null;
  private detach: (() => void) | null = null;
  private attaching = false;
  private readonly unsubscribe: () => void;

  constructor(
    parent: GUI,
    private readonly audio: AudioInput,
    private readonly controller: AvatarController,
    private readonly channels: EmotionChannels,
    private readonly workletUrl: string,
  ) {
    this.folder = parent.addFolder('Emotion / Prosody');
    this.folder.domElement.dataset.testid = 'emotion-panel';
    const f = this.folder;

    f.add(this.view, 'route', ['assistant', 'user']).name('audio source is');
    f.add(this.view, 'followState').name('drive state (speaking/listening)');
    f.add(this.view, 'assistantEnabled').name('Assistant emotion expression').onChange((v: boolean) => channels.setEnabled('assistant', v));
    f.add(this.view, 'userEnabled').name('User emotion reactions').onChange((v: boolean) => channels.setEnabled('user', v));
    f.add(this.view, 'model').name('analyzer model').disable().listen();
    f.add({ load: () => void this.loadModel() }, 'load').name(`load ./${MODEL_JSON}`);

    for (const ch of ['assistant', 'user'] as const) {
      const r = this.readouts[ch];
      const sub = f.addFolder(ch === 'user' ? 'User' : 'Assistant');
      for (const k of ['active', 'mode'] as const) {
        r[k] = k === 'active' ? false : 'heuristic';
        sub.add(r, k).disable().listen();
      }
      for (const k of ['valence', 'arousal', 'energy', 'tension', 'pitchLift', 'pitchVariation', 'speechRate', 'confidence', 'valenceConfidence'] as const) {
        r[k] = 0;
        sub.add(r, k, k === 'valence' || k === 'pitchLift' ? -1 : 0, 1).disable().listen();
      }
    }
    const mixFolder = f.addFolder('Mix (effective weights)');
    mixFolder.add(this.mixView, 'assistant', 0, 1).disable().listen();
    mixFolder.add(this.mixView, 'user', 0, 1).disable().listen();

    // Analyser settings: one set of sliders, applied to both channels.
    const a = f.addFolder('Analyzer (both channels)').close();
    const ac = this.analyzers.assistant.config;
    const sync = () => Object.assign(this.analyzers.user.config, { ...ac, arousalWeights: { ...ac.arousalWeights }, valenceWeights: { ...ac.valenceWeights } });
    const ranges: [keyof typeof ac, number, number, number][] = [
      ['window', 0.5, 3, 0.05],
      ['baselineWeight', 0, 1, 0.05],
      ['baselineWarmup', 0, 20, 0.5],
      ['baselineAdaptation', 5, 120, 1],
      ['pitchLiftRange', 1, 12, 0.5],
      ['pitchVariationRange', 1, 8, 0.25],
      ['speechRateMax', 3, 12, 0.5],
      ['centroidLowHz', 200, 2000, 50],
      ['centroidHighHz', 1000, 5000, 50],
      ['hysteresis', 0, 0.2, 0.005],
      ['arousalAttack', 0.05, 3, 0.05],
      ['arousalRelease', 0.05, 3, 0.05],
      ['valenceAttack', 0.05, 3, 0.05],
      ['valenceRelease', 0.05, 3, 0.05],
      ['silenceRelease', 0.1, 5, 0.1],
      ['heuristicConfidence', 0, 1, 0.05],
      ['heuristicValenceConfidence', 0, 1, 0.05],
    ];
    for (const [k, min, max, step] of ranges) a.add(ac, k, min, max, step).onChange(sync);
    const w = a.addFolder('arousal weights');
    for (const k of Object.keys(ac.arousalWeights) as (keyof typeof ac.arousalWeights)[]) {
      w.add(ac.arousalWeights, k, 0, 1, 0.05).onChange(sync);
    }

    // Mapping bounds (BehaviorMixer): what a full-scale emotion may do to the avatar.
    const m = f.addFolder('Mapping (BehaviorMixer)').close();
    const mc = controller.emotionConfig;
    for (const k of Object.keys(mc) as (keyof typeof mc)[]) {
      const d = DEFAULT_EMOTION_MIX[k];
      m.add(mc, k, 0, Math.max(0.05, d * 3), d > 0.1 ? 0.01 : 0.001);
    }

    f.add({ copy: () => void this.copySettings() }, 'copy').name('copy changed settings (JSON)');

    this.unsubscribe = audio.onKindChange((kind) => {
      if (kind !== 'none') void this.ensureAttached();
    });
    if (audio.kind !== 'none') void this.ensureAttached();
  }

  /** Call once per frame (after controller.update) to refresh readouts. */
  update(): void {
    for (const ch of ['assistant', 'user'] as const) {
      const v = this.channels.value[ch];
      Object.assign(this.readouts[ch], v);
    }
    // Frames stop when the source stops: hand the floor back once the channel has gone quiet.
    if (this.view.followState && this.channels.age(this.view.route) > 1 && this.controller.getState() === 'speaking') {
      this.controller.setState('listening');
    }
    this.mixView.assistant = this.controller.emotionMix.assistant;
    this.mixView.user = this.controller.emotionMix.user;
  }

  dispose(): void {
    this.unsubscribe();
    this.detach?.();
    this.host?.dispose();
    this.folder.destroy();
  }

  private async ensureAttached(): Promise<void> {
    const ctx = this.audio.context;
    if (this.detach || this.attaching || !ctx) return;
    this.attaching = true;
    try {
      await ctx.audioWorklet.addModule(this.workletUrl);
      const node = new AudioWorkletNode(ctx, USER_VOICE_PROCESSOR, {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCount: 1,
        channelCountMode: 'explicit',
        processorOptions: { frameRate: FRAME_RATE, pcmChunkSeconds: this.host ? 0.1 : undefined } satisfies UserVoiceProcessorOptions,
      });
      node.port.onmessage = (event: MessageEvent<UserVoiceWorkletMessage>) => {
        const msg = event.data;
        const route = this.view.route;
        if (msg.type === 'frame') {
          const out = this.analyzers[route].push(msg.frame, 1 / FRAME_RATE);
          if (out) this.onEmotion(route, out);
        } else if (msg.type === 'pcm') {
          this.host?.pushAudio(route, msg.samples, msg.sampleRate);
        }
      };
      const untap = this.audio.addTap(node);
      this.detach = () => {
        node.port.onmessage = null;
        untap();
        node.disconnect();
      };
    } catch (error) {
      console.warn('[emotion] feature worklet failed:', error);
    } finally {
      this.attaching = false;
    }
  }

  private onEmotion(route: EmotionChannel, frame: EmotionFrame): void {
    this.channels.push(route, frame);
    if (!this.view.followState) return;
    // Stand-in for the extension's ConversationSignalResolver: whoever is "talking" has the floor.
    const state = frame.active ? (route === 'assistant' ? 'speaking' : 'listening') : 'listening';
    if (this.controller.getState() !== state) this.controller.setState(state);
  }

  private async loadModel(): Promise<void> {
    if (this.host) return;
    this.view.model = 'loading';
    try {
      const response = await fetch(MODEL_JSON);
      if (!response.ok) throw new Error(`${MODEL_JSON}: HTTP ${response.status}`);
      const spec = parseModelSpec(await response.json(), (file) => `emotion-model/${file}`);
      if (!spec) throw new Error(`${MODEL_JSON} is not a valid model description`);
      const host = new EmotionModelHost(spec, onnxEmotionLoader());
      host.attach('assistant', this.analyzers.assistant);
      host.attach('user', this.analyzers.user);
      this.host = host;
      const status = await host.load();
      this.view.model = status === 'ready' ? host.mode : `failed: ${host.error}`;
      // Re-create the worklet so it also posts audio for the model.
      this.detach?.();
      this.detach = null;
      await this.ensureAttached();
    } catch (error) {
      this.view.model = `error: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private async copySettings(): Promise<void> {
    const changed = (cur: object, def: object) =>
      Object.fromEntries(
        Object.entries(cur).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify((def as Record<string, unknown>)[k])),
      );
    const json = JSON.stringify(
      {
        analyzer: changed(this.analyzers.assistant.config, DEFAULT_PROSODY_EMOTION_CONFIG),
        mapping: changed(this.controller.emotionConfig, DEFAULT_EMOTION_MIX),
      },
      null,
      2,
    );
    console.log('[emotion] changed settings:\n' + json);
    try {
      await navigator.clipboard.writeText(json);
    } catch {
      // Clipboard needs focus/permission; the console has it anyway.
    }
  }
}
