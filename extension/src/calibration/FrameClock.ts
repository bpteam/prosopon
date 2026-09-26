/**
 * The wizard's clock, advanced by the render loop (tick). Waits resolve on a tick, so the wizard has no timers of its
 * own and pauses with the page's rendering (a hidden tab), like the avatar does. `abort()` rejects every pending wait.
 */
export class CalibrationAborted extends Error {
  constructor() {
    super('calibration aborted');
  }
}

interface Waiter {
  test: () => boolean;
  deadline: number;
  resolve: (ok: boolean) => void;
  reject: (error: Error) => void;
}

export class FrameClock {
  /** Seconds of ticked time. */
  private time = 0;
  private waiters: Waiter[] = [];
  private aborted = false;

  get now(): number {
    return this.time;
  }

  tick(deltaSeconds: number): void {
    if (!(deltaSeconds > 0) || !Number.isFinite(deltaSeconds)) deltaSeconds = 0;
    this.time += deltaSeconds;
    if (!this.waiters.length) return;
    const pending = this.waiters;
    this.waiters = [];
    for (const w of pending) {
      let ok = false;
      try {
        ok = w.test();
      } catch (error) {
        w.reject(error instanceof Error ? error : new Error(String(error)));
        continue;
      }
      if (ok) w.resolve(true);
      else if (this.time >= w.deadline) w.resolve(false);
      else this.waiters.push(w);
    }
  }

  /** Resolves true once `test` holds (checked every tick), false after `seconds`. */
  until(test: () => boolean, seconds: number): Promise<boolean> {
    if (this.aborted) return Promise.reject(new CalibrationAborted());
    return new Promise((resolve, reject) => this.waiters.push({ test, deadline: this.time + seconds, resolve, reject }));
  }

  async sleep(seconds: number): Promise<void> {
    await this.until(() => false, seconds);
  }

  /** Resolves true once `test` has held continuously for `holdSeconds`, false after `timeout`. */
  async held(test: () => boolean, holdSeconds: number, timeout: number): Promise<boolean> {
    let since: number | null = null;
    return this.until(() => {
      if (!test()) {
        since = null;
        return false;
      }
      since ??= this.time;
      return this.time - since >= holdSeconds;
    }, timeout);
  }

  /** Rejects every pending and future wait with CalibrationAborted. */
  abort(): void {
    this.aborted = true;
    const pending = this.waiters;
    this.waiters = [];
    for (const w of pending) w.reject(new CalibrationAborted());
  }
}
