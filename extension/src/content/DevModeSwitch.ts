import type { DevToolsHandle } from '../ui/dev/DevBridge';

/**
 * Developer Mode on/off for one mounted runtime. ON loads and mounts the developer UI once (repeated ONs, or an ON
 * while it is still loading, create nothing new); OFF disposes it, and an OFF during loading discards the load when
 * it arrives. While OFF nothing of the developer UI exists: no windows, no history, no telemetry.
 */
export class DevModeSwitch {
  private handleValue: DevToolsHandle | null = null;
  private loading = false;
  private generation = 0;
  private onValue = false;
  private disposed = false;
  /** Mounts performed (tests). */
  mounts = 0;

  constructor(
    /** Loads the developer UI chunk and mounts it (a dynamic import in the runtime). */
    private readonly load: () => Promise<() => DevToolsHandle>,
    private readonly hooks: { onEnable?(): void; onDisable?(): void; onError?(error: unknown): void } = {},
  ) {}

  get on(): boolean {
    return this.onValue;
  }

  /** The mounted developer UI, null while off or still loading. */
  get handle(): DevToolsHandle | null {
    return this.handleValue;
  }

  get busy(): boolean {
    return this.loading;
  }

  set(on: boolean): void {
    if (this.disposed) return;
    if (!on) {
      const was = this.onValue || this.loading || this.handleValue;
      this.onValue = false;
      this.generation++;
      this.loading = false;
      this.handleValue?.prepareNextSession();
      this.handleValue?.dispose();
      this.handleValue = null;
      if (was) this.hooks.onDisable?.();
      return;
    }
    if (this.onValue) return; // ON twice: one instance
    this.onValue = true;
    this.hooks.onEnable?.();
    this.loading = true;
    const generation = ++this.generation;
    void this.load()
      .then((mount) => {
        if (generation !== this.generation || this.disposed) return;
        this.handleValue = mount();
        this.mounts++;
      })
      .catch((error: unknown) => this.hooks.onError?.(error))
      .finally(() => {
        if (generation === this.generation) this.loading = false;
      });
  }

  dispose(): void {
    this.generation++;
    this.handleValue?.dispose();
    this.handleValue = null;
    this.loading = false;
    this.disposed = true;
  }
}
