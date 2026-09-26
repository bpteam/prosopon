import { VISEMES } from '@avatar/avatar/MouthShape';
import { fmt, h, setText } from '../shared/dom';
import { STORAGE_KEYS, isCameraModified } from '../../shared/settings';
import type { DevBridge, DevSample } from './DevBridge';
import type { DevHistory } from './History';
import { STATE_COLORS, barRow, card, keyValue, metricChart, switchRow, type BarRow, type Chart, type KeyValue } from './widgets';

/** A block of the developer UI that follows the 10 Hz samples. draw() repaints its charts (≤ 10 Hz, visible only). */
export interface Panel {
  el: HTMLElement;
  update(s: DevSample): void;
  draw(): void;
}

const signed = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}`;
const ms = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v.toFixed(v < 10 ? 1 : 0)} ms`);
const deg = (rad: number) => `${((rad * 180) / Math.PI).toFixed(1)}°`;

/** Audio latency shown to humans: output latency of the assistant context, else its base latency. */
export function audioLatencyMs(s: DevSample): number | null {
  const c = s.telemetry?.contexts.find((x) => x.id === 'assistant');
  if (!c) return null;
  return (c.baseLatencyMs ?? 0) + (c.outputLatencyMs ?? 0) || null;
}

function stateLine(doc: Document): { el: HTMLElement; set(state: string): void } {
  const dot = h(doc, 'span', { class: 'dot' });
  const text = h(doc, 'span', { class: 'state', 'data-testid': 'dev-state' }, '—');
  return {
    el: h(doc, 'div', { class: 'state-line' }, h(doc, 'span', { class: 'secondary' }, 'State:'), dot, text),
    set(state) {
      setText(text, state);
      dot.style.background = STATE_COLORS[state] ?? 'var(--text-muted)';
      text.style.color = STATE_COLORS[state] ?? 'var(--text)';
    },
  };
}

/** Modifier bars: the effective gains BehaviorMixer actually used (BehaviorDebugSnapshot.weights). */
function modifierBars(doc: Document): { el: HTMLElement; update(s: DevSample): void } {
  const rows: [keyof DevSample['behavior']['weights'], string, string][] = [
    ['state', 'Conversation State', 'var(--purple)'],
    ['assistantEmotion', 'Emotion Assistant', 'var(--accent)'],
    ['userEmotion', 'Emotion User', 'var(--green)'],
    ['userReaction', 'User Reaction', 'var(--green)'],
    ['gesture', 'Gesture', 'var(--yellow)'],
    ['idle', 'Idle', 'var(--text-muted)'],
    ['mouth', 'Lip Sync', 'var(--blue)'],
  ];
  const bars = rows.map(([key, label, color]) => [key, barRow(doc, label, color)] as const);
  return {
    el: h(doc, 'div', { class: 'modifiers', 'data-testid': 'dev-modifiers' }, bars.map(([, b]) => b.el)),
    update(s) {
      for (const [key, bar] of bars) bar.set(s.behavior.weights[key]);
    },
  };
}

function visemeBars(doc: Document): { el: HTMLElement; update(s: DevSample): void } {
  const bars = VISEMES.map((v) => {
    const b = barRow(doc, v.toUpperCase(), 'var(--blue)');
    b.el.classList.add('short');
    return [v, b] as const;
  });
  return {
    el: h(doc, 'div', { class: 'visemes' }, bars.map(([, b]) => b.el)),
    update(s) {
      for (const [v, bar] of bars) bar.set(s.lipSync.visemes[v]);
    },
  };
}

// --- Debug HUD ---------------------------------------------------------------------------------------------------

export function hudPanel(doc: Document, history: DevHistory): Panel {
  const state = stateLine(doc);
  const emo = (['valence', 'arousal', 'energy', 'tension'] as const).map((k) => {
    const opts = k === 'valence' ? { min: -1, max: 1 } : { min: 0, max: 1 };
    return [k, metricChart(doc, k[0]!.toUpperCase() + k.slice(1), history.get(`assistant.${k}`), { ...opts, color: '#ff6422' })] as const;
  });
  const mouth = visemeBars(doc);
  const speaking = keyValue(doc, 'Speaking');
  const rms = metricChart(doc, 'RMS', history.get('user.rmsDb'), { min: -80, max: 0, color: '#29c978' });
  const pitch = metricChart(doc, 'Pitch', history.get('user.pitchHz'), { minSpan: 60, color: '#a968ff' });
  const mods = modifierBars(doc);
  const perf = h(doc, 'div', { class: 'perf-line tiny', 'data-testid': 'hud-perf' });
  const charts: Chart[] = [...emo.map(([, c]) => c), rms, pitch];
  const el = h(
    doc,
    'div',
    { class: 'hud' },
    h(doc, 'div', { class: 'section' }, state.el),
    h(doc, 'div', { class: 'section' }, h(doc, 'div', { class: 'section-label' }, 'Assistant Emotion'), h(doc, 'div', { class: 'grid4' }, emo.map(([, c]) => c.el))),
    h(doc, 'div', { class: 'section' }, h(doc, 'div', { class: 'section-label' }, 'Mouth'), mouth.el),
    h(doc, 'div', { class: 'section' }, h(doc, 'div', { class: 'section-label' }, 'User Voice'), speaking.el, h(doc, 'div', { class: 'grid2' }, rms.el, pitch.el)),
    h(doc, 'div', { class: 'section' }, h(doc, 'div', { class: 'section-label' }, 'Active Modifiers'), mods.el),
    h(doc, 'div', { class: 'section' }, perf),
  );
  return {
    el,
    update(s) {
      state.set(s.state);
      for (const [k, c] of emo) c.update(k === 'valence' ? signed(s.emotion.assistant[k]) : fmt(s.emotion.assistant[k]));
      mouth.update(s);
      const u = s.userVoice;
      const on = s.mic.state === 'on';
      speaking.set(on ? (u.speaking ? 'yes' : 'no') : `mic ${s.mic.state}`);
      rms.update(on ? `${u.rmsDb.toFixed(0)} dB` : '—');
      pitch.update(on && u.pitchHz !== null ? `${u.pitchHz.toFixed(0)} Hz` : '—');
      mods.update(s);
      setText(
        perf,
        [
          `FPS ${s.render.fps.toFixed(0)}`,
          `Frame ${ms(s.render.frameMs)}`,
          `Audio ${ms(audioLatencyMs(s))}`,
          `Emotion ${ms(s.telemetry?.emotionInferenceMs)}`,
          `${backendName(s)}`,
          `Lip frame ${ms(Number.isFinite(s.lipSync.frameAgeMs) ? s.lipSync.frameAgeMs : null)}`,
        ].join('   '),
      );
    },
    draw() {
      for (const c of charts) c.draw();
    },
  };
}

function backendName(s: DevSample): string {
  const mode = s.telemetry?.emotionBackend ?? s.emotionStatus.mode;
  return mode === 'ml-webgpu' ? 'WebGPU' : mode === 'ml-wasm' ? 'WASM' : mode === 'fallback' ? 'Fallback' : 'Heuristic';
}

// --- Developer Tools tabs ------------------------------------------------------------------------------------------

export function overviewPanel(doc: Document): Panel {
  const state = stateLine(doc);
  const signals = keyValue(doc, 'Signals');
  const voiceUi = keyValue(doc, 'Voice UI');
  const lip = { mode: keyValue(doc, 'Mode'), analyzer: keyValue(doc, 'Analyzer'), hz: keyValue(doc, 'Frames'), age: keyValue(doc, 'Frame age') };
  const sys = { fps: keyValue(doc, 'FPS'), frame: keyValue(doc, 'Frame'), draws: keyValue(doc, 'Draw calls'), tris: keyValue(doc, 'Triangles'), mem: keyValue(doc, 'Memory') };
  const emo = { val: keyValue(doc, 'Valence'), aro: keyValue(doc, 'Arousal'), en: keyValue(doc, 'Energy'), ten: keyValue(doc, 'Tension'), mode: keyValue(doc, 'Mode') };
  const user = { speaking: keyValue(doc, 'Speaking'), rms: keyValue(doc, 'RMS'), pitch: keyValue(doc, 'Pitch'), mic: keyValue(doc, 'Mic') };
  const mods = modifierBars(doc);
  const el = h(
    doc,
    'div',
    { class: 'overview' },
    card(doc, 'Conversation State', state.el, signals.el, voiceUi.el),
    card(doc, 'Lip Sync', ...Object.values(lip).map((k) => k.el)),
    card(doc, 'System', ...Object.values(sys).map((k) => k.el)),
    card(doc, 'Emotion Assistant', ...Object.values(emo).map((k) => k.el)),
    card(doc, 'User Voice', ...Object.values(user).map((k) => k.el)),
    card(doc, 'Active Mods', mods.el),
  );
  return {
    el,
    update(s) {
      state.set(s.state);
      signals.set(`${s.signals.userSpeaking ? 'user' : '—'} / ${s.signals.assistantSpeaking ? 'assistant' : '—'}${s.signals.crosstalk ? ' · crosstalk' : ''}`);
      voiceUi.set(s.voiceUi ? 'detected' : 'not found');
      lip.mode.set(s.lipSync.mode);
      lip.analyzer.set(s.lipSync.analyzer);
      lip.hz.set(`${s.lipSync.frameHz.toFixed(0)} Hz`);
      lip.age.set(ms(Number.isFinite(s.lipSync.frameAgeMs) ? s.lipSync.frameAgeMs : null));
      sys.fps.set(s.render.fps.toFixed(0));
      sys.frame.set(ms(s.render.frameMs));
      sys.draws.set(String(s.render.drawCalls));
      sys.tris.set(s.render.triangles.toLocaleString('en-US'));
      sys.mem.set(s.render.memoryMb === null ? 'n/a' : `${s.render.memoryMb.toFixed(0)} MB`);
      const a = s.emotion.assistant;
      emo.val.set(signed(a.valence));
      emo.aro.set(fmt(a.arousal));
      emo.en.set(fmt(a.energy));
      emo.ten.set(fmt(a.tension));
      emo.mode.set(a.mode);
      const u = s.userVoice;
      const on = s.mic.state === 'on';
      user.speaking.set(on ? (u.speaking ? 'yes' : 'no') : '—');
      user.rms.set(on ? `${u.rmsDb.toFixed(1)} dB` : '—');
      user.pitch.set(on && u.pitchHz !== null ? `${u.pitchHz.toFixed(0)} Hz` : '—');
      user.mic.set(s.mic.state);
      mods.update(s);
    },
    draw() {},
  };
}

export function audioPanel(doc: Document, history: DevHistory): Panel {
  const charts = {
    assistant: metricChart(doc, 'Assistant RMS', history.get('assistant.rmsDb'), { min: -90, max: 0, color: '#ff6422' }),
    user: metricChart(doc, 'User RMS', history.get('user.rmsDb'), { min: -90, max: 0, color: '#29c978' }),
    floor: metricChart(doc, 'Noise floor', history.get('user.noiseFloorDb'), { min: -90, max: 0, color: '#6f7b87' }),
    pitch: metricChart(doc, 'Pitch', history.get('user.pitchHz'), { minSpan: 60, color: '#a968ff' }),
    conf: metricChart(doc, 'Pitch confidence', history.get('user.pitchConfidence'), { min: 0, max: 1, color: '#a968ff' }),
    volume: metricChart(doc, 'Lip-sync level', history.get('assistant.volume'), { min: 0, max: 1, color: '#2684ff' }),
  };
  const kv = {
    vad: keyValue(doc, 'VAD (user speaking)'),
    mode: keyValue(doc, 'Lip-sync mode'),
    analyzer: keyValue(doc, 'Viseme analyzer'),
    feature: keyValue(doc, 'Assistant feature worklet'),
    mic: keyValue(doc, 'Microphone worklet'),
    contexts: keyValue(doc, 'Audio contexts'),
    latency: keyValue(doc, 'Assistant latency'),
  };
  const visemes = visemeBars(doc);
  const el = h(
    doc,
    'div',
    { class: 'tab-grid' },
    h(doc, 'div', { class: 'grid3' }, Object.values(charts).map((c) => c.el)),
    h(doc, 'div', { class: 'grid2' }, card(doc, 'Pipeline', ...Object.values(kv).map((k) => k.el)), card(doc, 'Viseme analyzer output', visemes.el)),
  );
  return {
    el,
    update(s) {
      const t = s.telemetry;
      const u = s.userVoice;
      const on = s.mic.state === 'on';
      charts.assistant.update(t?.assistantRmsDb === null || !t ? '—' : `${t.assistantRmsDb.toFixed(0)} dB`);
      charts.user.update(on ? `${u.rmsDb.toFixed(0)} dB` : '—');
      charts.floor.update(on ? `${u.noiseFloorDb.toFixed(0)} dB` : '—');
      charts.pitch.update(on && u.pitchHz !== null ? `${u.pitchHz.toFixed(0)} Hz` : '—');
      charts.conf.update(on ? fmt(u.pitchConfidence) : '—');
      charts.volume.update(fmt(s.lipSync.volume));
      kv.vad.set(on ? (u.speaking ? 'speaking' : 'silent') : `mic ${s.mic.state}`);
      kv.mode.set(s.lipSync.mode);
      kv.analyzer.set(t?.analyzer ?? s.lipSync.analyzer);
      kv.feature.set(t ? (t.featureWorklet ? 'running' : 'off') : '—');
      kv.mic.set(t ? (t.micWorklet ? 'running' : 'off') : '—');
      kv.contexts.set(t ? t.contexts.map((c) => `${c.id} ${c.state} ${(c.sampleRate / 1000).toFixed(0)}k`).join(' · ') || 'none' : '—');
      kv.latency.set(ms(audioLatencyMs(s)));
      visemes.update(s);
    },
    draw() {
      for (const c of Object.values(charts)) c.draw();
    },
  };
}

export function emotionPanel(doc: Document, history: DevHistory, bridge: DevBridge): Panel {
  const columns = (['assistant', 'user'] as const).map((ch) => {
    const color = ch === 'assistant' ? '#ff6422' : '#29c978';
    const sw = switchRow(doc, ch === 'assistant' ? 'Assistant emotion expression' : 'User emotion reactions', true, (on) => bridge.emotion.setEnabled(ch, on), `prosopon-${ch}-emotion`);
    const charts = (['valence', 'arousal', 'energy', 'tension', 'confidence'] as const).map(
      (k) => [k, metricChart(doc, k[0]!.toUpperCase() + k.slice(1), history.get(`${ch}.${k}`), { min: k === 'valence' ? -1 : 0, max: 1, color })] as const,
    );
    const kv = {
      valenceConfidence: keyValue(doc, 'Valence confidence'),
      pitchLift: keyValue(doc, 'Pitch lift'),
      pitchVariation: keyValue(doc, 'Pitch variation'),
      mode: keyValue(doc, 'Mode'),
      active: keyValue(doc, 'Voice'),
    };
    const el = card(doc, ch === 'assistant' ? 'Assistant' : 'User', sw.el, h(doc, 'div', { class: 'grid2' }, charts.map(([, c]) => c.el)), ...Object.values(kv).map((k) => k.el));
    return { ch, el, sw, charts, kv };
  });
  return {
    el: h(doc, 'div', { class: 'grid2' }, columns.map((c) => c.el)),
    update(s) {
      for (const c of columns) {
        const e = s.emotion[c.ch];
        if (c.sw.input.checked !== e.enabled) c.sw.input.checked = e.enabled;
        for (const [k, chart] of c.charts) chart.update(k === 'valence' ? signed(e[k]) : fmt(e[k]));
        c.kv.valenceConfidence.set(fmt(e.valenceConfidence));
        c.kv.pitchLift.set(signed(e.pitchLift));
        c.kv.pitchVariation.set(fmt(e.pitchVariation));
        c.kv.mode.set(e.mode);
        c.kv.active.set(e.active ? 'active' : 'silent');
      }
    },
    draw() {
      for (const c of columns) for (const [, chart] of c.charts) chart.draw();
    },
  };
}

export function behaviorPanel(doc: Document): Panel {
  const mods = modifierBars(doc);
  const pose: [string, (s: DevSample) => string][] = [
    ['Head yaw', (s) => deg(s.behavior.pose.headYaw)],
    ['Head pitch', (s) => deg(s.behavior.pose.headPitch)],
    ['Head roll', (s) => deg(s.behavior.pose.headRoll)],
    ['Lean', (s) => deg(s.behavior.pose.lean)],
    ['Breath', (s) => fmt(s.behavior.pose.breath)],
    ['Gaze yaw', (s) => `${s.behavior.pose.gazeYaw.toFixed(1)}°`],
    ['Gaze pitch', (s) => `${s.behavior.pose.gazePitch.toFixed(1)}°`],
    ['Body yaw', (s) => deg(s.behavior.pose.bodyYaw)],
    ['Body roll', (s) => deg(s.behavior.pose.bodyRoll)],
  ];
  const kvs = pose.map(([label, get]) => [keyValue(doc, label), get] as const);
  const expr = (['blink', 'happy', 'relaxed', 'sad', 'angry', 'surprised'] as const).map((k) => [k, barRow(doc, k, 'var(--accent)')] as const);
  return {
    el: h(
      doc,
      'div',
      { class: 'grid2' },
      card(doc, 'Composition (effective gains)', mods.el),
      card(doc, 'Final pose', ...kvs.map(([k]) => k.el)),
      card(doc, 'Procedural expressions', ...expr.map(([, b]) => b.el)),
    ),
    update(s) {
      mods.update(s);
      for (const [k, get] of kvs) k.set(get(s));
      for (const [k, b] of expr) b.set(s.behavior.expressions[k]);
    },
    draw() {},
  };
}

/** Gesture status and controls; used by Developer Tools and Avatar Controls. */
export function gesturePanel(doc: Document, bridge: DevBridge, testPrefix: string): Panel {
  const kv = {
    current: keyValue(doc, 'Current gesture'),
    phase: keyValue(doc, 'Phase'),
    progress: barRow(doc, 'Progress', 'var(--yellow)'),
    intensity: barRow(doc, 'Intensity', 'var(--yellow)'),
    cooldown: keyValue(doc, 'Cooldown'),
    count: keyValue(doc, 'Gestures / nods'),
  };
  const auto = switchRow(doc, 'Auto (scheduled gestures)', true, (on) => bridge.gestures.setAuto(on));
  const enabled = switchRow(doc, 'Enabled', true, (on) => bridge.gestures.setEnabled(on));
  const cancel = h(doc, 'button', { type: 'button' }, 'Cancel');
  cancel.addEventListener('click', () => bridge.gestures.cancel());
  const triggers = bridge.gestures.types.map((type) => {
    const b = h(doc, 'button', { type: 'button', 'data-testid': `${testPrefix}-gesture-${type}` }, type.replace('-', ' '));
    b.addEventListener('click', () => bridge.gestures.trigger(type));
    return b;
  });
  return {
    el: h(
      doc,
      'div',
      { class: 'grid2' },
      card(doc, 'Status', ...Object.values(kv).map((k) => k.el)),
      card(doc, 'Controls', auto.el, enabled.el, h(doc, 'div', { class: 'actions' }, cancel), h(doc, 'div', { class: 'section-label' }, 'Trigger'), h(doc, 'div', { class: 'btn-grid' }, triggers)),
    ),
    update(s) {
      const g = s.gesture;
      kv.current.set(g.type ?? '—');
      kv.phase.set(g.phase);
      kv.progress.set(g.progress);
      kv.intensity.set(g.intensity);
      kv.cooldown.set(`${g.cooldown.toFixed(1)} s`);
      kv.count.set(`${g.count} / ${g.nods}`);
      if (auto.input.checked !== g.auto) auto.input.checked = g.auto;
      if (enabled.input.checked !== g.enabled) enabled.input.checked = g.enabled;
      for (const b of triggers) b.disabled = !g.enabled;
    },
    draw() {},
  };
}

export function avatarTabPanel(doc: Document, bridge: DevBridge, openAvatarControls: () => void): Panel {
  const camera = keyValue(doc, 'Camera');
  const size = keyValue(doc, 'Avatar size');
  const position = keyValue(doc, 'Position');
  const open = h(doc, 'button', { type: 'button', class: 'primary', 'data-testid': 'open-avatar-controls' }, 'Open Avatar Controls');
  open.addEventListener('click', openAvatarControls);
  const move = h(doc, 'button', { type: 'button' }, 'Move avatar');
  move.addEventListener('click', () => bridge.setPlacementMode(!bridge.placementMode));
  return {
    el: card(doc, 'Avatar', camera.el, size.el, position.el, h(doc, 'div', { class: 'actions' }, open, move)),
    update() {
      const v = bridge.view.value;
      camera.set(presetLabel(v.camera.preset) + (isCameraModified(v.camera) ? ' · modified' : ''));
      size.set(`${Math.round(v.placement.scale * 100)} %`);
      position.set(`${v.placement.x.toFixed(2)} / ${v.placement.y.toFixed(2)}`);
      setText(move, bridge.placementMode ? 'Finish moving' : 'Move avatar');
    },
    draw() {},
  };
}

export function settingsTabPanel(doc: Document, bridge: DevBridge, resetWindows: () => void): Panel {
  const off = h(doc, 'button', { type: 'button', 'data-testid': 'dev-mode-off' }, 'Turn off Developer mode');
  off.addEventListener('click', () => bridge.setDeveloperMode(false));
  const reset = h(doc, 'button', { type: 'button' }, 'Reset window layout');
  reset.addEventListener('click', resetWindows);
  const keys = Object.values(STORAGE_KEYS).map((k) => h(doc, 'div', { class: 'tiny' }, k));
  return {
    el: h(
      doc,
      'div',
      { class: 'grid2' },
      card(
        doc,
        'Developer mode',
        h(doc, 'p', { class: 'note' }, 'Diagnostics run only while Developer mode is on. Turning it off removes every developer window and stops telemetry.'),
        h(doc, 'div', { class: 'actions' }, off, reset),
      ),
      card(doc, 'Stored settings (chrome.storage.local)', ...keys),
    ),
    update() {},
    draw() {},
  };
}

export function presetLabel(preset: string): string {
  return preset === 'face' ? 'Face' : preset === 'waist' ? 'Waist' : 'Full body';
}

export type { BarRow, KeyValue };
