// DEV only (C111): the dev server has no service worker (devOptions.enabled is false), but a worker left on
// the dev origin by an earlier build or `yarn preview` would keep serving stale files. Remove them all.

import { log } from '../../lib/log';

export async function unregisterDevWorkers(): Promise<void> {
  if (!import.meta.env.DEV) return;
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  try {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map((r) => r.unregister()));
    if (registrations.length > 0) log.info(`unregistered ${registrations.length} dev service worker(s)`);
  } catch (err) {
    log.warn('could not unregister dev service workers', err);
  }
}
