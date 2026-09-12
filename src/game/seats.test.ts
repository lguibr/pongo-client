import { beforeEach, describe, expect, it } from 'vitest';
import { seatOnJoined, seatOnLeft, seatOnLobby, seatOnPaddle, seatTickSafety, seatsFromInitial } from './seats';
import type { ReducerCtx } from './reducer';
import type { EventOf, GameEvent } from './events';
import { SeatConn } from './events';
import { createWorld } from './world';
import { SnapshotRing } from './ring';
import { Playout } from './playout';
import { createEventQueue } from './queue';
import { DeriveScratch } from './derive';
import { TUNING } from '../config/tuning';
import { GRACE_MS } from '../config/constants';
import { initialItem, joinedItem, leftItem, lobbyItem, paddleItem } from './testing/synth';

let ctx: ReducerCtx;
let events: GameEvent[];

function drain(): GameEvent[] {
  const out: GameEvent[] = [];
  ctx.queue.releaseAllStale((e) => out.push(e));
  events.push(...out);
  return out;
}

function last<T>(arr: readonly T[]): T | undefined {
  return arr[arr.length - 1];
}

function seatEvents(): EventOf<'seat'>[] {
  drain();
  return events.filter((e): e is EventOf<'seat'> => e.k === 'seat');
}

beforeEach(() => {
  ctx = {
    world: createWorld(), ring: new SnapshotRing(), playout: new Playout(TUNING.playout, TUNING.hitStop),
    queue: createEventQueue(), scratch: new DeriveScratch(), nowMs: 5000, tuning: TUNING,
  };
  events = [];
});

describe('seats (5.4.7)', () => {
  it('initial state: listed players are Connected with their score; a paddle with no player is Grace, unknown', () => {
    seatsFromInitial(ctx, initialItem({ players: [[0, 7]], paddles: [0, 2] }));
    const [s0, , s2] = ctx.world.seats;
    expect([s0.conn, s0.score, s0.scoreKnown, s0.everSeen]).toEqual([SeatConn.Connected, 7, true, true]);
    expect([s2.conn, s2.scoreKnown, s2.everSeen]).toEqual([SeatConn.Grace, false, true]);
    expect(Number.isNaN(s2.graceEndsAt)).toBe(true);
    expect(ctx.world.paddles[2].present).toBe(true);
    expect(ctx.world.paddles[0].y).toBe(450);   // stored as the centre
    expect(seatEvents()).toEqual([]);
  });

  it('playerJoined on an Empty seat: Connected with the payload score and a paddle', () => {
    seatOnJoined(ctx, joinedItem(1, 4), 3);
    const s = ctx.world.seats[1];
    expect([s.conn, s.score, s.leftCount, s.everSeen]).toEqual([SeatConn.Connected, 4, 0, true]);
    expect(ctx.world.paddles[1].present).toBe(true);
    expect(seatEvents().map((e) => [e.seat, e.from, e.to, e.tick])).toEqual([[1, SeatConn.Empty, SeatConn.Connected, 3]]);
  });

  it('playerJoined on a Grace seat: Connected again, paddle refreshed', () => {
    seatOnJoined(ctx, joinedItem(2, 3), 1);
    seatOnLeft(ctx, leftItem(2), 2);
    seatOnJoined(ctx, joinedItem(2, 3, { y: 100 }), 3);
    const s = ctx.world.seats[2];
    expect([s.conn, s.leftCount]).toEqual([SeatConn.Connected, 0]);
    expect(ctx.world.paddles[2].y).toBe(175);
    expect(seatEvents().map((e) => [e.from, e.to])).toEqual([
      [SeatConn.Empty, SeatConn.Connected], [SeatConn.Connected, SeatConn.Grace], [SeatConn.Grace, SeatConn.Connected],
    ]);
  });

  it('playerJoined on a Connected seat refreshes score and paddle with no seat event', () => {
    seatsFromInitial(ctx, initialItem({ players: [[3, 2]] }));
    seatOnJoined(ctx, joinedItem(3, 5, { x: 10 }), 1);
    expect(ctx.world.seats[3].score).toBe(5);
    expect(ctx.world.paddles[3].x).toBe(85);
    const seat = seatEvents();
    expect(seat).toEqual([]);
    const scores = events.filter((e) => e.k === 'score');
    expect(scores).toHaveLength(1);
    expect(scores[0]).toMatchObject({ seat: 3, from: 2, to: 5, delta: 3, cause: 'join' });
  });

  it('the first playerLeft moves Connected to Grace with a 30 s deadline, and keeps the paddle', () => {
    seatOnJoined(ctx, joinedItem(0), 1);
    ctx.nowMs = 12_345;
    seatOnLeft(ctx, leftItem(0), 2);
    const s = ctx.world.seats[0];
    expect([s.conn, s.leftCount, s.graceEndsAt]).toEqual([SeatConn.Grace, 1, 12_345 + GRACE_MS]);
    expect(ctx.world.paddles[0].present).toBe(true);
    const ev = last(seatEvents());
    expect(ev).toMatchObject({ from: SeatConn.Connected, to: SeatConn.Grace, graceEndsAt: 12_345 + GRACE_MS });
  });

  it('the second playerLeft moves Grace to Empty and removes the paddle', () => {
    seatOnJoined(ctx, joinedItem(0), 1);
    seatOnLeft(ctx, leftItem(0), 2);
    seatOnLeft(ctx, leftItem(0), 3);
    expect(ctx.world.seats[0].conn).toBe(SeatConn.Empty);
    expect(ctx.world.paddles[0].present).toBe(false);
    expect(ctx.scratch.goneMask & 1).toBe(1);
    expect(last(seatEvents())).toMatchObject({ from: SeatConn.Grace, to: SeatConn.Empty });
  });

  it('lobbyState lists a seat: Connected with its ready flag, an event only on a change', () => {
    seatOnLobby(ctx, lobbyItem([[1, true]]), 0);
    expect([ctx.world.seats[1].conn, ctx.world.seats[1].ready]).toEqual([SeatConn.Connected, true]);
    seatOnLobby(ctx, lobbyItem([[1, false]]), 0);
    expect(ctx.world.seats[1].ready).toBe(false);
    expect(seatEvents()).toHaveLength(1);
  });

  it('lobbyState omitting a Connected seat moves it to Grace', () => {
    seatOnLobby(ctx, lobbyItem([0, 3]), 0);
    ctx.nowMs = 9000;
    seatOnLobby(ctx, lobbyItem([0]), 0);
    expect(ctx.world.seats[3].conn).toBe(SeatConn.Grace);
    expect(ctx.world.seats[3].graceEndsAt).toBe(9000 + GRACE_MS);
    expect(last(seatEvents())).toMatchObject({ seat: 3, from: SeatConn.Connected, to: SeatConn.Grace });
  });

  it('a paddle update for an Empty seat heals a missed join into Grace', () => {
    seatOnPaddle(ctx, paddleItem(2), 4);
    expect(ctx.world.seats[2].conn).toBe(SeatConn.Grace);
    expect(ctx.world.seats[2].everSeen).toBe(true);
    expect(ctx.world.paddles[2].present).toBe(true);
    expect(seatEvents()).toMatchObject([{ seat: 2, from: SeatConn.Empty, to: SeatConn.Grace }]);
  });

  it('a Grace paddle missing for 3 ticks in play is removed; a Connected one is not', () => {
    seatsFromInitial(ctx, initialItem({ players: [[0, 0]], paddles: [0, 1] }));
    for (let k = 1; k <= 2; k++) seatTickSafety(ctx, 0, k);
    expect(ctx.world.seats[1].conn).toBe(SeatConn.Grace);
    seatTickSafety(ctx, 0b10, 3);   // an update resets the count
    seatOnPaddle(ctx, paddleItem(1), 3);
    for (let k = 4; k <= 6; k++) seatTickSafety(ctx, 0, k);
    expect(ctx.world.seats[1].conn).toBe(SeatConn.Empty);
    expect(ctx.world.paddles[1].present).toBe(false);
    expect(ctx.world.seats[0].conn).toBe(SeatConn.Connected);
    expect(seatEvents()).toMatchObject([{ seat: 1, from: SeatConn.Grace, to: SeatConn.Empty, tick: 6 }]);
  });
});
