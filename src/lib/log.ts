// Logger for DEV and ?debug=1 (C53). debug and info print only when enabled; warn and error always print
// (the production build strips console.log, debug and info). The protocol trail is a ring of the last
// 200 frames, kept only when enabled.

import { isDebug } from '../config/env';

const enabled = isDebug();
const PREFIX = '[pongo]';

export const log: { readonly enabled: boolean; debug(...a: unknown[]): void; info(...a: unknown[]): void; warn(...a: unknown[]): void; error(...a: unknown[]): void } = {
  enabled,
  debug(...a: unknown[]): void {
    if (enabled) console.debug(PREFIX, ...a);
  },
  info(...a: unknown[]): void {
    if (enabled) console.info(PREFIX, ...a);
  },
  warn(...a: unknown[]): void {
    console.warn(PREFIX, ...a);
  },
  error(...a: unknown[]): void {
    console.error(PREFIX, ...a);
  },
};

export interface ProtocolRecord { at: number; dir: 'in' | 'out'; kind: string; bytes: number }

const TRAIL_CAP = 200;
const trail: ProtocolRecord[] = [];
let head = 0;   // oldest record once the ring is full

/** No-op unless log.enabled; ring of 200. */
export function recordProtocol(r: ProtocolRecord): void {
  if (!enabled) return;
  if (trail.length < TRAIL_CAP) {
    trail.push(r);
    return;
  }
  trail[head] = r;
  head = (head + 1) % TRAIL_CAP;
}

/** Oldest first. */
export function protocolTrail(): readonly ProtocolRecord[] {
  return trail.length < TRAIL_CAP ? trail.slice() : trail.slice(head).concat(trail.slice(0, head));
}
