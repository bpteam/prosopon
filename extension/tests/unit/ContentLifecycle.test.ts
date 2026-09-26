import { describe, expect, it, vi } from 'vitest';
import { ContentLifecycle, type ContentLifecycleDeps } from '../../src/content/ContentLifecycle';
import type { AvatarRuntimeHandle } from '../../src/content/avatar-runtime';
import { message, type ExtensionMessage } from '../../src/shared/messages';

function fakeRuntime(): AvatarRuntimeHandle & { frames: unknown[]; disposed: number } {
  const r = {
    frames: [] as unknown[],
    disposed: 0,
    diagnostics: {} as AvatarRuntimeHandle['diagnostics'],
    pushFrame: (f: unknown) => void r.frames.push(f),
    setAudioStatus: vi.fn(),
    pushUserVoice: vi.fn(),
    setMicStatus: vi.fn(),
    pushEmotion: vi.fn(),
    setEmotionStatus: vi.fn(),
    setOffscreenConnected: vi.fn(),
    setExtensionState: vi.fn(),
    setPlacementMode: vi.fn(),
    pushTelemetry: vi.fn(),
    dispose: () => void r.disposed++,
  };
  return r;
}

function setup(overrides: Partial<ContentLifecycleDeps> = {}) {
  const runtimes: ReturnType<typeof fakeRuntime>[] = [];
  const links: { onMessage: (m: ExtensionMessage) => void; onDisconnect: () => void; disconnected: boolean }[] = [];
  const scheduled: (() => void)[] = [];
  let alive = true;
  const deps: ContentLifecycleDeps = {
    mount: vi.fn(async () => {
      const r = fakeRuntime();
      runtimes.push(r);
      return r;
    }),
    connect: vi.fn((onMessage, onDisconnect) => {
      const link = { onMessage, onDisconnect, disconnected: false };
      links.push(link);
      return { disconnect: () => void (link.disconnected = true) };
    }),
    requestState: vi.fn(async () => ({ state: 'enabled' as const })),
    isExtensionAlive: () => alive,
    schedule: (fn) => void scheduled.push(fn),
    ...overrides,
  };
  return { lifecycle: new ContentLifecycle(deps), deps, runtimes, links, scheduled, kill: () => (alive = false) };
}

const frame = { active: true, volume: 0.5, visemes: { aa: 0.5, ih: 0, ou: 0, ee: 0, oh: 0 } };

describe('ContentLifecycle', () => {
  it('enable, enable → one runtime and one port (also when concurrent)', async () => {
    const { lifecycle, runtimes, links } = setup();
    await Promise.all([lifecycle.apply('enabled'), lifecycle.apply('enabled')]);
    await lifecycle.apply('enabled');
    expect(runtimes).toHaveLength(1);
    expect(links).toHaveLength(1);
  });

  it('disable, disable is safe; resources are released once', async () => {
    const { lifecycle, runtimes, links } = setup();
    await lifecycle.apply('enabled');
    await lifecycle.apply('disabled');
    await lifecycle.apply('disabled');
    expect(runtimes[0]!.disposed).toBe(1);
    expect(links[0]!.disconnected).toBe(true);
    expect(lifecycle.mounted).toBeNull();
  });

  it('frames from the port reach the runtime (transport knows no VRM)', async () => {
    const { lifecycle, runtimes, links } = setup();
    await lifecycle.apply('enabled');
    links[0]!.onMessage(message({ type: 'lipsync:frame', frame }));
    links[0]!.onMessage(message({ type: 'audio:status', status: { mode: 'viseme', analyzer: 'ready' } }));
    expect(runtimes[0]!.frames).toEqual([frame]);
    expect(runtimes[0]!.setAudioStatus).toHaveBeenCalledWith({ mode: 'viseme', analyzer: 'ready' });
  });

  it('disable while the runtime is still loading discards it', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const runtime = fakeRuntime();
    const { lifecycle, links } = setup({ mount: vi.fn(async () => (await gate, runtime)) });
    const enabling = lifecycle.apply('enabled');
    await lifecycle.apply('disabled');
    release();
    await enabling;
    expect(runtime.disposed).toBe(1);
    expect(lifecycle.mounted).toBeNull();
    expect(links).toHaveLength(0);
  });

  it('error state tears down like disable (ChatGPT left as it was)', async () => {
    const { lifecycle, runtimes } = setup();
    await lifecycle.apply('enabled');
    await lifecycle.apply('error', 'tab audio capture ended');
    expect(runtimes[0]!.disposed).toBe(1);
  });

  it('mount failure (VRM chunk failed) is reported, nothing half-mounted', async () => {
    const onError = vi.fn();
    const { lifecycle, links } = setup({ mount: vi.fn().mockRejectedValue(new Error('import failed')), onError });
    await lifecycle.apply('enabled');
    expect(onError).toHaveBeenCalled();
    expect(links).toHaveLength(0);
  });

  it('port lost while enabled: asks the SW and reconnects once', async () => {
    const { lifecycle, links, scheduled, deps } = setup();
    await lifecycle.apply('enabled');
    links[0]!.onDisconnect();
    expect(lifecycle.connected).toBe(false);
    scheduled.shift()!();
    await vi.waitFor(() => expect(links).toHaveLength(2));
    expect(deps.requestState).toHaveBeenCalledTimes(1);
  });

  it('orphaned by an extension reload: disposes itself', async () => {
    const { lifecycle, links, runtimes, kill, scheduled } = setup();
    await lifecycle.apply('enabled');
    kill();
    links[0]!.onDisconnect();
    expect(runtimes[0]!.disposed).toBe(1);
    expect(scheduled).toHaveLength(0);
    await lifecycle.apply('enabled'); // late message: ignored
    expect(runtimes).toHaveLength(1);
  });

  // Regression (US-005): the development analyser hook must not outlive the port it writes to.
  it('sends debug payloads over the open port only', async () => {
    const sent: unknown[] = [];
    const { lifecycle } = setup({
      connect: () => ({ disconnect: () => {}, send: (payload) => void sent.push(payload) }),
    });

    lifecycle.send({ type: 'debug:analyzer', choice: 'none' });
    expect(sent).toEqual([]); // not connected yet

    await lifecycle.apply('enabled');
    lifecycle.send({ type: 'debug:analyzer', choice: 'none' });
    expect(sent).toEqual([{ type: 'debug:analyzer', choice: 'none' }]);

    await lifecycle.apply('disabled');
    lifecycle.send({ type: 'debug:analyzer', choice: 'headaudio' });
    expect(sent).toHaveLength(1);
  });
});
