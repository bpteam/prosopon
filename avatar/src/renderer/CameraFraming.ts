// Camera framing math: pure numbers, no three.js, so presets are unit-testable against synthetic model bounds.

export const CAMERA_PRESETS = ['face', 'waist', 'full-body'] as const;
export type CameraPreset = (typeof CAMERA_PRESETS)[number];

export function isCameraPreset(value: unknown): value is CameraPreset {
  return typeof value === 'string' && (CAMERA_PRESETS as readonly string[]).includes(value);
}

/**
 * Vertical landmarks of the loaded model in world space (meters), measured once from humanoid bones and the
 * model's bounding box. Presets are defined against these, never against world constants of one test model.
 */
export interface AvatarBounds {
  /** Top of the head (hair included): bounding box top. */
  top: number;
  /** Neck bone: chin level, approximately. */
  neck: number;
  /** Hips bone. */
  hips: number;
  /** Lowest point: feet bones or the bounding box bottom, whichever is lower. */
  bottom: number;
  /** Horizontal centre the camera aims at (head/hips x and z). */
  centerX: number;
  centerZ: number;
}

/**
 * What a preset puts in frame: a vertical span between two landmarks, and the share of the presentation box that
 * span fills (the rest is margin, split evenly above and below).
 */
export interface PresetSpec {
  /** Span top/bottom in world meters, from the bounds. */
  span(b: AvatarBounds): { top: number; bottom: number };
  /** Fraction of the presentation box height the span fills. */
  fill: number;
}

export const PRESET_SPECS: Readonly<Record<CameraPreset, PresetSpec>> = {
  // Top of the head to just below the chin, where the shoulders begin.
  face: {
    span: (b) => ({ top: b.top, bottom: b.neck - 0.35 * Math.max(0, b.top - b.neck) }),
    fill: 0.85,
  },
  // Top of the head to the hips.
  waist: {
    span: (b) => ({ top: b.top, bottom: b.hips }),
    fill: 0.88,
  },
  // Head to feet, ~5 % margin above and below.
  'full-body': {
    span: (b) => ({ top: b.top, bottom: b.bottom }),
    fill: 0.9,
  },
};

/**
 * Manual corrections on top of a preset. Relative units, so they mean the same thing for a model of any height.
 */
export interface CameraAdjust {
  /** Camera distance × (1 + distanceOffset): negative is closer. */
  distanceOffset: number;
  /** Look target moved by this share of the preset's span height (positive = up). */
  targetYOffset: number;
  /** Orbit around the target, degrees (positive = camera moves to the model's left). */
  yaw: number;
  /** Orbit around the target, degrees (positive = camera above, looking down). */
  pitch: number;
}

export const DEFAULT_CAMERA_ADJUST: Readonly<CameraAdjust> = Object.freeze({
  distanceOffset: 0,
  targetYOffset: 0,
  yaw: 0,
  pitch: 0,
});

/** Ranges of the manual corrections; values outside are clamped. */
export const CAMERA_ADJUST_LIMITS: Readonly<Record<keyof CameraAdjust, readonly [number, number]>> = {
  distanceOffset: [-0.6, 1.5],
  targetYOffset: [-0.5, 0.5],
  yaw: [-60, 60],
  pitch: [-30, 30],
};

export function clampCameraAdjust(adjust: Partial<CameraAdjust>, base: Readonly<CameraAdjust> = DEFAULT_CAMERA_ADJUST): CameraAdjust {
  const out = { ...base };
  for (const key of Object.keys(CAMERA_ADJUST_LIMITS) as (keyof CameraAdjust)[]) {
    const v = adjust[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    const [min, max] = CAMERA_ADJUST_LIMITS[key];
    out[key] = Math.min(max, Math.max(min, v));
  }
  return out;
}

/**
 * Where the avatar sits on screen, independent of the camera: a presentation box centred at (x, y) of the viewport
 * (0..1, 0.5/0.5 = centre), `height` × viewport height tall. The preset span fills `fill` of that box. The box is
 * realised with an off-axis projection (lens shift), so moving it never turns the avatar's head or eyes away.
 */
export interface Presentation {
  x: number;
  y: number;
  /** Box height as a fraction of the viewport height. 1 = full height. */
  height: number;
}

export const DEFAULT_PRESENTATION: Readonly<Presentation> = Object.freeze({ x: 0.5, y: 0.5, height: 1 });

export interface Viewport {
  width: number;
  height: number;
}

export interface Framing {
  /** Look target, world meters. */
  target: [number, number, number];
  /** Camera position, world meters. */
  position: [number, number, number];
  distance: number;
  /**
   * Projection shift in pixels for PerspectiveCamera.setViewOffset(w, h, offsetX, offsetY, w, h): the target
   * projects to the presentation box centre instead of the viewport centre.
   */
  offsetX: number;
  offsetY: number;
  /** Presentation box in viewport pixels (for placement handles and tests). */
  box: { left: number; top: number; width: number; height: number };
}

/** Aspect (width / height) of the presentation box drawn by placement handles. Framing itself is height-driven. */
export const PRESENTATION_BOX_ASPECT = 0.62;

/**
 * Camera for `preset` + `adjust` so that the preset's span fills `fill` of the presentation box, which is centred at
 * (presentation.x, presentation.y) of the viewport. Framing is height-driven: a model's arm span or a wide viewport
 * never changes it.
 */
export function computeFraming(
  bounds: Readonly<AvatarBounds>,
  preset: CameraPreset,
  adjust: Readonly<CameraAdjust>,
  presentation: Readonly<Presentation>,
  viewport: Readonly<Viewport>,
  fovDeg: number,
): Framing {
  const vw = Math.max(1, viewport.width);
  const vh = Math.max(1, viewport.height);
  const spec = PRESET_SPECS[preset];
  const raw = spec.span(bounds);
  // Degenerate bounds (a model without a skeleton, a zero-size box): frame a nominal 0.3 m instead of dividing by 0.
  const spanHeight = Math.max(0.05, raw.top - raw.bottom);
  const spanCenter = raw.bottom + spanHeight / 2;
  const a = clampCameraAdjust(adjust);

  const boxHeight = Math.max(1, vh * Math.max(0.05, presentation.height));
  const tanHalf = Math.tan(((fovDeg * Math.PI) / 180) / 2);
  // At distance d the viewport shows 2·d·tan(fov/2) meters vertically; the span must cover fill·boxHeight pixels.
  const baseDistance = (spanHeight * vh) / (spec.fill * boxHeight * 2 * tanHalf);
  const distance = baseDistance * (1 + a.distanceOffset);

  const target: [number, number, number] = [bounds.centerX, spanCenter + a.targetYOffset * spanHeight, bounds.centerZ];
  const yaw = (a.yaw * Math.PI) / 180;
  const pitch = (a.pitch * Math.PI) / 180;
  // VRM 1.0 models face +Z: the camera sits in front of them on +Z.
  const position: [number, number, number] = [
    target[0] + distance * Math.sin(yaw) * Math.cos(pitch),
    target[1] + distance * Math.sin(pitch),
    target[2] + distance * Math.cos(yaw) * Math.cos(pitch),
  ];

  const cx = clamp01(presentation.x) * vw;
  const cy = clamp01(presentation.y) * vh;
  const boxWidth = boxHeight * PRESENTATION_BOX_ASPECT;
  return {
    target,
    position,
    distance,
    offsetX: vw / 2 - cx,
    offsetY: vh / 2 - cy,
    box: { left: cx - boxWidth / 2, top: cy - boxHeight / 2, width: boxWidth, height: boxHeight },
  };
}

/**
 * Screen y (pixels from the viewport top) of a world height `y` at the target's depth, for a camera from
 * computeFraming with yaw = pitch = 0. Used by tests to check what a preset actually puts in frame.
 */
export function projectHeight(framing: Framing, y: number, viewport: Readonly<Viewport>, fovDeg: number): number {
  const tanHalf = Math.tan(((fovDeg * Math.PI) / 180) / 2);
  const ndc = (y - framing.position[1]) / (framing.distance * tanHalf);
  // Centre of the viewport, then the lens shift moves the target to the box centre.
  return viewport.height / 2 - (ndc * viewport.height) / 2 - framing.offsetY;
}

/** Bounds for a model with no usable skeleton or box: a 1.6 m humanoid standing at the origin. */
export const NOMINAL_BOUNDS: Readonly<AvatarBounds> = Object.freeze({
  top: 1.6,
  neck: 1.42,
  hips: 0.85,
  bottom: 0,
  centerX: 0,
  centerZ: 0,
});

/**
 * Bounds from what could be measured. Missing bones fall back to proportions of the measured height, so an odd
 * model still gets a sensible frame instead of NaN.
 */
export function resolveBounds(measured: {
  boxTop?: number | null;
  boxBottom?: number | null;
  head?: number | null;
  neck?: number | null;
  hips?: number | null;
  feet?: number | null;
  centerX?: number | null;
  centerZ?: number | null;
}): AvatarBounds {
  const finite = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);
  let bottom = finite(measured.feet) ? measured.feet : finite(measured.boxBottom) ? measured.boxBottom : NaN;
  if (finite(measured.boxBottom) && finite(bottom)) bottom = Math.min(bottom, measured.boxBottom);
  let top = finite(measured.boxTop) ? measured.boxTop : finite(measured.head) ? measured.head + 0.12 : NaN;
  if (finite(measured.head) && finite(top)) top = Math.max(top, measured.head + 0.05);
  if (!finite(top) || !finite(bottom) || top - bottom < 0.2) {
    if (!finite(top)) return { ...NOMINAL_BOUNDS };
    // Only a top: assume nominal proportions below it.
    bottom = top - NOMINAL_BOUNDS.top;
  }
  const h = top - bottom;
  const neck = finite(measured.neck) ? measured.neck : finite(measured.head) ? measured.head - 0.04 * h : bottom + 0.87 * h;
  const hips = finite(measured.hips) ? measured.hips : bottom + 0.53 * h;
  return {
    top,
    neck: Math.min(neck, top - 0.02),
    hips: Math.min(hips, neck - 0.02),
    bottom,
    centerX: finite(measured.centerX) ? measured.centerX : 0,
    centerZ: finite(measured.centerZ) ? measured.centerZ : 0,
  };
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5;
}
