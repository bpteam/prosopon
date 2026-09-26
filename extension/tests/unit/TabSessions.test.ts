import { describe, expect, it, vi } from 'vitest';
import { TabSessions, type CaptureBackend } from '../../src/background/TabSessions';

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

function setup(overrides: Partial<CaptureBackend> = {}) {
  const backend = {
    getStreamId: vi.fn(async (tabId: number) => `stream-${tabId}`),
    startCapture: vi.fn(async () => {}),
    stopCapture: vi.fn(async () => {}),
    release: vi.fn(async () => {}),
    ...overrides,
  };
  const sessions = new TabSessions(backend);
  const events: string[] = [];
  sessions.onChange((tab, state, error) => events.push(`${tab}:${state}${error ? `(${error})` : ''}`));
  return { backend, sessions, events };
}

describe('TabSessions', () => {
  it('enable → starting → enabled, one capture', async () => {
    const { backend, sessions, events } = setup();
    await sessions.enable(1);
    expect(sessions.get(1).state).toBe('enabled');
    expect(events).toEqual(['1:starting', '1:enabled']);
    expect(backend.startCapture).toHaveBeenCalledWith(1, 'stream-1');
  });

  it('enable, enable (concurrent and sequential) starts one capture', async () => {
    const start = deferred();
    const { backend, sessions } = setup({ startCapture: vi.fn(() => start.promise) });
    const a = sessions.enable(1);
    const b = sessions.enable(1);
    start.resolve();
    await Promise.all([a, b]);
    await sessions.enable(1);
    expect(backend.getStreamId).toHaveBeenCalledTimes(1);
    expect(backend.startCapture).toHaveBeenCalledTimes(1);
    expect(sessions.get(1).state).toBe('enabled');
  });

  it('disable, disable is safe and stops once', async () => {
    const { backend, sessions } = setup();
    await sessions.enable(1);
    await sessions.disable(1);
    await sessions.disable(1);
    await sessions.disable(99); // never enabled
    expect(backend.stopCapture).toHaveBeenCalledTimes(1);
    expect(backend.release).toHaveBeenCalledTimes(1);
    expect(sessions.get(1).state).toBe('disabled');
  });

  it('toggle flips between enabled and disabled', async () => {
    const { sessions } = setup();
    await sessions.toggle(3);
    expect(sessions.get(3).state).toBe('enabled');
    await sessions.toggle(3);
    expect(sessions.get(3).state).toBe('disabled');
  });

  it('disable while starting cancels: the late capture is stopped, state stays disabled', async () => {
    const start = deferred();
    const { backend, sessions } = setup({ startCapture: vi.fn(() => start.promise) });
    const enabling = sessions.enable(1);
    await Promise.resolve();
    await sessions.disable(1);
    start.resolve();
    await enabling;
    expect(sessions.get(1).state).toBe('disabled');
    expect(backend.stopCapture).toHaveBeenCalledWith(1);
  });

  it('tabCapture denied → error state, offscreen released; next click retries', async () => {
    const { backend, sessions } = setup({
      getStreamId: vi.fn().mockRejectedValueOnce(new Error('Extension has not been invoked')).mockResolvedValue('s'),
    });
    await sessions.enable(1);
    expect(sessions.get(1)).toEqual({ state: 'error', error: 'Extension has not been invoked' });
    expect(backend.release).toHaveBeenCalled();
    await sessions.toggle(1);
    expect(sessions.get(1).state).toBe('enabled');
  });

  it('offscreen failure (creation, AudioContext, worklet) → error', async () => {
    const { sessions } = setup({ startCapture: vi.fn().mockRejectedValue(new Error('AudioContext failed')) });
    await sessions.enable(1);
    expect(sessions.get(1)).toEqual({ state: 'error', error: 'AudioContext failed' });
  });

  it('capture ending by itself → error, released only when no other tab is active', async () => {
    const { backend, sessions } = setup();
    await sessions.enable(1);
    await sessions.enable(2);
    await sessions.captureEnded(1, 'tab audio capture ended');
    expect(sessions.get(1)).toEqual({ state: 'error', error: 'tab audio capture ended' });
    expect(backend.release).not.toHaveBeenCalled();
    await sessions.remove(2);
    expect(backend.release).toHaveBeenCalledTimes(1);
    expect(sessions.activeTabs).toEqual([]);
  });

  it('restore marks tabs the offscreen document still captures as enabled', () => {
    const { sessions } = setup();
    sessions.restore([4, 5]);
    expect(sessions.activeTabs).toEqual([4, 5]);
  });
});
