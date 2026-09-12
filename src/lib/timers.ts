// Named, tokened timers. Setting a name replaces its pending timer; every set returns a new token, and a
// callback that may run late checks isCurrent(name, token) before acting.

export interface TimerHost { setTimeout(fn: () => void, ms: number): number; clearTimeout(h: number): void }

export const browserTimers: TimerHost = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h),
};

export class Timers<N extends string> {
  private readonly host: TimerHost;
  private readonly handles = new Map<N, number>();   // pending timers only
  private readonly tokens = new Map<N, number>();    // latest token per name, kept after it fires
  private seq = 0;

  constructor(host: TimerHost = browserTimers) {
    this.host = host;
  }

  /** Replaces a pending timer of that name; returns its token. */
  set(name: N, ms: number, fire: (name: N) => void): number {
    this.clear(name);
    const token = ++this.seq;
    this.tokens.set(name, token);
    const handle = this.host.setTimeout(() => {
      if (this.tokens.get(name) !== token) return;   // replaced or cleared; the host could not cancel it
      this.handles.delete(name);
      fire(name);
    }, Math.max(0, ms));
    this.handles.set(name, handle);
    return token;
  }

  clear(name: N): void {
    const handle = this.handles.get(name);
    if (handle !== undefined) this.host.clearTimeout(handle);
    this.handles.delete(name);
    this.tokens.delete(name);
  }

  clearAll(): void {
    for (const handle of this.handles.values()) this.host.clearTimeout(handle);
    this.handles.clear();
    this.tokens.clear();
  }

  pending(name: N): boolean {
    return this.handles.has(name);
  }

  /** True while `token` is the latest set of `name` and it has not been cleared since. */
  isCurrent(name: N, token: number): boolean {
    return this.tokens.get(name) === token;
  }
}
