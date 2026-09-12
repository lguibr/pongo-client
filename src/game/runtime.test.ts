import { describe, expect, it } from 'vitest';
import { createGameRuntime } from './runtime';
import type { GameRuntime } from './types';
import { BALL_STRIDE, BO, BallVis, PADDLE_STRIDE, PO } from './types';
import type { GameEvent, IngestEventCtx, Seat } from './events';
import { SeatConn } from './events';
import { createStore } from '../lib/store';
import { initialAppState } from '../state/appStore';
import type { AppStore } from '../state/appStore';
import { FakeClock } from '../test/fakes/FakeClock';
import { forceGc } from '../test/gc';
import { decode } from '../net/decode';
import { CELLS, CellType, PADDLE_STEP } from '../config/constants';
import type { BatchItem, GameOver } from '../protocol/messages';
import {
  ballItem, batch, gridItem, initialItem, joinedItem, leftItem, lobbyItem, paddleBlock, paddleItem, removedItem, scoreItem,
  spawnedItem, startedItem, synthSession, wireBall, wirePaddle,
} from './testing/synth';
import { toWire } from './orientation';
import { TUNING } from '../config/tuning';
import type { Tuning } from '../config/tuning';

const FRAME = 1000 / 60;

interface Rig { rt: GameRuntime; store: AppStore; clock: FakeClock; fired: GameEvent[]; frame(n?: number): void }

function rig(epoch = 1, me: Seat | null = 0, tuning?: Tuning): Rig {
  const store = createStore(initialAppState());
  const clock = new FakeClock(10_000);
  const rt = createGameRuntime({ store, now: clock.now, timers: clock, tuning });
  const fired: GameEvent[] = [];
  rt.reset(epoch, me);
  return {
    rt, store, clock, fired,
    frame(n = 1) {
      for (let i = 0; i < n; i++) {
        clock.advance(FRAME);
        rt.frame(FRAME, clock.now(), (e) => fired.push(e));
      }
    },
  };
}

function ingest(r: Rig, items: BatchItem[]): void {
  r.rt.ingest(batch(...items), r.clock.now());
}

function ball(r: Rig, id: number): { x: number; y: number; vis: number } {
  const slot = r.rt.slotOf(id);
  const o = slot * BALL_STRIDE;
  return { x: r.rt.render.ball[o + BO.X] + 450, y: 450 - r.rt.render.ball[o + BO.Y], vis: r.rt.render.ball[o + BO.VIS] };
}

const present = (r: Rig, seat: Seat): number => r.rt.render.paddle[seat * PADDLE_STRIDE + PO.PRESENT];

function heapUsed(): number {
  const proc = (globalThis as { process?: { memoryUsage(): { heapUsed: number } } }).process;
  if (proc === undefined) throw new Error('process.memoryUsage is not available');
  return proc.memoryUsage().heapUsed;
}

/** Replays a four-seat synthetic session with bricks through the rig at its recorded arrival times, running 60 Hz
 *  frames in between. Returns the time of the last frame. */
function playSynth(r: Rig, seed: number, seconds: number, fire: (e: GameEvent) => void): number {
  const { frames } = synthSession({ seed, seats: [0, 1, 2, 3], bricks: true, seconds });
  const t0 = r.clock.now();
  const base = frames[0].t;
  let t = t0;
  for (const f of frames) {
    if (f.dir !== 'in') continue;
    const d = decode(f.d);
    if (!d.ok) continue;
    const at = t0 + f.t - base;
    while (t + FRAME <= at) {
      t += FRAME;
      r.clock.setTime(t);
      r.rt.frame(FRAME, t, fire);
    }
    r.clock.setTime(Math.max(r.clock.now(), at));
    if (d.msg.messageType === 'initialPlayersAndBallsState' || d.msg.messageType === 'gameUpdates') r.rt.ingest(d.msg, at);
  }
  return t;
}

/** A 1-brick board, admitted in the lobby. */
function lobby(r: Rig, seats: Seat[], life = (row: number, col: number): number => (row === 6 && col === 6 ? 3 : 0)): void {
  r.rt.ingest(initialItem({ players: seats.map((s) => [s, 0] as [Seat, number]), balls: [wireBall(1, 450, 700, 5, 5, { ownerIndex: seats[0] })] }), r.clock.now());
  ingest(r, [gridItem(life)]);
}

describe('createGameRuntime', () => {
  it('renders a paddle and ball that join in a headless lobby batch at once', () => {
    const r = rig();
    lobby(r, [0]);
    r.frame();
    expect(present(r, 1)).toBe(0);
    ingest(r, [joinedItem(1), spawnedItem(wireBall(2, 450, 200, 4, 6, { ownerIndex: 1 })), lobbyItem([0, 1])]);
    r.frame();
    expect(present(r, 1)).toBe(1);
    expect(ball(r, 2)).toMatchObject({ x: 450, y: 200, vis: BallVis.Live });
    expect(r.rt.world.seats[1].conn).toBe(SeatConn.Connected);
  });

  it('renders all four paddles on the first play frame', () => {
    const r = rig();
    lobby(r, [0, 1, 2, 3]);
    r.frame(3);
    ingest(r, [startedItem()]);
    r.frame();
    ingest(r, [...paddleBlock([0, 1, 2, 3]), ballItem(1, 455, 705, 5, 5)]);
    r.frame();
    expect(r.rt.playoutStats.idle).toBe(false);
    for (const s of [0, 1, 2, 3] as Seat[]) expect(present(r, s)).toBe(1);
    expect(ball(r, 1).vis).toBe(BallVis.Live);
  });

  it('shows every ball Live with a non-negative age on the first play frames, while display time is before tick 0', () => {
    const r = rig();
    r.rt.ingest(initialItem({ players: [[0, 0]], balls: [wireBall(1, 450, 700, 5, 5, { ownerIndex: 0 }), wireBall(2, 300, 300, -4, 3)] }), r.clock.now());
    ingest(r, [gridItem((row, col) => (row === 6 && col === 6 ? 3 : 0))]);
    // The first batch closes tick 1 and anchors the clock; render time snaps to 25 + since - 40 ms, below tick 0
    // (the oldest row) for the first 15 ms after the arrival.
    const t0 = r.clock.now();
    ingest(r, [...paddleBlock([0]), ballItem(1, 455, 705, 5, 5), ballItem(2, 296, 303, -4, 3)]);
    let prev = t0;
    for (const at of [t0 + 2, t0 + 10, t0 + 14]) {
      r.clock.setTime(at);
      r.rt.frame(at - prev, at, (e) => r.fired.push(e));
      prev = at;
      expect(r.rt.render.displayTick).toBeLessThan(0);
      for (const id of [1, 2]) {
        const o = r.rt.slotOf(id) * BALL_STRIDE;
        expect(r.rt.render.ball[o + BO.VIS]).toBe(BallVis.Live);
        expect(r.rt.render.ball[o + BO.AGE_S]).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('changes the display brick arrays only when the brick event is released', () => {
    const r = rig();
    lobby(r, [0]);
    const cell = 6 * 18 + 6;
    expect(r.rt.render.brickLife[cell]).toBe(3);
    expect(r.rt.render.ready).toBe(true);
    // 40 Hz arrivals and 60 Hz frames; the batch that closes tick 20 carries the damaged grid.
    const damage = 20;
    let nextArrival = r.clock.now();
    let k = 0;
    let released = -1;
    for (let i = 0; i < 200 && released < 0; i++) {
      while (r.clock.now() >= nextArrival) {
        k++;
        const items: BatchItem[] = [...paddleBlock([0]), ballItem(1, 450 + k, 700, 1, 1)];
        if (k === damage) items.push(gridItem((row, col) => (row === 6 && col === 6 ? 2 : 0)));
        ingest(r, items);
        if (k === damage) {
          expect(r.rt.world.brickLife[cell]).toBe(2);
          expect(r.rt.render.brickLife[cell]).toBe(3);   // not yet: display time is behind the damage tick
        }
        nextArrival += 25;
      }
      r.frame();
      if (r.rt.render.brickLife[cell] === 2) released = r.rt.render.displayTick;
    }
    expect(released).toBeGreaterThanOrEqual(damage);
    expect(released).toBeLessThan(damage + 1);   // on the first frame whose display time reached the tick
    expect(r.rt.render.brickFade[cell]).toBe(0);
    expect(r.fired.some((e) => e.k === 'brickDamaged' && !e.stale)).toBe(true);
    // Hidden: released stale at once, and the destroyed brick fades instead of shattering.
    r.rt.setHeadless(true);
    ingest(r, [...paddleBlock([0]), ballItem(1, 481, 701, 1, 1), gridItem(() => 0)]);
    expect(r.rt.render.brickType[cell]).toBe(CellType.Empty);
    expect(r.rt.render.brickFade[cell]).toBe(1);
  });

  it('releases the queue stale from ingest when no frame has run for 250 ms, and the bridge publishes the score', () => {
    const r = rig(1, 0);
    lobby(r, [0]);
    ingest(r, [...paddleBlock([0]), ballItem(1, 455, 705, 5, 5)]);
    r.frame();
    r.clock.advance(20);
    ingest(r, [scoreItem(0, 4), ...paddleBlock([0]), ballItem(1, 460, 710, 5, 5)]);
    expect(r.rt.queue.pendingScoreDelta[0]).toBe(4);   // frames are running: the pop has not flown yet
    r.clock.advance(150);
    expect(r.store.get().seats[0].score).toBe(0);
    r.clock.advance(300);   // no frame for 470 ms
    ingest(r, [...paddleBlock([0]), ballItem(1, 465, 715, 5, 5)]);
    expect(r.rt.queue.size).toBe(0);
    expect(r.rt.queue.pendingScoreDelta[0]).toBe(0);
    r.clock.advance(150);
    expect(r.store.get().seats[0].score).toBe(4);
  });

  it('a brick destroy ingested after 250 ms without a frame is released stale at once and fades', () => {
    const cell = 6 * 18 + 6;
    const stalled = rig(1, 0);
    const live = rig(1, 0);
    for (const r of [stalled, live]) {
      lobby(r, [0]);
      ingest(r, [...paddleBlock([0]), ballItem(1, 455, 705, 5, 5)]);
      r.frame();
    }
    // Frames are running (the last one 20 ms ago): the destroy waits for display time.
    live.clock.advance(20);
    ingest(live, [...paddleBlock([0]), ballItem(1, 460, 710, 5, 5), gridItem(() => 0)]);
    expect(live.rt.render.brickType[cell]).toBe(CellType.Brick);
    expect(live.rt.queue.size).toBeGreaterThan(0);
    // No frame for 300 ms (a hidden tab before visibilitychange): released stale by ingest itself.
    stalled.clock.advance(300);
    ingest(stalled, [...paddleBlock([0]), ballItem(1, 460, 710, 5, 5), gridItem(() => 0)]);
    expect(stalled.rt.queue.size).toBe(0);
    expect([stalled.rt.render.brickType[cell], stalled.rt.render.brickLife[cell], stalled.rt.render.brickFade[cell]]).toEqual([CellType.Empty, 0, 1]);
  });

  it('display brick arrays equal the World once the queue is empty (risk 16)', () => {
    const r = rig(1, 0);
    const released: GameEvent[] = [];
    const fire = (e: GameEvent): void => {
      released.push(e);
    };
    let t = playSynth(r, 23, 20, fire);
    for (let i = 0; i < 600 && r.rt.queue.size > 0; i++) {
      t += FRAME;
      r.clock.setTime(t);
      r.rt.frame(FRAME, t, fire);
    }
    expect(r.rt.queue.size).toBe(0);
    const w = r.rt.world;
    expect(w.bricksAlive).toBeLessThan(w.bricksAtStart);   // the board really changed during play
    expect(released.filter((e) => e.k === 'brickDestroyed' && !e.stale).length).toBeGreaterThan(0);
    expect(released.some((e) => e.k === 'brickDamaged')).toBe(true);
    let differing = 0;
    for (let i = 0; i < CELLS; i++) {
      if (r.rt.render.brickLife[i] !== w.brickLife[i] || r.rt.render.brickType[i] !== w.brickType[i]) differing++;
    }
    expect(differing).toBe(0);
  });

  it('marks the cold bridge at ingest only for seat, score and lobby changes', () => {
    const r = rig(1, 0);
    lobby(r, [0, 1]);
    r.clock.advance(200);   // the admission publish fires
    expect(r.clock.pending).toBe(0);
    ingest(r, [...paddleBlock([0, 1]), ballItem(1, 455, 705, 5, 5)]);
    expect(r.clock.pending).toBe(0);   // positions only: nothing a SeatView shows changed
    ingest(r, [lobbyItem([[0, true], 1]), ...paddleBlock([0, 1]), ballItem(1, 460, 710, 5, 5)]);
    expect(r.clock.pending).toBe(1);   // ready flags change with no event
    r.clock.advance(200);
    expect(r.store.get().seats[0].ready).toBe(true);
    ingest(r, [scoreItem(1, 2), ...paddleBlock([0, 1]), ballItem(1, 465, 715, 5, 5)]);
    expect(r.clock.pending).toBe(1);
    r.clock.advance(200);
    expect(r.store.get().seats[1].score).toBe(2);
    ingest(r, [leftItem(1), ...paddleBlock([0, 1]), ballItem(1, 470, 720, 5, 5)]);
    expect(r.clock.pending).toBe(1);
    r.clock.advance(200);
    expect(r.store.get().seats[1].conn).toBe(SeatConn.Grace);
  });

  it('frees removed slots with no frames at all, so new balls still get slots after 63 removals', () => {
    const r = rig();
    lobby(r, [0]);
    const ids = Array.from({ length: 63 }, (_, i) => 100 + i);
    ingest(r, [
      ...ids.map((id) => spawnedItem(wireBall(id, 300, 300, 5, 5, { isPermanent: false, ownerIndex: 0 }))),
      ...paddleBlock([0]), ballItem(1, 450, 700, 1, 1), ...ids.map((id) => ballItem(id, 305, 305, 5, 5)),
    ]);
    for (const id of ids) expect(r.rt.slotOf(id)).toBeGreaterThanOrEqual(0);   // every slot is now in use
    r.clock.advance(25);
    ingest(r, [...ids.map((id) => removedItem(id)), ...paddleBlock([0]), ballItem(1, 450, 700, 1, 1)]);
    for (let k = 0; k < 64; k++) {
      r.clock.advance(25);
      ingest(r, [...paddleBlock([0]), ballItem(1, 450, 700, 1, 1)]);
    }
    const fresh = Array.from({ length: 20 }, (_, i) => 500 + i);
    ingest(r, [
      ...fresh.map((id) => spawnedItem(wireBall(id, 200, 200, 5, 5, { isPermanent: false, ownerIndex: 0 }))),
      ...paddleBlock([0]), ballItem(1, 450, 700, 1, 1), ...fresh.map((id) => ballItem(id, 205, 205, 5, 5)),
    ]);
    for (const id of fresh) expect(r.rt.slotOf(id)).toBeGreaterThanOrEqual(0);
  });

  it('ended() queues gameOver and tells the ingest listeners, flagging a hidden page', () => {
    const r = rig();
    lobby(r, [0]);
    const seen: [readonly GameEvent[], IngestEventCtx][] = [];
    r.rt.onIngestEvents((es, c) => seen.push([es, c]));
    r.rt.setHeadless(true);
    r.rt.ended(0, false);
    expect(seen).toHaveLength(1);
    expect(seen[0][0]).toMatchObject([{ k: 'gameOver', winner: 0, derived: false, tick: -1 }]);
    expect(seen[0][1].headless).toBe(true);
    r.rt.setHeadless(false);
    r.rt.ended(-1, true);
    expect(seen[1][1].headless).toBe(false);
  });

  it('reset keeps render.frozen and the display bricks until the new epoch first grid, then fades what vanished', () => {
    const r = rig(1, 0);
    lobby(r, [0], (row, col) => (row === 4 && (col === 4 || col === 5) ? 2 : 0));
    r.frame();
    r.rt.freeze(true);
    expect(r.rt.render.frozen).toBe(true);
    r.rt.reset(2, 0);
    expect(r.rt.render.ready).toBe(false);
    expect(r.rt.render.frozen).toBe(true);
    expect(r.rt.render.brickLife[4 * 18 + 4]).toBe(2);
    r.rt.ingest(initialItem({ players: [[0, 0]] }), r.clock.now());
    expect(r.rt.render.frozen).toBe(true);
    const res = r.rt.ingest(batch(gridItem((row, col) => (row === 4 && col === 5 ? 1 : 0))), r.clock.now());
    expect(res.boardReady).toBe(true);
    expect(r.rt.render.ready).toBe(true);
    expect(r.rt.render.frozen).toBe(false);
    expect([r.rt.render.brickType[4 * 18 + 4], r.rt.render.brickFade[4 * 18 + 4]]).toEqual([CellType.Empty, 1]);
    expect([r.rt.render.brickLife[4 * 18 + 5], r.rt.render.brickFade[4 * 18 + 5]]).toEqual([1, 0]);
  });

  it('summarises the world, including grace seats other than mine', () => {
    const r = rig(1, 0);
    expect(r.rt.summary()).toMatchObject({ ready: false, bricksAlive: null, bricksAtStart: null });
    lobby(r, [0, 1, 2]);
    ingest(r, [leftItem(1), leftItem(0), lobbyItem([2])]);
    expect(r.rt.summary()).toEqual({ ready: true, bricksAlive: 1, bricksAtStart: 1, tick: 0, graceSeats: 1 });
  });

  it('builds results from gameOver or derives them', () => {
    const r = rig(1, 0);
    lobby(r, [0, 1]);
    const msg: GameOver = { messageType: 'gameOver', winnerIndex: 1, finalScores: [2, 5, 0, 0], reason: 'All bricks destroyed', roomPID: 'x' };
    expect(r.rt.results(msg, msg.reason)).toMatchObject({ winner: 1, derived: false, rows: [{ index: 1, winner: true }, { index: 0, isMe: true }] });
    expect(r.rt.results(null, 'All bricks destroyed')).toMatchObject({ winner: -1, derived: true });
  });

  it('leads my paddle toward the intent when the lead is on, and not otherwise', () => {
    const r = rig(1, 3);
    lobby(r, [3]);
    ingest(r, [...paddleBlock([3]), ballItem(1, 455, 705, 5, 5)]);
    r.rt.setIntentSource(() => 1);
    r.frame(10);
    expect(r.rt.render.paddleLead[3]).toBe(0);   // off by default (D08)
    r.rt.setOwnLead(true);
    r.frame(10);
    expect(r.rt.render.paddleLead[3]).toBeGreaterThan(0);   // seat 3: visual right is +x
    expect(r.rt.render.paddleLead[3]).toBeLessThanOrEqual(24);
    r.rt.setOwnLead(false);
    expect(r.rt.render.paddleLead[3]).toBe(0);
  });

  it('keeps a vertical seat lead in board y, pointing where the server moves the paddle for that key', () => {
    const r = rig(1, 0);
    lobby(r, [0]);
    // Visual -1 on seat 0 is the wire's ArrowRight (swap), which Paddle.Move turns into canvas +y.
    expect(toWire(0, -1)).toBe('ArrowRight');
    const y0 = wirePaddle(0).y;
    const cy: number[] = [];
    for (let k = 1; k <= 6; k++) {
      ingest(r, [paddleItem(0, { y: y0 + PADDLE_STEP * k, vy: PADDLE_STEP, isMoving: true }), ballItem(1, 450, 700, 1, 1)]);
      r.frame();
      r.clock.advance(25 - FRAME);
      cy.push(r.rt.render.paddle[0 * PADDLE_STRIDE + PO.CY]);
    }
    const serverStep = Math.sign(cy[cy.length - 1] - cy[0]);
    expect(serverStep).toBe(-1);   // canvas +y is board -y
    // The server paddle now stands still while the same key is held: the lead points the same way, in PO.CY units.
    r.rt.setOwnLead(true);
    r.rt.setIntentSource(() => -1);
    for (let k = 0; k < 10; k++) {
      ingest(r, [paddleItem(0, { y: y0 + PADDLE_STEP * 6 }), ballItem(1, 450, 700, 1, 1)]);
      r.frame();
      r.clock.advance(25 - FRAME);
    }
    expect(Math.sign(r.rt.render.paddleLead[0])).toBe(serverStep);
    expect([r.rt.render.paddleLead[1], r.rt.render.paddleLead[2], r.rt.render.paddleLead[3]]).toEqual([0, 0, 0]);
  });

  it('estimates display time for audio scheduling', () => {
    const r = rig();
    lobby(r, [0]);
    expect(r.rt.displayMs(r.clock.now())).toBe(0);
    for (let k = 1; k <= 12; k++) {
      ingest(r, [...paddleBlock([0]), ballItem(1, 450 + k, 700, 1, 1)]);
      r.frame();
      r.clock.advance(25 - FRAME);
    }
    const est = r.rt.displayMs(r.clock.now());
    expect(est).toBeGreaterThan(12 * 25 - 130);
    expect(est).toBeLessThanOrEqual(12 * 25 + 50);
  });

  it('holds the display estimate through a hit-stop and caps it at the newest sample while unstable', () => {
    const r = rig();
    lobby(r, [0]);
    for (let k = 1; k <= 12; k++) {
      ingest(r, [...paddleBlock([0]), ballItem(1, 450 + k, 700, 1, 1)]);
      r.frame();
      r.clock.advance(25 - FRAME);
    }
    r.rt.hitStop(90, 'lastBrick');
    r.frame();
    expect(r.rt.hitStopActive).toBe(true);
    const held = r.rt.render.displayMs;
    const left = 90 - FRAME;   // one frame of the stop has passed
    expect(r.rt.displayMs(r.clock.now() + 30)).toBe(held);   // display time stands still for the rest of the stop
    expect(r.rt.displayMs(r.clock.now() + 100)).toBeCloseTo(held + 100 - left, 6);
    r.rt.setUnstable(true);
    r.frame();
    const latest = r.rt.world.tick * 25;
    expect(r.rt.displayMs(r.clock.now() + 200)).toBeLessThanOrEqual(latest);
    r.rt.setUnstable(false);
    expect(r.rt.displayMs(r.clock.now() + 200)).toBeGreaterThan(latest);   // the extrapolation cap is back
  });

  it('does not snap the clock on freeze(false); only a reset or a return from hidden does', () => {
    const r = rig();
    lobby(r, [0]);
    for (let k = 1; k <= 20; k++) {
      ingest(r, [...paddleBlock([0]), ballItem(1, 450 + k, 700, 1, 1)]);
      r.frame();
      r.clock.advance(25 - FRAME);
    }
    const snaps = r.rt.playoutStats.snaps;
    r.rt.freeze(true);
    expect(r.rt.render.frozen).toBe(true);
    r.rt.freeze(false);
    r.frame();
    expect(r.rt.render.frozen).toBe(false);
    expect(r.rt.playoutStats.snaps).toBe(snaps);
    r.rt.setHeadless(true);
    r.rt.setHeadless(false);
    r.frame();
    expect(r.rt.playoutStats.snaps).toBe(snaps + 1);
  });

  it('frame() allocates nothing, idle or pinned at a fractional display tick: < 12 KB per 1 000 frames, none retained', () => {
    expect(typeof (globalThis as { gc?: unknown }).gc).toBe('function');
    let fired = 0;
    const fire = (): void => {
      fired++;
    };
    /** Timestamps boxed up front in a generic-elements array (the leading string), so passing one to frame()
     *  boxes nothing: the heap delta is frame()'s own. */
    const stamps = (from: number, n: number): unknown[] => {
      const out: unknown[] = ['boxed'];
      for (let i = 0; i < n; i++) out.push(from + (i + 1) * FRAME);
      return out;
    };
    const run = (r: Rig, list: unknown[]): number => {
      for (let i = 1; i < list.length; i++) r.rt.frame(FRAME, list[i] as number, fire);
      return list[list.length - 1] as number;
    };
    const measure = (r: Rig, from: number): { windows: number[]; retained: number } => {
      // Warm up long enough for the frame path to be optimised: after 2 000 frames the engine still allocated
      // about 700 B a frame in its baseline tiers, which says nothing about this code.
      let t = run(r, stamps(from, 20_000));
      const lists = [stamps(t, 1000), stamps(t + 1000 * FRAME, 1000), stamps(t + 2000 * FRAME, 1000)];
      const tail = stamps(t + 3000 * FRAME, 7000);
      forceGc();
      const h0 = heapUsed();
      // Garbage is measured with no collection in between, so a frame() that allocates and drops even one box
      // per call (12 B, so 12 000 B per window) fails here although a collection would hide it from `retained`.
      const windows: number[] = [];
      for (const list of lists) {
        const before = heapUsed();
        t = run(r, list);
        windows.push(heapUsed() - before);
      }
      run(r, tail);
      forceGc();
      return { windows, retained: heapUsed() - h0 };
    };

    // Idle: the session is over and render time holds on the newest sample.
    const idle = rig(1, 0);
    const idleEnd = playSynth(idle, 17, 6, fire);
    idle.rt.setOwnLead(true);
    idle.rt.setIntentSource(() => -1);
    expect(fired).toBeGreaterThan(20);   // the drain path ran with real events during the session
    expect(idle.rt.render.ballHigh).toBeGreaterThan(2);
    const a = measure(idle, idleEnd);
    expect(idle.rt.playoutStats.idle).toBe(true);

    // In play: never idle, and render time capped 13 ms behind the newest sample, so every frame interpolates
    // between two rows at a fractional tick, as it does while batches stream in.
    const pinned = rig(1, 0, { ...TUNING, playout: { ...TUNING.playout, idleMs: 1e12, maxExtrapMs: -13 } });
    const pinnedEnd = playSynth(pinned, 17, 6, fire);
    pinned.rt.setOwnLead(true);
    pinned.rt.setIntentSource(() => -1);
    const b = measure(pinned, pinnedEnd);
    expect(pinned.rt.playoutStats.idle).toBe(false);
    expect(Number.isInteger(pinned.rt.render.displayTick)).toBe(false);
    expect(pinned.rt.render.displayTick).toBeLessThan(pinned.rt.world.tick);
    expect(pinned.rt.render.displayTick).toBeGreaterThan(pinned.rt.world.tick - 1);

    console.info(`[alloc] per 1 000 warm frames before collection: idle ${a.windows.join(', ')} B, pinned ${b.windows.join(', ')} B; `
      + `10 000 frames retained: idle ${a.retained} B, pinned ${b.retained} B`);
    for (const m of [a, b]) {
      expect(Math.max(...m.windows)).toBeLessThan(12 * 1024);
      expect(m.retained).toBeLessThan(64 * 1024);
    }
  });
});
