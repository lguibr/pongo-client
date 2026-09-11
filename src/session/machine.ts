// The pure session core (5.5.1, D02). transition(model, input, env) returns the next model and the effects
// for the interpreter (runtime.ts) to run. Nothing here reads a clock, a socket or storage: time, randomness,
// the session id, the last frame time and the world summary all arrive in `env`, and the input model is never
// mutated.
//
// Every input runs, in order: (1) budget accounting; (2) T46; (3) the environment bookkeeping of T38 and T39;
// (4) the first state row whose From, Input and Guard all match. Row numbers in comments refer to table 5.5.1.
// Inputs that carry a gen other than the current one are ignored before any of that.

import type { ClientMessage, GameOver, PlayerAssignment, RoomCreated, RoomJoined, RoomPhase } from '../protocol/messages';
import type { Seat } from '../game/events';
import type { MusicScene } from '../audio/types';
import type {
  CloseCode, ControlEvent, DropCause, FailCode, Failure, Intent, MachineEnv, Model, NoticeKind, Policy,
  RetryCounters, RoomCode, RoomRef, SessionEffect, SessionInput, SessionState, TimerName,
} from './types';
import { EMPTY_ROOM_GRACE_MS, GRACE_MS, ROOM_CODE_RE } from '../config/constants';
import { T } from '../config/tuning';
import { backoff, classifyReason } from './policy';

type StateOf<N extends SessionState['s']> = Extract<SessionState, { s: N }>;
type Admitted = StateOf<'lobby'> | StateOf<'countdown'> | StateOf<'playing'>;
type Connecting = StateOf<'connecting'>;
type Requesting = StateOf<'requesting'>;
type Reconnecting = StateOf<'reconnecting'>;

/** The working copy of one step. */
interface Step { m: Model; fx: SessionEffect[]; env: MachineEnv; p: Policy; now: number }

// ---- public helpers (4.4) ----

export function initialModel(online: boolean, visible: boolean): Model {
  return {
    state: { s: 'idle' }, lastGen: 0, epoch: 0, online, visible, resumeGraceUntil: 0, unstable: false,
    badCount: 0, badWindowStart: 0, lastLeft: null,
    budgetUsedMs: 0, budgetAt: 0, droppedAt: null, roomCloseFloorAt: null,
  };
}

/** The state's room, or null (idle, or no room yet). */
export function roomOf(m: Readonly<Model>): RoomRef | null {
  const s = m.state;
  return s.s === 'idle' ? null : s.room;
}

/** The state's intent, or null. Admitted and finished states carry none. */
export function intentOf(m: Readonly<Model>): Intent | null {
  const s = m.state;
  switch (s.s) {
    case 'connecting':
    case 'requesting':
    case 'reconnecting':
    case 'failed':
      return s.intent;
    default:
      return null;
  }
}

/** room?.code ?? (intent is join ? intent.code : null), for every state except idle, which gives null. */
export function boundCode(m: Readonly<Model>): RoomCode | null {
  if (m.state.s === 'idle') return null;
  const room = roomOf(m);
  if (room !== null) return room.code;
  const intent = intentOf(m);
  return intent !== null && intent.kind === 'join' ? intent.code : null;
}

/** m.state.s !== 'idle' && boundCode(m) === code */
export function isBoundTo(m: Readonly<Model>, code: RoomCode): boolean {
  return m.state.s !== 'idle' && boundCode(m) === code;
}

// ---- the transition ----

export function transition(model: Model, input: SessionInput, env: MachineEnv): { model: Model; effects: SessionEffect[] } {
  if ('gen' in input && input.gen !== model.lastGen) return { model, effects: [] };

  const c: Step = { m: { ...model }, fx: [], env, p: env.policy, now: env.now };
  accountBudget(c);
  t46BudgetSpent(c);
  envBookkeeping(c, input);
  stateRow(c, input);
  if (c.m.unstable && c.m.state.s !== 'playing') c.m.unstable = false; // the soft stall belongs to play only

  return { model: shallowSame(model, c.m) ? model : c.m, effects: c.fx };
}

// ---- (1) budget accounting, (2) T46, (3) T38/T39 ----

function recovering(s: SessionState): boolean {
  return s.s === 'reconnecting' || ((s.s === 'connecting' || s.s === 'requesting') && s.room !== null);
}

// A suspended reconnect (T40, bfcache) counts like offline time: no attempt can run while the page sits in the
// cache, and the clock keeps advancing there, so charging it would fail the restore through T46 (amended).
function accountBudget(c: Step): void {
  const s = c.m.state;
  if (!recovering(s)) return;
  const suspended = s.s === 'reconnecting' && s.suspended;
  if (c.m.online && !suspended) c.m.budgetUsedMs += Math.max(0, c.now - c.m.budgetAt);
  c.m.budgetAt = c.now;
}

const budgetSpent = (c: Step): boolean => c.m.budgetUsedMs >= c.p.inRoom.onlineBudgetMs;

// T46: reconnecting with a room, and the online budget spent.
function t46BudgetSpent(c: Step): void {
  const s = c.m.state;
  if (s.s !== 'reconnecting' || s.room === null || !budgetSpent(c)) return;
  clear(c);
  c.m.state = { s: 'failed', failure: failure('room-lost', { retryable: true }), intent: s.intent, room: s.room };
}

function envBookkeeping(c: Step, input: SessionInput): void {
  switch (input.t) {
    case 'visible':
    case 'resume':
    case 'pageshow': {
      // T38 (5.6 adds pageshow to the resume grace).
      c.m.visible = true;
      c.m.resumeGraceUntil = c.now + c.p.liveness.resumeGraceMs;
      const s = c.m.state;
      if (isAdmitted(s)) setTimer(c, 'liveness', c.p.liveness.resumeGraceMs + limit(c, s));
      return;
    }
    case 'hidden':
    case 'freeze':
    case 'pagehide':
      c.m.visible = false; // T39: timers keep running; the liveness verdict uses real times
      return;
    case 'online':
      c.m.online = true;
      return;
    case 'offline':
      c.m.online = false;
      return;
    default:
      return;
  }
}

// ---- (4) state rows ----

function stateRow(c: Step, input: SessionInput): void {
  switch (input.t) {
    case 'start':
      return onStart(c, input.intent);
    case 'leave':
      return onLeave(c, input.explicit);
    case 'retry':
      return onRetry(c);
    case 'joinAsNew':
      return onJoinAsNew(c);
    case 'open':
      return onOpen(c);
    case 'closed':
      return onClosed(c);
    case 'message':
      return onMessage(c, input.msg);
    case 'control':
      return onControl(c, input.ev, input.at);
    case 'frame':
      // T36
      if (c.m.state.s === 'playing' && c.m.unstable) c.m.unstable = false;
      return;
    case 'badFrame':
      return onBadFrame(c, input.at);
    case 'timer':
      return onTimer(c, input.name);
    case 'online':
      return onOnline(c);
    case 'offline':
      return onOffline(c);
    case 'visible':
    case 'pageshow':
      return onShown(c);
    case 'pagehide':
      if (input.persisted) onPageHidePersisted(c);
      return;
    case 'hidden':
    case 'freeze':
    case 'resume':
      return;
  }
}

function onStart(c: Step, intent: Intent): void {
  const s = c.m.state;
  // T1: a join whose code fails ROOM_CODE_RE, from any state. Leaving play also freezes, halts and changes the
  // scene, as every other row that leaves play does (amended).
  if (intent.kind === 'join' && !ROOM_CODE_RE.test(intent.code)) {
    clear(c);
    closeSocket(c, 1000, 'invalid-code');
    if (isAdmitted(s)) leavePlay(c);
    c.m.state = { s: 'failed', failure: failure('invalid-code'), intent, room: null };
    return;
  }
  // T2: the idempotent binding, in every state except idle.
  if (s.s !== 'idle' && intent.kind === 'join' && isBoundTo(c.m, intent.code)) return;

  if (isAdmitted(s)) {
    // T3
    clear(c);
    closeSocket(c, 1000, 'switch');
    c.fx.push({ e: 'identity.rotate' });
    c.m.lastLeft = { code: s.room.code, at: c.now };
    c.fx.push({ e: 'game.reset', epoch: c.m.epoch, myIndex: null });
    freshStart(c);
    const gen = openSocket(c);
    c.m.state = { s: 'connecting', intent, room: null, attempt: 0, gen, retry: zeroRetry() };
    return;
  }
  // T4: idle, failed, finished, connecting, requesting, reconnecting.
  clear(c);
  closeSocket(c, 1000, 'restart');
  freshStart(c);
  const gen = openSocket(c);
  c.m.state = { s: 'connecting', intent, room: null, attempt: 0, gen, retry: zeroRetry() };
}

// T52
function onLeave(c: Step, explicit: boolean): void {
  const s = c.m.state;
  if (s.s === 'idle') return;
  clear(c);
  closeSocket(c, 1000, 'leave');
  c.fx.push({ e: 'game.reset', epoch: c.m.epoch, myIndex: null });
  c.fx.push({ e: 'input.halt' });
  scene(c, 'landing');
  // Any state with a room except finished (amended): the server may still hold the seat under this id for
  // GRACE_MS, and Quick Play would silently re-attach it (C17).
  const room = roomOf(c.m);
  if (explicit && room !== null && s.s !== 'finished') {
    c.fx.push({ e: 'identity.rotate' });
    c.m.lastLeft = { code: room.code, at: c.now };
  }
  c.m.droppedAt = null;
  c.m.roomCloseFloorAt = null;
  c.m.state = { s: 'idle' };
}

function onRetry(c: Step): void {
  const s = c.m.state;
  if (s.s === 'reconnecting') {
    // T45
    c.m.budgetUsedMs = 0;
    c.m.budgetAt = c.now;
    reopen(c, s.intent, s.room, s.attempt, s.retry);
  } else if (s.s === 'failed' && s.failure.retryable && s.intent !== null) {
    // T49
    c.m.budgetUsedMs = 0;
    c.m.budgetAt = c.now;
    reopen(c, s.intent, s.room, 0, zeroRetry());
  }
}

// T47
function onJoinAsNew(c: Step): void {
  const s = c.m.state;
  if (s.s !== 'reconnecting' && s.s !== 'failed') return;
  const room = s.room;
  if (room === null) return;
  clear(c);
  c.fx.push({ e: 'identity.rotate' });
  notice(c, 'joined-as-new');
  freshStart(c);
  const gen = openSocket(c);
  c.m.state = {
    s: 'connecting', intent: joinOf(room.code), room: { code: room.code, myIndex: null, lastPhase: room.lastPhase },
    attempt: 0, gen, retry: zeroRetry(),
  };
}

// T5
function onOpen(c: Step): void {
  const s = c.m.state;
  if (s.s !== 'connecting') return;
  c.fx.push({ e: 'socket.send', gen: s.gen, msg: requestFor(s.intent, c.env.sessionId) });
  setTimer(c, 'admission', c.p.admissionTimeoutMs);
  c.m.state = { s: 'requesting', intent: s.intent, room: s.room, attempt: s.attempt, gen: s.gen, sentAt: c.now, retry: s.retry };
}

function onClosed(c: Step): void {
  const s = c.m.state;
  switch (s.s) {
    case 'connecting':
      return connectFailed(c, s, 'closed');
    case 'requesting':
      return admissionFailed(c, s, 'closed');
    case 'playing':
      if (c.env.world.bricksAlive === 0) {
        // T30: checkGameOver flushes the grid before it ends the game (D18).
        clear(c);
        c.fx.push({ e: 'input.halt' });
        scene(c, 'finished');
        c.fx.push({ e: 'game.ended', msg: null, reason: 'All bricks destroyed' });
        c.m.state = { s: 'finished', room: s.room, gameOver: null, derived: true };
        return;
      }
      return drop(c, s, 'closed'); // T31
    case 'lobby':
    case 'countdown':
      return drop(c, s, 'closed'); // T31
    default:
      return; // T51 (finished) and every other state: nothing
  }
}

function onMessage(c: Step, msg: RoomCreated | RoomJoined | PlayerAssignment | GameOver): void {
  const s = c.m.state;
  if (msg.messageType === 'gameOver') {
    if (!isAdmitted(s)) return;
    // T29
    clear(c);
    closeSocket(c, 1000, 'finished');
    c.fx.push({ e: 'input.halt' });
    scene(c, 'finished');
    c.fx.push({ e: 'game.ended', msg, reason: msg.reason });
    c.m.state = { s: 'finished', room: s.room, gameOver: msg, derived: false };
    return;
  }
  if (s.s !== 'requesting') return;
  switch (msg.messageType) {
    case 'roomCreated': {
      // T9: from here, no retry can create a second room.
      const code = msg.code as RoomCode;
      if (s.room === null) startBudget(c);
      c.m.state = { ...s, intent: joinOf(code), room: { code, myIndex: null, lastPhase: 'lobby' } };
      return;
    }
    case 'roomJoined':
      if (msg.success) return roomJoined(c, s, msg);
      return rejected(c, s, msg.reason);
    case 'playerAssignment':
      if (s.room !== null) admit(c, s, s.room, msg);
      return;
  }
}

// T10
function roomJoined(c: Step, s: Requesting, msg: RoomJoined): void {
  const code = msg.code as RoomCode;
  // The quick-play half of T11's placed-in-left-room test runs here: T10 rewrites the intent to join(code),
  // so by T11 a quick play can no longer be told apart from a join by code (reported in the package notes).
  const left = c.m.lastLeft;
  if (s.intent.kind === 'quick' && left !== null && left.code === code && c.now - left.at < T.session.rejoinWindowMs) {
    notice(c, 'placed-in-left-room');
  }
  const phase: RoomPhase | null = msg.phase === '' ? (s.room?.lastPhase ?? null) : msg.phase;
  if (s.room === null) startBudget(c);
  c.m.state = { ...s, intent: joinOf(code), room: { code, myIndex: s.room?.myIndex ?? null, lastPhase: phase } };
}

// T11
function admit(c: Step, s: Requesting, room: RoomRef, msg: PlayerAssignment): void {
  const i = msg.playerIndex as Seat;
  const phase = msg.phase;
  clear(c);
  c.m.epoch += 1;
  c.fx.push({ e: 'game.reset', epoch: c.m.epoch, myIndex: i });
  const next: RoomRef = { code: room.code, myIndex: i, lastPhase: phase };
  const state: Admitted = phase === 'lobby'
    ? { s: 'lobby', room: next, gen: s.gen }
    : phase === 'countingDown'
      ? { s: 'countdown', room: next, gen: s.gen, seconds: null, endsAt: null }
      : { s: 'playing', room: next, gen: s.gen };
  setTimer(c, 'liveness', limit(c, state));
  if (state.s === 'playing') setTimer(c, 'stall', c.p.liveness.playSoftMs);
  c.fx.push({ e: 'input.resync' });
  scene(c, sceneOf(phase));
  if (c.m.droppedAt !== null && room.myIndex !== null) {
    if (i !== room.myIndex) notice(c, 'seat-released');
    // The server may have noticed the drop later than we did, so the time test cannot prove the release.
    else if (c.now - c.m.droppedAt >= GRACE_MS) notice(c, 'seat-maybe-released');
  }
  c.m.droppedAt = null;
  c.m.roomCloseFloorAt = null;
  c.m.budgetUsedMs = 0;
  c.m.badCount = 0;
  c.m.state = state;
}

// T12 to T23
function rejected(c: Step, s: Requesting, reason: string): void {
  const cls = classifyReason(reason);
  const r = s.retry;
  switch (cls) {
    case 'room-gone':
      if (s.room === null) {
        // T12
        return reject(c, s, failure(reason.trim() === 'Room not found' ? 'room-not-found' : 'room-closing', { serverReason: reason }));
      }
      return roomGoneOnRejoin(c, s, s.room, reason); // T13
    case 'room-full':
      // T14: with a room, the room is alive but the held seat went to someone else.
      return reject(c, s, s.room === null
        ? failure('room-full', { retryable: true, serverReason: reason })
        : failure('seat-taken', { serverReason: reason }));
    case 'server-full':
      if (r.serverFull < c.p.serverFullDelaysMs.length) {
        // T15
        return rejectAndRetry(c, s, { ...r, serverFull: r.serverFull + 1 }, c.p.serverFullDelaysMs[r.serverFull]);
      }
      return reject(c, s, failure('server-full', { retryable: true, serverReason: reason })); // T16
    case 'pending':
      if (r.pending < c.p.pendingDelaysMs.length) {
        // T17: the handler clears `pending` on the rejection, so the same socket may ask again.
        c.fx.push({ e: 'timer.clear', name: 'admission' });
        setTimer(c, 'retry', c.p.pendingDelaysMs[r.pending]);
        c.m.state = { ...s, retry: { ...r, pending: r.pending + 1 } };
        return;
      }
      return busy(c, s, reason); // pending spent: T19 to T21
    case 'busy':
      return busy(c, s, reason);
    case 'transient':
      if (r.transient < c.p.transientMaxInRow) {
        // T22
        const d = s.room === null
          ? backoff(r.transient, c.p.preAdmit.baseMs, c.p.preAdmit.capMs, c.env.rand)
          : backoff(r.transient, c.p.inRoom.baseMs, c.p.inRoom.capMs, c.env.rand);
        return rejectAndRetry(c, s, { ...r, transient: r.transient + 1 }, d);
      }
      return reject(c, s, failure('unknown', { retryable: true, serverReason: reason })); // T23
    case 'unknown':
      return reject(c, s, failure('unknown', { retryable: true, serverReason: reason })); // T23
  }
}

// T19, T20, T21 (D03, D04). The client never rotates its id for a busy session unless the retries are spent.
function busy(c: Step, s: Requesting, reason: string): void {
  const r = s.retry;
  if (r.busy < c.p.busyDelaysMs.length) {
    // T19
    return rejectAndRetry(c, s, { ...r, busy: r.busy + 1 }, c.p.busyDelaysMs[r.busy]);
  }
  if (s.room?.lastPhase !== 'playing') {
    // T20: join as a new player automatically.
    clear(c);
    closeSocket(c, 4002, 'rejected');
    c.fx.push({ e: 'identity.rotate' });
    notice(c, 'joined-as-new');
    // Amended: the drop bookkeeping ends (the rotated id cannot reclaim the seat), but the in-room budget carries
    // on. Accounting already ran for this input, and resetting it here would let a pending, busy, T20 loop run
    // forever without reaching T46.
    c.m.droppedAt = null;
    c.m.roomCloseFloorAt = null;
    c.m.budgetAt = c.now;
    const gen = openSocket(c);
    const room = s.room === null ? null : { code: s.room.code, myIndex: null, lastPhase: s.room.lastPhase };
    c.m.state = { s: 'connecting', intent: s.intent, room, attempt: 0, gen, retry: zeroRetry() };
    return;
  }
  // T21
  reject(c, s, failure('session-busy', { retryable: true, canJoinAsNew: true, serverReason: reason }));
}

// T13 (D18)
function roomGoneOnRejoin(c: Step, s: Requesting, room: RoomRef, reason: string): void {
  const bricks = c.env.world.bricksAlive;
  const floor = c.m.roomCloseFloorAt;
  const derivedFinish = room.lastPhase === 'playing' && bricks !== null && bricks <= 3 && floor !== null && c.now < floor;
  if (!derivedFinish) return reject(c, s, failure('room-lost', { serverReason: reason }));
  clear(c);
  closeSocket(c, 4002, 'rejected');
  c.fx.push({ e: 'game.ended', msg: null, reason: 'All bricks destroyed' });
  c.fx.push({ e: 'input.halt' });
  scene(c, 'finished');
  c.m.state = { s: 'finished', room, gameOver: null, derived: true };
}

function reject(c: Step, s: Requesting, f: Failure): void {
  clear(c);
  closeSocket(c, 4002, 'rejected');
  c.m.state = { s: 'failed', failure: f, intent: s.intent, room: s.room };
}

function rejectAndRetry(c: Step, s: Requesting, retry: RetryCounters, delayMs: number): void {
  clear(c);
  closeSocket(c, 4002, 'rejected');
  toReconnecting(c, s.intent, s.room, s.attempt + 1, 'rejected', delayMs, retry);
}

// T6, T7, T8
function connectFailed(c: Step, s: Connecting, cause: 'closed' | 'connect-timeout'): void {
  clear(c);
  if (cause === 'connect-timeout') closeSocket(c, 4000, 'connect-timeout');
  if (s.room === null) return preAdmitRetry(c, s, cause);
  inRoomRetry(c, s, cause); // T8
}

// T24
function admissionFailed(c: Step, s: Requesting, cause: 'closed' | 'admission-timeout'): void {
  clear(c);
  if (cause === 'admission-timeout') closeSocket(c, 4000, 'admission-timeout');
  if (s.room === null) return preAdmitRetry(c, s, cause);
  inRoomRetry(c, s, cause);
}

// T6 and T7 (T24 applies T7's limit before admission).
function preAdmitRetry(c: Step, s: Connecting | Requesting, cause: DropCause): void {
  const r = s.retry;
  const max = c.p.preAdmit.maxAttempts;
  if (r.preAdmit + 1 < max) {
    const d = backoff(s.attempt, c.p.preAdmit.baseMs, c.p.preAdmit.capMs, c.env.rand);
    toReconnecting(c, s.intent, s.room, s.attempt + 1, cause, d, { ...r, preAdmit: r.preAdmit + 1 });
    return;
  }
  // T7. T50's single automatic retry marks its counter as past the limit, so its own failure turns
  // autoRetryOnOnline off ("if that fails again").
  c.m.state = {
    s: 'failed', failure: failure('unreachable', { retryable: true, autoRetryOnOnline: r.preAdmit < max }),
    intent: s.intent, room: s.room,
  };
}

// T8 and T24 with a room: the in-room budget continues on Model.
function inRoomRetry(c: Step, s: Connecting | Requesting, cause: DropCause): void {
  if (budgetSpent(c)) {
    c.m.state = { s: 'failed', failure: failure('room-lost', { retryable: true }), intent: s.intent, room: s.room };
    return;
  }
  const d = backoff(s.attempt, c.p.inRoom.baseMs, c.p.inRoom.capMs, c.env.rand);
  toReconnecting(c, s.intent, s.room, s.attempt + 1, cause, d, s.retry);
}

// T25 to T28
function onControl(c: Step, ev: ControlEvent, at: number): void {
  const s = c.m.state;
  switch (ev.k) {
    case 'countdown': {
      const endsAt = at + ev.seconds * 1000;
      if (s.s === 'lobby') {
        // T25
        c.m.state = { s: 'countdown', room: { ...s.room, lastPhase: 'countingDown' }, gen: s.gen, seconds: ev.seconds, endsAt };
        scene(c, 'countdown');
      } else if (s.s === 'countdown') {
        c.m.state = { ...s, seconds: ev.seconds, endsAt }; // T26
      }
      return;
    }
    case 'cancelled':
      if (s.s !== 'countdown') return;
      // T27
      c.m.state = { s: 'lobby', room: { ...s.room, lastPhase: 'lobby' }, gen: s.gen };
      notice(c, 'countdown-cancelled');
      scene(c, 'lobby');
      return;
    case 'started':
      if (s.s !== 'lobby' && s.s !== 'countdown') return;
      // T28
      c.m.state = { s: 'playing', room: { ...s.room, lastPhase: 'playing' }, gen: s.gen };
      c.fx.push({ e: 'input.resync' });
      scene(c, 'playing');
      setTimer(c, 'liveness', c.p.liveness.playHardMs);
      setTimer(c, 'stall', c.p.liveness.playSoftMs);
      return;
  }
}

// T37
function onBadFrame(c: Step, at: number): void {
  const s = c.m.state;
  if (!isAdmitted(s)) return;
  const { count, windowMs } = c.p.badFrames;
  if (c.m.badCount === 0 || at - c.m.badWindowStart > windowMs) {
    c.m.badWindowStart = at;
    c.m.badCount = 1;
  } else {
    c.m.badCount += 1;
  }
  if (c.m.badCount < count) return;
  clear(c);
  closeSocket(c, 1000, 'protocol');
  leavePlay(c); // amended: freeze, halt and scene, like every other row that leaves play
  c.m.state = { s: 'failed', failure: failure('protocol', { retryable: true }), intent: joinOf(s.room.code), room: s.room };
}

function onTimer(c: Step, name: TimerName): void {
  const s = c.m.state;
  switch (name) {
    case 'connect':
      if (s.s === 'connecting') connectFailed(c, s, 'connect-timeout'); // T6, T7, T8
      return;
    case 'admission':
      if (s.s === 'requesting') admissionFailed(c, s, 'admission-timeout'); // T24
      return;
    case 'retry':
      if (s.s === 'requesting') {
        // T18: the socket for gen is open, or `closed` would have left requesting.
        c.fx.push({ e: 'socket.send', gen: s.gen, msg: requestFor(s.intent, c.env.sessionId) });
        setTimer(c, 'admission', c.p.admissionTimeoutMs);
        c.m.state = { ...s, sentAt: c.now };
      } else if (s.s === 'reconnecting' && c.m.online) {
        reopen(c, s.intent, s.room, s.attempt, s.retry); // T42
      }
      return;
    case 'liveness': {
      if (!isAdmitted(s)) return;
      const lim = limit(c, s);
      const silent = c.now - c.env.lastFrameAt;
      if (c.now >= c.m.resumeGraceUntil && silent > lim) {
        // T32
        c.fx.push({ e: 'socket.close', gen: c.m.lastGen, code: 4000, reason: 'liveness' });
        drop(c, s, 'liveness');
        return;
      }
      setTimer(c, 'liveness', Math.max(lim - silent, c.m.resumeGraceUntil - c.now, 50)); // T33
      return;
    }
    case 'stall': {
      if (s.s !== 'playing') return;
      const silent = c.now - c.env.lastFrameAt;
      if (silent > c.p.liveness.playSoftMs) {
        c.m.unstable = true; // T34
        setTimer(c, 'stall', 250);
      } else {
        setTimer(c, 'stall', Math.max(c.p.liveness.playSoftMs - silent, 1)); // T35
      }
      return;
    }
  }
}

function onOnline(c: Step): void {
  const s = c.m.state;
  if (s.s === 'reconnecting') {
    // T44
    const d = c.env.rand() * c.p.onlineRetryMaxMs;
    setTimer(c, 'retry', d);
    c.m.state = { ...s, offline: false, attempt: Math.min(s.attempt, 1), nextAt: c.now + d };
  } else if (isAdmitted(s)) {
    rearmLiveness(c, s); // T48
  } else if (s.s === 'failed' && s.failure.code === 'unreachable' && s.failure.autoRetryOnOnline && s.intent !== null) {
    // T50: one automatic attempt; the spent counter makes a second failure turn autoRetryOnOnline off.
    reopen(c, s.intent, s.room, 0, { ...zeroRetry(), preAdmit: c.p.preAdmit.maxAttempts });
  }
}

function onOffline(c: Step): void {
  const s = c.m.state;
  if (s.s === 'reconnecting') {
    // T43
    c.fx.push({ e: 'timer.clear', name: 'retry' });
    c.m.state = { ...s, offline: true, nextAt: null };
  } else if (isAdmitted(s)) {
    rearmLiveness(c, s); // T48
  }
}

// T41
function onShown(c: Step): void {
  const s = c.m.state;
  if (s.s !== 'reconnecting') return;
  if (s.suspended || (s.nextAt !== null && s.nextAt <= c.now)) reopen(c, s.intent, s.room, s.attempt, s.retry);
}

// T40
function onPageHidePersisted(c: Step): void {
  const s = c.m.state;
  if (!isAdmitted(s)) return;
  clear(c);
  closeSocket(c, 1000, 'pagehide');
  c.fx.push({ e: 'game.freeze', frozen: true });
  c.fx.push({ e: 'input.halt' });
  dropBookkeeping(c);
  toReconnecting(c, joinOf(s.room.code), s.room, 0, 'pagehide', null, zeroRetry(), true);
}

// T31 (and T32 after its close)
function drop(c: Step, s: Admitted, cause: DropCause): void {
  clear(c);
  c.fx.push({ e: 'game.freeze', frozen: true });
  c.fx.push({ e: 'input.halt' });
  dropBookkeeping(c);
  // Most drops are blips and the server holds the seat for 30 s, so the first retry is almost immediate.
  toReconnecting(c, joinOf(s.room.code), s.room, 0, cause, c.env.rand() * c.p.firstRetryMaxMs, zeroRetry());
}

// ---- small builders ----

function isAdmitted(s: SessionState): s is Admitted {
  return s.s === 'lobby' || s.s === 'countdown' || s.s === 'playing';
}

/** T1 (when admitted) and T37: an admitted session that fails stops the world, the input and the music. */
function leavePlay(c: Step): void {
  c.fx.push({ e: 'game.freeze', frozen: true });
  c.fx.push({ e: 'input.halt' });
  scene(c, 'landing');
}

function hasSocket(s: SessionState): boolean {
  return s.s === 'connecting' || s.s === 'requesting' || isAdmitted(s);
}

function zeroRetry(): RetryCounters {
  return { preAdmit: 0, busy: 0, pending: 0, serverFull: 0, transient: 0 };
}

function joinOf(code: RoomCode): Intent {
  return { kind: 'join', code };
}

function failure(code: FailCode, o: { retryable?: boolean; canJoinAsNew?: boolean; autoRetryOnOnline?: boolean; serverReason?: string } = {}): Failure {
  return {
    code, serverReason: o.serverReason ?? null, retryable: o.retryable ?? false,
    canJoinAsNew: o.canJoinAsNew ?? false, autoRetryOnOnline: o.autoRetryOnOnline ?? false,
  };
}

function requestFor(intent: Intent, sessionId: string): ClientMessage {
  switch (intent.kind) {
    case 'create':
      return { messageType: 'createRoom', isPublic: intent.isPublic, sessionId };
    case 'quick':
      return { messageType: 'quickPlay', sessionId };
    case 'join':
      return { messageType: 'joinRoom', code: intent.code, sessionId };
  }
}

/** `limit(state)`: lobbyMs in lobby and countdown, playHardMs in play, offlineMs while offline. */
function limit(c: Step, s: Admitted): number {
  const l = c.p.liveness;
  if (!c.m.online) return l.offlineMs;
  return s.s === 'playing' ? l.playHardMs : l.lobbyMs;
}

function rearmLiveness(c: Step, s: Admitted): void {
  const silent = c.now - c.env.lastFrameAt;
  setTimer(c, 'liveness', Math.max(limit(c, s) - silent, c.m.resumeGraceUntil - c.now, 50));
}

function sceneOf(phase: RoomPhase): MusicScene {
  return phase === 'lobby' ? 'lobby' : phase === 'countingDown' ? 'countdown' : 'playing';
}

function clear(c: Step): void {
  c.fx.push({ e: 'timer.clear', name: '*' });
}

function setTimer(c: Step, name: TimerName, ms: number): void {
  c.fx.push({ e: 'timer.set', name, ms: Math.max(0, ms) });
}

function scene(c: Step, s: MusicScene): void {
  c.fx.push({ e: 'audio.scene', scene: s });
}

function notice(c: Step, kind: NoticeKind): void {
  c.fx.push({ e: 'notice', kind });
}

/** Closes the current socket, when the state has one. Must run before openSocket bumps lastGen. */
function closeSocket(c: Step, code: CloseCode, reason: string): void {
  if (hasSocket(c.m.state)) c.fx.push({ e: 'socket.close', gen: c.m.lastGen, code, reason });
}

/** `open`: gen = ++lastGen, then socket.open(gen) and timer.set('connect', connectTimeoutMs). */
function openSocket(c: Step): number {
  const gen = c.m.lastGen + 1;
  c.m.lastGen = gen;
  c.fx.push({ e: 'socket.open', gen });
  setTimer(c, 'connect', c.p.connectTimeoutMs);
  return gen;
}

/** A retry leaving reconnecting or failed (T41, T42, T45, T49, T50). The clear drops a retry timer that may
 *  still be pending, so it cannot fire T18 in the next requesting.
 *
 *  `attempt` counts the failed tries of the current recovery (amended): 0 after a drop or a fresh start, n after
 *  the n-th failure. Only the failure rows add one (T6, T8, T15, T19, T22, T24), and their backoff(attempt) takes
 *  the failures before them. The rows that enter connecting (T41, T42, T45) keep it. */
function reopen(c: Step, intent: Intent, room: RoomRef | null, attempt: number, retry: RetryCounters): void {
  clear(c);
  const gen = openSocket(c);
  c.m.state = { s: 'connecting', intent, room, attempt, gen, retry };
}

function toReconnecting(
  c: Step, intent: Intent, room: RoomRef | null, attempt: number, cause: DropCause,
  delayMs: number | null, retry: RetryCounters, suspended = false,
): void {
  // Offline, T42 would refuse the timer anyway, so none is armed and no retry time is shown: the same end state
  // as T43, and T44 arms the retry on online.
  const armed = c.m.online ? delayMs : null;
  if (armed !== null) setTimer(c, 'retry', armed);
  const next: Reconnecting = {
    s: 'reconnecting', intent, room, attempt, nextAt: armed === null ? null : c.now + Math.max(0, armed),
    cause, offline: !c.m.online, suspended, retry,
  };
  c.m.state = next;
}

/** A fresh admission attempt is not a recovery: nothing dropped, and the budget starts now. */
function freshStart(c: Step): void {
  c.m.droppedAt = null;
  c.m.roomCloseFloorAt = null;
  c.m.budgetUsedMs = 0;
  c.m.budgetAt = c.now;
}

/** T9 and T10 when the room was unknown (amended). Accounting runs only once a room is known, so its first run
 *  would otherwise charge everything since the last reset: the pre-admission retries after T4, or the whole
 *  failed{unreachable} wait before T50, which resets nothing. */
function startBudget(c: Step): void {
  c.m.budgetUsedMs = 0;
  c.m.budgetAt = c.now;
}

/** T31, T32 and T40. With no other seat in grace, the empty-room timer can start no earlier than this
 *  player's own grace expiry (game_actor_disconnect.go:79-117). */
function dropBookkeeping(c: Step): void {
  c.m.budgetUsedMs = 0;
  c.m.budgetAt = c.now;
  c.m.droppedAt = c.now;
  c.m.roomCloseFloorAt = c.now + EMPTY_ROOM_GRACE_MS + (c.env.world.graceSeats > 0 ? 0 : GRACE_MS);
}

function shallowSame(a: Model, b: Model): boolean {
  for (const k of Object.keys(b) as Array<keyof Model>) if (!Object.is(a[k], b[k])) return false;
  return true;
}
