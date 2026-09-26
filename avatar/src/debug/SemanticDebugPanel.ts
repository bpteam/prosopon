import type GUI from 'lil-gui';
import type { AvatarController } from '../avatar/AvatarController';
import type { GestureEngine } from '../avatar/gesture/GestureEngine';
import { SemanticAnalyzer } from '../semantic/SemanticAnalyzer';
import type { SemanticLocale } from '../semantic/SemanticCue';
import { SemanticPacer } from '../semantic/SemanticPacer';
import { DEMO_REPLIES } from '../semantic/demoReplies';

/**
 * "Semantic" folder of the sandbox GUI: plays a demo reply (RU/UK/EN/ES) the way ChatGPT's voice mode would —
 * text streamed faster than it is spoken, the avatar in `speaking`, the text clock releasing intents at the
 * speech rate — so semantic accents can be judged by eye. No audio is played; lip sync stays closed.
 */
export class SemanticDebugPanel {
  readonly folder: GUI;
  private analyzer = new SemanticAnalyzer();
  readonly pacer = new SemanticPacer();
  private text = '';
  private shown = 0;
  private playing = false;
  private run = 0;
  private tail = 0;
  private readonly view = {
    language: 'ru' as SemanticLocale,
    textRate: 40,
    followSpeech: true,
    segment: '—',
    cues: '—',
    decision: '—',
    counts: '0 / 0 / 0',
  };

  constructor(
    parent: GUI,
    private readonly controller: AvatarController,
    private readonly engine: GestureEngine,
  ) {
    this.folder = parent.addFolder('Semantic');
    this.folder.domElement.dataset.testid = 'semantic-panel';
    const f = this.folder;
    const actions = { play: () => this.play(this.view.language), stop: () => this.stop() };
    f.add(this.view, 'language', ['ru', 'uk', 'en', 'es']).name('Demo reply');
    f.add(this.view, 'textRate', 5, 200, 1).name('Text arrives, chars/s');
    f.add(this.pacer.config, 'charsPerSecond', 6, 30, 0.5).name('Speech, chars/s');
    f.add(this.view, 'followSpeech').name('Follow speech').onChange((v: boolean) => (this.pacer.enabled = v));
    f.add(engine.semantic.config, 'enabled').name('Semantic gestures');
    f.add(engine.semantic.config, 'probabilityScale', 0, 4, 0.1).name('Chance ×');
    f.add(engine.semantic.config, 'globalCooldown', 0, 10, 0.1).name('Cooldown, s');
    f.add(actions, 'play').name('▶ Play demo');
    f.add(actions, 'stop').name('■ Stop');
    f.add(this.view, 'segment').name('Segment').disable().listen();
    f.add(this.view, 'cues').name('Cues').disable().listen();
    f.add(this.view, 'decision').name('Decision').disable().listen();
    f.add(this.view, 'counts').name('Cues / intents / gestures').disable().listen();
    f.close();
  }

  play(language: SemanticLocale): void {
    this.analyzer = new SemanticAnalyzer();
    this.pacer.clear();
    this.text = DEMO_REPLIES[language];
    this.shown = 0;
    this.tail = 0;
    this.playing = true;
    this.run++;
    this.controller.setState('speaking');
  }

  stop(): void {
    if (!this.playing) return;
    this.playing = false;
    this.pacer.clear();
    this.controller.setState('idle');
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  /** From the render loop. */
  update(delta: number): void {
    if (!this.playing) return;
    const id = `demo-${this.run}`;
    if (this.shown < this.text.length) {
      this.shown = Math.min(this.text.length, this.shown + delta * this.view.textRate);
      const complete = this.shown >= this.text.length;
      for (const intent of this.analyzer.update(id, this.text.slice(0, Math.floor(this.shown)), complete)) this.pacer.push(intent);
    }
    for (const intent of this.pacer.update(delta, true, true)) {
      this.engine.pushSemantic(intent);
      this.view.segment = intent.text.slice(0, 60);
      this.view.cues = intent.cues.map((c) => `${c.type} ${c.confidence.toFixed(2)}`).join(', ');
    }
    const last = this.engine.semantic.history.at(-1);
    if (last) this.view.decision = last.accepted ? `${last.cue} → ${last.gesture}` : `${last.cue ?? '—'}: ${last.reason}`;
    const st = this.engine.semanticStatus;
    this.view.counts = `${this.analyzer.stats.cues} / ${st.intents} / ${st.accepted}`;
    // Done when the text is out, the speech clock has passed it and a short tail has run.
    if (this.shown >= this.text.length && this.pacer.status.pending === 0 && this.pacer.status.spokenChars >= this.text.length) {
      this.tail += delta;
      if (this.tail > 1) this.stop();
    }
  }
}
