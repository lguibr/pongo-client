// Service worker updates in prompt mode (5.14 amended, D24, C30). `start()` registers through `register`
// (default: `registerWithWorkbox`, workbox-window on /sw.js; nothing in DEV) and checks for a new worker every
// 30 minutes and whenever the page becomes visible. A waiting update is applied (SKIP_WAITING) only when the
// session is idle or failed AND the path is `/`; otherwise `pwa.updateReady` is set and UpdateChip shows. The
// check runs when an update is found, on every session state change and on every notifyRoute, so "Back to
// menu" (leave while still on /room/…, then navigate to `/`) applies the update on the second step.
//
// The reload follows `controlling` (a new worker took over this page) and goes through the same policy. This
// tab's own SKIP_WAITING arrives with the policy already met and reloads at once. Another tab's update never
// reloads a tab that is in a room: that reload waits, with the chip shown, until the policy holds. The page
// never reloads inside a room.

import { Workbox } from 'workbox-window';
import type { AppStore } from '../../state/appStore';
import type { SessionApi, SessionStateName } from '../../session/types';
import type { PwaApi } from '../../app/types';
import { log } from '../../lib/log';

export const UPDATE_CHECK_MS = 30 * 60 * 1000;

/** What a registration reports back to createPwa. */
export interface SwHooks {
  /** A new worker is waiting: this page's own update, or one another tab installed. */
  onNeedRefresh(): void;
  onRegisteredSW(r: ServiceWorkerRegistration | undefined): void;
  onRegisterError(err: unknown): void;
  /** A new worker took control of this page. `isUpdate` is false for the first install (nothing to reload). */
  onControlling(isUpdate: boolean): void;
}

export interface SwRegistration {
  /** Asks the waiting worker to activate; the reload follows through `onControlling`. */
  skipWaiting(): Promise<void>;
}

export interface PwaDeps {
  store: AppStore;
  session: SessionApi;
  register?: (h: SwHooks) => SwRegistration;
  reload?: () => void;
}

const APPLY_STATES: ReadonlySet<SessionStateName> = new Set(['idle', 'failed']);

const NO_REGISTRATION: SwRegistration = { skipWaiting: () => Promise.resolve() };

/** The default `register`: workbox-window on /sw.js. DEV registers nothing, because the dev server has no
 *  worker (devOptions.enabled is false) and unregisterDevWorkers removes stale ones. Neither does a browser
 *  without service workers. */
export function registerWithWorkbox(h: SwHooks): SwRegistration {
  if (import.meta.env.DEV || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return NO_REGISTRATION;
  const wb = new Workbox('/sw.js', { scope: '/' });
  // This page's own update arrives as `waiting`; one installed by another tab arrives as an external install.
  wb.addEventListener('waiting', () => h.onNeedRefresh());
  wb.addEventListener('installed', (e) => {
    if (e.isExternal === true) h.onNeedRefresh();
  });
  wb.addEventListener('controlling', (e) => h.onControlling(e.isUpdate === true));
  wb.register({ immediate: true }).then(
    (r) => h.onRegisteredSW(r),
    (err: unknown) => h.onRegisterError(err),
  );
  return {
    skipWaiting: async () => {
      wb.messageSkipWaiting();
    },
  };
}

export function createPwa(deps: PwaDeps): PwaApi {
  const { store } = deps;
  const register = deps.register ?? registerWithWorkbox;
  const reload = deps.reload ?? ((): void => location.reload());
  const supported = typeof navigator !== 'undefined' && 'serviceWorker' in navigator;

  let pathname = typeof location !== 'undefined' ? location.pathname : '/';
  let registration: SwRegistration | null = null;
  let pending = false;
  let applying = false;
  /** A new worker already controls this page (another tab applied it); only the reload is left to do. */
  let reloadDeferred = false;
  let started = false;
  let disposed = false;
  let lastState: SessionStateName = store.get().session.s;
  let interval: ReturnType<typeof setInterval> | null = null;
  let onVisible: (() => void) | null = null;
  let unsubscribe: (() => void) | null = null;

  const canApply = (): boolean => APPLY_STATES.has(store.get().session.s) && pathname === '/';

  function setReady(ready: boolean): void {
    if (store.get().pwa.updateReady !== ready) store.patch({ pwa: { updateReady: ready } });
  }

  function reloadNow(): void {
    reloadDeferred = false;
    reload();
  }

  function apply(): void {
    if (applying || registration === null) return;
    applying = true;
    setReady(false);
    // skipWaiting resolves once SKIP_WAITING is sent; the reload comes later, from `controlling`. If none
    // follows (the waiting worker went redundant), the next check or onNeedRefresh must be free to apply again.
    registration.skipWaiting().then(
      () => {
        applying = false;
      },
      (err: unknown) => {
        applying = false;
        log.warn('service worker update failed', err);
        if (!disposed && pending) setReady(true);
      },
    );
  }

  function check(): void {
    if (disposed) return;
    if (reloadDeferred && canApply()) {
      reloadNow();
      return;
    }
    if (!pending || applying) return;
    if (registration !== null && canApply()) apply();
    else setReady(true);
  }

  function onControlling(isUpdate: boolean): void {
    if (!isUpdate || disposed) return;
    if (canApply()) {
      reloadNow();
      return;
    }
    reloadDeferred = true;
    pending = true;
    setReady(true);
  }

  function watchRegistration(r: ServiceWorkerRegistration | undefined): void {
    if (r === undefined || disposed) return;
    const update = (): void => {
      r.update().catch((err: unknown) => log.debug('service worker update check failed', err));
    };
    interval = setInterval(update, UPDATE_CHECK_MS);
    if (typeof document !== 'undefined') {
      onVisible = () => {
        if (document.visibilityState === 'visible') update();
      };
      document.addEventListener('visibilitychange', onVisible);
    }
  }

  return {
    supported,
    start() {
      if (started || disposed) return;
      started = true;
      unsubscribe = store.subscribe(() => {
        const s = store.get().session.s;
        if (s === lastState) return;
        lastState = s;
        check();
      });
      registration = register({
        onNeedRefresh: () => {
          // A new waiting worker replaces the one an earlier apply signalled, so that apply is void.
          applying = false;
          pending = true;
          check();
        },
        onRegisteredSW: (r) => watchRegistration(r),
        onRegisterError: (err: unknown) => log.warn('service worker registration failed', err),
        onControlling,
      });
      check(); // onNeedRefresh may have fired before register returned
    },
    notifyRoute(p) {
      pathname = p;
      check();
    },
    applyUpdate() {
      if (disposed) return;
      // An explicit request (UpdateChip off a room path). When the new worker already controls the page,
      // SKIP_WAITING would reach nothing: only the reload is left.
      if (reloadDeferred) reloadNow();
      else if (pending) apply();
    },
    dispose() {
      disposed = true;
      unsubscribe?.();
      unsubscribe = null;
      if (interval !== null) clearInterval(interval);
      interval = null;
      if (onVisible !== null && typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
      onVisible = null;
    },
  };
}
