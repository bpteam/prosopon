import { FpsMeter } from '@avatar/debug/FpsMeter';
import {
  DEV_WINDOW_SPECS,
  type DevWindowId,
  type DevWindowState,
  type DevWindowsSettingsV1,
  type WindowBounds,
} from '../../shared/settings';
import type { DevTelemetry } from '../../shared/messages';
import { FLOATING_WINDOW_CSS, FloatingWindow, type WindowAction } from '../shared/FloatingWindow';
import { ICONS } from '../shared/icons';
import { cameraPanel, expressionPanel, posePanel, quickToolbar, scenePanel } from './avatarControls';
import type { DevBridge, DevSample, DevToolsHandle } from './DevBridge';
import { DevHistory, SAMPLE_HZ } from './History';
import {
  audioPanel,
  avatarTabPanel,
  behaviorPanel,
  emotionPanel,
  gesturePanel,
  hudPanel,
  overviewPanel,
  semanticPanel,
  settingsTabPanel,
  type Panel,
} from './panels';
import { DEV_CSS, tabs, type Tabs } from './widgets';
import { CALIBRATION_CSS, calibrationPanel, type CalibrationSlot } from './calibrationPanel';
import { CalibrationRunner } from '../../calibration/CalibrationRunner';
import { buildScenario } from '../../calibration/scenarios';

const DEVTOOLS_TABS = ['Overview', 'Audio', 'Emotion', 'Behavior', 'Gestures', 'Semantic', 'Calibration', 'Avatar', 'Settings'] as const;
const AVATAR_TABS = ['Camera', 'Expressions', 'Poses', 'Gestures', 'Scene'] as const;
const TITLES: Record<DevWindowId, string> = { hud: 'Prosopon Debug', devtools: 'Prosopon Developer Tools', avatarControls: 'Avatar Controls' };

/** Charts repaint at most this often (they are canvas 2D, but still not at 60 FPS). */
const DRAW_HZ = 10;

interface OpenWindow {
  win: FloatingWindow;
  /** Panels of this window; with tabs, only the selected tab's panel is updated and drawn. */
  panels: Map<string, Panel>;
  tabs: Tabs | null;
}

/**
 * Developer Mode UI: Debug HUD, Developer Tools and Avatar Controls windows, and the quick camera toolbar, inside
 * Prosopon's own shadow root. Samples the bridge at 10 Hz from the render loop's frame() call, keeps 30 s of history
 * in fixed ring buffers, repaints only what is visible. Mounted once per Developer Mode session; dispose() leaves
 * nothing behind (no listeners, no timers, no buffers).
 */
export class DevTools implements DevToolsHandle {
  readonly history = new DevHistory();
  private readonly fps = new FpsMeter(0.5);
  private readonly windows = new Map<DevWindowId, OpenWindow>();
  private readonly toolbar: Panel;
  private sinceSample = 0;
  private sinceDraw = 0;
  private last: DevSample | null = null;
  private readonly offView: () => void;
  private disposed = false;
  /** The calibration wizard's run (created on Start, ticked every frame, discarded with Developer Mode). */
  private calibrationRunner: CalibrationRunner | null = null;
  readonly calibration: CalibrationSlot;

  constructor(private readonly bridge: DevBridge) {
    const tools = this;
    this.calibration = {
      get runner() {
        return tools.calibrationRunner;
      },
      create: () => {
        this.calibrationRunner = new CalibrationRunner({ host: bridge.calibration, scenario: buildScenario(bridge.calibration.scenarioOptions) });
        return this.calibrationRunner;
      },
    };
    const layer = bridge.layer;
    layer.addStyle('floating-window', FLOATING_WINDOW_CSS);
    layer.addStyle('dev', DEV_CSS);
    layer.addStyle('calibration', CALIBRATION_CSS);
    this.toolbar = quickToolbar(bridge.doc, bridge);
    layer.root.append(this.toolbar.el);
    for (const id of ['hud', 'devtools', 'avatarControls'] as const) {
      const saved = bridge.windows.value.windows[id];
      if (saved ? saved.open : DEV_WINDOW_SPECS[id].openByDefault) this.open(id, false);
    }
    this.offView = bridge.view.onChange(() => this.refreshControls());
    bridge.setTelemetry(true);
    layer.host.dataset.devTools = 'mounted';
  }

  /** Open windows (tests and E2E). */
  get openWindows(): DevWindowId[] {
    return [...this.windows.keys()];
  }

  window(id: DevWindowId): FloatingWindow | null {
    return this.windows.get(id)?.win ?? null;
  }

  frame(delta: number): void {
    if (this.disposed) return;
    if (this.fps.tick(delta) && this.last) {
      this.last.render.fps = this.fps.fps;
      this.last.render.frameMs = this.fps.frameTime;
    }
    this.sinceSample += delta;
    this.sinceDraw += delta;
    // Epsilon: six 1/60 s frames sum to slightly under 0.1 s in floating point and would drop every 10th sample.
    if (this.sinceSample >= 1 / SAMPLE_HZ - 1e-6) {
      this.sinceSample = Math.max(0, this.sinceSample - 1 / SAMPLE_HZ) % (1 / SAMPLE_HZ);
      this.sampleNow();
    }
    // The calibration wizard runs on this clock too (its waits resolve on frames): no timers of its own.
    this.calibrationRunner?.tick(delta);
    if (this.sinceDraw >= 1 / DRAW_HZ - 1e-6) {
      this.sinceDraw = Math.max(0, this.sinceDraw - 1 / DRAW_HZ) % (1 / DRAW_HZ);
      for (const w of this.windows.values()) this.visiblePanel(w)?.draw();
    }
  }

  /** Takes a sample and updates visible panels (called at SAMPLE_HZ by frame()). */
  sampleNow(): void {
    const s = this.bridge.sample();
    s.render.fps = this.fps.fps;
    s.render.frameMs = this.fps.frameTime;
    this.last = s;
    this.history.push(s);
    for (const w of this.windows.values()) this.visiblePanel(w)?.update(s);
  }

  pushTelemetry(_t: DevTelemetry): void {
    // Picked up by the next sample (DevSample.telemetry); nothing to redraw in between.
  }

  refresh(): void {
    for (const w of this.windows.values()) w.win.refit();
    this.refreshControls();
  }

  open(id: DevWindowId, focus = true): FloatingWindow {
    const existing = this.windows.get(id);
    if (existing) {
      if (focus) existing.win.focus();
      return existing.win;
    }
    const doc = this.bridge.doc;
    const spec = DEV_WINDOW_SPECS[id];
    const saved = this.bridge.windows.value.windows[id];
    const actions: WindowAction[] = [];
    if (id === 'hud') {
      actions.push(
        { id: 'expand', label: 'Open Developer Tools', icon: ICONS.expand, onClick: () => this.open('devtools') },
        {
          id: 'pin',
          label: 'Pin',
          icon: ICONS.pin,
          pressed: saved?.pinned ?? false,
          onClick: (b) => {
            const pinned = b.getAttribute('aria-pressed') !== 'true';
            b.setAttribute('aria-pressed', String(pinned));
            this.saveWindow(id, { pinned }, 'now');
          },
        },
      );
    }
    const win = new FloatingWindow(doc, {
      title: TITLES[id],
      spec,
      bounds: saved ?? spec.initial(this.bridge.layer.viewport),
      viewport: () => this.bridge.layer.viewport,
      actions,
      autoHeight: id === 'hud',
      testId: `dev-window-${id}`,
      onBounds: (b, final) => this.saveWindow(id, b, final ? 'now' : 'debounced'),
      // A pinned HUD ignores Escape (it stays while you work in the other windows); its × still closes it.
      onClose: (reason) => {
        if (reason === 'escape' && id === 'hud' && this.bridge.windows.value.windows.hud?.pinned) return;
        this.close(id);
      },
    });
    const entry: OpenWindow = { win, panels: new Map(), tabs: null };
    this.buildContent(id, entry);
    this.windows.set(id, entry);
    this.bridge.layer.root.append(win.el);
    this.saveWindow(id, { ...win.bounds, open: true }, 'now');
    if (this.last) this.visiblePanel(entry)?.update(this.last);
    if (focus) win.focus();
    return win;
  }

  close(id: DevWindowId): void {
    const w = this.windows.get(id);
    if (!w) return;
    w.win.dispose();
    this.windows.delete(id);
    this.saveWindow(id, { open: false }, 'now');
  }

  /**
   * A Developer Mode toggle starts a fresh diagnostics session. Restore its
   * default windows so closing the HUD cannot permanently remove the only UI
   * entry point to the developer tools. Page reloads do not call this method,
   * so a close still survives a reload while Developer Mode remains on.
   */
  prepareNextSession(): void {
    for (const id of ['hud', 'devtools', 'avatarControls'] as const) {
      if (DEV_WINDOW_SPECS[id].openByDefault) this.saveWindow(id, { open: true }, 'now');
    }
  }

  /** Every window back to its initial geometry. */
  resetLayout(): void {
    const next: DevWindowsSettingsV1 = { ...this.bridge.windows.value, windows: {} };
    const open = [...this.windows.keys()];
    for (const id of open) {
      this.windows.get(id)!.win.dispose();
      this.windows.delete(id);
    }
    this.bridge.windows.set(next, 'now');
    for (const id of open) this.open(id, false);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // Leaving Developer Mode ends a calibration: its recordings are destroyed, not kept for later.
    if (this.calibrationRunner && this.calibrationRunner.view.phase !== 'discarded') void this.calibrationRunner.discard();
    this.calibrationRunner = null;
    this.offView();
    for (const w of this.windows.values()) w.win.dispose();
    this.windows.clear();
    this.toolbar.el.remove();
    this.bridge.setTelemetry(false);
    delete this.bridge.layer.host.dataset.devTools;
  }

  private visiblePanel(w: OpenWindow): Panel | undefined {
    return w.tabs ? w.panels.get(w.tabs.selected) : w.panels.get('main');
  }

  private refreshControls(): void {
    this.toolbar.update(this.last!);
    for (const w of this.windows.values()) {
      const p = this.visiblePanel(w);
      if (p && this.last) p.update(this.last);
    }
  }

  private saveWindow(id: DevWindowId, change: Partial<DevWindowState> | WindowBounds, persist: 'debounced' | 'now'): void {
    const cur = this.bridge.windows.value;
    const prev = cur.windows[id] ?? { ...DEV_WINDOW_SPECS[id].initial(this.bridge.layer.viewport), open: false, pinned: false };
    this.bridge.windows.set({ ...cur, windows: { ...cur.windows, [id]: { ...prev, ...change } } }, persist);
  }

  private buildContent(id: DevWindowId, entry: OpenWindow): void {
    const doc = this.bridge.doc;
    const body = entry.win.body;
    if (id === 'hud') {
      const p = hudPanel(doc, this.history);
      entry.panels.set('main', p);
      body.append(p.el);
      return;
    }
    const names = id === 'devtools' ? DEVTOOLS_TABS : AVATAR_TABS;
    const make = (name: string): Panel => {
      const b = this.bridge;
      if (id === 'devtools') {
        switch (name) {
          case 'Overview':
            return overviewPanel(doc);
          case 'Audio':
            return audioPanel(doc, this.history);
          case 'Emotion':
            return emotionPanel(doc, this.history, b);
          case 'Behavior':
            return behaviorPanel(doc);
          case 'Gestures':
            return gesturePanel(doc, b, 'devtools');
          case 'Semantic':
            return semanticPanel(doc, b);
          case 'Calibration':
            return calibrationPanel(doc, b, this.calibration);
          case 'Avatar':
            return avatarTabPanel(doc, b, () => this.open('avatarControls'));
          default:
            return settingsTabPanel(doc, b, () => this.resetLayout());
        }
      }
      switch (name) {
        case 'Camera':
          return cameraPanel(doc, b);
        case 'Expressions':
          return expressionPanel(doc, b);
        case 'Poses':
          return posePanel(doc, b);
        case 'Gestures':
          return gesturePanel(doc, b, 'avatar');
        default:
          return scenePanel(doc, b);
      }
    };
    const saved = this.bridge.windows.value.tabs[id];
    entry.tabs = tabs(
      doc,
      names,
      saved ?? names[0]!,
      (name) => {
        // Panels are built on first view: a tab never opened costs nothing.
        if (!entry.panels.has(name)) {
          const p = make(name);
          entry.panels.set(name, p);
          entry.tabs?.panels.get(name)?.append(p.el);
        }
        if (this.last) entry.panels.get(name)!.update(this.last);
        const cur = this.bridge.windows.value;
        if (cur.tabs[id] !== name) this.bridge.windows.set({ ...cur, tabs: { ...cur.tabs, [id]: name } }, 'debounced');
      },
      `prosopon-${id}`,
    );
    // The first select() ran before entry.tabs was assigned: attach its panel now.
    const first = entry.tabs.selected;
    const firstPanel = entry.panels.get(first);
    if (firstPanel && !firstPanel.el.isConnected) entry.tabs.panels.get(first)!.append(firstPanel.el);
    body.append(entry.tabs.el);
  }
}

export function mountDevTools(bridge: DevBridge): DevTools {
  return new DevTools(bridge);
}
