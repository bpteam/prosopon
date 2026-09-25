import { describe, expect, it } from 'vitest';
import { FpsMeter } from '../../src/debug/FpsMeter';
import { fitDistance } from '../../src/renderer/AvatarStage';

describe('fitDistance', () => {
  it('is height-bound on landscape and width-bound on narrow portrait viewports', () => {
    const landscape = fitDistance(0.6, 0.6, 30, 16 / 9);
    const square = fitDistance(0.6, 0.6, 30, 1);
    const portrait = fitDistance(0.6, 0.6, 30, 9 / 16);
    expect(landscape).toBeCloseTo(square);
    expect(portrait).toBeGreaterThan(square);
    // 0.6m at fov 30°: 0.3 / tan(15°)
    expect(square).toBeCloseTo(0.3 / Math.tan(Math.PI / 12));
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
