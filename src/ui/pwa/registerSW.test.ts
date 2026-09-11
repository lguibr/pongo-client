/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStore } from '../../lib/store';
import { initialAppState } from '../../state/appStore';
import type { AppStore } from '../../state/appStore';
import type { SessionStateName } from '../../session/types';
import { fakeSession } from '../../test/fakes/fakeApp';
import { createPwa, registerWithWorkbox, UPDATE_CHECK_MS } from './registerSW';
import type { SwHooks } from './registerSW';

// workbox-window, recorded: each instance keeps its constructor arguments and its listeners, and `emit` plays
// a workbox event to them.
const wb = vi.hoisted(() => {
  type Listener = (e: object) => void;
  const state = {
    made: [] as FakeWorkbox[],
    registerResult: (): Promise<unknown> => Promise.resolve(undefined),
  };
  class FakeWorkbox {
    readonly listeners = new Map<string, Listener[]>();
    readonly register = vi.fn(() => state.registerResult());
    readonly messageSkipWaiting = vi.fn();
    constructor(
      readonly url: string,
      readonly options: unknown,
    ) {
      state.made.push(this);
    }
    addEventListener(type: string, fn: Listener): void {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
    }
    emit(type: string, e: object = {}): void {
      for (const fn of this.listeners.get(type) ?? []) fn(e);
    }
  }
  return Object.assign(state, { FakeWorkbox });
});

vi.mock('workbox-window', () => ({ Workbox: wb.FakeWorkbox }));

interface Harness {
  store: AppStore;
  pwa: ReturnType<typeof createPwa>;
  register: ReturnType<typeof vi.fn>;
  skipWaiting: ReturnType<typeof vi.fn>;
  reload: ReturnType<typeof vi.fn>;
  hooks(): SwHooks;
  needRefresh(): void;
  controlling(isUpdate: boolean): void;
  setState(s: SessionStateName): void;
}

function harness(opts: { skipWaiting?: () => Promise<void>; initial?: SessionStateName; fireDuringRegister?: boolean } = {}): Harness {
  const store = createStore(initialAppState());
  const setState = (s: SessionStateName): void => store.patch({ session: { ...store.get().session, s } });
  if (opts.initial !== undefined) setState(opts.initial);
  let captured: SwHooks | null = null;
  const skipWaiting = vi.fn(opts.skipWaiting ?? (() => Promise.resolve()));
  const register = vi.fn((h: SwHooks) => {
    captured = h;
    if (opts.fireDuringRegister === true) h.onNeedRefresh();
    return { skipWaiting };
  });
  const reload = vi.fn();
  const pwa = createPwa({ store, session: fakeSession(), register, reload });
  const hooks = (): SwHooks => {
    if (captured === null) throw new Error('register was not called');
    return captured;
  };
  return {
    store, pwa, register, skipWaiting, reload, hooks, setState,
    needRefresh: () => hooks().onNeedRefresh(),
    controlling: (isUpdate) => hooks().onControlling(isUpdate),
  };
}

const updateReady = (h: Harness): boolean => h.store.get().pwa.updateReady;

function spyHooks(): { onNeedRefresh: ReturnType<typeof vi.fn>; onRegisteredSW: ReturnType<typeof vi.fn>; onRegisterError: ReturnType<typeof vi.fn>; onControlling: ReturnType<typeof vi.fn> } {
  return { onNeedRefresh: vi.fn(), onRegisteredSW: vi.fn(), onRegisterError: vi.fn(), onControlling: vi.fn() };
}

/** jsdom has no service worker API; registerWithWorkbox only checks that it exists. */
function withServiceWorkerApi(): void {
  Object.defineProperty(navigator, 'serviceWorker', { value: {}, configurable: true });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  Reflect.deleteProperty(navigator, 'serviceWorker');
  wb.made.length = 0;
  wb.registerResult = () => Promise.resolve(undefined);
});

describe('registerWithWorkbox (5.14, amended)', () => {
  it('registers nothing in DEV, where the dev server has no worker', async () => {
    withServiceWorkerApi();
    vi.stubEnv('DEV', true);
    const reg = registerWithWorkbox(spyHooks());
    expect(wb.made).toHaveLength(0);
    await expect(reg.skipWaiting()).resolves.toBeUndefined();
  });

  it('registers nothing without the service worker API', () => {
    vi.stubEnv('DEV', false);
    registerWithWorkbox(spyHooks());
    expect(wb.made).toHaveLength(0);
  });

  it('in a build, registers /sw.js at once and maps workbox events to the hooks', async () => {
    withServiceWorkerApi();
    vi.stubEnv('DEV', false);
    const registration = { scope: '/' } as ServiceWorkerRegistration;
    wb.registerResult = () => Promise.resolve(registration);
    const h = spyHooks();
    const reg = registerWithWorkbox(h);
    expect(wb.made).toHaveLength(1);
    const w = wb.made[0];
    expect(w.url).toBe('/sw.js');
    expect(w.options).toEqual({ scope: '/' });
    expect(w.register).toHaveBeenCalledWith({ immediate: true });
    await vi.waitFor(() => expect(h.onRegisteredSW).toHaveBeenCalledWith(registration));

    w.emit('waiting');
    expect(h.onNeedRefresh).toHaveBeenCalledTimes(1);
    w.emit('installed', { isExternal: false }); // this page's own install: its `waiting` follows
    expect(h.onNeedRefresh).toHaveBeenCalledTimes(1);
    w.emit('installed', { isExternal: true }); // another tab's update
    expect(h.onNeedRefresh).toHaveBeenCalledTimes(2);

    w.emit('controlling', { isUpdate: true, isExternal: true });
    expect(h.onControlling).toHaveBeenLastCalledWith(true);
    w.emit('controlling', { isExternal: false }); // the first install claiming the page
    expect(h.onControlling).toHaveBeenLastCalledWith(false);

    await reg.skipWaiting();
    expect(w.messageSkipWaiting).toHaveBeenCalledTimes(1);
    expect(h.onRegisterError).not.toHaveBeenCalled();
  });

  it('reports a failed registration', async () => {
    withServiceWorkerApi();
    vi.stubEnv('DEV', false);
    const err = new Error('blocked');
    wb.registerResult = () => Promise.reject(err);
    const h = spyHooks();
    registerWithWorkbox(h);
    await vi.waitFor(() => expect(h.onRegisterError).toHaveBeenCalledWith(err));
    expect(h.onRegisteredSW).not.toHaveBeenCalled();
  });
});

describe('createPwa registration', () => {
  it('registers once, through the injected register', () => {
    const h = harness();
    h.pwa.start();
    h.pwa.start();
    expect(h.register).toHaveBeenCalledTimes(1);
    h.pwa.dispose();
  });

  it('checks for a new worker every 30 minutes and when the page becomes visible, until disposed', () => {
    vi.useFakeTimers();
    const h = harness();
    h.pwa.start();
    const update = vi.fn(() => Promise.resolve());
    h.hooks().onRegisteredSW({ update } as unknown as ServiceWorkerRegistration);

    vi.advanceTimersByTime(UPDATE_CHECK_MS - 1);
    expect(update).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(update).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(UPDATE_CHECK_MS);
    expect(update).toHaveBeenCalledTimes(2);

    const visibility = vi.spyOn(document, 'visibilityState', 'get');
    visibility.mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(update).toHaveBeenCalledTimes(2);
    visibility.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(update).toHaveBeenCalledTimes(3);

    h.pwa.dispose();
    vi.advanceTimersByTime(UPDATE_CHECK_MS * 3);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(update).toHaveBeenCalledTimes(3);
    visibility.mockRestore();
  });
});

describe('createPwa apply policy (D24, 5.14)', () => {
  it('applies at once when an update is found while idle on /', () => {
    const h = harness({ initial: 'idle' });
    h.pwa.notifyRoute('/');
    h.pwa.start();
    h.needRefresh();
    expect(h.skipWaiting).toHaveBeenCalledTimes(1);
    expect(updateReady(h)).toBe(false);
  });

  it('applies when the session has failed on /', () => {
    const h = harness({ initial: 'failed' });
    h.pwa.notifyRoute('/');
    h.pwa.start();
    h.needRefresh();
    expect(h.skipWaiting).toHaveBeenCalledTimes(1);
  });

  it('never applies inside a room: it sets updateReady instead', () => {
    for (const s of ['connecting', 'requesting', 'lobby', 'countdown', 'playing', 'reconnecting', 'finished'] as const) {
      const h = harness({ initial: s });
      h.pwa.notifyRoute(`/room/ABC123`);
      h.pwa.start();
      h.needRefresh();
      expect(h.skipWaiting, s).not.toHaveBeenCalled();
      expect(updateReady(h), s).toBe(true);
    }
  });

  it('does not apply while the session is still active on /, and applies once it goes idle there', () => {
    const h = harness({ initial: 'finished' });
    h.pwa.notifyRoute('/');
    h.pwa.start();
    h.needRefresh();
    expect(h.skipWaiting).not.toHaveBeenCalled();
    expect(updateReady(h)).toBe(true);
    h.setState('idle');
    expect(h.skipWaiting).toHaveBeenCalledTimes(1);
  });

  it('"Back to menu": leave while still on /room/…, then navigate to / — applied on the second step', () => {
    const h = harness({ initial: 'finished' });
    h.pwa.notifyRoute('/room/ABC123');
    h.pwa.start();
    h.needRefresh();
    expect(updateReady(h)).toBe(true);

    h.setState('idle'); // leave({ explicit: false })
    expect(h.skipWaiting).not.toHaveBeenCalled();
    expect(updateReady(h)).toBe(true);

    h.pwa.notifyRoute('/'); // navigate('/')
    expect(h.skipWaiting).toHaveBeenCalledTimes(1);

    h.pwa.notifyRoute('/');
    h.setState('failed');
    expect(h.skipWaiting).toHaveBeenCalledTimes(1);
  });

  it('idle on another page shows the chip and applies on reaching /', () => {
    const h = harness({ initial: 'idle' });
    h.pwa.notifyRoute('/nowhere');
    h.pwa.start();
    h.needRefresh();
    expect(h.skipWaiting).not.toHaveBeenCalled();
    expect(updateReady(h)).toBe(true);
    h.pwa.notifyRoute('/');
    expect(h.skipWaiting).toHaveBeenCalledTimes(1);
  });

  it('does nothing without a pending update', () => {
    const h = harness({ initial: 'idle' });
    h.pwa.start();
    h.pwa.notifyRoute('/');
    h.setState('failed');
    h.pwa.applyUpdate();
    expect(h.skipWaiting).not.toHaveBeenCalled();
    expect(h.reload).not.toHaveBeenCalled();
    expect(updateReady(h)).toBe(false);
  });

  it('handles an update found before register returned', () => {
    const h = harness({ initial: 'idle', fireDuringRegister: true });
    h.pwa.notifyRoute('/');
    h.pwa.start();
    expect(h.skipWaiting).toHaveBeenCalledTimes(1);
  });

  it('shows the chip again when applying fails, and can apply later', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let fail = true;
    const h = harness({ initial: 'idle', skipWaiting: () => (fail ? Promise.reject(new Error('offline')) : Promise.resolve()) });
    h.pwa.notifyRoute('/');
    h.pwa.start();
    h.needRefresh();
    await Promise.resolve();
    await Promise.resolve();
    expect(updateReady(h)).toBe(true);
    fail = false;
    h.pwa.notifyRoute('/');
    expect(h.skipWaiting).toHaveBeenCalledTimes(2);
  });

  it('applies a newer waiting worker after an earlier apply resolved without a reload', async () => {
    const h = harness({ initial: 'idle' });
    h.pwa.notifyRoute('/');
    h.pwa.start();
    h.needRefresh();
    expect(h.skipWaiting).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    await Promise.resolve();
    // SKIP_WAITING went out but that worker went redundant, so no reload came; a newer one is waiting now.
    h.needRefresh();
    expect(h.skipWaiting).toHaveBeenCalledTimes(2);
  });

  it('applies a newer waiting worker even while the earlier apply has not settled', () => {
    const h = harness({ initial: 'idle', skipWaiting: () => new Promise<void>(() => {}) });
    h.pwa.notifyRoute('/');
    h.pwa.start();
    h.needRefresh();
    h.needRefresh();
    expect(h.skipWaiting).toHaveBeenCalledTimes(2);
  });

  it('applyUpdate applies a pending update on request', () => {
    const h = harness({ initial: 'finished' });
    h.pwa.notifyRoute('/room/ABC123');
    h.pwa.start();
    h.needRefresh();
    expect(h.skipWaiting).not.toHaveBeenCalled();
    h.pwa.applyUpdate();
    expect(h.skipWaiting).toHaveBeenCalledTimes(1);
  });

  it('stops following the session after dispose', () => {
    const h = harness({ initial: 'playing' });
    h.pwa.notifyRoute('/');
    h.pwa.start();
    h.needRefresh();
    h.pwa.dispose();
    h.setState('idle');
    expect(h.skipWaiting).not.toHaveBeenCalled();
  });
});

describe('createPwa reload on controlling (5.14, amended)', () => {
  it("another tab's update never reloads a tab in a room: the reload waits for idle on /", () => {
    const h = harness({ initial: 'playing' });
    h.pwa.notifyRoute('/room/ABC123');
    h.pwa.start();
    h.needRefresh();
    expect(updateReady(h)).toBe(true);
    expect(h.skipWaiting).not.toHaveBeenCalled();

    h.controlling(true); // the other tab sent SKIP_WAITING; the new worker controls this page too
    expect(h.reload).not.toHaveBeenCalled();
    expect(updateReady(h)).toBe(true);

    h.setState('idle');
    expect(h.reload).not.toHaveBeenCalled(); // still on /room/…
    h.pwa.notifyRoute('/');
    expect(h.reload).toHaveBeenCalledTimes(1);
    expect(h.skipWaiting).not.toHaveBeenCalled();

    h.pwa.notifyRoute('/');
    h.setState('failed');
    expect(h.reload).toHaveBeenCalledTimes(1);
  });

  it("this tab's own apply: idle on /, SKIP_WAITING goes out and the controlling change reloads once", () => {
    const h = harness({ initial: 'idle' });
    h.pwa.notifyRoute('/');
    h.pwa.start();
    h.needRefresh();
    expect(h.skipWaiting).toHaveBeenCalledTimes(1);
    expect(h.reload).not.toHaveBeenCalled();
    h.controlling(true);
    expect(h.reload).toHaveBeenCalledTimes(1);
    expect(updateReady(h)).toBe(false);
  });

  it('the first install taking control (isUpdate false) does nothing', () => {
    const h = harness({ initial: 'idle' });
    h.pwa.notifyRoute('/');
    h.pwa.start();
    h.controlling(false);
    expect(h.reload).not.toHaveBeenCalled();
    expect(updateReady(h)).toBe(false);
    h.setState('failed');
    h.pwa.notifyRoute('/');
    expect(h.reload).not.toHaveBeenCalled();
  });

  it('with the new worker already in control off a room path, Reload now reloads instead of sending SKIP_WAITING', () => {
    const h = harness({ initial: 'idle' });
    h.pwa.notifyRoute('/nowhere');
    h.pwa.start();
    h.controlling(true);
    expect(h.reload).not.toHaveBeenCalled();
    expect(updateReady(h)).toBe(true);
    h.pwa.applyUpdate();
    expect(h.reload).toHaveBeenCalledTimes(1);
    expect(h.skipWaiting).not.toHaveBeenCalled();
    h.pwa.notifyRoute('/');
    expect(h.reload).toHaveBeenCalledTimes(1);
  });

  it('ignores a controlling change after dispose', () => {
    const h = harness({ initial: 'idle' });
    h.pwa.notifyRoute('/');
    h.pwa.start();
    h.pwa.dispose();
    h.controlling(true);
    h.pwa.applyUpdate();
    expect(h.reload).not.toHaveBeenCalled();
  });
});
