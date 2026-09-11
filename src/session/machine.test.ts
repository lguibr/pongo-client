// One table-driven case (or more) per row T1–T52 of 5.5.1. Every input model is deep-frozen, so a transition
// that mutated its input would throw.

import { describe, expect, it } from 'vitest';
import { boundCode, initialModel, intentOf, isBoundTo, roomOf, transition } from './machine';
import { POLICY } from './policy';
import type {
  Failure, Intent, MachineEnv, Model, RetryCounters, RoomCode, RoomRef, SessionEffect, SessionInput, SessionState,
  TimerName, WorldSummary, CloseCode, NoticeKind,
} from './types';
import type { ClientMessage, GameOver, RoomPhase } from '../protocol/messages';
import type { MusicScene } from '../audio/types';
import type { Seat } from '../game/events';

const CODE = 'ABC123' as RoomCode;
const OTHER = 'DEF456' as RoomCode;
const NOW = 100_000;
const GEN = 4;
const P = POLICY;

function deepFreeze<V>(v: V): V {
  if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze((v as Record<string, unknown>)[k]);
  }
  return v;
}

const world = (o: Partial<WorldSummary> = {}): WorldSummary => ({ ready: true, bricksAlive: 40, bricksAtStart: 100, tick: 10, graceSeats: 0, ...o });
const env = (o: Partial<MachineEnv> = {}): MachineEnv => ({ now: NOW, rand: () => 0.5, sessionId: 'sid-1', lastFrameAt: NOW, world: world(), policy: P, ...o });
const retry = (o: Partial<RetryCounters> = {}): RetryCounters => ({ preAdmit: 0, busy: 0, pending: 0, serverFull: 0, transient: 0, ...o });
const room = (o: Partial<RoomRef> = {}): RoomRef => ({ code: CODE, myIndex: 1, lastPhase: 'playing', ...o });
const join = (code: RoomCode = CODE): Intent => ({ kind: 'join', code });
const failure = (o: Partial<Failure> & { code: Failure['code'] }): Failure => ({ serverReason: null, retryable: false, canJoinAsNew: false, autoRetryOnOnline: false, ...o });

type St<N extends SessionState['s']> = Extract<SessionState, { s: N }>;
const idle = (): SessionState => ({ s: 'idle' });
const connecting = (o: Partial<St<'connecting'>> = {}): St<'connecting'> => ({ s: 'connecting', intent: join(), room: null, attempt: 0, gen: GEN, retry: retry(), ...o });
const requesting = (o: Partial<St<'requesting'>> = {}): St<'requesting'> => ({ s: 'requesting', intent: join(), room: null, attempt: 0, gen: GEN, sentAt: NOW - 10, retry: retry(), ...o });
const lobby = (o: Partial<St<'lobby'>> = {}): St<'lobby'> => ({ s: 'lobby', room: room({ lastPhase: 'lobby' }), gen: GEN, ...o });
const countdown = (o: Partial<St<'countdown'>> = {}): St<'countdown'> => ({ s: 'countdown', room: room({ lastPhase: 'countingDown' }), gen: GEN, seconds: 3, endsAt: NOW + 3000, ...o });
const playing = (o: Partial<St<'playing'>> = {}): St<'playing'> => ({ s: 'playing', room: room(), gen: GEN, ...o });
const reconnecting = (o: Partial<St<'reconnecting'>> = {}): St<'reconnecting'> => ({
  s: 'reconnecting', intent: join(), room: room(), attempt: 1, nextAt: NOW + 500, cause: 'closed', offline: false, suspended: false, retry: retry(), ...o,
});
const failed = (o: Partial<St<'failed'>> = {}): St<'failed'> => ({ s: 'failed', failure: failure({ code: 'room-lost', retryable: true }), intent: join(), room: room(), ...o });
const finished = (o: Partial<St<'finished'>> = {}): St<'finished'> => ({ s: 'finished', room: room(), gameOver: null, derived: true, ...o });

function model(state: SessionState, o: Partial<Model> = {}): Model {
  return { ...initialModel(true, true), lastGen: GEN, epoch: 2, budgetAt: NOW, state, ...o };
}

function run(m: Model, input: SessionInput, e: Partial<MachineEnv> = {}): { model: Model; effects: SessionEffect[] } {
  return transition(deepFreeze(m), input, env(e));
}

// Effect builders.
const CLEAR: SessionEffect = { e: 'timer.clear', name: '*' };
const set = (name: TimerName, ms: number): SessionEffect => ({ e: 'timer.set', name, ms });
const clr = (name: TimerName): SessionEffect => ({ e: 'timer.clear', name });
const open = (gen: number): SessionEffect => ({ e: 'socket.open', gen });
const close = (code: CloseCode, reason: string, gen = GEN): SessionEffect => ({ e: 'socket.close', gen, code, reason });
const send = (msg: ClientMessage, gen = GEN): SessionEffect => ({ e: 'socket.send', gen, msg });
const reset = (epoch: number, myIndex: Seat | null): SessionEffect => ({ e: 'game.reset', epoch, myIndex });
const FREEZE: SessionEffect = { e: 'game.freeze', frozen: true };
const ended = (msg: GameOver | null, reason: string): SessionEffect => ({ e: 'game.ended', msg, reason });
const ROTATE: SessionEffect = { e: 'identity.rotate' };
const RESYNC: SessionEffect = { e: 'input.resync' };
const HALT: SessionEffect = { e: 'input.halt' };
const scene = (s: MusicScene): SessionEffect => ({ e: 'audio.scene', scene: s });
const notice = (kind: NoticeKind): SessionEffect => ({ e: 'notice', kind });

const joined = (code: string, phase: RoomPhase, gen = GEN): SessionInput => ({
  t: 'message', gen, at: NOW, msg: { messageType: 'roomJoined', success: true, roomPID: 'p', code, phase, reason: '' },
});
const rejectedWith = (reason: string, gen = GEN): SessionInput => ({
  t: 'message', gen, at: NOW, msg: { messageType: 'roomJoined', success: false, roomPID: '', code: '', phase: '', reason },
});
const assign = (i: number, phase: RoomPhase): SessionInput => ({ t: 'message', gen: GEN, at: NOW, msg: { messageType: 'playerAssignment', playerIndex: i, phase } });
const closedOn = (gen: number): SessionInput => ({ t: 'closed', gen, code: 1006, wasClean: false });
const closed: SessionInput = closedOn(GEN);
const timer = (name: TimerName): SessionInput => ({ t: 'timer', name });
const GAME_OVER: GameOver = { messageType: 'gameOver', winnerIndex: 2, finalScores: [1, 2, 9, 0], reason: 'All bricks destroyed', roomPID: 'p' };

describe('initialModel and helpers', () => {
  it('starts idle with nothing to recover', () => {
    expect(initialModel(false, true)).toEqual({
      state: { s: 'idle' }, lastGen: 0, epoch: 0, online: false, visible: true, resumeGraceUntil: 0, unstable: false,
      badCount: 0, badWindowStart: 0, lastLeft: null, budgetUsedMs: 0, budgetAt: 0, droppedAt: null, roomCloseFloorAt: null,
    });
  });

  it('roomOf and intentOf read the state', () => {
    expect(roomOf(model(idle()))).toBeNull();
    expect(roomOf(model(lobby()))).toEqual(room({ lastPhase: 'lobby' }));
    expect(roomOf(model(connecting()))).toBeNull();
    expect(intentOf(model(connecting({ intent: { kind: 'quick' } })))).toEqual({ kind: 'quick' });
    expect(intentOf(model(failed({ intent: null })))).toBeNull();
    expect(intentOf(model(playing()))).toBeNull();
    expect(intentOf(model(idle()))).toBeNull();
  });

  it('boundCode prefers the room, then a join intent, and is null when idle', () => {
    expect(boundCode(model(idle()))).toBeNull();
    expect(boundCode(model(connecting({ intent: join(OTHER) })))).toBe(OTHER);
    expect(boundCode(model(connecting({ intent: { kind: 'create', isPublic: true } })))).toBeNull();
    expect(boundCode(model(requesting({ intent: { kind: 'quick' }, room: room({ code: OTHER }) })))).toBe(OTHER);
    expect(boundCode(model(finished()))).toBe(CODE);
    expect(boundCode(model(failed({ intent: join(OTHER), room: null })))).toBe(OTHER);
  });

  it('isBoundTo is false when idle, whatever the code', () => {
    expect(isBoundTo(model(idle()), CODE)).toBe(false);
    expect(isBoundTo(model(reconnecting()), CODE)).toBe(true);
    expect(isBoundTo(model(reconnecting()), OTHER)).toBe(false);
  });
});

describe('general rules', () => {
  it('ignores an input from another generation without touching the model', () => {
    const m = model(lobby());
    const r = run(m, { t: 'closed', gen: GEN - 1, code: 1000, wasClean: true });
    expect(r.model).toBe(m);
    expect(r.effects).toEqual([]);
  });

  it('leaves the model identical for an input no row lists', () => {
    const m = model(idle());
    const r = run(m, { t: 'retry' });
    expect(r.model).toBe(m);
    expect(r.effects).toEqual([]);
  });

  it('accounts online recovery time on every input in reconnecting', () => {
    const m = model(reconnecting(), { budgetUsedMs: 1000, budgetAt: NOW - 700 });
    const r = run(m, { t: 'hidden' });
    expect(r.model.budgetUsedMs).toBe(1700);
    expect(r.model.budgetAt).toBe(NOW);
  });

  it('does not count time spent offline (C31)', () => {
    const m = model(reconnecting({ offline: true, nextAt: null }), { online: false, budgetUsedMs: 1000, budgetAt: NOW - 50_000 });
    const r = run(m, { t: 'online' });
    expect(r.model.budgetUsedMs).toBe(1000);
    expect(r.model.budgetAt).toBe(NOW);
  });

  it('does not count time suspended in the bfcache (amended): the restore reopens instead of failing', () => {
    const suspended = reconnecting({ suspended: true, nextAt: null, attempt: 0, cause: 'pagehide' });
    const kept = run(model(suspended, { budgetUsedMs: 1000, budgetAt: NOW - 120_000 }), { t: 'hidden' });
    expect(kept.model.budgetUsedMs).toBe(1000);
    expect(kept.model.budgetAt).toBe(NOW);
    const restored = run(model(suspended, { budgetUsedMs: 0, budgetAt: NOW - 120_000 }), { t: 'pageshow', persisted: true });
    expect(restored.model.state).toMatchObject({ s: 'connecting', room: room(), attempt: 0, gen: GEN + 1 });
    expect(restored.model).toMatchObject({ budgetUsedMs: 0, budgetAt: NOW });
    expect(restored.effects).toEqual([CLEAR, open(GEN + 1), set('connect', 8000)]);
  });

  it('entering reconnecting while offline arms no retry and shows no retry time', () => {
    const drop = run(model(playing(), { online: false }), closed);
    expect(drop.model.state).toMatchObject({ s: 'reconnecting', cause: 'closed', offline: true, nextAt: null });
    expect(drop.effects).toEqual([CLEAR, FREEZE, HALT]);
    const pre = run(model(connecting({ intent: { kind: 'quick' } }), { online: false }), closed);
    expect(pre.model.state).toMatchObject({ s: 'reconnecting', offline: true, nextAt: null, retry: retry({ preAdmit: 1 }) });
    expect(pre.effects).toEqual([CLEAR]);
    const busyOffline = run(model(requesting({ room: room() }), { online: false }), rejectedWith('Session already connected'));
    expect(busyOffline.model.state).toMatchObject({ s: 'reconnecting', offline: true, nextAt: null, retry: retry({ busy: 1 }) });
    expect(busyOffline.effects).toEqual([CLEAR, close(4002, 'rejected')]);
    // T44 then arms the retry.
    const back = run(drop.model, { t: 'online' });
    expect(back.model.state).toMatchObject({ s: 'reconnecting', offline: false, nextAt: NOW + 250 });
    expect(back.effects).toEqual([set('retry', 250)]);
  });

  it('accounts in connecting and requesting only when a room is known', () => {
    expect(run(model(connecting({ room: room() }), { budgetUsedMs: 0, budgetAt: NOW - 300 }), { t: 'hidden' }).model.budgetUsedMs).toBe(300);
    expect(run(model(requesting({ room: null }), { budgetUsedMs: 0, budgetAt: NOW - 300 }), { t: 'hidden' }).model.budgetUsedMs).toBe(0);
    expect(run(model(lobby(), { budgetUsedMs: 0, budgetAt: NOW - 300 }), { t: 'hidden' }).model.budgetUsedMs).toBe(0);
  });

  it('clears the soft stall when play ends', () => {
    const r = run(model(playing(), { unstable: true }), closed);
    expect(r.model.state.s).toBe('reconnecting');
    expect(r.model.unstable).toBe(false);
  });
});

describe('transition table 5.5.1', () => {
  it('T1: a join with a malformed code fails from any state', () => {
    const bad: Intent = { kind: 'join', code: 'zz12!!' as RoomCode };
    const r = run(model(playing()), { t: 'start', intent: bad });
    expect(r.model.state).toEqual({ s: 'failed', failure: failure({ code: 'invalid-code' }), intent: bad, room: null });
    // Amended: leaving play also freezes the world, halts input and changes the scene.
    expect(r.effects).toEqual([CLEAR, close(1000, 'invalid-code'), FREEZE, HALT, scene('landing')]);
    expect(run(model(lobby()), { t: 'start', intent: bad }).effects).toEqual([CLEAR, close(1000, 'invalid-code'), FREEZE, HALT, scene('landing')]);

    const fromIdle = run(model(idle()), { t: 'start', intent: bad });
    expect(fromIdle.model.state.s).toBe('failed');
    expect(fromIdle.effects).toEqual([CLEAR]); // no socket to close
    expect(run(model(connecting()), { t: 'start', intent: bad }).effects).toEqual([CLEAR, close(1000, 'invalid-code')]); // not admitted
  });

  it('T2: start(join c) while bound to c changes nothing, in every non-idle state', () => {
    const bound: SessionState[] = [
      connecting(), requesting({ intent: join(), room: room() }), lobby(), countdown(), playing(), reconnecting(),
      failed({ failure: failure({ code: 'room-full', retryable: true }), room: null }), finished(),
    ];
    for (const st of bound) {
      const m = model(st);
      const r = run(m, { t: 'start', intent: join(CODE) });
      expect(r.model, st.s).toBe(m);
      expect(r.effects, st.s).toEqual([]);
    }
    // After T9 a create is bound to its code too.
    const created = model(requesting({ intent: join(CODE), room: room({ myIndex: null, lastPhase: 'lobby' }) }));
    expect(run(created, { t: 'start', intent: join(CODE) }).model).toBe(created);
    // Idle is never bound.
    expect(run(model(idle()), { t: 'start', intent: join(CODE) }).model.state.s).toBe('connecting');
  });

  it('T3: another start while admitted switches rooms, rotating the id', () => {
    const r = run(model(playing()), { t: 'start', intent: { kind: 'quick' } });
    expect(r.model.state).toEqual({ s: 'connecting', intent: { kind: 'quick' }, room: null, attempt: 0, gen: GEN + 1, retry: retry() });
    expect(r.model.lastLeft).toEqual({ code: CODE, at: NOW });
    expect(r.model.lastGen).toBe(GEN + 1);
    expect(r.effects).toEqual([CLEAR, close(1000, 'switch'), ROTATE, reset(2, null), open(GEN + 1), set('connect', P.connectTimeoutMs)]);

    const other = run(model(lobby()), { t: 'start', intent: join(OTHER) });
    expect(other.model.state).toMatchObject({ s: 'connecting', intent: join(OTHER) });
  });

  it('T4: a valid start from idle, failed, finished, connecting, requesting or reconnecting', () => {
    const fromIdle = run(model(idle()), { t: 'start', intent: { kind: 'create', isPublic: true } });
    expect(fromIdle.model.state).toEqual({ s: 'connecting', intent: { kind: 'create', isPublic: true }, room: null, attempt: 0, gen: GEN + 1, retry: retry() });
    expect(fromIdle.effects).toEqual([CLEAR, open(GEN + 1), set('connect', 8000)]);

    const fromRequesting = run(model(requesting()), { t: 'start', intent: { kind: 'quick' } });
    expect(fromRequesting.effects).toEqual([CLEAR, close(1000, 'restart'), open(GEN + 1), set('connect', 8000)]);

    const fromReconnecting = run(model(reconnecting(), { droppedAt: NOW - 5000, roomCloseFloorAt: NOW + 55_000, budgetUsedMs: 4000 }), { t: 'start', intent: join(OTHER) });
    expect(fromReconnecting.model).toMatchObject({ droppedAt: null, roomCloseFloorAt: null, budgetUsedMs: 0, budgetAt: NOW });
    expect(fromReconnecting.effects).toEqual([CLEAR, open(GEN + 1), set('connect', 8000)]);

    for (const st of [failed(), finished()]) {
      expect(run(model(st), { t: 'start', intent: { kind: 'quick' } }).model.state.s).toBe('connecting');
    }
  });

  it('T5: open sends the request with the session id and arms the admission timer', () => {
    const r = run(model(connecting()), { t: 'open', gen: GEN });
    expect(r.model.state).toEqual({ s: 'requesting', intent: join(), room: null, attempt: 0, gen: GEN, sentAt: NOW, retry: retry() });
    expect(r.effects).toEqual([send({ messageType: 'joinRoom', code: CODE, sessionId: 'sid-1' }), set('admission', 8000)]);

    const create = run(model(connecting({ intent: { kind: 'create', isPublic: false } })), { t: 'open', gen: GEN });
    expect(create.effects[0]).toEqual(send({ messageType: 'createRoom', isPublic: false, sessionId: 'sid-1' }));
    const quick = run(model(connecting({ intent: { kind: 'quick' } })), { t: 'open', gen: GEN }, { sessionId: 'sid-9' });
    expect(quick.effects[0]).toEqual(send({ messageType: 'quickPlay', sessionId: 'sid-9' }));
  });

  it('T6: before a room, a close or connect timeout backs off while attempts remain', () => {
    const r = run(model(connecting({ intent: { kind: 'quick' } })), closed);
    expect(r.model.state).toEqual({
      s: 'reconnecting', intent: { kind: 'quick' }, room: null, attempt: 1, nextAt: NOW + 375, cause: 'closed',
      offline: false, suspended: false, retry: retry({ preAdmit: 1 }),
    });
    expect(r.effects).toEqual([CLEAR, set('retry', 375)]); // backoff(0, 500, 4000) at rand 0.5

    const t = run(model(connecting({ attempt: 2, retry: retry({ preAdmit: 1 }) })), timer('connect'));
    expect(t.model.state).toMatchObject({ s: 'reconnecting', cause: 'connect-timeout', attempt: 3, retry: retry({ preAdmit: 2 }) });
    expect(t.effects).toEqual([CLEAR, close(4000, 'connect-timeout'), set('retry', 1500)]); // backoff(2): step 2000
  });

  it('T7: before a room, the fifth failure gives failed{unreachable}', () => {
    const r = run(model(connecting({ retry: retry({ preAdmit: 4 }) })), closed);
    expect(r.model.state).toEqual({ s: 'failed', failure: failure({ code: 'unreachable', retryable: true, autoRetryOnOnline: true }), intent: join(), room: null });
    expect(r.effects).toEqual([CLEAR]);
  });

  it('T8: with a room, retry within the budget, else failed{room-lost, retryable}', () => {
    const r = run(model(connecting({ room: room(), attempt: 1 }), { budgetUsedMs: 1000, budgetAt: NOW - 100 }), closed);
    expect(r.model.state).toMatchObject({ s: 'reconnecting', room: room(), attempt: 2, nextAt: NOW + 600, cause: 'closed' });
    expect(r.model.budgetUsedMs).toBe(1100); // the budget continues on Model
    expect(r.effects).toEqual([CLEAR, set('retry', 600)]); // backoff(1, 400, 5000)

    const spent = run(model(connecting({ room: room() }), { budgetUsedMs: 89_900, budgetAt: NOW - 200 }), timer('connect'));
    expect(spent.model.state).toEqual({ s: 'failed', failure: failure({ code: 'room-lost', retryable: true }), intent: join(), room: room() });
    expect(spent.effects).toEqual([CLEAR, close(4000, 'connect-timeout')]);
  });

  it('T9: roomCreated makes the intent a join of that code, and starts the budget clock (amended)', () => {
    const stale = { budgetUsedMs: 30_000, budgetAt: NOW - 60_000 };
    const r = run(model(requesting({ intent: { kind: 'create', isPublic: true } }), stale), { t: 'message', gen: GEN, at: NOW, msg: { messageType: 'roomCreated', code: 'C0FFEE', roomPID: 'p' } });
    expect(r.model.state).toMatchObject({ s: 'requesting', intent: join('C0FFEE' as RoomCode), room: { code: 'C0FFEE', myIndex: null, lastPhase: 'lobby' } });
    expect(r.model).toMatchObject({ budgetUsedMs: 0, budgetAt: NOW });
    expect(r.effects).toEqual([]);
  });

  it('T10: roomJoined{success} records the room and its phase', () => {
    const r = run(model(requesting({ intent: { kind: 'quick' } }), { budgetUsedMs: 30_000, budgetAt: NOW - 60_000 }), joined('C0FFEE', 'playing'));
    expect(r.model.state).toMatchObject({ s: 'requesting', intent: join('C0FFEE' as RoomCode), room: { code: 'C0FFEE', myIndex: null, lastPhase: 'playing' } });
    expect(r.model).toMatchObject({ budgetUsedMs: 0, budgetAt: NOW }); // amended: the room just became known
    expect(r.effects).toEqual([]);

    // A room already known keeps the running budget, after this input's accounting.
    const rejoin = run(model(requesting({ room: room({ myIndex: 3, lastPhase: 'playing' }) }), { budgetUsedMs: 5000, budgetAt: NOW - 100 }), joined(CODE, 'playing'));
    expect(rejoin.model.state).toMatchObject({ room: { code: CODE, myIndex: 3, lastPhase: 'playing' } });
    expect(rejoin.model).toMatchObject({ budgetUsedMs: 5100, budgetAt: NOW });
  });

  it('T10 carries T11\'s placed-in-left-room test for a quick play that lands in the room just left', () => {
    const left = { code: CODE, at: NOW - 10_000 };
    const quick = run(model(requesting({ intent: { kind: 'quick' } }), { lastLeft: left }), joined(CODE, 'lobby'));
    expect(quick.effects).toEqual([notice('placed-in-left-room')]);
    // Not for a join by code, not after the rejoin window, not for another room.
    expect(run(model(requesting(), { lastLeft: left }), joined(CODE, 'lobby')).effects).toEqual([]);
    expect(run(model(requesting({ intent: { kind: 'quick' } }), { lastLeft: { code: CODE, at: NOW - 30_000 } }), joined(CODE, 'lobby')).effects).toEqual([]);
    expect(run(model(requesting({ intent: { kind: 'quick' } }), { lastLeft: left }), joined('C0FFEE', 'lobby')).effects).toEqual([]);
  });

  it('T11: playerAssignment admits into the phase it names', () => {
    const base = model(requesting({ room: room({ myIndex: null, lastPhase: 'lobby' }) }), { budgetUsedMs: 5000, badCount: 3 });
    const toLobby = run(base, assign(2, 'lobby'));
    expect(toLobby.model.state).toEqual({ s: 'lobby', room: { code: CODE, myIndex: 2, lastPhase: 'lobby' }, gen: GEN });
    expect(toLobby.model).toMatchObject({ epoch: 3, budgetUsedMs: 0, droppedAt: null, roomCloseFloorAt: null, badCount: 0 });
    expect(toLobby.effects).toEqual([CLEAR, reset(3, 2), set('liveness', 20_000), RESYNC, scene('lobby')]);

    const toPlay = run(base, assign(0, 'playing'));
    expect(toPlay.model.state).toEqual({ s: 'playing', room: { code: CODE, myIndex: 0, lastPhase: 'playing' }, gen: GEN });
    expect(toPlay.effects).toEqual([CLEAR, reset(3, 0), set('liveness', 5000), set('stall', 1200), RESYNC, scene('playing')]);

    const toCountdown = run(base, assign(1, 'countingDown'));
    expect(toCountdown.model.state).toEqual({ s: 'countdown', room: { code: CODE, myIndex: 1, lastPhase: 'countingDown' }, gen: GEN, seconds: null, endsAt: null });
    expect(toCountdown.effects).toContainEqual(scene('countdown'));

    const offline = run(model(requesting({ room: room() }), { online: false }), assign(1, 'lobby'));
    expect(offline.effects).toContainEqual(set('liveness', 3000));

    // No code known yet: no row.
    const noRoom = model(requesting());
    expect(run(noRoom, assign(0, 'lobby')).model).toBe(noRoom);
  });

  it('T11: seat notices after an in-room drop', () => {
    const dropped = (droppedAt: number) => model(requesting({ room: room({ myIndex: 1 }) }), { droppedAt, roomCloseFloorAt: droppedAt + 60_000 });
    expect(run(dropped(NOW - 5000), assign(3, 'playing')).effects).toContainEqual(notice('seat-released'));
    expect(run(dropped(NOW - 30_000), assign(1, 'playing')).effects).toContainEqual(notice('seat-maybe-released'));
    const back = run(dropped(NOW - 29_999), assign(1, 'playing'));
    expect(back.effects.filter((e) => e.e === 'notice')).toEqual([]);
    expect(back.model).toMatchObject({ droppedAt: null, roomCloseFloorAt: null });
    // No held seat to compare with: no notice.
    const unseated = model(requesting({ room: room({ myIndex: null }) }), { droppedAt: NOW - 40_000 });
    expect(run(unseated, assign(1, 'playing')).effects.filter((e) => e.e === 'notice')).toEqual([]);
  });

  it('T12: a room-gone rejection before a room is known', () => {
    for (const [reason, code] of [['Room not found', 'room-not-found'], ['Room is closing', 'room-closing'], ['Room closed during admission', 'room-closing']] as const) {
      const r = run(model(requesting()), rejectedWith(reason));
      expect(r.model.state).toEqual({ s: 'failed', failure: failure({ code, serverReason: reason }), intent: join(), room: null });
      expect(r.effects).toEqual([CLEAR, close(4002, 'rejected')]);
    }
  });

  it('T13: a room-gone rejection on a rejoin derives the finish only with few bricks and before the empty-room floor', () => {
    const rejoin = (o: Partial<Model> = {}, r: RoomRef = room()) => model(requesting({ room: r }), { roomCloseFloorAt: NOW + 1, ...o });
    const fin = run(rejoin(), rejectedWith('Room not found'), { world: world({ bricksAlive: 3 }) });
    expect(fin.model.state).toEqual({ s: 'finished', room: room(), gameOver: null, derived: true });
    expect(fin.effects).toEqual([CLEAR, close(4002, 'rejected'), ended(null, 'All bricks destroyed'), HALT, scene('finished')]);

    const lost = (m: Model, w: Partial<WorldSummary>) => run(m, rejectedWith('Room is closing'), { world: world(w) }).model.state;
    const roomLost = { s: 'failed', failure: failure({ code: 'room-lost', serverReason: 'Room is closing' }) };
    expect(lost(rejoin(), { bricksAlive: 4 })).toMatchObject(roomLost);
    expect(lost(rejoin(), { bricksAlive: null })).toMatchObject(roomLost);
    expect(lost(rejoin({ roomCloseFloorAt: NOW }), { bricksAlive: 1 })).toMatchObject(roomLost); // the room may have closed empty
    expect(lost(rejoin({ roomCloseFloorAt: null }), { bricksAlive: 1 })).toMatchObject(roomLost);
    expect(lost(rejoin({}, room({ lastPhase: 'lobby' })), { bricksAlive: 1 })).toMatchObject(roomLost);
  });

  it('T14: room full is retryable before a room, and seat-taken on a rejoin', () => {
    const fresh = run(model(requesting()), rejectedWith('Room is full'));
    expect(fresh.model.state).toMatchObject({ s: 'failed', failure: failure({ code: 'room-full', retryable: true, serverReason: 'Room is full' }) });
    expect(fresh.effects).toEqual([CLEAR, close(4002, 'rejected')]);
    const rejoin = run(model(requesting({ room: room() })), rejectedWith('Room is full'));
    expect(rejoin.model.state).toMatchObject({ s: 'failed', failure: failure({ code: 'seat-taken', serverReason: 'Room is full' }) });
  });

  it('T15: server full backs off 5, 10 and 20 s', () => {
    const r = run(model(requesting()), rejectedWith('Server is full'));
    expect(r.model.state).toMatchObject({ s: 'reconnecting', cause: 'rejected', attempt: 1, nextAt: NOW + 5000, retry: retry({ serverFull: 1 }) });
    expect(r.effects).toEqual([CLEAR, close(4002, 'rejected'), set('retry', 5000)]);
    expect(run(model(requesting({ retry: retry({ serverFull: 2 }) })), rejectedWith('Server is full')).effects).toContainEqual(set('retry', 20_000));
  });

  it('T16: server full, retries spent', () => {
    const r = run(model(requesting({ retry: retry({ serverFull: 3 }) })), rejectedWith('Server is full'));
    expect(r.model.state).toMatchObject({ s: 'failed', failure: failure({ code: 'server-full', retryable: true, serverReason: 'Server is full' }) });
  });

  it('T17: admission pending retries on the same socket', () => {
    const r = run(model(requesting()), rejectedWith('Session admission is pending'));
    expect(r.model.state).toMatchObject({ s: 'requesting', gen: GEN, retry: retry({ pending: 1 }) });
    expect(r.effects).toEqual([clr('admission'), set('retry', 400)]);
    expect(run(model(requesting({ retry: retry({ pending: 4 }) })), rejectedWith('Session admission is pending')).effects).toEqual([clr('admission'), set('retry', 2000)]);
  });

  it('T18: the retry timer in requesting re-sends the request', () => {
    const r = run(model(requesting({ intent: { kind: 'quick' }, retry: retry({ pending: 1 }) })), timer('retry'), { sessionId: 'sid-2' });
    expect(r.model.state).toMatchObject({ s: 'requesting', sentAt: NOW, retry: retry({ pending: 1 }) });
    expect(r.effects).toEqual([send({ messageType: 'quickPlay', sessionId: 'sid-2' }), set('admission', 8000)]);
  });

  it('T19: busy backs off 1.5, 3 and 6 s; spent pending takes the busy path', () => {
    const r = run(model(requesting({ room: room() })), rejectedWith('Session already connected'));
    expect(r.model.state).toMatchObject({ s: 'reconnecting', cause: 'rejected', nextAt: NOW + 1500, retry: retry({ busy: 1 }) });
    expect(r.effects).toEqual([CLEAR, close(4002, 'rejected'), set('retry', 1500)]);
    const spentPending = run(model(requesting({ retry: retry({ pending: 5, busy: 1 }) })), rejectedWith('Session admission is pending'));
    expect(spentPending.model.state).toMatchObject({ s: 'reconnecting', retry: retry({ pending: 5, busy: 2 }) });
    expect(spentPending.effects).toContainEqual(set('retry', 3000));
  });

  it('T20: busy spent outside play joins as a new player', () => {
    const m = model(requesting({ room: room({ lastPhase: 'lobby', myIndex: 2 }), retry: retry({ busy: 3 }) }), { droppedAt: NOW - 9000, roomCloseFloorAt: NOW + 51_000 });
    const r = run(m, rejectedWith('Session already connected'));
    expect(r.model.state).toEqual({ s: 'connecting', intent: join(), room: { code: CODE, myIndex: null, lastPhase: 'lobby' }, attempt: 0, gen: GEN + 1, retry: retry() });
    expect(r.model).toMatchObject({ droppedAt: null, roomCloseFloorAt: null });
    expect(r.effects).toEqual([CLEAR, close(4002, 'rejected'), ROTATE, notice('joined-as-new'), open(GEN + 1), set('connect', 8000)]);
    // Before any room is known, too.
    expect(run(model(requesting({ retry: retry({ busy: 3 }) })), rejectedWith('Session already connected')).model.state).toMatchObject({ s: 'connecting', room: null });
  });

  it('T20 keeps the in-room budget (amended), after this input\'s accounting', () => {
    const m = model(requesting({ room: room({ myIndex: 0, lastPhase: 'lobby' }), retry: retry({ busy: 3 }) }), { budgetUsedMs: 80_000, budgetAt: NOW - 500 });
    const r = run(m, rejectedWith('Session already connected'));
    expect(r.model.state).toMatchObject({ s: 'connecting', room: { code: CODE, myIndex: null, lastPhase: 'lobby' }, attempt: 0, retry: retry() });
    expect(r.model.budgetUsedMs).toBeGreaterThanOrEqual(80_000);
    expect(r.model).toMatchObject({ budgetUsedMs: 80_500, budgetAt: NOW });
  });

  it('T21: busy spent in play fails with session-busy', () => {
    const r = run(model(requesting({ room: room({ lastPhase: 'playing' }), retry: retry({ busy: 3 }) })), rejectedWith('Session already connected'));
    expect(r.model.state).toMatchObject({ s: 'failed', failure: failure({ code: 'session-busy', retryable: true, canJoinAsNew: true, serverReason: 'Session already connected' }) });
    expect(r.effects).toEqual([CLEAR, close(4002, 'rejected')]);
  });

  it('T22: a transient rejection backs off', () => {
    const r = run(model(requesting()), rejectedWith('Server is stopping'));
    expect(r.model.state).toMatchObject({ s: 'reconnecting', cause: 'rejected', retry: retry({ transient: 1 }), nextAt: NOW + 375 });
    expect(r.effects).toEqual([CLEAR, close(4002, 'rejected'), set('retry', 375)]);
    const inRoom = run(model(requesting({ room: room() })), rejectedWith('Room is unavailable'));
    expect(inRoom.effects).toContainEqual(set('retry', 300)); // in-room schedule
  });

  it('T23: transient spent, or an unknown reason, fails with the server reason', () => {
    const spent = run(model(requesting({ retry: retry({ transient: 3 }) })), rejectedWith('Admission failed'));
    expect(spent.model.state).toMatchObject({ s: 'failed', failure: failure({ code: 'unknown', serverReason: 'Admission failed', retryable: true }) });
    expect(spent.effects).toEqual([CLEAR, close(4002, 'rejected')]);
    const unknown = run(model(requesting()), rejectedWith('Nobody expects this'));
    expect(unknown.model.state).toMatchObject({ s: 'failed', failure: failure({ code: 'unknown', serverReason: 'Nobody expects this', retryable: true }) });
  });

  it('T24: admission timeout or close in requesting', () => {
    const t = run(model(requesting()), timer('admission'));
    expect(t.model.state).toMatchObject({ s: 'reconnecting', cause: 'admission-timeout', attempt: 1, retry: retry({ preAdmit: 1 }) });
    expect(t.effects).toEqual([CLEAR, close(4000, 'admission-timeout'), set('retry', 375)]);

    const c = run(model(requesting()), closed);
    expect(c.model.state).toMatchObject({ s: 'reconnecting', cause: 'closed' });
    expect(c.effects).toEqual([CLEAR, set('retry', 375)]);

    expect(run(model(requesting({ retry: retry({ preAdmit: 4 }) })), closed).model.state).toMatchObject({ s: 'failed', failure: { code: 'unreachable' } });

    const inRoom = run(model(requesting({ room: room(), attempt: 1 })), timer('admission'));
    expect(inRoom.model.state).toMatchObject({ s: 'reconnecting', attempt: 2, retry: retry() });
    expect(inRoom.effects).toContainEqual(set('retry', 600));

    const spent = run(model(requesting({ room: room() }), { budgetUsedMs: 90_000 }), closed);
    expect(spent.model.state).toMatchObject({ s: 'failed', failure: failure({ code: 'room-lost', retryable: true }) });
    expect(spent.effects).toEqual([CLEAR]);
  });

  it('T25: countdown from the lobby', () => {
    const r = run(model(lobby()), { t: 'control', gen: GEN, at: NOW + 7, ev: { k: 'countdown', seconds: 3 } });
    expect(r.model.state).toEqual({ s: 'countdown', room: room({ lastPhase: 'countingDown' }), gen: GEN, seconds: 3, endsAt: NOW + 3007 });
    expect(r.effects).toEqual([scene('countdown')]);
  });

  it('T26: a countdown tick updates the end', () => {
    const r = run(model(countdown()), { t: 'control', gen: GEN, at: NOW + 1000, ev: { k: 'countdown', seconds: 2 } });
    expect(r.model.state).toMatchObject({ s: 'countdown', seconds: 2, endsAt: NOW + 3000 });
    expect(r.effects).toEqual([]);
  });

  it('T27: a cancelled countdown returns to the lobby with a notice', () => {
    const r = run(model(countdown()), { t: 'control', gen: GEN, at: NOW, ev: { k: 'cancelled', reason: 'player left' } });
    expect(r.model.state).toEqual({ s: 'lobby', room: room({ lastPhase: 'lobby' }), gen: GEN });
    expect(r.effects).toEqual([notice('countdown-cancelled'), scene('lobby')]);
  });

  it('T28: started enters play from the lobby or the countdown', () => {
    for (const st of [lobby(), countdown()]) {
      const r = run(model(st), { t: 'control', gen: GEN, at: NOW, ev: { k: 'started' } });
      expect(r.model.state).toEqual({ s: 'playing', room: room({ lastPhase: 'playing' }), gen: GEN });
      expect(r.effects).toEqual([RESYNC, scene('playing'), set('liveness', 5000), set('stall', 1200)]);
    }
  });

  it('T29: gameOver finishes an admitted session', () => {
    const r = run(model(playing()), { t: 'message', gen: GEN, at: NOW, msg: GAME_OVER });
    expect(r.model.state).toEqual({ s: 'finished', room: room(), gameOver: GAME_OVER, derived: false });
    expect(r.effects).toEqual([CLEAR, close(1000, 'finished'), HALT, scene('finished'), ended(GAME_OVER, 'All bricks destroyed')]);
    expect(run(model(lobby()), { t: 'message', gen: GEN, at: NOW, msg: GAME_OVER }).model.state.s).toBe('finished');
  });

  it('T30: a close in play with no bricks left is a derived finish', () => {
    const r = run(model(playing()), closed, { world: world({ bricksAlive: 0 }) });
    expect(r.model.state).toEqual({ s: 'finished', room: room(), gameOver: null, derived: true });
    expect(r.effects).toEqual([CLEAR, HALT, scene('finished'), ended(null, 'All bricks destroyed')]);
  });

  it('T31: any other close while admitted starts the in-room recovery', () => {
    for (const st of [lobby(), countdown(), playing()]) {
      const r = run(model(st, { budgetUsedMs: 777, budgetAt: 1 }), closed);
      expect(r.model.state).toEqual({
        s: 'reconnecting', intent: join(), room: st.room, attempt: 0, nextAt: NOW + 125, cause: 'closed',
        offline: false, suspended: false, retry: retry(),
      });
      expect(r.model).toMatchObject({ budgetUsedMs: 0, budgetAt: NOW, droppedAt: NOW, roomCloseFloorAt: NOW + 60_000 });
      expect(r.effects).toEqual([CLEAR, FREEZE, HALT, set('retry', 125)]);
    }
    // Another seat already in grace can expire at any moment and start the empty-room timer.
    expect(run(model(playing()), closed, { world: world({ graceSeats: 1 }) }).model.roomCloseFloorAt).toBe(NOW + 30_000);
  });

  it('T32: liveness exceeded outside the resume grace drops the socket', () => {
    const r = run(model(playing()), timer('liveness'), { lastFrameAt: NOW - 5001 });
    expect(r.model.state).toMatchObject({ s: 'reconnecting', cause: 'liveness', attempt: 0, nextAt: NOW + 125 });
    expect(r.model.droppedAt).toBe(NOW);
    expect(r.effects).toEqual([close(4000, 'liveness'), CLEAR, FREEZE, HALT, set('retry', 125)]);
    const lobbyDrop = run(model(lobby()), timer('liveness'), { lastFrameAt: NOW - 20_001 });
    expect(lobbyDrop.model.state).toMatchObject({ s: 'reconnecting', cause: 'liveness' });
  });

  it('T33: liveness not exceeded, or inside the resume grace, re-arms', () => {
    expect(run(model(lobby()), timer('liveness'), { lastFrameAt: NOW - 5000 }).effects).toEqual([set('liveness', 15_000)]);
    const graced = model(playing(), { resumeGraceUntil: NOW + 1000 });
    const r = run(graced, timer('liveness'), { lastFrameAt: NOW - 9000 });
    expect(r.model.state.s).toBe('playing');
    expect(r.effects).toEqual([set('liveness', 1000)]);
    expect(run(model(playing()), timer('liveness'), { lastFrameAt: NOW - 5000 }).effects).toEqual([set('liveness', 50)]);
  });

  it('T34: a soft stall in play sets unstable', () => {
    const r = run(model(playing()), timer('stall'), { lastFrameAt: NOW - 1201 });
    expect(r.model.unstable).toBe(true);
    expect(r.effects).toEqual([set('stall', 250)]);
  });

  it('T35: no stall re-arms for the rest of the window', () => {
    const r = run(model(playing()), timer('stall'), { lastFrameAt: NOW - 200 });
    expect(r.model.unstable).toBe(false);
    expect(r.effects).toEqual([set('stall', 1000)]);
    expect(run(model(playing()), timer('stall'), { lastFrameAt: NOW - 1200 }).effects).toEqual([set('stall', 1)]); // never a 0 ms loop
  });

  it('T36: a frame clears unstable', () => {
    const r = run(model(playing(), { unstable: true }), { t: 'frame', gen: GEN, at: NOW });
    expect(r.model.unstable).toBe(false);
    expect(r.effects).toEqual([]);
    const steady = model(playing());
    expect(run(steady, { t: 'frame', gen: GEN, at: NOW }).model).toBe(steady);
  });

  it('T37: 20 bad frames within 5 s fail with protocol', () => {
    const r = run(model(lobby(), { badCount: 19, badWindowStart: NOW - 4000 }), { t: 'badFrame', gen: GEN, at: NOW });
    expect(r.model.state).toEqual({ s: 'failed', failure: failure({ code: 'protocol', retryable: true }), intent: join(), room: room({ lastPhase: 'lobby' }) });
    expect(r.effects).toEqual([CLEAR, close(1000, 'protocol'), FREEZE, HALT, scene('landing')]); // amended
    const stale = run(model(lobby(), { badCount: 19, badWindowStart: NOW - 5001 }), { t: 'badFrame', gen: GEN, at: NOW });
    expect(stale.model).toMatchObject({ badCount: 1, badWindowStart: NOW, state: { s: 'lobby' } });
    expect(stale.effects).toEqual([]);
  });

  it('T38: visible, resume or pageshow opens the resume grace', () => {
    const r = run(model(playing(), { visible: false }), { t: 'visible' });
    expect(r.model).toMatchObject({ visible: true, resumeGraceUntil: NOW + 2500 });
    expect(r.effects).toEqual([set('liveness', 7500)]);
    // 5.6 adds pageshow to the resume grace.
    const shown = run(model(playing(), { visible: false }), { t: 'pageshow', persisted: true });
    expect(shown.model).toMatchObject({ visible: true, resumeGraceUntil: NOW + 2500 });
    expect(shown.effects).toEqual([set('liveness', 7500)]);
    expect(run(model(lobby(), { visible: false }), { t: 'resume' }).effects).toEqual([set('liveness', 22_500)]);
    const notAdmitted = run(model(idle(), { visible: false }), { t: 'visible' });
    expect(notAdmitted.model.visible).toBe(true);
    expect(notAdmitted.effects).toEqual([]);
  });

  it('T39: hidden, freeze or an unloading pagehide only records visibility', () => {
    for (const input of [{ t: 'hidden' }, { t: 'freeze' }, { t: 'pagehide', persisted: false }] as const) {
      const r = run(model(playing()), input);
      expect(r.model.visible, input.t).toBe(false);
      expect(r.model.state.s).toBe('playing');
      expect(r.effects).toEqual([]);
    }
  });

  it('T40: a persisted pagehide suspends an admitted session', () => {
    const r = run(model(countdown()), { t: 'pagehide', persisted: true });
    expect(r.model.state).toEqual({
      s: 'reconnecting', intent: join(), room: room({ lastPhase: 'countingDown' }), attempt: 0, nextAt: null, cause: 'pagehide',
      offline: false, suspended: true, retry: retry(),
    });
    expect(r.model).toMatchObject({ droppedAt: NOW, roomCloseFloorAt: NOW + 60_000, budgetUsedMs: 0 });
    expect(r.effects).toEqual([CLEAR, close(1000, 'pagehide'), FREEZE, HALT]);
    const unloading = run(model(playing()), { t: 'pagehide', persisted: false });
    expect(unloading.model.state.s).toBe('playing');
    expect(unloading.effects).toEqual([]);
  });

  it('T41: pageshow or visible resumes a suspended or overdue reconnect, keeping the attempt', () => {
    const suspended = run(model(reconnecting({ suspended: true, nextAt: null, attempt: 0 })), { t: 'pageshow', persisted: true });
    expect(suspended.model.state).toEqual({ s: 'connecting', intent: join(), room: room(), attempt: 0, gen: GEN + 1, retry: retry() });
    expect(suspended.effects).toEqual([CLEAR, open(GEN + 1), set('connect', 8000)]);
    const overdue = run(model(reconnecting({ nextAt: NOW })), { t: 'visible' });
    expect(overdue.model.state).toMatchObject({ s: 'connecting', attempt: 1 });
    const early = run(model(reconnecting({ nextAt: NOW + 1 })), { t: 'visible' });
    expect(early.model.state.s).toBe('reconnecting');
    expect(early.effects).toEqual([]);
  });

  it('T42: the retry timer reconnects while online, keeping the attempt', () => {
    const r = run(model(reconnecting({ retry: retry({ busy: 2 }) })), timer('retry'));
    expect(r.model.state).toEqual({ s: 'connecting', intent: join(), room: room(), attempt: 1, gen: GEN + 1, retry: retry({ busy: 2 }) });
    expect(r.effects).toEqual([CLEAR, open(GEN + 1), set('connect', 8000)]);
    const offline = model(reconnecting({ offline: true }), { online: false });
    expect(run(offline, timer('retry')).model.state.s).toBe('reconnecting');
  });

  it('T43: offline in reconnecting stops the retry', () => {
    const r = run(model(reconnecting()), { t: 'offline' });
    expect(r.model.online).toBe(false);
    expect(r.model.state).toMatchObject({ s: 'reconnecting', offline: true, nextAt: null });
    expect(r.effects).toEqual([clr('retry')]);
  });

  it('T44: online in reconnecting retries soon, with a reset backoff', () => {
    const r = run(model(reconnecting({ offline: true, nextAt: null, attempt: 7 }), { online: false }), { t: 'online' });
    expect(r.model.online).toBe(true);
    expect(r.model.state).toMatchObject({ s: 'reconnecting', offline: false, attempt: 1, nextAt: NOW + 250 });
    expect(r.effects).toEqual([set('retry', 250)]);
  });

  it('T45: the user retries a reconnect, resetting the budget and keeping the attempt', () => {
    const r = run(model(reconnecting(), { budgetUsedMs: 60_000, budgetAt: NOW - 10 }), { t: 'retry' });
    expect(r.model.state).toMatchObject({ s: 'connecting', attempt: 1, gen: GEN + 1 });
    expect(r.model).toMatchObject({ budgetUsedMs: 0, budgetAt: NOW });
    expect(r.effects).toEqual([CLEAR, open(GEN + 1), set('connect', 8000)]);
  });

  it('T46: any input in reconnecting with the budget spent fails', () => {
    const r = run(model(reconnecting(), { budgetUsedMs: 89_500, budgetAt: NOW - 600 }), { t: 'hidden' });
    expect(r.model.state).toEqual({ s: 'failed', failure: failure({ code: 'room-lost', retryable: true }), intent: join(), room: room() });
    expect(r.effects).toEqual([CLEAR]);
    // Offline time does not count, and a reconnect without a room has no budget.
    expect(run(model(reconnecting(), { online: false, budgetUsedMs: 89_500, budgetAt: NOW - 600 }), { t: 'hidden' }).model.state.s).toBe('reconnecting');
    expect(run(model(reconnecting({ room: null }), { budgetUsedMs: 200_000 }), { t: 'hidden' }).model.state.s).toBe('reconnecting');
  });

  it('T46 then T49 in one step: a user retry with the budget spent still reconnects', () => {
    const r = run(model(reconnecting(), { budgetUsedMs: 89_500, budgetAt: NOW - 600 }), { t: 'retry' });
    expect(r.model.state).toEqual({ s: 'connecting', intent: join(), room: room(), attempt: 0, gen: GEN + 1, retry: retry() });
    expect(r.model).toMatchObject({ budgetUsedMs: 0, budgetAt: NOW });
    expect(r.effects).toEqual([CLEAR, CLEAR, open(GEN + 1), set('connect', 8000)]); // T46's clear, then T49's
  });

  it('T47: join as a new player from reconnecting or failed', () => {
    for (const st of [failed({ failure: failure({ code: 'session-busy', retryable: true, canJoinAsNew: true }) }), reconnecting()]) {
      const r = run(model(st, { droppedAt: NOW - 1000, roomCloseFloorAt: NOW + 59_000 }), { t: 'joinAsNew' });
      expect(r.model.state).toEqual({ s: 'connecting', intent: join(), room: { code: CODE, myIndex: null, lastPhase: 'playing' }, attempt: 0, gen: GEN + 1, retry: retry() });
      expect(r.model).toMatchObject({ droppedAt: null, roomCloseFloorAt: null });
      expect(r.effects).toEqual([CLEAR, ROTATE, notice('joined-as-new'), open(GEN + 1), set('connect', 8000)]);
    }
    const noRoom = model(failed({ room: null }));
    expect(run(noRoom, { t: 'joinAsNew' }).model).toBe(noRoom);
  });

  it('T48: online or offline while admitted re-arms liveness with the new limit', () => {
    const off = run(model(playing()), { t: 'offline' }, { lastFrameAt: NOW - 1000 });
    expect(off.model.online).toBe(false);
    expect(off.effects).toEqual([set('liveness', 2000)]);
    const on = run(model(lobby(), { online: false }), { t: 'online' }, { lastFrameAt: NOW - 1000 });
    expect(on.model.online).toBe(true);
    expect(on.effects).toEqual([set('liveness', 19_000)]);
  });

  it('T49: retry from a retryable failure', () => {
    const r = run(model(failed(), { budgetUsedMs: 90_000, budgetAt: NOW - 5 }), { t: 'retry' });
    expect(r.model.state).toEqual({ s: 'connecting', intent: join(), room: room(), attempt: 0, gen: GEN + 1, retry: retry() });
    expect(r.model).toMatchObject({ budgetUsedMs: 0, budgetAt: NOW });
    expect(r.effects).toEqual([CLEAR, open(GEN + 1), set('connect', 8000)]);
    const final = model(failed({ failure: failure({ code: 'seat-taken' }) }));
    expect(run(final, { t: 'retry' }).model).toBe(final);
  });

  it('T50: online retries failed{unreachable} once', () => {
    const unreachable = failed({ failure: failure({ code: 'unreachable', retryable: true, autoRetryOnOnline: true }), intent: { kind: 'quick' }, room: null });
    const r = run(model(unreachable, { online: false }), { t: 'online' });
    expect(r.model.state).toMatchObject({ s: 'connecting', intent: { kind: 'quick' }, attempt: 0, gen: GEN + 1 });
    expect(r.effects).toEqual([CLEAR, open(GEN + 1), set('connect', 8000)]);
    // If that fails again, autoRetryOnOnline turns off.
    const again = transition(r.model, { t: 'closed', gen: GEN + 1, code: 1006, wasClean: false }, env());
    expect(again.model.state).toMatchObject({ s: 'failed', failure: { code: 'unreachable', retryable: true, autoRetryOnOnline: false } });
    const noAuto = transition({ ...again.model, online: false }, { t: 'online' }, env());
    expect(noAuto.model.state.s).toBe('failed');
    expect(noAuto.effects).toEqual([]);
  });

  it('T51: a close after finishing changes nothing (C07)', () => {
    const m = model(finished());
    const r = run(m, closed);
    expect(r.model).toBe(m);
    expect(r.effects).toEqual([]);
  });

  it('T52: leave from any state except idle', () => {
    const r = run(model(playing()), { t: 'leave', explicit: true });
    expect(r.model.state).toEqual({ s: 'idle' });
    expect(r.model.lastLeft).toEqual({ code: CODE, at: NOW });
    expect(r.effects).toEqual([CLEAR, close(1000, 'leave'), reset(2, null), HALT, scene('landing'), ROTATE]);

    const implicit = run(model(lobby()), { t: 'leave', explicit: false });
    expect(implicit.model.lastLeft).toBeNull();
    expect(implicit.effects).toEqual([CLEAR, close(1000, 'leave'), reset(2, null), HALT, scene('landing')]);

    const recon = run(model(reconnecting(), { droppedAt: NOW - 3000, roomCloseFloorAt: NOW + 57_000 }), { t: 'leave', explicit: true });
    expect(recon.effects).toEqual([CLEAR, reset(2, null), HALT, scene('landing'), ROTATE]);
    expect(recon.model).toMatchObject({ droppedAt: null, roomCloseFloorAt: null, lastLeft: { code: CODE, at: NOW } });

    const cancel = run(model(connecting({ intent: { kind: 'quick' } })), { t: 'leave', explicit: true });
    expect(cancel.effects).toEqual([CLEAR, close(1000, 'leave'), reset(2, null), HALT, scene('landing')]); // no room: no rotation

    // Amended guard: any state with a room except finished. The server may still hold the seat under this id.
    const rejoining = run(model(requesting({ room: room() })), { t: 'leave', explicit: true });
    expect(rejoining.effects).toEqual([CLEAR, close(1000, 'leave'), reset(2, null), HALT, scene('landing'), ROTATE]);
    expect(rejoining.model.lastLeft).toEqual({ code: CODE, at: NOW });
    const busyFail = run(model(failed({ failure: failure({ code: 'session-busy', retryable: true, canJoinAsNew: true }) })), { t: 'leave', explicit: true });
    expect(busyFail.effects).toEqual([CLEAR, reset(2, null), HALT, scene('landing'), ROTATE]);
    expect(busyFail.model.lastLeft).toEqual({ code: CODE, at: NOW });
    const done = run(model(finished()), { t: 'leave', explicit: true });
    expect(done.effects).toEqual([CLEAR, reset(2, null), HALT, scene('landing')]); // the room is over: no seat to protect
    expect(done.model.lastLeft).toBeNull();

    const m = model(idle());
    expect(run(m, { t: 'leave', explicit: true }).model).toBe(m);
  });
});

// A small driver for multi-step sequences: a moving clock, and the timers the effects arm.
interface Drive { m: Model; now: number; timers: Map<TimerName, number> }

function feed(d: Drive, input: SessionInput, e: Partial<MachineEnv> = {}): SessionEffect[] {
  const r = transition(deepFreeze(d.m), input, env({ now: d.now, lastFrameAt: d.now, ...e }));
  for (const f of r.effects) {
    if (f.e === 'timer.set') d.timers.set(f.name, d.now + f.ms);
    else if (f.e === 'timer.clear') {
      if (f.name === '*') d.timers.clear();
      else d.timers.delete(f.name);
    }
  }
  d.m = r.model;
  return r.effects;
}

/** Fires the earliest armed timer, moving the clock to it. */
function fireNext(d: Drive, e: Partial<MachineEnv> = {}): SessionEffect[] {
  let next: [TimerName, number] | null = null;
  for (const t of d.timers) if (next === null || t[1] < next[1]) next = t;
  if (next === null) throw new Error(`no timer armed in ${d.m.state.s}`);
  d.timers.delete(next[0]);
  d.now = Math.max(d.now, next[1]);
  return feed(d, timer(next[0]), e);
}

function reconnectingOf(m: Model): St<'reconnecting'> {
  if (m.state.s !== 'reconnecting') throw new Error(`expected reconnecting, got ${m.state.s}`);
  return m.state;
}

describe('budget accounting across cycles (session-1, amended T9, T10, T20)', () => {
  it('a lobby drop looping through pending, busy and T20 still fails within the recovery bound', () => {
    const bound = P.inRoom.onlineBudgetMs + P.inRoom.capMs + P.connectTimeoutMs;
    const d: Drive = { m: model(lobby()), now: NOW, timers: new Map() };
    feed(d, closedOn(d.m.lastGen)); // T31
    expect(d.m.state.s).toBe('reconnecting');
    const droppedAt = d.now;
    let joinsAsNew = 0;
    for (let i = 0; i < 2000 && d.m.state.s !== 'failed'; i++) {
      const s = d.m.state;
      if (s.s === 'connecting') {
        d.now += 20;
        feed(d, { t: 'open', gen: d.m.lastGen });
      } else if (s.s === 'requesting' && !d.timers.has('retry')) {
        // The server answers pending until the client stops asking on that path (T17 five times), then busy.
        d.now += 20;
        const reason = s.retry.pending < P.pendingDelaysMs.length ? 'Session admission is pending' : 'Session already connected';
        if (feed(d, rejectedWith(reason, d.m.lastGen)).some((f) => f.e === 'identity.rotate')) joinsAsNew += 1;
      } else {
        fireNext(d);
      }
    }
    expect(joinsAsNew).toBeGreaterThanOrEqual(2); // the cycle went round T20 more than once
    expect(d.m.state).toMatchObject({ s: 'failed', failure: { code: 'room-lost', retryable: true } });
    expect(d.now - droppedAt).toBeLessThanOrEqual(bound);
    expect(d.now - droppedAt).toBeGreaterThanOrEqual(P.inRoom.onlineBudgetMs);
  });

  it('the budget clock starts when the room becomes known, not at the last reset before a long unreachable wait', () => {
    const d: Drive = { m: model(idle(), { budgetAt: 0 }), now: 0, timers: new Map() };
    feed(d, { t: 'start', intent: { kind: 'quick' } }); // T4 at t = 0
    for (let i = 0; i < 20 && d.m.state.s !== 'failed'; i++) fireNext(d); // connect timeouts and retries
    expect(d.m.state).toMatchObject({ s: 'failed', failure: { code: 'unreachable', autoRetryOnOnline: true }, room: null });
    feed(d, { t: 'offline' });
    d.now = 600_000;
    feed(d, { t: 'online' }); // T50
    expect(d.m.state).toMatchObject({ s: 'connecting', room: null });
    d.now += 20;
    feed(d, { t: 'open', gen: d.m.lastGen });
    d.now += 20;
    feed(d, joined(CODE, 'lobby', d.m.lastGen)); // T10: the room becomes known
    d.now += 20;
    feed(d, closedOn(d.m.lastGen)); // T24 with a room
    expect(d.m.state).toMatchObject({ s: 'reconnecting', room: { code: CODE }, cause: 'closed' });
    expect(d.m.budgetUsedMs).toBeLessThan(1000);
  });
});

describe('attempt counts failed tries (browser-D2, amended T41, T42, T45)', () => {
  const one: Partial<MachineEnv> = { rand: () => 1 };

  it('in a room: the failure rows add one, the rows entering connecting keep it, and backoff takes the failures before', () => {
    const d: Drive = { m: model(playing()), now: NOW, timers: new Map() };
    feed(d, closedOn(d.m.lastGen), one); // T31
    expect(d.m.state).toMatchObject({ s: 'reconnecting', attempt: 0, nextAt: NOW + 250 });
    fireNext(d, one); // T42
    expect(d.m.state).toMatchObject({ s: 'connecting', attempt: 0 });
    feed(d, closedOn(d.m.lastGen), one); // T8
    expect(d.m.state).toMatchObject({ s: 'reconnecting', attempt: 1, nextAt: d.now + 400 }); // backoff(0)
    fireNext(d, one); // T42
    expect(d.m.state).toMatchObject({ s: 'connecting', attempt: 1 });
    feed(d, closedOn(d.m.lastGen), one);
    expect(d.m.state).toMatchObject({ s: 'reconnecting', attempt: 2, nextAt: d.now + 800 }); // backoff(1)
    feed(d, { t: 'retry' }, one); // T45
    expect(d.m.state).toMatchObject({ s: 'connecting', attempt: 2 });
    feed(d, closedOn(d.m.lastGen), one);
    expect(d.m.state).toMatchObject({ s: 'reconnecting', attempt: 3, nextAt: d.now + 1600 });
    d.now = reconnectingOf(d.m).nextAt ?? NaN;
    feed(d, { t: 'visible' }, one); // T41 once nextAt has passed
    expect(d.m.state).toMatchObject({ s: 'connecting', attempt: 3 });
    feed(d, closedOn(d.m.lastGen), one);
    expect(d.m.state).toMatchObject({ s: 'reconnecting', attempt: 4, nextAt: d.now + 3200 });
    fireNext(d, one);
    feed(d, closedOn(d.m.lastGen), one);
    expect(d.m.state).toMatchObject({ s: 'reconnecting', attempt: 5, nextAt: d.now + 5000 }); // the cap, at the fifth failure
  });

  it('before a room: connect timeouts give attempts 1 to 4, then failed{unreachable} on the fifth', () => {
    const d: Drive = { m: model(idle()), now: NOW, timers: new Map() };
    feed(d, { t: 'start', intent: { kind: 'quick' } }, one);
    const attempts: number[] = [];
    const delays: number[] = [];
    for (let i = 0; i < 4; i++) {
      expect(fireNext(d, one)).toContainEqual(close(4000, 'connect-timeout', d.m.lastGen));
      const s = reconnectingOf(d.m);
      attempts.push(s.attempt);
      delays.push((s.nextAt ?? NaN) - d.now);
      fireNext(d, one); // T42
      expect(d.m.state).toMatchObject({ s: 'connecting', attempt: i + 1 });
    }
    fireNext(d, one);
    expect(d.m.state).toMatchObject({ s: 'failed', failure: { code: 'unreachable', retryable: true, autoRetryOnOnline: true } });
    expect(attempts).toEqual([1, 2, 3, 4]);
    expect(delays).toEqual([500, 1000, 2000, 4000]); // backoff(0..3, 500, 4000) at rand 1
  });
});
