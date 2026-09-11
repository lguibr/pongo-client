// Session runtime flows (5.5.5, 14.1) against a mock-socket server. The runtime's timers run on a FakeClock;
// mock-socket delivers every event on a real 4 ms timer, so each step settles real time after moving fake time.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Client } from 'mock-socket';
import { createSessionRuntime, NOTICE_TEXT } from './runtime';
import { Transport } from '../net/transport';
import { createFakeSocketServer } from '../test/fakes/fakeSocket';
import type { FakeSocketServer } from '../test/fakes/fakeSocket';
import { FakeClock } from '../test/fakes/FakeClock';
import { createStore } from '../lib/store';
import { initialAppState } from '../state/appStore';
import type { AppStore, SessionView } from '../state/appStore';
import { stats } from '../state/stats';
import type { ClientMessage, RoomPhase } from '../protocol/messages';
import type { ControlEvent, GameSink, IdentityApi, RoomCode, SessionApi, WorldSummary } from './types';
import type { Owner } from '../game/events';

const URL = 'ws://runtime.test/subscribe';
const CODE = 'ABC123' as RoomCode;
const settle = (ms = 40) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ---- server messages ----

const S = {
  created: (code: string) => ({ messageType: 'roomCreated', code, roomPID: 'actor-1' }),
  joined: (code: string, phase: RoomPhase) => ({ messageType: 'roomJoined', success: true, roomPID: 'actor-1', code, phase, reason: '' }),
  rejected: (reason: string) => ({ messageType: 'roomJoined', success: false, roomPID: '', code: '', phase: '', reason }),
  assign: (playerIndex: number, phase: RoomPhase) => ({ messageType: 'playerAssignment', playerIndex, phase }),
  initial: () => ({ messageType: 'initialPlayersAndBallsState', players: [], paddles: [], balls: [] }),
  grid: () => ({ messageType: 'gameUpdates', updates: [{ messageType: 'fullGridUpdate', cellSize: 50, bricks: [] }] }),
  updates: (...updates: object[]) => ({ messageType: 'gameUpdates', updates }),
  heartbeat: () => ({ messageType: 'gameUpdates', updates: null }),
  gameOver: () => ({ messageType: 'gameOver', winnerIndex: 0, finalScores: [3, 1, 0, 0], reason: 'All bricks destroyed', roomPID: 'actor-1' }),
};

// ---- fakes ----

interface FakeGame extends GameSink { summaryValue: WorldSummary }

function makeGame(calls: string[]): FakeGame {
  const g: FakeGame = {
    summaryValue: { ready: false, bricksAlive: 40, bricksAtStart: 100, tick: 0, graceSeats: 0 },
    reset: (epoch, me) => calls.push(`game.reset:${epoch}:${me}`),
    freeze: (f) => calls.push(`game.freeze:${f}`),
    ingest: (msg) => {
      calls.push(`ingest:${msg.messageType}`);
      if (msg.messageType !== 'gameUpdates') return { controls: [], ticks: 0, boardReady: false };
      const controls: ControlEvent[] = [];
      let grid = false;
      for (const u of msg.updates) {
        if (u.messageType === 'fullGridUpdate') grid = true;
        else if (u.messageType === 'gameStartCountdown') controls.push({ k: 'countdown', seconds: u.seconds });
        else if (u.messageType === 'gameStarted') controls.push({ k: 'started' });
        else if (u.messageType === 'gameStartCancelled') controls.push({ k: 'cancelled', reason: u.reason });
      }
      return { controls, ticks: 0, boardReady: grid };
    },
    summary: () => ({ ...g.summaryValue }),
    results: (msg, reason) => ({ winner: (msg?.winnerIndex ?? -1) as Owner, rows: [], reason, derived: msg === null }),
    ended: (winner, derived) => calls.push(`game.ended:${winner}:${derived}`),
    snap: () => {},
    setHeadless: () => {},
  };
  return g;
}

interface FakeIdentity extends IdentityApi { resolve(): void; setPrevious(id: string | null): void }

function makeIdentity(calls: string[], readyNow: boolean): FakeIdentity {
  let current = 'sid-1';
  let next = 2;
  let previous: string | null = null;
  let resolve: () => void = () => {};
  const ready = readyNow ? Promise.resolve() : new Promise<void>((r) => {
    resolve = r;
  });
  return {
    ready,
    resolve: () => resolve(),
    setPrevious: (id) => {
      previous = id;
    },
    current: () => current,
    rotate: () => {
      calls.push('identity.rotate');
      previous = current;
      current = `sid-${next++}`;
    },
    hasPrevious: () => previous !== null,
    restorePrevious: () => {
      if (previous === null) return false;
      current = previous;
      previous = null;
      return true;
    },
    onPageHide: () => {},
    onPageShow: () => Promise.resolve(),
  };
}

// ---- harness ----

interface Harness {
  fake: FakeSocketServer;
  clock: FakeClock;
  store: AppStore;
  session: SessionApi;
  game: FakeGame;
  identity: FakeIdentity;
  calls: string[];
  opens: number[]; // generations passed to transport.open
  closes: Array<{ socket: number; code?: number; reason?: string }>; // client-side closes, by socket index
  requests: ClientMessage[]; // createRoom, joinRoom and quickPlay as the server received them
}

let active: Harness[] = [];

afterEach(async () => {
  for (const h of active) {
    h.session.dispose();
    await h.fake.stop();
  }
  active = [];
});

async function harness(o: { identityReady?: boolean } = {}): Promise<Harness> {
  const fake = createFakeSocketServer(URL);
  const clock = new FakeClock(10_000);
  const closes: Harness['closes'] = [];
  const factory = (url: string): WebSocket => {
    const ws = fake.factory(url);
    const socket = fake.sockets.length - 1;
    const close = ws.close.bind(ws);
    ws.close = (code?: number, reason?: string) => {
      closes.push({ socket, code, reason });
      close(code, reason);
    };
    return ws;
  };
  const transport = new Transport(factory, clock.now);
  const opens: number[] = [];
  const open = transport.open.bind(transport);
  transport.open = (gen: number, url: string) => {
    opens.push(gen);
    open(gen, url);
  };
  const calls: string[] = [];
  const requests: ClientMessage[] = [];
  fake.onMessage((text) => {
    const msg = JSON.parse(text) as ClientMessage;
    if (msg.messageType === 'createRoom' || msg.messageType === 'joinRoom' || msg.messageType === 'quickPlay') requests.push(msg);
  });
  const store = createStore(initialAppState());
  const game = makeGame(calls);
  const identity = makeIdentity(calls, o.identityReady ?? true);
  const session = createSessionRuntime({
    transport, game, identity, store, wsUrl: () => URL, timers: clock, now: clock.now, rand: () => 0.5,
    input: { resync: () => calls.push('input.resync'), halt: () => calls.push('input.halt') },
    audio: { setScene: (s) => calls.push(`audio:${s}`), setHidden: () => {} },
  });
  const h: Harness = { fake, clock, store, session, game, identity, calls, opens, closes, requests };
  active.push(h);
  await settle(0); // lets the identity's ready promise settle
  return h;
}

interface ServerOpts {
  code?: string;
  index?: number;
  phase?: RoomPhase;
  /** A rejection reason for request n (0-based), or null to admit. */
  reject?: (msg: ClientMessage, n: number) => string | null;
  /** Never answer request n. */
  silent?: (msg: ClientMessage, n: number) => boolean;
  /** Whether admission number k also sends the grid (default: always). */
  grid?: (k: number) => boolean;
}

/** A server that admits (or rejects) every request, the way pongo/game does: roomCreated or roomJoined, then
 *  playerAssignment, the initial state, and the grid last. */
function roomServer(h: Harness, o: ServerOpts = {}): { rejections: number; admissions: number } {
  const count = { rejections: 0, admissions: 0 };
  h.fake.onMessage((text, conn: Client) => {
    const msg = JSON.parse(text) as ClientMessage;
    if (msg.messageType === 'playerReady' || msg.messageType === 'direction') return;
    const n = h.requests.length - 1;
    if (o.silent?.(msg, n)) return;
    const reason = o.reject?.(msg, n) ?? null;
    if (reason !== null) {
      count.rejections += 1;
      h.fake.send(S.rejected(reason), conn);
      return;
    }
    const code = o.code ?? CODE;
    const phase: RoomPhase = msg.messageType === 'createRoom' ? 'lobby' : (o.phase ?? 'lobby');
    h.fake.send(msg.messageType === 'createRoom' ? S.created(code) : S.joined(code, phase), conn);
    h.fake.send(S.assign(o.index ?? 0, phase), conn);
    h.fake.send(S.initial(), conn);
    if (o.grid?.(count.admissions) ?? true) h.fake.send(S.grid(), conn);
    count.admissions += 1;
  });
  return count;
}

const view = (h: Harness): SessionView => h.store.get().session;
const sidOf = (m: ClientMessage | undefined) => (m !== undefined && 'sessionId' in m ? m.sessionId : undefined);

async function joinInto(h: Harness, phase: RoomPhase = 'lobby', o: ServerOpts = {}): Promise<{ rejections: number; admissions: number }> {
  const server = roomServer(h, { phase, ...o });
  h.session.start({ kind: 'join', code: CODE });
  await settle();
  return server;
}

// ---- flows ----

describe('session runtime', () => {
  it('create reaches the lobby, and worldReady follows the grid', async () => {
    const h = await harness();
    roomServer(h, { grid: () => false });
    h.session.start({ kind: 'create', isPublic: true });
    expect(view(h)).toMatchObject({ s: 'connecting', intent: { kind: 'create', isPublic: true }, code: null, roomKnown: false, gen: 1, canReady: false });
    await settle();
    expect(view(h)).toMatchObject({
      s: 'lobby', code: CODE, myIndex: 0, phase: 'lobby', roomKnown: true, worldReady: false, stageRetained: false, canReady: true, epoch: 1,
    });
    expect(h.calls).toEqual(['game.reset:1:0', 'input.resync', 'audio:lobby', 'ingest:initialPlayersAndBallsState']);

    h.fake.send(S.grid());
    await settle();
    expect(view(h)).toMatchObject({ worldReady: true, stageRetained: true });
    expect(h.requests).toEqual([{ messageType: 'createRoom', isPublic: true, sessionId: 'sid-1' }]);
    expect(h.fake.sockets).toHaveLength(1);

    expect(h.session.setReady(true)).toBe(true);
    expect(h.session.sendDirection('ArrowLeft')).toBe(false); // not playing
    await settle();
    expect(h.fake.received.slice(-1)[0]).toBe('{"messageType":"playerReady","isReady":true}');
  });

  it('drops game frames that arrive before the assignment', async () => {
    const h = await harness();
    h.fake.onMessage((_text, conn) => {
      h.fake.send(S.joined(CODE, 'lobby'), conn);
      h.fake.send(S.initial(), conn); // too early: still requesting
      h.fake.send(S.assign(2, 'lobby'), conn);
      h.fake.send(S.grid(), conn);
    });
    h.session.start({ kind: 'join', code: CODE });
    await settle();
    expect(view(h)).toMatchObject({ s: 'lobby', myIndex: 2, worldReady: true });
    expect(h.calls.filter((c) => c.startsWith('ingest'))).toEqual(['ingest:gameUpdates']);
  });

  it('a wrong code ends in failed with a 4002 close, and a rebind does not retry', async () => {
    const h = await harness();
    roomServer(h, { reject: () => 'Room not found' });
    h.session.bindRoute('FFFFFF' as RoomCode, 'route');
    await settle();
    expect(view(h)).toMatchObject({ s: 'failed', code: 'FFFFFF', failure: { code: 'room-not-found', retryable: false, serverReason: 'Room not found' } });
    expect(h.closes).toEqual([{ socket: 0, code: 4002, reason: 'rejected' }]);
    h.clock.advance(60_000);
    h.session.bindRoute('FFFFFF' as RoomCode, 'route-after-reset');
    await settle();
    expect(h.fake.sockets).toHaveLength(1);
  });

  it('busy rejoins back off 1.5, 3 and 6 s, then join as a new player in the lobby', async () => {
    const h = await harness();
    const server = await joinInto(h, 'lobby', { reject: (msg, n) => (n > 0 && sidOf(msg) === 'sid-1' ? 'Session already connected' : null) });
    expect(view(h).s).toBe('lobby');

    h.fake.close(1001, 'going away');
    await settle();
    expect(view(h)).toMatchObject({ s: 'reconnecting', cause: 'closed', nextAt: h.clock.now() + 125, stageRetained: true });

    h.clock.advance(125);
    await settle();
    const busyState = () => h.session.getModel().state;
    expect(busyState()).toMatchObject({ s: 'reconnecting', cause: 'rejected', nextAt: h.clock.now() + 1500, retry: { busy: 1 } });
    h.clock.advance(1500);
    await settle();
    expect(busyState()).toMatchObject({ s: 'reconnecting', nextAt: h.clock.now() + 3000, retry: { busy: 2 } });
    h.clock.advance(3000);
    await settle();
    expect(busyState()).toMatchObject({ s: 'reconnecting', nextAt: h.clock.now() + 6000, retry: { busy: 3 } });
    expect(h.calls).not.toContain('identity.rotate'); // never rotates while the retries last (D03)
    h.clock.advance(6000);
    await settle();

    expect(server.rejections).toBe(4);
    expect(view(h)).toMatchObject({ s: 'lobby', epoch: 2 });
    expect(h.calls.filter((c) => c === 'identity.rotate')).toHaveLength(1);
    expect(sidOf(h.requests.slice(-1)[0])).toBe('sid-2');
    expect(h.store.get().notices.map((n) => [n.kind, n.text])).toEqual([['joined-as-new', NOTICE_TEXT['joined-as-new']]]);
    expect(h.closes.filter((c) => c.code === 4002)).toHaveLength(4);
    expect(h.fake.sockets).toHaveLength(6);
  });

  it('busy in play gives failed{session-busy}; Join as new player recovers', async () => {
    const h = await harness();
    await joinInto(h, 'playing', { reject: (msg, n) => (n > 0 && sidOf(msg) === 'sid-1' ? 'Session already connected' : null) });
    expect(view(h).s).toBe('playing');
    h.fake.close(1001, 'going away');
    await settle();
    for (const wait of [125, 1500, 3000, 6000]) {
      h.clock.advance(wait);
      await settle();
    }
    expect(view(h)).toMatchObject({ s: 'failed', failure: { code: 'session-busy', retryable: true, canJoinAsNew: true } });
    expect(h.calls).not.toContain('identity.rotate');

    h.session.joinAsNew();
    await settle();
    expect(view(h)).toMatchObject({ s: 'playing', epoch: 2 });
    expect(sidOf(h.requests.slice(-1)[0])).toBe('sid-2');
    expect(h.store.get().notices.map((n) => n.kind)).toEqual(['joined-as-new']);
  });

  it('a pending admission is re-sent on the same socket', async () => {
    const h = await harness();
    roomServer(h, { reject: (_msg, n) => (n === 0 ? 'Session admission is pending' : null) });
    h.session.start({ kind: 'join', code: CODE });
    await settle();
    expect(view(h).s).toBe('requesting');
    h.clock.advance(399);
    await settle();
    expect(h.requests).toHaveLength(1);
    h.clock.advance(1);
    await settle();
    expect(view(h).s).toBe('lobby');
    expect(h.requests).toHaveLength(2);
    expect(h.fake.sockets).toHaveLength(1);
    expect(h.closes).toEqual([]);
  });

  it('an admission timeout closes with 4000 and retries on a new socket', async () => {
    const h = await harness();
    roomServer(h, { silent: () => true });
    h.session.start({ kind: 'quick' });
    await settle();
    expect(view(h).s).toBe('requesting');
    h.clock.advance(7999);
    await settle();
    expect(view(h).s).toBe('requesting');
    h.clock.advance(1);
    expect(view(h)).toMatchObject({ s: 'reconnecting', cause: 'admission-timeout', attempt: 1 });
    expect(h.closes).toEqual([{ socket: 0, code: 4000, reason: 'admission-timeout' }]);
    h.clock.advance(375); // backoff(0, 500, 4000) at rand 0.5
    await settle();
    expect(h.fake.sockets).toHaveLength(2);
    expect(view(h)).toMatchObject({ s: 'requesting', attempt: 1 }); // one failed try so far
  });

  it('liveness drops a silent lobby after 20 s', async () => {
    const h = await harness();
    await joinInto(h);
    h.clock.advance(20_000);
    expect(view(h).s).toBe('lobby');
    h.clock.advance(100);
    expect(view(h)).toMatchObject({ s: 'reconnecting', cause: 'liveness' });
    expect(h.closes).toEqual([{ socket: 0, code: 4000, reason: 'liveness' }]);
    expect(h.calls).toContain('game.freeze:true');
  });

  it('play marks a 1.2 s gap unstable and drops after 5 s', async () => {
    const h = await harness();
    await joinInto(h, 'playing');
    h.clock.advance(1300);
    expect(h.store.get().net.unstable).toBe(true);
    h.fake.send(S.heartbeat());
    await settle();
    expect(h.store.get().net.unstable).toBe(false); // the next frame clears it
    h.clock.advance(4900);
    expect(view(h).s).toBe('playing');
    h.clock.advance(200);
    expect(view(h)).toMatchObject({ s: 'reconnecting', cause: 'liveness' });
    expect(h.store.get().net.unstable).toBe(false);
  });

  it('the resume grace holds the liveness verdict while a thawed page catches up', async () => {
    const h = await harness();
    await joinInto(h, 'playing');
    h.clock.advance(4000); // no frames: without the grace the verdict would come at 5 s
    h.session.notifyEnv({ t: 'visible' });
    h.clock.advance(2000);
    expect(view(h).s).toBe('playing');
    h.fake.send(S.heartbeat()); // buffered frames arrive
    await settle();
    h.clock.advance(4900);
    expect(view(h).s).toBe('playing');
  });

  it('after gameOver no socket opens for 60 s, and results clear on leave', async () => {
    const h = await harness();
    await joinInto(h, 'playing');
    h.fake.send(S.gameOver());
    await settle();
    expect(view(h).s).toBe('finished');
    expect(h.store.get().results).toEqual({ winner: 0, rows: [], reason: 'All bricks destroyed', derived: false });
    expect(h.calls).toContain('game.ended:0:false');
    expect(h.closes).toEqual([{ socket: 0, code: 1000, reason: 'finished' }]);
    h.clock.advance(60_000);
    h.session.bindRoute(CODE, 'after-boundary-reset'); // still bound: no auto-rejoin of an ended room
    await settle();
    expect(h.fake.sockets).toHaveLength(1);
    expect(h.opens).toEqual([1]);
    h.session.leave({ explicit: false });
    expect(h.store.get().results).toBeNull();
  });

  it('a close in play with no bricks left is a derived finish', async () => {
    const h = await harness();
    await joinInto(h, 'playing');
    h.game.summaryValue = { ...h.game.summaryValue, bricksAlive: 0 };
    h.fake.close(1006, '');
    await settle();
    expect(view(h).s).toBe('finished');
    expect(h.store.get().results).toMatchObject({ winner: -1, derived: true, reason: 'All bricks destroyed' });
    expect(h.calls).toContain('game.ended:-1:true');
    h.clock.advance(60_000);
    await settle();
    expect(h.fake.sockets).toHaveLength(1);
  });

  it('pagehide(persisted) suspends the session until pageshow', async () => {
    const h = await harness();
    await joinInto(h);
    h.session.notifyEnv({ t: 'pagehide', persisted: true });
    expect(view(h)).toMatchObject({ s: 'reconnecting', suspended: true, cause: 'pagehide', nextAt: null });
    expect(h.closes).toEqual([{ socket: 0, code: 1000, reason: 'pagehide' }]);
    h.clock.advance(120_000); // longer than onlineBudgetMs: time in the bfcache must not spend the budget
    await settle();
    expect(h.fake.sockets).toHaveLength(1);
    expect(h.session.getModel().budgetUsedMs).toBe(0);
    h.session.notifyEnv({ t: 'pageshow', persisted: true });
    await settle();
    expect(h.fake.sockets).toHaveLength(2);
    expect(view(h)).toMatchObject({ s: 'lobby', epoch: 2 });
  });

  it('time offline does not spend the in-room budget', async () => {
    const h = await harness();
    await joinInto(h, 'playing');
    h.fake.close(1001, 'going away');
    await settle();
    h.session.notifyEnv({ t: 'offline' });
    expect(view(h)).toMatchObject({ s: 'reconnecting', offline: true, nextAt: null });
    h.clock.advance(200_000);
    await settle();
    expect(view(h).s).toBe('reconnecting');
    expect(h.fake.sockets).toHaveLength(1);
    h.session.notifyEnv({ t: 'online' });
    expect(h.session.getModel().budgetUsedMs).toBeLessThan(1000);
    expect(view(h)).toMatchObject({ offline: false, nextAt: h.clock.now() + 250 });
    h.clock.advance(250);
    await settle();
    expect(view(h)).toMatchObject({ s: 'playing', epoch: 2 });
  });

  it('a StrictMode-style double bind starts once and never leaves', async () => {
    const h = await harness();
    roomServer(h);
    const unbindFirst = h.session.bindRoute(CODE, 'k');
    unbindFirst(); // StrictMode's simulated unmount
    const unbind = h.session.bindRoute(CODE, 'k');
    h.clock.advance(0);
    await settle();
    expect(h.opens).toEqual([1]);
    expect(view(h).s).toBe('lobby');
    expect(h.calls).not.toContain('audio:landing');

    unbind(); // a real unmount leaves one macrotask later
    expect(view(h).s).toBe('lobby');
    h.clock.advance(0);
    expect(view(h).s).toBe('idle');
    expect(h.closes).toEqual([{ socket: 0, code: 1000, reason: 'leave' }]);
  });

  it('create, then roomCreated, then bindRoute(code) opens no second socket', async () => {
    const h = await harness();
    let hold: Client | null = null;
    h.fake.onMessage((_text, conn) => {
      hold = conn;
      h.fake.send(S.created(CODE), conn); // the assignment follows later
    });
    h.session.start({ kind: 'create', isPublic: false });
    const unbindNull = h.session.bindRoute(null, 'room');
    await settle();
    expect(view(h)).toMatchObject({ s: 'requesting', code: CODE, roomKnown: true, intent: { kind: 'join', code: CODE } });

    unbindNull(); // the URL sync re-binds the same route with the code
    h.session.bindRoute(CODE, 'room');
    h.clock.advance(0);
    const conn = hold as Client | null;
    if (conn === null) throw new Error('no connection');
    h.fake.send(S.assign(0, 'lobby'), conn);
    h.fake.send(S.initial(), conn);
    h.fake.send(S.grid(), conn);
    await settle();
    expect(view(h)).toMatchObject({ s: 'lobby', worldReady: true });
    expect(h.opens).toEqual([1]);
    expect(h.fake.sockets).toHaveLength(1);
    expect(h.requests).toEqual([{ messageType: 'createRoom', isPublic: false, sessionId: 'sid-1' }]);
  });

  it('rejoinPrevious then bindRoute opens exactly one socket, with the restored id', async () => {
    const h = await harness();
    roomServer(h);
    h.identity.setPrevious('sid-old');
    h.session.rejoinPrevious(CODE);
    h.session.bindRoute(CODE, 'k');
    await settle();
    expect(h.opens).toEqual([1]);
    expect(h.fake.sockets).toHaveLength(1);
    expect(h.requests).toEqual([{ messageType: 'joinRoom', code: CODE, sessionId: 'sid-old' }]);
    expect(view(h).s).toBe('lobby');
  });

  it('rejoinPrevious after the window gives the rejoin-failed notice and opens nothing', async () => {
    const h = await harness();
    h.session.rejoinPrevious(CODE);
    expect(h.opens).toEqual([]);
    expect(view(h).s).toBe('idle');
    expect(h.store.get().notices.map((n) => [n.kind, n.text, n.tone])).toEqual([['rejoin-failed', 'That seat has already been released.', 'warn']]);
  });

  it('a leave during the identity wait opens no socket', async () => {
    const h = await harness({ identityReady: false });
    roomServer(h);
    h.session.start({ kind: 'quick' });
    h.session.leave({ explicit: false });
    h.identity.resolve();
    await settle();
    expect(h.opens).toEqual([]);
    expect(h.fake.sockets).toHaveLength(0);
    expect(view(h).s).toBe('idle');
  });

  it('a second start during the identity wait opens only the newest generation', async () => {
    const h = await harness({ identityReady: false });
    roomServer(h);
    h.session.start({ kind: 'quick' });
    h.session.start({ kind: 'create', isPublic: false });
    h.identity.resolve();
    await settle();
    expect(h.opens).toEqual([2]);
    expect(h.closes).toEqual([]); // nothing was superseded with 4001
    expect(h.requests.map((m) => m.messageType)).toEqual(['createRoom']);
    expect(view(h).s).toBe('lobby');
  });

  it('the identity wait is bounded by identityReadyMaxMs', async () => {
    const h = await harness({ identityReady: false });
    roomServer(h);
    h.session.start({ kind: 'quick' });
    h.clock.advance(999);
    expect(h.opens).toEqual([]);
    h.clock.advance(1);
    expect(h.opens).toEqual([1]);
    await settle();
    expect(sidOf(h.requests[0])).toBe('sid-1');
  });

  it('once the identity bound is hit, later opens do not wait again', async () => {
    const h = await harness({ identityReady: false });
    roomServer(h);
    h.session.start({ kind: 'quick' });
    h.clock.advance(1000);
    expect(h.opens).toEqual([1]);
    h.session.start({ kind: 'create', isPublic: true }); // T4: a restart opens at once
    expect(h.opens).toEqual([1, 2]);
    await settle();
    expect(view(h).s).toBe('lobby');
  });

  it('dispose during the identity wait cancels the bound', async () => {
    const h = await harness({ identityReady: false });
    h.session.start({ kind: 'quick' });
    h.session.dispose();
    expect(h.clock.pending).toBe(0);
    h.clock.advance(1000);
    expect(h.opens).toEqual([]);
  });

  it('a throwing world summary or subscriber never wedges the session', async () => {
    const h = await harness();
    await joinInto(h);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const good = h.game.summary;
      let failures = 1;
      h.game.summary = () => {
        if (failures > 0) {
          failures -= 1;
          throw new Error('summary unavailable');
        }
        return good();
      };
      let heard = 0;
      h.session.subscribe(() => {
        throw new Error('subscriber');
      });
      h.session.subscribe(() => {
        heard += 1;
      });
      // The first liveness check (T33 at 20 s) meets the throwing summary; its timer must still re-arm for T32.
      h.clock.advance(20_100);
      expect(failures).toBe(0);
      expect(view(h)).toMatchObject({ s: 'reconnecting', cause: 'liveness' });
      expect(h.closes).toEqual([{ socket: 0, code: 4000, reason: 'liveness' }]);
      expect(heard).toBe(1); // the second subscriber still heard the change
      expect(errors).toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });

  it('stageRetained survives a drop and rejoin, and clears on leave', async () => {
    const h = await harness();
    await joinInto(h, 'lobby', { grid: (k) => k === 0 });
    expect(view(h)).toMatchObject({ worldReady: true, stageRetained: true });

    h.fake.close(1001, 'going away');
    await settle();
    expect(view(h)).toMatchObject({ s: 'reconnecting', worldReady: true, stageRetained: true });
    h.clock.advance(125);
    expect(view(h)).toMatchObject({ s: 'connecting', stageRetained: true });
    await settle();
    expect(view(h)).toMatchObject({ s: 'lobby', epoch: 2, worldReady: false, stageRetained: true }); // reset, board not ready yet
    h.fake.send(S.grid());
    await settle();
    expect(view(h)).toMatchObject({ worldReady: true, stageRetained: true });

    h.session.leave({ explicit: true });
    expect(view(h)).toMatchObject({ s: 'idle', worldReady: false, stageRetained: false, code: null });
    expect(h.store.get().lastLeft).toEqual({ code: CODE, at: h.clock.now(), canRejoin: true });
  });

  it('countdown and notices: text from NOTICE_TEXT, removed after noticeTtlMs or on dismiss', async () => {
    const h = await harness();
    await joinInto(h);
    h.fake.send(S.updates({ messageType: 'gameStartCountdown', seconds: 3 }));
    await settle();
    expect(view(h)).toMatchObject({ s: 'countdown', phase: 'countingDown', canReady: true });
    expect(h.store.get().countdown).toEqual({ seconds: 3, endsAt: h.clock.now() + 3000 });

    h.fake.send(S.updates({ messageType: 'gameStartCancelled', reason: 'a player left' }));
    await settle();
    expect(view(h).s).toBe('lobby');
    expect(h.store.get().countdown).toBeNull();
    expect(h.store.get().notices).toEqual([{
      id: 1, kind: 'countdown-cancelled', text: 'Countdown cancelled — a player left or changed their ready state.',
      tone: 'info', expiresAt: h.clock.now() + 6000,
    }]);
    h.clock.advance(5999);
    expect(h.store.get().notices).toHaveLength(1);
    h.clock.advance(1);
    expect(h.store.get().notices).toEqual([]);

    h.fake.send(S.updates({ messageType: 'gameStartCountdown', seconds: 3 }, { messageType: 'gameStartCancelled', reason: 'x' }));
    await settle();
    const [second] = h.store.get().notices;
    expect(second.id).toBe(2);
    h.session.dismissNotice(2);
    expect(h.store.get().notices).toEqual([]);
  });

  it('countdown then gameStarted enters play and allows directions', async () => {
    const h = await harness();
    await joinInto(h);
    h.fake.send(S.updates({ messageType: 'gameStartCountdown', seconds: 1 }, { messageType: 'gameStarted' }));
    await settle();
    expect(view(h)).toMatchObject({ s: 'playing', phase: 'playing', canReady: false });
    expect(h.session.setReady(false)).toBe(false);
    expect(h.session.sendDirection('ArrowRight')).toBe(true);
    await settle();
    expect(h.fake.received.slice(-1)[0]).toBe('{"messageType":"direction","direction":"ArrowRight"}');
  });

  it('twenty bad frames within five seconds fail with protocol', async () => {
    const h = await harness();
    await joinInto(h);
    const before = stats.net.badFrames;
    for (let i = 0; i < 20; i++) h.fake.send('{"messageType":');
    await settle(80);
    expect(stats.net.badFrames - before).toBe(20);
    expect(view(h)).toMatchObject({ s: 'failed', failure: { code: 'protocol', retryable: true } });
    expect(h.closes).toEqual([{ socket: 0, code: 1000, reason: 'protocol' }]);
  });

  it('subscribe fires after model changes only', async () => {
    const h = await harness();
    await joinInto(h);
    let heard = 0;
    const off = h.session.subscribe(() => {
      heard += 1;
    });
    h.fake.send(S.heartbeat()); // a frame in a steady lobby changes nothing in the model
    await settle();
    expect(heard).toBe(0);
    h.session.leave({ explicit: false });
    expect(heard).toBe(1);
    off();
    h.session.start({ kind: 'quick' });
    expect(heard).toBe(1);
  });

  it('dispose closes the socket and cancels every timer', async () => {
    const h = await harness();
    await joinInto(h);
    h.session.dispose();
    expect(h.closes).toEqual([{ socket: 0, code: 1000, reason: 'dispose' }]);
    expect(h.clock.pending).toBe(0);
    h.session.start({ kind: 'quick' });
    expect(h.opens).toEqual([1]);
  });
});
