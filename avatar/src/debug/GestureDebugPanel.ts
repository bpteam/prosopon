import type GUI from 'lil-gui';
import { GESTURE_TYPES, type GestureType } from '../avatar/gesture/Gesture';
import { GESTURE_CONFIG, type GestureTypeConfig } from '../avatar/gesture/GestureConfig';
import type { GestureEngine } from '../avatar/gesture/GestureEngine';

const LABELS: Record<GestureType, string> = {
  nod: 'Nod',
  'double-nod': 'Double Nod',
  'head-tilt': 'Head Tilt',
  'body-shift': 'Body Shift',
  'shoulder-shift': 'Shoulder Shift',
  'hand-emphasis': 'Hand Emphasis',
};

const AMPLITUDES = [
  'headPitch',
  'headYaw',
  'headRoll',
  'bodyLean',
  'bodyYaw',
  'bodyRoll',
  'shoulder',
  'armForward',
  'armOutward',
  'elbowBend',
] as const satisfies readonly (keyof GestureTypeConfig)[];

/**
 * "Gestures" folder of the sandbox GUI (US-008): state readouts, manual triggers and live amplitude tuning.
 * Amplitudes are radians at intensity 1; "copy settings" puts the changed values on the clipboard as a
 * GestureConfigOverrides literal to paste into GESTURE_CONFIG or pass to another model's GestureEngine.
 */
export class GestureDebugPanel {
  readonly folder: GUI;
  private readonly view = {
    current: '—',
    phase: 'none',
    progress: 0,
    intensity: 0,
    cooldown: 0,
    count: 0,
    triggerIntensity: GESTURE_CONFIG.forcedIntensity,
  };

  constructor(
    parent: GUI,
    private readonly engine: GestureEngine,
  ) {
    this.folder = parent.addFolder('Gestures');
    this.folder.domElement.dataset.testid = 'gesture-panel';
    const f = this.folder;
    const c = engine.config;
    const toggles = { enabled: engine.enabled, auto: engine.auto };
    f.add(toggles, 'enabled').name('Enabled').onChange((v: boolean) => (engine.enabled = v));
    f.add(toggles, 'auto').name('Auto gestures').onChange((v: boolean) => (engine.auto = v));
    f.add(c, 'rateScale', 0, 10, 0.1).name('rate × (tuning)');
    f.add(this.view, 'current').name('Current gesture').disable().listen();
    f.add(this.view, 'phase').name('Phase').disable().listen();
    f.add(this.view, 'progress', 0, 1).name('Progress').disable().listen();
    f.add(this.view, 'intensity', 0, 1).name('Intensity').disable().listen();
    f.add(this.view, 'cooldown', 0, 8).name('Cooldown (s)').disable().listen();
    f.add(this.view, 'count').name('Gestures started').disable().listen();

    f.add(this.view, 'triggerIntensity', 0, 1, 0.05).name('trigger intensity');
    for (const type of GESTURE_TYPES) {
      f.add({ go: () => engine.trigger(type, this.view.triggerIntensity) }, 'go').name(LABELS[type]);
    }
    f.add({ cancel: () => engine.cancel() }, 'cancel').name('Cancel');

    const amps = f.addFolder('Amplitudes (rad @ intensity 1)');
    for (const type of GESTURE_TYPES) {
      const t = c.types[type];
      const sub = amps.addFolder(LABELS[type]);
      for (const key of AMPLITUDES) {
        if (GESTURE_CONFIG.types[type][key] === 0) continue;
        sub.add(t, key, key.startsWith('arm') || key === 'elbowBend' ? -0.6 : -0.2, key.startsWith('arm') || key === 'elbowBend' ? 0.6 : 0.2, 0.001);
      }
      sub.close();
    }
    amps.close();
    f.add({ copy: () => void this.copySettings() }, 'copy').name('copy settings');
  }

  /** Refresh readouts; call once per frame. */
  update(): void {
    const g = this.engine.current;
    const v = this.view;
    v.current = g.type ?? '—';
    v.phase = g.phase;
    v.progress = g.progress;
    v.intensity = g.intensity;
    v.cooldown = this.engine.cooldownRemaining;
    v.count = this.engine.history.gestureCount;
  }

  dispose(): void {
    this.folder.destroy();
  }

  private async copySettings(): Promise<void> {
    const changed: Record<string, Record<string, number>> = {};
    for (const type of GESTURE_TYPES) {
      for (const key of AMPLITUDES) {
        const v = this.engine.config.types[type][key];
        if (v !== GESTURE_CONFIG.types[type][key]) (changed[type] ??= {})[key] = Number(v.toFixed(4));
      }
    }
    const text = JSON.stringify({ types: changed, rateScale: this.engine.config.rateScale }, null, 2);
    console.info('[gestures] settings:\n' + text);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard needs focus/permission; the console has it anyway.
    }
  }
}
