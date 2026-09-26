import { CAMERA_ADJUST_LIMITS, isCameraPreset, type CameraPreset } from '@avatar/renderer/CameraFraming';

// Persistent UI settings (chrome.storage.local). The only place their keys, schemas and defaults are defined:
// the popup, the content runtime and the Dev Tools all read and write through here. Contract only (plus pure
// sanitising and a debounced writer): no DOM, no chrome.* at module scope.

/** Every chrome.storage.local key Prosopon's UI owns. The emotion model's metadata key lives in ModelStorage. */
export const STORAGE_KEYS = {
  /** AvatarViewSettingsV1: camera preset + corrections, on-screen placement and size. */
  view: 'prosopon.view',
  /** boolean: Developer Mode (diagnostics, Dev Tools, Avatar Controls). */
  developerMode: 'prosopon.developerMode',
  /** DevWindowsSettingsV1: geometry and open state of the in-page developer windows. */
  devWindows: 'prosopon.devWindows',
} as const;

/** Avatar size range of the UI: 100 % puts the avatar's presentation box at half the viewport height. */
export const AVATAR_SCALE = { min: 0.75, max: 2.5, step: 0.05, default: 1.5 } as const;
/** Presentation box height, as a share of the viewport height, at scale 1 (100 %). */
export const BASE_BOX_HEIGHT = 0.5;

export interface CameraViewSettings {
  preset: CameraPreset;
  /** See CameraAdjust in @avatar/renderer/CameraFraming: relative distance, share of the span, degrees. */
  distanceOffset: number;
  targetYOffset: number;
  yaw: number;
  pitch: number;
}

export interface AvatarPlacement {
  /** Centre of the avatar's presentation box, 0..1 of the viewport (0.5 / 0.5 = centre). */
  x: number;
  y: number;
  /** Avatar size, 1 = 100 % (AVATAR_SCALE). */
  scale: number;
}

export interface AvatarViewSettingsV1 {
  version: 1;
  camera: CameraViewSettings;
  placement: AvatarPlacement;
}

export const DEFAULT_VIEW_SETTINGS: Readonly<AvatarViewSettingsV1> = Object.freeze({
  version: 1,
  camera: Object.freeze({ preset: 'waist', distanceOffset: 0, targetYOffset: 0, yaw: 0, pitch: 0 }),
  placement: Object.freeze({ x: 0.5, y: 0.54, scale: AVATAR_SCALE.default }),
}) as Readonly<AvatarViewSettingsV1>;

export const DEV_WINDOW_IDS = ['hud', 'devtools', 'avatarControls'] as const;
export type DevWindowId = (typeof DEV_WINDOW_IDS)[number];

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DevWindowState extends WindowBounds {
  open: boolean;
  /** HUD only: stays open while the other windows close with Escape. */
  pinned: boolean;
}

export interface DevWindowsSettingsV1 {
  version: 1;
  /** Only windows that were ever moved, resized or toggled have an entry; the rest use their initial geometry. */
  windows: Partial<Record<DevWindowId, DevWindowState>>;
  /** Last selected tab per window. */
  tabs: Partial<Record<DevWindowId, string>>;
}

export const DEFAULT_DEV_WINDOWS: Readonly<DevWindowsSettingsV1> = Object.freeze({ version: 1, windows: {}, tabs: {} });

export interface DevWindowSpec {
  /** Geometry before the first move, from the viewport size. */
  initial(viewport: Viewport): WindowBounds;
  minWidth: number;
  minHeight: number;
  /** Margin kept to the viewport edges when sizing (max-width: calc(100vw − 2·margin)). */
  margin: number;
  resizable: boolean;
  /** Open when Developer Mode turns on (before the user ever closed it). */
  openByDefault: boolean;
}

export interface Viewport {
  width: number;
  height: number;
}

export const DEV_WINDOW_SPECS: Readonly<Record<DevWindowId, DevWindowSpec>> = {
  hud: {
    initial: (v) => ({ x: v.width - 20 - 470, y: 72, width: 470, height: Math.round(v.height * 0.7) }),
    minWidth: 360,
    minHeight: 160,
    margin: 8,
    resizable: false,
    openByDefault: true,
  },
  devtools: {
    // Centred (the spec's translate(−50 %, −50 %)), as real coordinates so a drag starts from where it is.
    initial: (v) => ({ x: Math.round((v.width - 900) / 2), y: Math.round((v.height - 620) / 2), width: 900, height: 620 }),
    minWidth: 680,
    minHeight: 420,
    margin: 20,
    resizable: true,
    openByDefault: false,
  },
  avatarControls: {
    initial: (v) => ({ x: v.width - 20 - 460, y: 100, width: 460, height: 620 }),
    minWidth: 380,
    minHeight: 360,
    margin: 20,
    resizable: true,
    openByDefault: false,
  },
};

/** Pixels of a window's header that always stay on screen while dragging. */
export const MIN_VISIBLE_HEADER = 24;
/** Horizontal pixels of the header that stay on screen, so it can be grabbed again. */
export const MIN_VISIBLE_WIDTH = 80;

// --- Sanitising ---------------------------------------------------------------------------------------------------

const num = (v: unknown, fallback: number, min: number, max: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Any stored value → a valid V1 view. Unknown versions and garbage fall back to defaults field by field. */
export function sanitizeViewSettings(raw: unknown): AvatarViewSettingsV1 {
  const r = obj(raw);
  const d = DEFAULT_VIEW_SETTINGS;
  if (r.version !== undefined && r.version !== 1) return cloneView(d);
  const c = obj(r.camera);
  const p = obj(r.placement);
  const L = CAMERA_ADJUST_LIMITS;
  return {
    version: 1,
    camera: {
      preset: isCameraPreset(c.preset) ? c.preset : d.camera.preset,
      distanceOffset: num(c.distanceOffset, 0, ...L.distanceOffset),
      targetYOffset: num(c.targetYOffset, 0, ...L.targetYOffset),
      yaw: num(c.yaw, 0, ...L.yaw),
      pitch: num(c.pitch, 0, ...L.pitch),
    },
    placement: {
      x: num(p.x, d.placement.x, 0, 1),
      y: num(p.y, d.placement.y, 0, 1),
      scale: num(p.scale, d.placement.scale, AVATAR_SCALE.min, AVATAR_SCALE.max),
    },
  };
}

export function cloneView(v: Readonly<AvatarViewSettingsV1>): AvatarViewSettingsV1 {
  return { version: 1, camera: { ...v.camera }, placement: { ...v.placement } };
}

/** Whether the camera differs from its preset's default (shown as "Waist · modified"). */
export function isCameraModified(camera: Readonly<CameraViewSettings>): boolean {
  return camera.distanceOffset !== 0 || camera.targetYOffset !== 0 || camera.yaw !== 0 || camera.pitch !== 0;
}

/** Snaps a size to AVATAR_SCALE's step and range. */
export function snapScale(scale: number): number {
  const s = Math.round(scale / AVATAR_SCALE.step) * AVATAR_SCALE.step;
  return Math.round(Math.min(AVATAR_SCALE.max, Math.max(AVATAR_SCALE.min, s)) * 100) / 100;
}

export function sanitizeDevWindows(raw: unknown): DevWindowsSettingsV1 {
  const r = obj(raw);
  if (r.version !== undefined && r.version !== 1) return { version: 1, windows: {}, tabs: {} };
  const windows: DevWindowsSettingsV1['windows'] = {};
  const tabs: DevWindowsSettingsV1['tabs'] = {};
  const w = obj(r.windows);
  const t = obj(r.tabs);
  for (const id of DEV_WINDOW_IDS) {
    const e = obj(w[id]);
    if (['x', 'y', 'width', 'height'].every((k) => typeof e[k] === 'number' && Number.isFinite(e[k]))) {
      windows[id] = {
        x: e.x as number,
        y: e.y as number,
        width: Math.max(1, e.width as number),
        height: Math.max(1, e.height as number),
        open: e.open === true,
        pinned: e.pinned === true,
      };
    }
    if (typeof t[id] === 'string' && (t[id] as string).length <= 40) tabs[id] = t[id] as string;
  }
  return { version: 1, windows, tabs };
}

export function sanitizeDeveloperMode(raw: unknown): boolean {
  return raw === true;
}

/**
 * Window bounds that fit `viewport`.
 *  - 'drag': the window may hang over an edge, but MIN_VISIBLE_HEADER px of its header (MIN_VISIBLE_WIDTH wide) stay
 *    on screen, so it can always be grabbed again.
 *  - 'restore': after a resolution change or on first open; the whole window is brought inside when it fits.
 * Size is limited to the viewport minus the window's margin and never below its minimum (unless the viewport is
 * smaller still).
 */
export function clampWindowBounds(
  bounds: Readonly<WindowBounds>,
  viewport: Readonly<Viewport>,
  spec: Pick<DevWindowSpec, 'minWidth' | 'minHeight' | 'margin'>,
  mode: 'drag' | 'restore',
): WindowBounds {
  const vw = Math.max(1, viewport.width);
  const vh = Math.max(1, viewport.height);
  const maxW = Math.max(1, vw - 2 * spec.margin);
  const maxH = Math.max(1, vh - 2 * spec.margin);
  const width = Math.min(maxW, Math.max(Math.min(spec.minWidth, maxW), finiteOr(bounds.width, spec.minWidth)));
  const height = Math.min(maxH, Math.max(Math.min(spec.minHeight, maxH), finiteOr(bounds.height, spec.minHeight)));
  let x = finiteOr(bounds.x, 0);
  let y = finiteOr(bounds.y, 0);
  if (mode === 'restore') {
    x = Math.min(Math.max(0, x), Math.max(0, vw - width));
    y = Math.min(Math.max(0, y), Math.max(0, vh - height));
  } else {
    const visible = Math.min(MIN_VISIBLE_WIDTH, width);
    x = Math.min(Math.max(x, visible - width), vw - visible);
    y = Math.min(Math.max(y, 0), vh - MIN_VISIBLE_HEADER);
  }
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

function finiteOr(v: number, fallback: number): number {
  return Number.isFinite(v) ? v : fallback;
}

// --- Storage ---------------------------------------------------------------------------------------------------------

/** The subset of chrome.storage.local (+ onChanged) the settings need; tests provide a fake. */
export interface SettingsArea {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  /** Changes from any context (other tabs, the popup). @returns unsubscribe */
  subscribe(listener: (changes: Record<string, unknown>) => void): () => void;
}

/** chrome.storage.local as a SettingsArea. */
export function chromeSettingsArea(): SettingsArea {
  return {
    get: (keys) => chrome.storage.local.get(keys) as Promise<Record<string, unknown>>,
    set: (items) => chrome.storage.local.set(items),
    subscribe(listener) {
      const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
        if (area !== 'local') return;
        const values: Record<string, unknown> = {};
        for (const [k, c] of Object.entries(changes)) values[k] = c.newValue;
        listener(values);
      };
      chrome.storage.onChanged.addListener(onChanged);
      return () => chrome.storage.onChanged.removeListener(onChanged);
    },
  };
}

export interface Scheduler {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realScheduler: Scheduler = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** Storage writes are debounced by this much during drags and slider moves (pointerup/change/close flush). */
export const PERSIST_DEBOUNCE_MS = 250;

/**
 * One settings key: current value, debounced persistence and changes from other contexts. Echoes of its own writes
 * (storage.onChanged fires in the writing context too) are ignored, so a slow echo never snaps a drag back.
 */
export class PersistedValue<T> {
  private valueRef: T;
  private timer: unknown = null;
  private pendingWrite = false;
  private lastWritten: string | null = null;
  private readonly listeners = new Set<(value: T) => void>();
  private unsubscribe: (() => void) | null = null;
  /** Writes performed (tests, diagnostics). */
  writes = 0;

  constructor(
    private readonly area: SettingsArea,
    readonly key: string,
    private readonly sanitize: (raw: unknown) => T,
    initial: T,
    private readonly scheduler: Scheduler = realScheduler,
    private readonly debounceMs = PERSIST_DEBOUNCE_MS,
  ) {
    this.valueRef = initial;
  }

  get value(): T {
    return this.valueRef;
  }

  get pending(): boolean {
    return this.pendingWrite;
  }

  /** Reads the stored value and starts following external changes. */
  async load(): Promise<T> {
    const stored = await this.area.get([this.key]).catch(() => ({}) as Record<string, unknown>);
    // A local change made while loading wins over the stored value.
    if (!this.pendingWrite) this.valueRef = this.sanitize((stored as Record<string, unknown>)[this.key]);
    this.unsubscribe ??= this.area.subscribe((changes) => {
      if (!(this.key in changes)) return;
      const raw = changes[this.key];
      if (JSON.stringify(raw) === this.lastWritten) return; // our own write
      if (this.pendingWrite) return; // a local edit in progress wins; it is written shortly
      this.valueRef = this.sanitize(raw);
      for (const l of [...this.listeners]) l(this.valueRef);
    });
    return this.valueRef;
  }

  /** External changes (other tabs, the popup). @returns unsubscribe */
  onChange(listener: (value: T) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  /** Sets the value now and persists it after the debounce (or at the next flush()). */
  set(value: T, persist: 'debounced' | 'now' = 'debounced'): void {
    this.valueRef = value;
    this.pendingWrite = true;
    if (persist === 'now') {
      void this.flush();
      return;
    }
    if (this.timer !== null) this.scheduler.clearTimeout(this.timer);
    this.timer = this.scheduler.setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.debounceMs);
  }

  /** Writes a pending value right away (pointerup, change, window close, teardown). */
  async flush(): Promise<void> {
    if (this.timer !== null) this.scheduler.clearTimeout(this.timer);
    this.timer = null;
    if (!this.pendingWrite) return;
    this.pendingWrite = false;
    const value = this.valueRef;
    this.lastWritten = JSON.stringify(value);
    this.writes++;
    await this.area.set({ [this.key]: value }).catch(() => {});
  }

  dispose(): void {
    void this.flush();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.listeners.clear();
  }
}
