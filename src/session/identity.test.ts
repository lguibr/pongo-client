import { describe, expect, it, vi } from 'vitest';
import { createIdentity, DEVICE_ID_KEY, LOCK_PREFIX, SESSION_ID_KEY } from './identity';
import { createSafeStorage } from '../lib/storage';
import type { SafeStorage } from '../lib/storage';
import { FakeClock } from '../test/fakes/FakeClock';

/** An in-memory Web Locks manager: exclusive locks, ifAvailable, AbortSignal, FIFO waiters. */
class FakeLocks implements LockManager {
  readonly requests: Array<{ name: string; options: LockOptions }> = [];
  onRequest: ((name: string) => void) | null = null;
  private readonly holders = new Map<string, object>();
  private readonly waiters = new Map<string, Array<() => void>>();

  isHeld(id: string): boolean {
    return this.holders.has(LOCK_PREFIX + id);
  }

  /** Another tab holds the lock until the returned function runs. */
  holdElsewhere(id: string): () => void {
    const name = LOCK_PREFIX + id;
    const token = {};
    this.holders.set(name, token);
    return () => this.freeIf(name, token);
  }

  /** The holder's document died: its lock goes away without its callback promise settling. */
  forceRelease(name: string): void {
    if (this.holders.has(name)) this.free(name);
  }

  query(): Promise<LockManagerSnapshot> {
    return Promise.resolve({ held: [...this.holders.keys()].map((name) => ({ name, mode: 'exclusive' as LockMode })), pending: [] });
  }

  request(name: string, a: LockOptions | LockGrantedCallback, b?: LockGrantedCallback): Promise<unknown> {
    const options: LockOptions = typeof a === 'function' ? {} : a;
    const cb = (typeof a === 'function' ? a : b) as LockGrantedCallback;
    this.requests.push({ name, options });
    this.onRequest?.(name);
    return new Promise((resolve, reject) => {
      const grant = (): void => {
        const token = {};
        this.holders.set(name, token);
        Promise.resolve()
          .then(() => cb({ name, mode: 'exclusive' }))
          .then(
            (v) => {
              this.freeIf(name, token);
              resolve(v);
            },
            (err) => {
              this.freeIf(name, token);
              reject(err);
            },
          );
      };
      if (!this.holders.has(name)) return grant();
      if (options.ifAvailable) {
        Promise.resolve().then(() => cb(null)).then(resolve, reject);
        return;
      }
      const signal = options.signal;
      if (signal?.aborted) return reject(signal.reason);
      const queue = this.waiters.get(name) ?? [];
      this.waiters.set(name, queue);
      const onAbort = (): void => {
        const i = queue.indexOf(entry);
        if (i >= 0) queue.splice(i, 1);
        reject(signal?.reason);
      };
      const entry = (): void => {
        signal?.removeEventListener('abort', onAbort);
        grant();
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      queue.push(entry);
    });
  }

  private freeIf(name: string, token: object): void {
    if (this.holders.get(name) === token) this.free(name);
  }

  private free(name: string): void {
    this.holders.delete(name);
    this.waiters.get(name)?.shift()?.();
  }
}

const memory = (init: Record<string, string> = {}): SafeStorage => {
  const s = createSafeStorage(() => null);
  for (const [k, v] of Object.entries(init)) s.set(k, v);
  return s;
};
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
/** Settles pending promise chains without a timer, for tests that fake setTimeout. */
const microtasks = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
const HEX32 = /^[0-9a-f]{32}$/;
// Real-time waits only need a lower bound to prove the wait; the upper bounds are loose for a loaded run.

describe('createIdentity with Web Locks', () => {
  it('tab A keeps its sessionStorage id, waiting for its lock with a signal', async () => {
    const locks = new FakeLocks();
    const id = createIdentity({ locks, local: memory({ [DEVICE_ID_KEY]: 'dev' }), session: memory({ [SESSION_ID_KEY]: 'aaa' }) });
    await id.ready;
    expect(id.current()).toBe('aaa');
    expect(locks.isHeld('aaa')).toBe(true);
    expect(locks.requests[0].name).toBe(LOCK_PREFIX + 'aaa');
    expect(locks.requests[0].options.signal).toBeInstanceOf(AbortSignal);
    expect(locks.requests[0].options.ifAvailable).toBeUndefined();
  });

  it('a first visit mints an id, locks it, and stores it as the device id', async () => {
    const locks = new FakeLocks();
    const local = memory();
    const session = memory();
    const id = createIdentity({ locks, local, session });
    await id.ready;
    expect(id.current()).toMatch(HEX32);
    expect(local.get(DEVICE_ID_KEY)).toBe(id.current());
    expect(session.get(SESSION_ID_KEY)).toBe(id.current());
    expect(locks.isHeld(id.current())).toBe(true);
    expect(locks.requests.slice(-1)[0]?.options.ifAvailable).toBe(true);
  });

  it('a PWA relaunch (no sessionStorage) uses the device id', async () => {
    const locks = new FakeLocks();
    const session = memory();
    const id = createIdentity({ locks, local: memory({ [DEVICE_ID_KEY]: 'dev' }), session });
    await id.ready;
    expect(id.current()).toBe('dev');
    expect(session.get(SESSION_ID_KEY)).toBe('dev');
    expect(locks.requests.map((r) => [r.name, r.options.ifAvailable])).toEqual([[LOCK_PREFIX + 'dev', true]]);
  });

  it('tab B with a copied sessionStorage mints a new id after waitMs', async () => {
    const locks = new FakeLocks();
    const local = memory({ [DEVICE_ID_KEY]: 'aaa' });
    const a = createIdentity({ locks, local, session: memory({ [SESSION_ID_KEY]: 'aaa' }) });
    await a.ready;

    const sessionB = memory({ [SESSION_ID_KEY]: 'aaa' }); // duplicated tab: sessionStorage is copied
    const t0 = performance.now();
    const b = createIdentity({ locks, local, session: sessionB, waitMs: 60 });
    await b.ready;
    const waited = performance.now() - t0;
    expect(waited).toBeGreaterThanOrEqual(50);
    expect(waited).toBeLessThan(2000);
    expect(b.current()).toMatch(HEX32);
    expect(b.current()).not.toBe('aaa');
    expect(sessionB.get(SESSION_ID_KEY)).toBe(b.current());
    expect(local.get(DEVICE_ID_KEY)).toBe('aaa'); // the device id stays with tab A
    expect(a.current()).toBe('aaa');
    expect(locks.isHeld('aaa')).toBe(true);
    expect(locks.isHeld(b.current())).toBe(true);
  });

  it('a second tab whose device id is held elsewhere settles without waiting', async () => {
    const locks = new FakeLocks();
    const local = memory({ [DEVICE_ID_KEY]: 'dev' });
    locks.holdElsewhere('dev');
    const t0 = performance.now();
    const id = createIdentity({ locks, local, session: memory(), waitMs: 10_000 });
    await id.ready;
    expect(performance.now() - t0).toBeLessThan(2000); // ifAvailable, not the 10 s wait
    expect(id.current()).not.toBe('dev');
    expect(local.get(DEVICE_ID_KEY)).toBe('dev');
  });

  it('a reload keeps the id when the unloading page releases its lock 100 ms after the new request', async () => {
    const locks = new FakeLocks();
    const session = memory({ [SESSION_ID_KEY]: 'aaa' });
    const local = memory({ [DEVICE_ID_KEY]: 'aaa' });
    const old = createIdentity({ locks, local, session });
    await old.ready;
    expect(locks.isHeld('aaa')).toBe(true);

    locks.onRequest = (name) => {
      if (name === LOCK_PREFIX + 'aaa') setTimeout(() => locks.forceRelease(name), 100);
    };
    const t0 = performance.now();
    const reloaded = createIdentity({ locks, local, session }); // sessionStorage survives the reload
    await reloaded.ready;
    const waited = performance.now() - t0;
    expect(reloaded.current()).toBe('aaa');
    expect(waited).toBeGreaterThanOrEqual(90);
    expect(waited).toBeLessThan(2500);
    expect(locks.isHeld('aaa')).toBe(true);
  });

  it('rotate keeps the previous id for the rejoin window; restorePrevious works within it', async () => {
    const clock = new FakeClock(0);
    const locks = new FakeLocks();
    const local = memory();
    const session = memory();
    const id = createIdentity({ locks, local, session, now: clock.now, windowMs: 30_000 });
    await id.ready;
    const first = id.current();
    expect(id.hasPrevious()).toBe(false);

    id.rotate();
    await flush();
    const second = id.current();
    expect(second).not.toBe(first);
    expect(session.get(SESSION_ID_KEY)).toBe(second);
    expect(local.get(DEVICE_ID_KEY)).toBe(second); // this tab owned the device id
    expect(id.hasPrevious()).toBe(true);
    expect(locks.isHeld(first)).toBe(true); // kept during the window
    expect(locks.isHeld(second)).toBe(true);

    clock.advance(29_999);
    expect(id.restorePrevious()).toBe(true);
    await flush();
    expect(id.current()).toBe(first);
    expect(session.get(SESSION_ID_KEY)).toBe(first);
    expect(local.get(DEVICE_ID_KEY)).toBe(first);
    expect(locks.isHeld(second)).toBe(false); // the rotated id is released
    expect(id.hasPrevious()).toBe(false);
    expect(id.restorePrevious()).toBe(false);
  });

  it('restorePrevious fails after the window, and the previous lock is released', async () => {
    const clock = new FakeClock(0);
    const locks = new FakeLocks();
    const id = createIdentity({ locks, local: memory(), session: memory(), now: clock.now, windowMs: 30_000 });
    await id.ready;
    const first = id.current();
    id.rotate();
    await flush();
    clock.advance(30_000);
    expect(id.hasPrevious()).toBe(false);
    expect(id.restorePrevious()).toBe(false);
    await flush();
    expect(locks.isHeld(first)).toBe(false);
    expect(id.current()).not.toBe(first);
  });

  it('releases the previous lock when the window timer fires just before the window ends', async () => {
    let t = 0; // `now` and the host timer are coarsened separately, so the timer may run ahead of the clock
    const locks = new FakeLocks();
    const id = createIdentity({ locks, local: memory(), session: memory(), now: () => t, windowMs: 30_000 });
    await id.ready;
    const first = id.current();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      id.rotate();
      await microtasks();
      t = 29_999;
      await vi.advanceTimersByTimeAsync(30_000); // fires at until - 1 on the clock
      await microtasks();
      expect(locks.isHeld(first)).toBe(true); // not yet: the window has 1 ms left
      t = 30_000;
      await vi.advanceTimersByTimeAsync(1); // the re-armed timer
      await microtasks();
      expect(locks.isHeld(first)).toBe(false); // released without any later call into the identity
      expect(locks.isHeld(id.current())).toBe(true);
    } finally {
      vi.useRealTimers();
    }
    expect(id.hasPrevious()).toBe(false);
  });

  it('rotate leaves the device id alone when this tab does not own it', async () => {
    const locks = new FakeLocks();
    const local = memory({ [DEVICE_ID_KEY]: 'dev' });
    locks.holdElsewhere('dev');
    const id = createIdentity({ locks, local, session: memory() });
    await id.ready;
    id.rotate();
    expect(local.get(DEVICE_ID_KEY)).toBe('dev');
  });

  it('pagehide(persisted) releases the locks, and pageshow takes the current one back', async () => {
    const locks = new FakeLocks();
    const id = createIdentity({ locks, local: memory(), session: memory({ [SESSION_ID_KEY]: 'aaa' }) });
    await id.ready;
    id.onPageHide(false);
    await flush();
    expect(locks.isHeld('aaa')).toBe(true); // an unloading page keeps them until the browser drops them

    id.onPageHide(true);
    await flush();
    expect(locks.isHeld('aaa')).toBe(false);
    await id.onPageShow(true);
    expect(locks.isHeld('aaa')).toBe(true);
    expect(id.current()).toBe('aaa');
  });

  it('pageshow keeps the id without a lock when another tab took it meanwhile', async () => {
    const locks = new FakeLocks();
    const id = createIdentity({ locks, local: memory(), session: memory({ [SESSION_ID_KEY]: 'aaa' }) });
    await id.ready;
    id.onPageHide(true);
    await flush();
    const releaseOther = locks.holdElsewhere('aaa');
    await id.onPageShow(true);
    expect(id.current()).toBe('aaa');
    releaseOther();
    expect(locks.isHeld('aaa')).toBe(false);
  });

  it('settles even when the lock manager throws', async () => {
    const broken = { request: () => { throw new Error('SecurityError'); }, query: () => Promise.reject(new Error('no')) } as unknown as LockManager;
    const id = createIdentity({ locks: broken, local: memory({ [DEVICE_ID_KEY]: 'dev' }), session: memory({ [SESSION_ID_KEY]: 'aaa' }), waitMs: 20 });
    await id.ready;
    expect(id.current()).toMatch(HEX32); // neither candidate could be locked
  });
});

describe('createIdentity without Web Locks', () => {
  it('uses the sessionStorage id first', async () => {
    const id = createIdentity({ locks: null, local: memory({ [DEVICE_ID_KEY]: 'dev' }), session: memory({ [SESSION_ID_KEY]: 'sss' }) });
    await id.ready;
    expect(id.current()).toBe('sss');
  });

  it('falls back to the device id, as the previous client did', async () => {
    const session = memory();
    const id = createIdentity({ local: memory({ [DEVICE_ID_KEY]: 'dev' }), session });
    await id.ready;
    expect(id.current()).toBe('dev');
    expect(session.get(SESSION_ID_KEY)).toBe('dev');
  });

  it('mints and stores an id when there is none', async () => {
    const local = memory();
    const session = memory();
    const id = createIdentity({ locks: null, local, session });
    await id.ready;
    expect(id.current()).toMatch(HEX32);
    expect(local.get(DEVICE_ID_KEY)).toBe(id.current());
    expect(session.get(SESSION_ID_KEY)).toBe(id.current());
  });

  it('still rotates and restores', async () => {
    const clock = new FakeClock(0);
    const id = createIdentity({ locks: null, local: memory(), session: memory({ [SESSION_ID_KEY]: 'sss' }), now: clock.now });
    await id.ready;
    id.rotate();
    expect(id.current()).not.toBe('sss');
    expect(id.restorePrevious()).toBe(true);
    expect(id.current()).toBe('sss');
    await id.onPageShow(true);
    expect(id.current()).toBe('sss');
  });
});
