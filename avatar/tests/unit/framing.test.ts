import { describe, expect, it } from 'vitest';
import { FpsMeter } from '../../src/debug/FpsMeter';
import { budgetPixelRatio } from '../../src/renderer/AvatarStage';
import {
  CAMERA_ADJUST_LIMITS,
  CAMERA_PRESETS,
  DEFAULT_CAMERA_ADJUST,
  DEFAULT_PRESENTATION,
  PRESET_SPECS,
  clampCameraAdjust,
  computeFraming,
  projectHeight,
  resolveBounds,
} from '../../src/renderer/CameraFraming';

const FOV = 30;
/** A 1.6 m model and a 1.9 m one with different proportions: presets must not depend on the test model. */
const MODELS = {
  standard: resolveBounds({ boxTop: 1.6, boxBottom: 0, head: 1.45, neck: 1.4, hips: 0.85, feet: 0.05 }),
  tall: resolveBounds({ boxTop: 1.95, boxBottom: -0.02, head: 1.78, neck: 1.7, hips: 1.08, feet: 0.06, centerX: 0.3, centerZ: -0.2 }),
};
const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1024, height: 768 },
  { width: 390, height: 844 },
];

describe('camera presets', () => {
  for (const [name, bounds] of Object.entries(MODELS)) {
    for (const viewport of VIEWPORTS) {
      for (const preset of CAMERA_PRESETS) {
        it(`${name} model, ${preset}, ${viewport.width}x${viewport.height}: finite camera, span fills the box as specified`, () => {
          const presentation = { x: 0.5, y: 0.54, height: 0.75 };
          const f = computeFraming(bounds, preset, DEFAULT_CAMERA_ADJUST, presentation, viewport, FOV);
          expect(f.distance).toBeGreaterThan(0);
          for (const v of [...f.target, ...f.position, f.offsetX, f.offsetY]) expect(Number.isFinite(v)).toBe(true);
          const span = PRESET_SPECS[preset].span(bounds);
          const top = projectHeight(f, span.top, viewport, FOV);
          const bottom = projectHeight(f, span.bottom, viewport, FOV);
          // The span covers `fill` of the box, centred in it.
          expect((bottom - top) / f.box.height).toBeCloseTo(PRESET_SPECS[preset].fill, 5);
          expect((top + bottom) / 2).toBeCloseTo(f.box.top + f.box.height / 2, 5);
          expect(f.box.top + f.box.height / 2).toBeCloseTo(0.54 * viewport.height, 5);
        });
      }
    }
  }

  it('face keeps the whole head: from the top of the head to below the chin', () => {
    const b = MODELS.standard;
    const span = PRESET_SPECS.face.span(b);
    expect(span.top).toBe(b.top);
    expect(span.bottom).toBeLessThan(b.neck);
    expect(span.bottom).toBeGreaterThan(b.hips);
  });

  it('waist ends at the hips; full body includes the feet with ~5 % margins', () => {
    const b = MODELS.standard;
    expect(PRESET_SPECS.waist.span(b)).toEqual({ top: b.top, bottom: b.hips });
    expect(PRESET_SPECS['full-body'].span(b)).toEqual({ top: b.top, bottom: b.bottom });
    expect((1 - PRESET_SPECS['full-body'].fill) / 2).toBeCloseTo(0.05);
  });

  it('wider presets put the camera further away (same presentation)', () => {
    const d = (preset: (typeof CAMERA_PRESETS)[number]) =>
      computeFraming(MODELS.standard, preset, DEFAULT_CAMERA_ADJUST, DEFAULT_PRESENTATION, VIEWPORTS[0]!, FOV).distance;
    expect(d('face')).toBeLessThan(d('waist'));
    expect(d('waist')).toBeLessThan(d('full-body'));
  });

  it('a larger presentation box brings the camera closer; position only shifts the lens', () => {
    const at = (height: number, x = 0.5) =>
      computeFraming(MODELS.standard, 'waist', DEFAULT_CAMERA_ADJUST, { x, y: 0.5, height }, VIEWPORTS[0]!, FOV);
    expect(at(1.25).distance).toBeLessThan(at(0.75).distance);
    const left = at(0.75, 0.2);
    const centre = at(0.75);
    expect(left.position).toEqual(centre.position);
    expect(left.offsetX).toBeCloseTo(1920 * 0.3);
  });

  it('manual corrections are relative and clamped', () => {
    const base = computeFraming(MODELS.tall, 'waist', DEFAULT_CAMERA_ADJUST, DEFAULT_PRESENTATION, VIEWPORTS[0]!, FOV);
    const zoomed = computeFraming(MODELS.tall, 'waist', { ...DEFAULT_CAMERA_ADJUST, distanceOffset: 0.5 }, DEFAULT_PRESENTATION, VIEWPORTS[0]!, FOV);
    expect(zoomed.distance).toBeCloseTo(base.distance * 1.5);
    const orbit = computeFraming(MODELS.tall, 'waist', { ...DEFAULT_CAMERA_ADJUST, yaw: 30, pitch: 10 }, DEFAULT_PRESENTATION, VIEWPORTS[0]!, FOV);
    const dist = Math.hypot(...orbit.position.map((p, i) => p - orbit.target[i]!));
    expect(dist).toBeCloseTo(base.distance);
    expect(orbit.position[0]).toBeGreaterThan(orbit.target[0]);
    expect(orbit.position[1]).toBeGreaterThan(orbit.target[1]);
    expect(clampCameraAdjust({ yaw: 500, pitch: Number.NaN, distanceOffset: -5 })).toEqual({
      ...DEFAULT_CAMERA_ADJUST,
      yaw: CAMERA_ADJUST_LIMITS.yaw[1],
      distanceOffset: CAMERA_ADJUST_LIMITS.distanceOffset[0],
    });
  });

  it('degenerate or missing measurements still give a finite frame', () => {
    for (const bounds of [resolveBounds({}), resolveBounds({ boxTop: 1, boxBottom: 1 }), resolveBounds({ head: 1.5 })]) {
      for (const v of Object.values(bounds)) expect(Number.isFinite(v)).toBe(true);
      expect(bounds.top).toBeGreaterThan(bounds.neck);
      expect(bounds.neck).toBeGreaterThan(bounds.hips);
      expect(bounds.hips).toBeGreaterThan(bounds.bottom);
      const f = computeFraming(bounds, 'face', DEFAULT_CAMERA_ADJUST, DEFAULT_PRESENTATION, { width: 0, height: 0 }, FOV);
      expect(f.distance).toBeGreaterThan(0);
      expect(Number.isFinite(f.offsetX + f.offsetY)).toBe(true);
    }
  });
});

describe('budgetPixelRatio', () => {
  it('keeps the device ratio for small canvases and lowers it for a full 4K viewport', () => {
    expect(budgetPixelRatio(2, 800, 600, 4_500_000)).toBe(2);
    const r = budgetPixelRatio(2, 3840, 2160, 4_500_000);
    expect(r).toBeLessThan(1);
    expect(3840 * 2160 * r * r).toBeLessThanOrEqual(4_500_000 + 1);
    expect(budgetPixelRatio(3, 10, 10, 4_500_000)).toBe(2);
    expect(budgetPixelRatio(1, 100_000, 100_000, 4_500_000)).toBe(0.5);
  });
});

describe('FpsMeter', () => {
  it('reports frame rate from deltas', () => {
    const m = new FpsMeter(0.5);
    let published = false;
    for (let i = 0; i < 31; i++) published = m.tick(1 / 60) || published;
    expect(published).toBe(true);
    expect(m.fps).toBeCloseTo(60, 0);
    expect(m.frameTime).toBeCloseTo(16.67, 1);
  });
});
