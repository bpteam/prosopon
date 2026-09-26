import { describe, expect, it } from 'vitest';
import { RingBuffer } from '../../src/ui/shared/RingBuffer';
import { DevHistory, HISTORY_CAPACITY, SERIES } from '../../src/ui/dev/History';

describe('RingBuffer', () => {
  it('never grows past its capacity', () => {
    const b = new RingBuffer(300);
    for (let i = 0; i < 10_000; i++) b.push(i);
    expect(b.length).toBe(300);
    expect(b.at(0)).toBe(9700);
    expect(b.last).toBe(9999);
    expect(b.range()).toEqual({ min: 9700, max: 9999 });
  });

  it('keeps gaps (NaN) out of the range', () => {
    const b = new RingBuffer(4);
    b.push(Number.NaN);
    b.push(2);
    b.push(Number.POSITIVE_INFINITY);
    expect(b.range()).toEqual({ min: 2, max: 2 });
  });

  it('diagnostics history is 30 s at 10 Hz for every series', () => {
    expect(HISTORY_CAPACITY).toBe(300);
    const h = new DevHistory();
    for (const key of SERIES) for (let i = 0; i < 10_000; i++) h.get(key).push(i);
    expect(h.size).toBe(SERIES.length * 300);
  });
});
