import { h } from '../shared/dom';
import type { CalibrationRunner, CalibrationView } from '../../calibration/CalibrationRunner';
import type { DevBridge } from './DevBridge';
import type { Panel } from './panels';
import { card, keyValue } from './widgets';

/** Keeps the one calibration run of a Developer Mode session (the DevTools own it and tick it every frame). */
export interface CalibrationSlot {
  readonly runner: CalibrationRunner | null;
  /** A new runner (the previous one must have ended). */
  create(): CalibrationRunner;
}

export const CALIBRATION_CSS = `
.cal { display: flex; flex-direction: column; gap: var(--gap-m); }
.cal-big { font-size: 20px; font-weight: 600; line-height: 1.3; }
.cal-phrase { font-size: 22px; font-weight: 600; line-height: 1.35; padding: 12px 0; }
.cal-count { font-size: 44px; font-weight: 700; text-align: center; font-variant-numeric: tabular-nums; }
.cal-speak { font-size: 28px; font-weight: 800; text-align: center; color: var(--red, #e5484d); letter-spacing: 0.04em; }
.cal-listen::before { content: "●"; color: var(--red, #e5484d); margin-right: 6px; }
.cal-progress { height: 6px; border-radius: 3px; background: var(--bg-hover); overflow: hidden; }
.cal-progress > div { height: 100%; background: var(--accent); width: 0; transition: width 0.3s; }
.cal-row { display: flex; flex-wrap: wrap; gap: var(--gap-s); align-items: center; }
.cal-primary { background: var(--accent); color: #fff; border-color: var(--accent); font-weight: 600; min-height: 36px; padding: 0 18px; }
.cal-voices { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--gap-s); }
.cal-lines { margin: 0; padding-left: 18px; }
.cal-error { color: var(--red, #e5484d); }
`;

/**
 * Developer Tools → Calibration: the wizard's only screen. Before Start it shows what was detected; during the run
 * only what the user must do (a phrase to say, a countdown, a fallback button); at the end the result and Export.
 * All logic is in CalibrationRunner; this renders its view.
 */
export function calibrationPanel(doc: Document, bridge: DevBridge, slot: CalibrationSlot): Panel {
  const root = h(doc, 'div', { class: 'tab-panel cal', 'data-testid': 'calibration' });
  let off: (() => void) | null = null;
  let sinceDetect = Infinity;
  let flagOpen = false;

  const kv = {
    voice: keyValue(doc, 'Current voice'),
    mode: keyValue(doc, 'Voice mode'),
    languages: keyValue(doc, 'Languages'),
    mic: keyValue(doc, 'Microphone'),
    capture: keyValue(doc, 'Audio capture'),
  };
  for (const [k, v] of Object.entries(kv)) v.el.dataset.testid = `calibration-${k}`;

  const button = (label: string, onClick: () => void, attrs: Record<string, string> = {}) =>
    h(doc, 'button', { type: 'button', onclick: onClick, ...attrs }, label);

  function attach(runner: CalibrationRunner): void {
    off?.();
    off = runner.onChange((v) => render(v, runner));
    render(runner.view, runner);
  }

  function start(): void {
    const runner = slot.create();
    attach(runner);
    void runner.start();
  }

  function idle(): void {
    const env = bridge.calibration.environment();
    const e = bridge.calibration.chat.detectVoiceEnvironment();
    kv.voice.set(e.voiceName ?? 'Detecting…');
    kv.mode.set(e.voiceMode ?? 'Detecting…');
    kv.languages.set('RU UK EN ES');
    kv.mic.set(env.mic.state === 'on' ? 'Ready' : env.mic.state === 'off' ? 'Off (will be turned on)' : `Unavailable (${env.mic.state})`);
    kv.capture.set(env.offscreenConnected ? 'Ready' : 'Not capturing');
    root.replaceChildren(
      card(
        doc,
        'Real Voice Calibration',
        ...Object.values(kv).map((x) => x.el),
        h(doc, 'p', { class: 'secondary' }, 'Calibration will temporarily record audio locally for analysis. Nothing is uploaded.'),
        h(doc, 'p', { class: 'secondary' }, 'Use headphones: ChatGPT Voice hears your speakers.'),
        h(doc, 'div', { class: 'cal-row' }, button('Start calibration', start, { class: 'cal-primary', 'data-testid': 'calibration-start' })),
      ),
    );
  }

  function render(v: CalibrationView, runner: CalibrationRunner): void {
    const parts: HTMLElement[] = [];
    parts.push(
      h(
        doc,
        'div',
        { class: 'kv' },
        h(doc, 'span', { class: 'secondary', 'data-testid': 'calibration-phase', 'data-phase': v.phase }, v.label),
        h(doc, 'span', { class: 'value', 'data-testid': 'calibration-samples' }, `${v.samples.valid} / ${v.samples.total} valid`),
      ),
    );
    const bar = h(doc, 'div');
    bar.style.width = `${v.progress.total ? Math.round((100 * v.progress.done) / v.progress.total) : 0}%`;
    parts.push(h(doc, 'div', { class: 'cal-progress' }, bar));
    if (v.environment.voice) parts.push(h(doc, 'div', { class: 'secondary' }, `Voice: ${v.environment.voice} · Microphone: ${v.environment.microphone}`));
    if (v.message) parts.push(h(doc, 'div', { class: 'cal-big', 'data-testid': 'calibration-message' }, v.message));
    if (v.error) parts.push(h(doc, 'div', { class: 'cal-error', 'data-testid': 'calibration-error' }, v.error));

    const p = v.prompt;
    if (p) {
      const box = h(doc, 'div', { 'data-testid': 'calibration-prompt' }, h(doc, 'div', { class: 'cal-big' }, p.title));
      if (p.instruction) box.append(h(doc, 'div', { class: 'secondary' }, p.instruction));
      box.append(h(doc, 'div', { class: 'cal-phrase' }, `«${p.text}»`));
      if (p.countdown !== null) box.append(h(doc, 'div', { class: 'cal-count' }, String(p.countdown)));
      else if (p.speakNow && !p.listening && v.phase === 'interruption') box.append(h(doc, 'div', { class: 'cal-speak' }, 'SPEAK NOW'));
      box.append(h(doc, 'div', { class: p.listening ? 'cal-listen' : 'secondary' }, p.listening ? 'Listening…' : p.speakNow ? 'Waiting for your voice…' : 'Get ready…'));
      parts.push(box);
    }
    if (v.action) {
      const a = v.action;
      parts.push(h(doc, 'div', { class: 'cal-row' }, button(a.label, () => runner.act(a.id), { class: 'cal-primary', 'data-testid': `calibration-action-${a.id}` })));
    }
    if (v.voicePicker) {
      const other = h(doc, 'input', { type: 'text', placeholder: 'Other…', 'aria-label': 'Other voice', maxlength: '40' });
      parts.push(
        h(doc, 'div', { class: 'cal-voices' }, ...v.voicePicker.options.map((name) => button(name, () => runner.pickVoice(name), { 'data-voice': name }))),
        h(doc, 'div', { class: 'cal-row' }, other, button('Use', () => runner.pickVoice(other.value))),
      );
    }
    if (v.flaggable) {
      const row = h(doc, 'div', { class: 'cal-row' });
      row.append(
        button('Mark this as visually wrong', () => {
          runner.flag();
          flagOpen = true;
          render(runner.view, runner);
        }, { 'data-testid': 'calibration-flag' }),
      );
      if (flagOpen) {
        for (const [label, reason] of [['Too weak', 'too-weak'], ['Too much', 'too-much'], ['Wrong timing', 'wrong-timing']] as const) {
          row.append(button(label, () => {
            runner.flag(reason);
            flagOpen = false;
            render(runner.view, runner);
          }));
        }
      }
      parts.push(row);
    } else flagOpen = false;
    if (v.result) {
      parts.push(h(doc, 'ul', { class: 'cal-lines', 'data-testid': 'calibration-result' }, ...v.result.lines.map((l) => h(doc, 'li', {}, l))));
    }
    const actions = h(doc, 'div', { class: 'cal-row' });
    if (v.phase === 'complete') actions.append(button('Export calibration', () => void runner.export(), { class: 'cal-primary', 'data-testid': 'calibration-export' }));
    if (runner.running || v.phase === 'complete') actions.append(button('Discard', () => void runner.discard(), { 'data-testid': 'calibration-discard' }));
    if (['exported', 'discarded', 'failed'].includes(v.phase)) actions.append(button('Start again', start, { 'data-testid': 'calibration-restart' }));
    parts.push(actions);
    root.replaceChildren(card(doc, 'Real Voice Calibration', ...parts));
  }

  if (slot.runner) attach(slot.runner);
  else idle();

  return {
    el: root,
    update() {
      // Idle screen: refresh what was detected once a second (DOM reads through the adapter, only while visible).
      if (slot.runner) return;
      sinceDetect++;
      if (sinceDetect >= 10) {
        sinceDetect = 0;
        idle();
      }
    },
    draw() {},
  };
}
