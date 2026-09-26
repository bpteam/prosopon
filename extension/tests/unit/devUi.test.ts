// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { CLOSED_MOUTH } from '@avatar/avatar/MouthShape';
import { NEUTRAL_EMOTION } from '@avatar/audio/emotion/EmotionFrame';
import { SILENT_USER_VOICE_FRAME } from '@avatar/audio/user/UserVoiceFrame';
import { EMPTY_PROCEDURAL_POSE } from '@avatar/avatar/Avatar';
import { GESTURE_TYPES } from '@avatar/avatar/gesture/Gesture';
import { DevModeSwitch } from '../../src/content/DevModeSwitch';
import {
  DEFAULT_VIEW_SETTINGS,
  DEV_WINDOW_SPECS,
  cloneView,
  sanitizeDevWindows,
  type AvatarViewSettingsV1,
  type DevWindowsSettingsV1,
} from '../../src/shared/settings';
import { FloatingWindow } from '../../src/ui/shared/FloatingWindow';
import { UiLayer } from '../../src/ui/shared/UiLayer';
import { NEUTRAL_POSE_OFFSETS, type DevBridge, type DevSample, type DevToolsHandle } from '../../src/ui/dev/DevBridge';
import { DevTools } from '../../src/ui/dev/DevTools';
import { ManualControls } from '../../src/ui/dev/ManualControls';
import { PlacementHandle } from '../../src/ui/placement/PlacementHandle';

function pointer(type: string, x: number, y: number): PointerEvent {
  return new PointerEvent(type, { clientX: x, clientY: y, button: 0, pointerId: 1, bubbles: true });
}

function sample(): DevSample {
  return {
    time: 0,
    avatarLoaded: true,
    voiceUi: true,
    offscreenConnected: true,
    state: 'speaking',
    signals: { voiceUi: true, userSpeaking: false, assistantSpeaking: true, crosstalk: false },
    lipSync: { mode: 'viseme', analyzer: 'ready', active: true, volume: 0.4, visemes: { ...CLOSED_MOUTH, aa: 0.72 }, frameHz: 30, frameAgeMs: 24 },
    mic: { state: 'off' },
    userVoice: SILENT_USER_VOICE_FRAME,
    emotion: {
      user: { ...NEUTRAL_EMOTION, active: false, enabled: true },
      assistant: { ...NEUTRAL_EMOTION, valence: 0.32, arousal: 0.68, active: true, enabled: true },
    },
    emotionStatus: { model: 'off', mode: 'heuristic', inferences: 0 },
    behavior: {
      state: 'speaking',
      weights: { idle: 1, state: 1, assistantEmotion: 0.85, userEmotion: 0, userReaction: 0.25, gesture: 0.6, mouth: 0.72 },
      pose: { ...EMPTY_PROCEDURAL_POSE },
      gesture: { type: null, phase: 'none', progress: 0, intensity: 0 },
      expressions: { blink: 0, aa: 0.72, ih: 0, ou: 0, ee: 0, oh: 0, happy: 0, sad: 0, angry: 0, relaxed: 0, surprised: 0 },
    },
    gesture: { type: null, phase: 'none', progress: 0, intensity: 0, cooldown: 0, count: 0, nods: 0, auto: true, enabled: true },
    render: { fps: 60, frameMs: 16.7, drawCalls: 12, triangles: 40000, pixelRatio: 1, memoryMb: null },
    semantic: {
      available: true,
      enabled: true,
      error: null,
      pacing: true,
      mode: 'speech',
      spokenChars: 120,
      pending: 1,
      dropped: 0,
      messages: 1,
      segments: 6,
      cues: 3,
      intents: 3,
      accepted: 1,
      probabilityScale: 1,
      busyMs: 0.8,
      entries: [
        {
          segmentId: 'm#0',
          text: 'Да, именно.',
          early: true,
          cues: [{ type: 'agreement', confidence: 1, strength: 0.8 }],
          matches: [{ kind: 'agreement', marker: 'Да, именно', locale: 'ru', tier: 'strong', confidence: 1 }],
          modifiers: [],
          decision: { accepted: true, gesture: 'nod', reason: null, probability: 0.6, cue: 'agreement', intensity: 0.8 },
        },
        {
          segmentId: 'm#1',
          text: 'Но тут есть важный нюанс.',
          early: false,
          cues: [{ type: 'contrast', confidence: 0.92, strength: 1 }],
          matches: [{ kind: 'contrast', marker: 'Но', locale: 'ru', tier: 'medium', confidence: 0.82 }],
          modifiers: [],
          decision: { accepted: false, gesture: null, reason: 'cooldown', probability: 0, cue: 'contrast', intensity: 0 },
        },
      ],
    },
    telemetry: null,
  };
}

function fakeBridge(doc: Document) {
  let view: AvatarViewSettingsV1 = cloneView(DEFAULT_VIEW_SETTINGS);
  let windows: DevWindowsSettingsV1 = sanitizeDevWindows({});
  const layer = new UiLayer(doc);
  const viewListeners = new Set<() => void>();
  const calls = { windowWrites: [] as { value: DevWindowsSettingsV1; persist: string }[], telemetry: [] as boolean[], samples: 0 };
  const bridge: DevBridge = {
    doc,
    layer,
    sample: () => {
      calls.samples++;
      return sample();
    },
    windows: {
      get value() {
        return windows;
      },
      set(value, persist) {
        windows = value;
        calls.windowWrites.push({ value, persist });
      },
    },
    view: {
      get value() {
        return view;
      },
      update(change) {
        view = { ...view, camera: { ...view.camera, ...change.camera }, placement: { ...view.placement, ...change.placement } };
        for (const l of viewListeners) l();
      },
      resetCamera() {
        view = { ...view, camera: { ...view.camera, distanceOffset: 0, targetYOffset: 0, yaw: 0, pitch: 0 } };
        for (const l of viewListeners) l();
      },
      onChange(l) {
        viewListeners.add(l);
        return () => void viewListeners.delete(l);
      },
    },
    setPlacementMode: vi.fn(),
    placementMode: false,
    setDeveloperMode: vi.fn(),
    camera: { preset: 'waist', adjust: { distanceOffset: 0, targetYOffset: 0, yaw: 0, pitch: 0 } },
    scene: { helpers: () => ({ grid: false, skeleton: false, axes: false }), setHelpers: vi.fn(), transparent: true, setTransparent: vi.fn() },
    avatar: {
      listExpressions: () => ['happy', 'sad', 'blink'],
      hasExpression: (n) => ['happy', 'sad', 'blink'].includes(n),
      setExpressionPreview: vi.fn(),
      expressionPreview: false,
      previewExpression: vi.fn(() => true),
      clearExpressions: vi.fn(),
      setPoseOffsets: vi.fn(),
      poseOffsets: NEUTRAL_POSE_OFFSETS,
      resetPoseOffsets: vi.fn(),
    },
    emotion: { setEnabled: vi.fn() },
    gestures: { types: GESTURE_TYPES, trigger: vi.fn(() => true), cancel: vi.fn(), setAuto: vi.fn(), setEnabled: vi.fn() },
    semantic: { setEnabled: vi.fn(), setPacing: vi.fn(), setProbabilityScale: vi.fn() },
    setTelemetry: (on) => void calls.telemetry.push(on),
  };
  return { bridge, layer, calls, get view() {
    return view;
  } };
}

describe('FloatingWindow drag', () => {
  it('drag by the header updates bounds, schedules persistence, flushes on pointerup', () => {
    const onBounds = vi.fn();
    const win = new FloatingWindow(document, {
      title: 'Test',
      spec: DEV_WINDOW_SPECS.devtools,
      bounds: { x: 100, y: 100, width: 700, height: 500 },
      viewport: () => ({ width: 1600, height: 900 }),
      onBounds,
      onClose: vi.fn(),
    });
    document.body.append(win.el);
    const head = win.el.firstElementChild as HTMLElement;
    head.dispatchEvent(pointer('pointerdown', 150, 110));
    head.dispatchEvent(pointer('pointermove', 250, 160));
    expect(win.bounds).toMatchObject({ x: 200, y: 150 });
    expect(onBounds).toHaveBeenLastCalledWith(expect.objectContaining({ x: 200, y: 150 }), false); // debounced write
    head.dispatchEvent(pointer('pointermove', 5000, 5000));
    expect(win.bounds.y).toBeLessThanOrEqual(900 - 24); // the header stays on screen
    head.dispatchEvent(pointer('pointerup', 5000, 5000));
    expect(onBounds).toHaveBeenLastCalledWith(win.bounds, true); // flush
    expect(win.el.style.left).toBe(`${win.bounds.x}px`);
  });

  it('resizes from the corner within min/max, and Escape closes', () => {
    const onClose = vi.fn();
    const win = new FloatingWindow(document, {
      title: 'Test',
      spec: DEV_WINDOW_SPECS.devtools,
      bounds: { x: 0, y: 0, width: 700, height: 500 },
      viewport: () => ({ width: 1600, height: 900 }),
      onBounds: vi.fn(),
      onClose,
    });
    document.body.append(win.el);
    const corner = [...win.el.children].find((c) => c.classList.contains('br')) as HTMLElement;
    corner.dispatchEvent(pointer('pointerdown', 700, 500));
    corner.dispatchEvent(pointer('pointermove', 100, 100));
    expect([win.bounds.width, win.bounds.height]).toEqual([680, 420]);
    corner.dispatchEvent(pointer('pointerup', 100, 100));
    win.el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(onClose).toHaveBeenCalledWith('escape');
  });
});

describe('Developer Mode', () => {
  it('OFF: nothing is created; ON: one HUD; ON again: no duplicates; OFF: everything goes', async () => {
    const { bridge, layer, calls } = fakeBridge(document);
    const mounted: DevTools[] = [];
    const onDisable = vi.fn();
    const sw = new DevModeSwitch(async () => () => {
      const d = new DevTools(bridge);
      mounted.push(d);
      return d as DevToolsHandle;
    }, { onDisable });
    // OFF by default: no windows, no history, no telemetry.
    expect(sw.handle).toBeNull();
    expect(layer.root.childElementCount).toBe(0);
    sw.set(false);
    expect(onDisable).not.toHaveBeenCalled();

    sw.set(true);
    sw.set(true); // while loading
    await Promise.resolve();
    await Promise.resolve();
    sw.set(true); // after mount
    await Promise.resolve();
    expect(sw.mounts).toBe(1);
    const huds = layer.root.querySelectorAll('[data-testid="dev-window-hud"]');
    expect(huds.length).toBe(1);
    expect(calls.telemetry).toEqual([true]);
    expect(layer.root.querySelectorAll('[data-testid="quick-toolbar"]').length).toBe(1);

    // Samples at 10 Hz from the render loop, not per frame.
    for (let i = 0; i < 60; i++) sw.handle!.frame(1 / 60);
    expect(calls.samples).toBe(10);
    expect(mounted[0]!.history.size).toBeGreaterThan(0);

    sw.set(false);
    expect(sw.handle).toBeNull();
    expect(layer.root.childElementCount).toBe(0);
    expect(calls.telemetry).toEqual([true, false]);
    expect(onDisable).toHaveBeenCalledTimes(1);
  });

  it('OFF while the chunk is still loading discards the late mount', async () => {
    let resolve!: (m: () => DevToolsHandle) => void;
    const sw = new DevModeSwitch(() => new Promise((r) => (resolve = r)));
    sw.set(true);
    sw.set(false);
    const dispose = vi.fn();
    resolve(() => ({ frame() {}, pushTelemetry() {}, refresh() {}, prepareNextSession() {}, dispose }));
    await new Promise((r) => setTimeout(r, 0));
    expect(sw.handle).toBeNull();
    expect(sw.mounts).toBe(0);
  });

  it('restores the default HUD after Developer Mode is toggled off and on', async () => {
    const { bridge, layer } = fakeBridge(document);
    const sw = new DevModeSwitch(async () => () => new DevTools(bridge));

    sw.set(true);
    await Promise.resolve();
    await Promise.resolve();
    (layer.shadow.querySelector('[data-testid="dev-window-hud"] [data-action="close"]') as HTMLButtonElement).click();
    expect(layer.shadow.querySelector('[data-testid="dev-window-hud"]')).toBeNull();

    sw.set(false);
    sw.set(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(layer.shadow.querySelectorAll('[data-testid="dev-window-hud"]')).toHaveLength(1);
    sw.set(false);
  });

  it('opens Developer Tools and Avatar Controls, persists their geometry and restores it', () => {
    const { bridge, calls } = fakeBridge(document);
    const tools = new DevTools(bridge);
    tools.open('devtools');
    tools.open('avatarControls');
    tools.open('devtools'); // focus, not a second window
    expect(tools.openWindows.sort()).toEqual(['avatarControls', 'devtools', 'hud']);
    const win = tools.window('devtools')!;
    win.moveTo(30, 40);
    const last = calls.windowWrites.at(-1)!;
    expect(last.persist).toBe('now');
    expect(last.value.windows.devtools).toMatchObject({ x: 30, y: 40, open: true });
    tools.dispose();

    // Next session: restored where it was, open.
    const again = new DevTools(bridge);
    expect(again.openWindows.sort()).toEqual(['avatarControls', 'devtools', 'hud']);
    expect(again.window('devtools')!.bounds).toMatchObject({ x: 30, y: 40 });
    again.dispose();
  });

  it('camera preset buttons and the size buttons write the view settings; the UI never touches the avatar', () => {
    const f = fakeBridge(document);
    const tools = new DevTools(f.bridge);
    const root = f.layer.shadow;
    (root.querySelector('[data-testid="toolbar-face"]') as HTMLButtonElement).click();
    expect(f.view.camera.preset).toBe('face');
    (root.querySelector('[data-testid="toolbar-larger"]') as HTMLButtonElement).click();
    expect(f.view.placement.scale).toBe(1.55);
    expect(root.querySelector('[data-testid="toolbar-face"]')!.getAttribute('aria-pressed')).toBe('true');
    tools.open('avatarControls');
    (root.querySelector('[data-testid="camera-full-body"]') as HTMLButtonElement).click();
    expect(f.view.camera.preset).toBe('full-body');
    expect(root.querySelector('[data-testid="toolbar-full-body"]')!.getAttribute('aria-pressed')).toBe('true');
    tools.dispose();
  });
});

describe('ManualControls', () => {
  function setup() {
    const avatar = {
      setExpression: vi.fn(() => true),
      resetExpressions: vi.fn(),
      hasExpression: vi.fn(() => true),
      listExpressions: vi.fn(() => []),
      setHeadRotation: vi.fn(() => true),
      setBoneRotation: vi.fn(() => true),
      resetPose: vi.fn(),
    };
    const channel = vi.fn();
    return { avatar, channel, manual: new ManualControls(avatar, channel) };
  }

  it('expression preview mutes emotion, writes the manual layer only while on, and restores on exit', () => {
    const { avatar, channel, manual } = setup();
    expect(manual.previewExpression('happy', 1)).toBe(false);
    expect(avatar.setExpression).not.toHaveBeenCalled();
    manual.setEmotionEnabled('user', false);
    manual.setExpressionPreview(true);
    expect(channel).toHaveBeenCalledWith('assistant', false);
    manual.previewExpression('happy', 1);
    expect(avatar.setExpression).toHaveBeenCalledWith('happy', 1);
    manual.setExpressionPreview(false);
    expect(avatar.resetExpressions).toHaveBeenCalled();
    // Back as the user left them: assistant on, user still off.
    expect(channel).toHaveBeenLastCalledWith('assistant', true);
    expect(channel).toHaveBeenCalledWith('user', false);
  });

  it('pose offsets add to the rest pose; release returns to it', () => {
    const { avatar, manual } = setup();
    manual.setPoseOffsets({ arms: 30 });
    expect(avatar.setBoneRotation).toHaveBeenCalledWith('leftUpperArm', { z: -1.2 + Math.PI / 6 });
    manual.release();
    expect(avatar.resetPose).toHaveBeenCalled();
    expect(manual.poseOffsets).toEqual(NEUTRAL_POSE_OFFSETS);
  });
});

describe('PlacementHandle', () => {
  it('arrow keys and +/- move and resize the avatar in normalised units; Escape finishes', () => {
    const onChange = vi.fn();
    const onDone = vi.fn();
    const handle = new PlacementHandle(document, { viewport: () => ({ width: 1000, height: 800 }), onChange, onDone });
    handle.setBox({ left: 400, top: 100, width: 200, height: 400 });
    handle.el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(onChange).toHaveBeenLastCalledWith({ x: 0.508, y: 0.375 }, true);
    handle.el.dispatchEvent(new KeyboardEvent('keydown', { key: '+', bubbles: true }));
    expect(onChange).toHaveBeenLastCalledWith({ scale: 1.05 }, true);
    handle.el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(onDone).toHaveBeenCalled();
  });

  it('dragging the box moves its centre', () => {
    const onChange = vi.fn();
    const handle = new PlacementHandle(document, { viewport: () => ({ width: 1000, height: 800 }), onChange, onDone: vi.fn() });
    handle.setBox({ left: 400, top: 200, width: 200, height: 400 });
    document.body.append(handle.el);
    handle.el.dispatchEvent(pointer('pointerdown', 500, 400));
    handle.el.dispatchEvent(pointer('pointermove', 300, 480));
    expect(onChange).toHaveBeenLastCalledWith({ x: 0.3, y: 0.6 }, false);
    handle.el.dispatchEvent(pointer('pointerup', 300, 480));
    expect(onChange).toHaveBeenLastCalledWith({}, true);
  });
});
