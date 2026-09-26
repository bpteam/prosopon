import { describe, expect, it, vi } from 'vitest';
import {
  AVATAR_SCALE,
  DEFAULT_VIEW_SETTINGS,
  DEV_WINDOW_SPECS,
  MIN_VISIBLE_HEADER,
  PERSIST_DEBOUNCE_MS,
  PersistedValue,
  STORAGE_KEYS,
  clampWindowBounds,
  cloneView,
  sanitizeDevWindows,
  sanitizeDeveloperMode,
  sanitizeViewSettings,
  snapScale,
  type SettingsArea,
} from '../../src/shared/settings';

/** In-memory chrome.storage.local with onChanged fan-out (to every subscriber, like Chrome). */
function fakeArea() {
  const data = new Map<string, unknown>();
  const listeners = new Set<(c: Record<string, unknown>) => void>();
  const area: SettingsArea & { data: Map<string, unknown>; sets: number } = {
    data,
    sets: 0,
    async get(keys) {
      const out: Record<string, unknown> = {};
      for (const k of keys) if (data.has(k)) out[k] = structuredClone(data.get(k));
      return out;
    },
    async set(items) {
      area.sets++;
      for (const [k, v] of Object.entries(items)) data.set(k, structuredClone(v));
      for (const l of listeners) l(structuredClone(items));
    },
    subscribe(l) {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
  };
  return area;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('settings schema', () => {
  it('defaults: Waist, 150 %, centred slightly low', () => {
    expect(DEFAULT_VIEW_SETTINGS).toEqual({
      version: 1,
      camera: { preset: 'waist', distanceOffset: 0, targetYOffset: 0, yaw: 0, pitch: 0 },
      placement: { x: 0.5, y: 0.54, scale: 1.5 },
    });
    expect(AVATAR_SCALE.max).toBeGreaterThanOrEqual(2.5);
  });

  it('sanitises garbage field by field and rejects unknown versions', () => {
    expect(sanitizeViewSettings(undefined)).toEqual(DEFAULT_VIEW_SETTINGS);
    expect(sanitizeViewSettings({ version: 2, camera: { preset: 'face' } })).toEqual(DEFAULT_VIEW_SETTINGS);
    const v = sanitizeViewSettings({ camera: { preset: 'nope', yaw: 500, pitch: 'x' }, placement: { x: -3, y: 0.2, scale: 99 } });
    expect(v.camera.preset).toBe('waist');
    expect(v.camera.yaw).toBe(60);
    expect(v.camera.pitch).toBe(0);
    expect(v.placement).toEqual({ x: 0, y: 0.2, scale: AVATAR_SCALE.max });
    expect(sanitizeDeveloperMode('true')).toBe(false);
    expect(sanitizeDevWindows({ windows: { hud: { x: 1, y: 2, width: 3 } } }).windows.hud).toBeUndefined();
    expect(snapScale(1.52)).toBe(1.5);
    expect(snapScale(9)).toBe(2.5);
  });
});

describe('persistence roundtrip: save → reload → restore', () => {
  it('restores preset, camera offsets, placement, scale, window bounds and Developer Mode', async () => {
    const area = fakeArea();
    // Session 1: the user sets everything up.
    const view = new PersistedValue(area, STORAGE_KEYS.view, sanitizeViewSettings, cloneView(DEFAULT_VIEW_SETTINGS));
    const dev = new PersistedValue(area, STORAGE_KEYS.developerMode, sanitizeDeveloperMode, false);
    const windows = new PersistedValue(area, STORAGE_KEYS.devWindows, sanitizeDevWindows, sanitizeDevWindows({}));
    await Promise.all([view.load(), dev.load(), windows.load()]);
    const saved = {
      version: 1 as const,
      camera: { preset: 'face' as const, distanceOffset: 0.2, targetYOffset: -0.1, yaw: 12, pitch: -4 },
      placement: { x: 0.31, y: 0.62, scale: 2.2 },
    };
    view.set(saved, 'now');
    dev.set(true, 'now');
    windows.set({ version: 1, windows: { devtools: { x: 40, y: 50, width: 700, height: 480, open: true, pinned: false } }, tabs: { devtools: 'Audio' } }, 'now');
    await flush();
    view.dispose();
    dev.dispose();
    windows.dispose();

    // Session 2 (refresh, new tab, browser restart): same storage, fresh objects.
    const view2 = new PersistedValue(area, STORAGE_KEYS.view, sanitizeViewSettings, cloneView(DEFAULT_VIEW_SETTINGS));
    const dev2 = new PersistedValue(area, STORAGE_KEYS.developerMode, sanitizeDeveloperMode, false);
    const windows2 = new PersistedValue(area, STORAGE_KEYS.devWindows, sanitizeDevWindows, sanitizeDevWindows({}));
    expect(await view2.load()).toEqual(saved);
    expect(await dev2.load()).toBe(true);
    const w = await windows2.load();
    expect(w.windows.devtools).toEqual({ x: 40, y: 50, width: 700, height: 480, open: true, pinned: false });
    expect(w.tabs.devtools).toBe('Audio');
  });

  it('debounces drags (~250 ms) and flushes on demand', async () => {
    vi.useFakeTimers();
    try {
      const area = fakeArea();
      const view = new PersistedValue(area, STORAGE_KEYS.view, sanitizeViewSettings, cloneView(DEFAULT_VIEW_SETTINGS));
      for (let i = 0; i < 50; i++) view.set({ ...view.value, placement: { ...view.value.placement, x: i / 100 } });
      expect(area.sets).toBe(0);
      expect(view.pending).toBe(true);
      vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS - 1);
      expect(area.sets).toBe(0);
      vi.advanceTimersByTime(1);
      expect(area.sets).toBe(1);
      expect((area.data.get(STORAGE_KEYS.view) as { placement: { x: number } }).placement.x).toBe(0.49);
      // pointerup: the pending value goes out at once.
      view.set({ ...view.value, placement: { ...view.value.placement, x: 0.7 } });
      await view.flush();
      expect(area.sets).toBe(2);
      expect(view.pending).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('follows other tabs, ignores echoes of its own writes, and keeps a drag in progress', async () => {
    const area = fakeArea();
    const a = new PersistedValue(area, STORAGE_KEYS.view, sanitizeViewSettings, cloneView(DEFAULT_VIEW_SETTINGS));
    const b = new PersistedValue(area, STORAGE_KEYS.view, sanitizeViewSettings, cloneView(DEFAULT_VIEW_SETTINGS));
    await Promise.all([a.load(), b.load()]);
    const seenA = vi.fn();
    const seenB = vi.fn();
    a.onChange(seenA);
    b.onChange(seenB);
    a.set({ ...a.value, camera: { ...a.value.camera, preset: 'full-body' } }, 'now');
    await flush();
    expect(seenA).not.toHaveBeenCalled(); // its own echo
    expect(seenB).toHaveBeenCalledTimes(1);
    expect(b.value.camera.preset).toBe('full-body');
    // b is mid-drag (pending): a's change doesn't snap it back.
    b.set({ ...b.value, placement: { ...b.value.placement, x: 0.1 } });
    a.set({ ...a.value, placement: { ...a.value.placement, x: 0.9 } }, 'now');
    await flush();
    expect(b.value.placement.x).toBe(0.1);
  });
});

describe('responsive clamp', () => {
  const spec = DEV_WINDOW_SPECS.devtools;

  it('a window saved at x = 1800 is visible after restore on a 1024 px viewport', () => {
    const b = clampWindowBounds({ x: 1800, y: 900, width: 900, height: 620 }, { width: 1024, height: 768 }, spec, 'restore');
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.x + b.width).toBeLessThanOrEqual(1024);
    expect(b.y + b.height).toBeLessThanOrEqual(768);
    expect(b.width).toBeLessThanOrEqual(1024 - 2 * spec.margin);
  });

  it('dragging may hang a window over the edge, but its header stays reachable', () => {
    const vp = { width: 1280, height: 800 };
    const right = clampWindowBounds({ x: 5000, y: 5000, width: 700, height: 500 }, vp, spec, 'drag');
    expect(right.x).toBeLessThanOrEqual(vp.width - 80);
    expect(right.y).toBeLessThanOrEqual(vp.height - MIN_VISIBLE_HEADER);
    const left = clampWindowBounds({ x: -5000, y: -50, width: 700, height: 500 }, vp, spec, 'drag');
    expect(left.x + left.width).toBeGreaterThanOrEqual(80);
    expect(left.y).toBe(0);
  });

  it('respects min and max size', () => {
    const tiny = clampWindowBounds({ x: 0, y: 0, width: 10, height: 10 }, { width: 1920, height: 1080 }, spec, 'drag');
    expect([tiny.width, tiny.height]).toEqual([spec.minWidth, spec.minHeight]);
    const huge = clampWindowBounds({ x: 0, y: 0, width: 9000, height: 9000 }, { width: 1920, height: 1080 }, spec, 'drag');
    expect([huge.width, huge.height]).toEqual([1920 - 40, 1080 - 40]);
  });
});
