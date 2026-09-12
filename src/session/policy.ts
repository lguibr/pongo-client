// Reconnection policy (5.5.2, 5.5.3): the machine's timing numbers, the rejection classes, and the backoff.

import { T } from '../config/tuning';
import type { Rand } from '../lib/random';
import type { Policy, ReasonClass } from './types';

const s = T.session;

/** Built from T.session. */
export const POLICY: Policy = {
  connectTimeoutMs: s.connectTimeoutMs,
  admissionTimeoutMs: s.admissionTimeoutMs,
  preAdmit: { ...s.preAdmit },
  inRoom: { ...s.inRoom },
  busyDelaysMs: s.busyDelaysMs,
  pendingDelaysMs: s.pendingDelaysMs,
  serverFullDelaysMs: s.serverFullDelaysMs,
  transientMaxInRow: s.transientMaxInRow,
  liveness: { ...s.liveness },
  badFrames: { ...s.badFrames },
  firstRetryMaxMs: s.firstRetryMaxMs,
  onlineRetryMaxMs: s.onlineRetryMaxMs,
};

// The literal strings the server sends (5.5.2).
const REASONS: ReadonlyMap<string, ReasonClass> = new Map<string, ReasonClass>([
  ['Room not found', 'room-gone'], // room_manager.go:145
  ['Room is closing', 'room-gone'], // game_actor_admission.go:21
  ['Room closed during admission', 'room-gone'], // room_manager.go:80
  ['Room is full', 'room-full'], // room_manager.go:184, game_actor_admission.go:49
  ['Server is full', 'server-full'], // room_manager.go:151
  ['Session admission is pending', 'pending'], // room_manager.go:177
  ['Session already connected', 'busy'], // game_actor_admission.go:42
  ['Server is stopping', 'transient'], // room_manager.go:169
  ['Room is unavailable', 'transient'], // room_manager.go:207
  ['Invalid connection', 'transient'], // game_actor_admission.go:25
  ['Connection closed', 'transient'], // game_actor_admission.go:30
  ['Admission failed', 'transient'], // game_actor_admission.go:57
]);

/** Table in 5.5.2. Anything the table does not name is 'unknown'. */
export function classifyReason(reason: string): ReasonClass {
  return REASONS.get(reason.trim()) ?? 'unknown';
}

/** Equal jitter: step = min(cap, base * 2^attempt); delay = step/2 + rand() * step/2, rounded. */
export function backoff(attempt: number, baseMs: number, capMs: number, rand: Rand): number {
  const n = Math.max(0, Math.floor(attempt));
  const step = Math.min(capMs, baseMs * 2 ** n);
  return Math.round(step / 2 + rand() * (step / 2));
}
