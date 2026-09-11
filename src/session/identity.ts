// Per-tab session identity through Web Locks (5.5.6, D03, C17, C34). The server uses `sessionId` as the
// reconnect credential (game_actor_admission.go:38-44,161-175), so the id decides whether a reload reclaims
// the seat and whether a second tab steals it.
//
// Candidates, in order: this tab's sticky id (sessionStorage 'pongo.sid'), then the device id (localStorage
// 'pongo_session_id', the key the previous client used). The first candidate that gets its lock wins. The
// sticky id WAITS for its lock (an unloading document releases its lock asynchronously, so a reload may ask
// before the old page lets go); the device id and a freshly minted id use ifAvailable. A granted lock is held
// until released, by returning a promise from the lock callback.

import type { IdentityApi } from './types';
import type { SafeStorage } from '../lib/storage';
import { randomId } from '../lib/storage';
import type { Now } from '../lib/clock';
import { now as clockNow } from '../lib/clock';
import { T } from '../config/tuning';

/** waitMs: how long the sessionStorage candidate waits for its lock (default T.session.identityWaitMs, 500). */
export interface IdentityDeps { locks?: LockManager | null; local: SafeStorage; session: SafeStorage; now?: Now; waitMs?: number; windowMs?: number }

export const SESSION_ID_KEY = 'pongo.sid';
export const DEVICE_ID_KEY = 'pongo_session_id';
export const LOCK_PREFIX = 'pongo-sid:';

export function createIdentity(deps: IdentityDeps): IdentityApi {
  const locks = deps.locks ?? null;
  const now = deps.now ?? clockNow;
  const waitMs = deps.waitMs ?? T.session.identityWaitMs;
  const windowMs = deps.windowMs ?? T.session.rejoinWindowMs;
  const held = new Map<string, () => void>(); // id -> release of its granted lock

  // Provisional until `ready`: the runtime bounds its wait, and uses whatever this is if the bound is hit.
  let currentId = deps.session.get(SESSION_ID_KEY) ?? deps.local.get(DEVICE_ID_KEY) ?? randomId();
  let previous: { id: string; until: number } | null = null;
  let previousTimer: ReturnType<typeof setTimeout> | null = null;
  let ownsDevice = false; // this tab's id is the device id, so rotations move the device id with it
  let changes = 0; // bumped by rotate and restorePrevious, so a late settle never overwrites them

  function acquire(id: string, wait: boolean): Promise<boolean> {
    if (locks === null || held.has(id)) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const granted = (lock: Lock | null): Promise<void> | null => {
        if (lock === null) {
          resolve(false); // ifAvailable, and another tab holds it
          return null;
        }
        return new Promise<void>((release) => {
          held.set(id, release);
          resolve(true);
        });
      };
      try {
        const options: LockOptions = wait ? { signal: timeoutSignal(waitMs) } : { ifAvailable: true };
        // An AbortError (or TimeoutError) means another live tab still holds the lock after waitMs.
        locks.request(LOCK_PREFIX + id, options, granted).catch(() => resolve(false));
      } catch {
        resolve(false);
      }
    });
  }

  function release(id: string): void {
    const r = held.get(id);
    if (r === undefined) return;
    held.delete(id);
    r();
  }

  function adopt(id: string): void {
    currentId = id;
    deps.session.set(SESSION_ID_KEY, id);
    if (ownsDevice) deps.local.set(DEVICE_ID_KEY, id);
  }

  function dropPrevious(): void {
    if (previousTimer !== null) clearTimeout(previousTimer);
    previousTimer = null;
    const p = previous;
    previous = null;
    if (p !== null && p.id !== currentId) release(p.id);
  }

  function expirePrevious(): void {
    if (previous !== null && now() >= previous.until) dropPrevious();
  }

  /** The window timer. The host timer and `now` are coarsened and jittered separately, so the timer may fire
   *  just before `until`; it then re-arms for the rest rather than leave the previous lock held (5.5.6 step 5). */
  function onWindowTimer(): void {
    previousTimer = null;
    if (previous !== null && now() < previous.until) {
      previousTimer = setTimeout(onWindowTimer, Math.max(1, previous.until - now()));
      return;
    }
    expirePrevious();
  }

  async function settle(): Promise<void> {
    const startedAt = changes;
    const sid = deps.session.get(SESSION_ID_KEY);
    const dev = deps.local.get(DEVICE_ID_KEY);
    let chosen: string | null = null;
    if (locks === null) {
      chosen = sid ?? dev; // no Web Locks: today's behaviour plus per-tab stickiness
    } else if (sid !== null && (await acquire(sid, true))) {
      chosen = sid;
    } else if (dev !== null && dev !== sid && (await acquire(dev, false))) {
      chosen = dev;
    }
    if (chosen === null) {
      // A second or duplicated tab, or a first visit: mint an id of our own.
      chosen = randomId();
      await acquire(chosen, false);
      if (dev === null) deps.local.set(DEVICE_ID_KEY, chosen);
    }
    if (changes !== startedAt) {
      // rotate() or restorePrevious() ran while the locks were settling; they win.
      if (chosen !== currentId && previous?.id !== chosen) release(chosen);
      return;
    }
    ownsDevice = chosen === deps.local.get(DEVICE_ID_KEY);
    adopt(chosen);
  }

  const ready: Promise<void> = settle().catch(() => {
    // Storage and locks are wrapped already; keep the provisional id if anything else goes wrong.
  });

  return {
    ready,
    current: () => currentId,
    rotate(): void {
      changes += 1;
      expirePrevious();
      dropPrevious();
      previous = { id: currentId, until: now() + windowMs };
      if (typeof setTimeout === 'function') previousTimer = setTimeout(onWindowTimer, windowMs);
      const fresh = randomId();
      adopt(fresh);
      void acquire(fresh, false);
    },
    hasPrevious(): boolean {
      expirePrevious();
      return previous !== null;
    },
    restorePrevious(): boolean {
      expirePrevious();
      if (previous === null) return false;
      changes += 1;
      const rotated = currentId;
      const back = previous.id;
      if (previousTimer !== null) clearTimeout(previousTimer);
      previousTimer = null;
      previous = null;
      adopt(back);
      if (rotated !== back) release(rotated);
      if (!held.has(back)) void acquire(back, false);
      return true;
    },
    onPageHide(persisted: boolean): void {
      if (!persisted) return; // the document is going away; the lock manager releases everything
      for (const id of Array.from(held.keys())) release(id);
    },
    async onPageShow(persisted: boolean): Promise<void> {
      if (!persisted || locks === null || held.has(currentId)) return;
      await acquire(currentId, false); // if another tab took it meanwhile, keep the id without a lock
    },
  };
}

function timeoutSignal(ms: number): AbortSignal {
  if (typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}
