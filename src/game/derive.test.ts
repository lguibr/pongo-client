import { describe, expect, it } from 'vitest';
import { createGameRuntime } from './runtime';
import type { GameRuntime } from './types';
import type { EventOf, GameEvent, GameEventKind, Seat } from './events';
import { IMMEDIATE, SeatConn } from './events';
import { createStore } from '../lib/store';
import { initialAppState } from '../state/appStore';
import { FakeClock } from '../test/fakes/FakeClock';
import type { BallPositionUpdate, BatchItem, WireBall } from '../protocol/messages';
import type { OracleTruth } from './testing/oracle';
import { ServerSim } from './testing/oracle';
import {
  ballItem, batch, cancelledItem, countdownItem, gridItem, initialItem, joinedItem, leftItem, lobbyItem, ownerItem,
  paddleBlock, removedItem, scoreItem, spawnedItem, startedItem, wireBall,
} from './testing/synth';
import { rMax, rMin } from './radius';

// ---------------------------------------------------------------------------------------------- harnesses

interface Base {
  rt: GameRuntime; events: GameEvent[];
  of<K extends GameEventKind>(k: K): EventOf<K>[];
}

function runtime(me: Seat | null): { rt: GameRuntime; clock: FakeClock; events: GameEvent[] } {
  const store = createStore(initialAppState());
  const clock = new FakeClock(1000);
  const rt = createGameRuntime({ store, now: clock.now, timers: clock });
  const events: GameEvent[] = [];
  rt.onIngestEvents((es) => {
    events.push(...es);
  });
  rt.reset(1, me);
  return { rt, clock, events };
}

function ofKind(events: GameEvent[]) {
  return <K extends GameEventKind>(k: K): EventOf<K>[] => events.filter((e): e is EventOf<K> => e.k === k);
}

/** A ServerSim room replayed through the runtime, one batch per tick. */
function simRoom(seats: Seat[], setup: (sim: ServerSim) => void, opts: { me?: Seat | null } = {}): Base & { sim: ServerSim; truth: OracleTruth[]; step(n?: number): void } {
  const sim = new ServerSim({ seed: 1, seats }, { spawnBalls: false });
  setup(sim);
  const { rt, clock, events } = runtime(opts.me ?? seats[0] ?? null);
  rt.ingest(sim.initialState(), clock.now());
  sim.gridDirty = false;
  rt.ingest(batch(sim.grid()), clock.now());
  events.length = 0;
  const truth: OracleTruth[] = [];
  return {
    rt, sim, events, truth, of: ofKind(events),
    step(n = 1) {
      for (let i = 0; i < n; i++) {
        const s = sim.step();
        truth.push(...s.truth);
        const items = [...s.items];
        if (sim.gridDirty) {
          items.push(sim.grid());
          sim.gridDirty = false;
        }
        clock.advance(25);
        rt.ingest(batch(...items), clock.now());
      }
    },
  };
}

/** Hand-written ticks: pre items, the paddle block of `seats`, then the given ball rows (and optionally the grid). */
function room(opts: { seats: Seat[]; players?: [Seat, number][]; balls?: WireBall[]; life?: (r: number, c: number) => number; me?: Seat | null }):
  Base & {
    setLife(r: number, c: number, l: number): void;
    tick(pre: BatchItem[], balls: BallPositionUpdate[], grid?: boolean): void;
    /** One batch of exactly these items (several ticks, or items after the positions). */
    raw(items: BatchItem[]): void;
  } {
  const { rt, clock, events } = runtime(opts.me ?? null);
  const lives = new Int32Array(18 * 18);
  for (let r = 0; r < 18; r++) for (let c = 0; c < 18; c++) lives[r * 18 + c] = opts.life?.(r, c) ?? 0;
  rt.ingest(initialItem({ players: opts.players ?? opts.seats.map((s) => [s, 0] as [Seat, number]), paddles: opts.seats, balls: opts.balls }), clock.now());
  rt.ingest(batch(gridItem((r, c) => lives[r * 18 + c])), clock.now());
  events.length = 0;
  return {
    rt, events, of: ofKind(events),
    setLife(r, c, l) {
      lives[r * 18 + c] = l;
    },
    tick(pre, balls, grid = false) {
      clock.advance(25);
      const items: BatchItem[] = [...pre, ...paddleBlock(opts.seats), ...balls];
      if (grid) items.push(gridItem((r, c) => lives[r * 18 + c]));
      rt.ingest(batch(...items), clock.now());
    },
    raw(items) {
      clock.advance(25);
      rt.ingest(batch(...items), clock.now());
    },
  };
}

const cellOf = (r: number, c: number): number => r * 18 + c;

// ---------------------------------------------------------------------------------------------- R1, R2

describe('R1 paddleHit and R2 ownerChanged', () => {
  it('a paddle contact gives paddleHit at the contact row and an owner change', () => {
    const t = simRoom([3], (sim) => sim.addBall({ id: 1, x: 460, y: 800, vx: 1, vy: 7, ownerIndex: -1 }));
    t.step(12);
    const truth = t.truth.filter((x) => x.kind === 'paddle');
    expect(truth).toEqual([{ tick: 10, ball: 1, kind: 'paddle', seat: 3 }]);
    const [hit] = t.of('paddleHit');
    expect(hit).toMatchObject({ tick: 10, ball: 1, seat: 3, prevOwner: -1, conf: 1, x: 470, y: 870 });
    expect(hit.u).toBeCloseTo((470 - 375) / 150, 6);
    // rel 20 of 75 -> norm 0.2933, angle 0.329 rad; (0.3232, -0.9463) x sqrt(50) -> trunc (2, -6).
    expect(hit.speed).toBeCloseTo(Math.hypot(2, -6), 6);
    expect(t.of('ownerChanged')).toMatchObject([{ tick: 10, ball: 1, from: -1, to: 3, cause: 'paddle' }]);
  });

  it('a second contact by the same owner is a paddleHit with no owner change', () => {
    const r = room({ seats: [3], balls: [wireBall(1, 450, 860, 1, 7, { ownerIndex: 3 })] });
    r.tick([ownerItem(1, 3)], [ballItem(1, 451, 867, 1, -6)]);
    expect(r.of('paddleHit')).toHaveLength(1);
    expect(r.of('ownerChanged')).toEqual([]);
  });

  it('an own goal releases the ball (cause ownGoal, backed by the goal on the owner wall)', () => {
    const t = simRoom([0], (sim) => sim.addBall({ id: 4, x: 885, y: 100, vx: 8, vy: 3, ownerIndex: 0 }));
    t.step();
    expect(t.of('ownerChanged')).toMatchObject([{ ball: 4, from: 0, to: -1, cause: 'ownGoal', conf: 1 }]);
    expect(t.of('goal')).toMatchObject([{ ball: 4, wall: 0, scorer: -1 }]);
  });

  it('a release with neither a goal on the owner wall nor a second playerLeft falls back to ownGoal at conf 0.5', () => {
    const r = room({ seats: [3], balls: [wireBall(1, 450, 450, 5, 5, { ownerIndex: 3 })] });
    r.tick([ownerItem(1, -1)], [ballItem(1, 455, 455, 5, 5)]);
    expect(r.of('goal')).toEqual([]);
    expect(r.of('ownerChanged')).toMatchObject([{ ball: 1, from: 3, to: -1, cause: 'ownGoal', conf: 0.5 }]);
  });

  it('a grace expiry releases permanent balls and removes temporary ones (cause released)', () => {
    const t = simRoom([1, 3], (sim) => {
      sim.addBall({ id: 1, x: 450, y: 450, vx: 1, vy: 1, ownerIndex: 1 });
      sim.addBall({ id: 2, x: 300, y: 300, vx: 1, vy: 1, ownerIndex: 1, isPermanent: false });
    });
    t.step(2);
    t.sim.disconnect(1);
    t.step();
    expect(t.of('seat')).toMatchObject([{ seat: 1, from: SeatConn.Connected, to: SeatConn.Grace }]);
    t.sim.expireGrace(1);
    t.step();
    expect(t.of('seat')[1]).toMatchObject({ seat: 1, from: SeatConn.Grace, to: SeatConn.Empty });
    expect(t.of('ownerChanged')).toMatchObject([{ ball: 1, from: 1, to: -1, cause: 'released' }]);
    expect(t.of('ballRemoved')).toMatchObject([{ ball: 2, cause: 'released', owner: 1 }]);
  });
});

// ---------------------------------------------------------------------------------------------- R3, R10

describe('R3 goal and R10 score', () => {
  it('a goal on a connected wall: conceder -1, scorer +1 when it is the ball owner', () => {
    const t = simRoom([0, 3], (sim) => sim.addBall({ id: 1, x: 885, y: 100, vx: 8, vy: 3, ownerIndex: 3 }));
    t.step();
    const [g] = t.of('goal');
    expect(g).toMatchObject({ tick: 1, ball: 1, wall: 0, scorer: 3, repeat: 0, conf: 0.9, x: 900, y: 103 });
    expect(g.u).toBeCloseTo(103 / 900, 6);
    expect(t.of('score').map((e) => [e.seat, e.from, e.to, e.delta, e.cause])).toEqual([[0, 0, -1, -1, 'conceded'], [3, 0, 1, 1, 'scored']]);
    expect(t.of('wallBounce')).toEqual([]);   // the goal covers the reflection
  });

  it('prefers the overlapping ball whose tick-start owner is the +1 that follows', () => {
    const r = room({ seats: [0, 1, 3], balls: [wireBall(1, 890, 200, 5, 1, { ownerIndex: 1 }), wireBall(2, 890, 600, 5, 1, { ownerIndex: 3 })] });
    r.tick([scoreItem(0, -1), scoreItem(3, 1)], [ballItem(1, 895, 201, -5, 1), ballItem(2, 895, 601, -5, 1)]);
    expect(r.of('goal')).toMatchObject([{ ball: 2, scorer: 3 }]);
    expect(r.of('wallBounce')).toMatchObject([{ ball: 1, wall: 0 }]);
  });

  it('never reads a +1 that is not the ball tick-start owner as the scorer', () => {
    // Ball 1 (owner 1 at tick start) scores on wall 0; the +1 right after it is seat 3's level-1 brick.
    const r = room({ seats: [0, 1, 3], balls: [wireBall(1, 890, 200, 5, 1, { ownerIndex: 1 })] });
    r.tick([scoreItem(0, -1), scoreItem(3, 1)], [ballItem(1, 895, 201, -5, 1)]);
    expect(r.of('goal')).toMatchObject([{ ball: 1, scorer: -1 }]);
    expect(r.of('score').map((e) => e.cause)).toEqual(['conceded', 'brick']);
  });

  it('takes the scorer from the tick-start owner, not from a paddle message later in the same pre', () => {
    // Owner 3 at tick start scores; seat 1's paddle then takes the ball in the same tick.
    const a = room({ seats: [0, 1, 3], balls: [wireBall(1, 890, 200, 5, 1, { ownerIndex: 3 })] });
    a.tick([scoreItem(0, -1), scoreItem(3, 1), ownerItem(1, 1)], [ballItem(1, 895, 201, -5, 1)]);
    expect(a.of('goal')).toMatchObject([{ ball: 1, wall: 0, scorer: 3 }]);
    expect(a.of('score').map((e) => e.cause)).toEqual(['conceded', 'scored']);
    expect(a.of('ownerChanged')).toMatchObject([{ ball: 1, from: 3, to: 1, cause: 'paddle' }]);
    // Owner 1 at tick start; the +1 is seat 3's brick, and seat 3's paddle takes the ball afterwards.
    const b = room({ seats: [0, 1, 3], balls: [wireBall(1, 890, 200, 5, 1, { ownerIndex: 1 })] });
    b.tick([scoreItem(0, -1), scoreItem(3, 1), ownerItem(1, 3)], [ballItem(1, 895, 201, -5, 1)]);
    expect(b.of('goal')).toMatchObject([{ ball: 1, wall: 0, scorer: -1 }]);
    expect(b.of('score').map((e) => e.cause)).toEqual(['conceded', 'brick']);
  });

  it('binds an own goal to the ball its release names, so the depth pick leaves the next +1 its own ball', () => {
    // Two non-phasing balls overlap wall 0 in one tick. The server scores ball 1 first (seat 0's own ball: the -1
    // and its release, no +1), then ball 2 (seat 2's: the -1 and seat 2's +1). Ball 1 comes first in map order and
    // is shallower (penetration 1); ball 2 is deeper (5).
    const r = room({
      seats: [0, 2], players: [[0, 10], [2, 10]],
      balls: [wireBall(1, 888, 200, 5, 1, { ownerIndex: 0 }), wireBall(2, 892, 600, 5, 1, { ownerIndex: 2 })],
    });
    r.tick([scoreItem(0, 9), ownerItem(1, -1), scoreItem(0, 8), scoreItem(2, 11)], [ballItem(1, 893, 201, -5, 1), ballItem(2, 897, 601, -5, 1)]);
    expect(r.of('goal')).toMatchObject([{ ball: 1, wall: 0, scorer: -1 }, { ball: 2, wall: 0, scorer: 2 }]);
    expect(r.of('score').map((e) => [e.seat, e.cause])).toEqual([[0, 'conceded'], [0, 'conceded'], [2, 'scored']]);
    expect(r.of('ownerChanged')).toMatchObject([{ ball: 1, from: 0, to: -1, cause: 'ownGoal', conf: 1 }]);
    expect(r.of('wallBounce')).toEqual([]);
  });

  it('matches a goal to a temporary ball absorbed at an empty adjacent wall in the same tick', () => {
    // Wall 0 (connected) scores it, then wall 1 (empty) absorbs it: the ball has no row at the goal tick.
    const t = simRoom([0, 3], (sim) => sim.addBall({ id: 7, x: 885, y: 15, vx: 8, vy: -8, ownerIndex: 3, isPermanent: false }), { me: 3 });
    t.step();
    expect(t.truth.map((x) => [x.kind, x.wall])).toEqual([['goal', 0], ['absorbed', 1]]);
    const [g] = t.of('goal');
    expect(g).toMatchObject({ tick: 1, ball: 7, wall: 0, scorer: 3, conf: 0.9, x: 900, y: 7 });
    expect(g.u).toBeCloseTo(7 / 900, 6);
    expect(t.of('score').map((e) => e.cause)).toEqual(['conceded', 'scored']);
    expect(t.of('absorbed')).toMatchObject([{ tick: 1, ball: 7, wall: 1 }]);
    expect(t.of('ballRemoved')).toMatchObject([{ ball: 7, cause: 'absorbed' }]);
  });

  it('an unowned-ball goal followed by a level-1 destroy by another seat gives scorer -1', () => {
    const cell = cellOf(4, 8);   // centre (425, 225)
    const r = room({
      seats: [0, 2],
      balls: [wireBall(1, 890, 600, 5, 1, { ownerIndex: -1 }), wireBall(2, 425, 190, 1, 6, { ownerIndex: 2 })],
      life: (row, col) => (row === 4 && col === 8 ? 1 : 0),
    });
    r.setLife(4, 8, 0);
    r.tick([scoreItem(0, -1), scoreItem(2, 1)], [ballItem(1, 895, 601, -5, 1), ballItem(2, 426, 196, 1, -6)], true);
    expect(r.of('goal')).toMatchObject([{ ball: 1, wall: 0, scorer: -1 }]);
    expect(r.of('score').map((e) => [e.seat, e.cause])).toEqual([[0, 'conceded'], [2, 'brick']]);
    expect(r.of('brickDestroyed')).toMatchObject([{ cell, ball: 2, scorer: 2, points: 1, conf: 0.9 }]);
  });

  it('merges repeats of the same ball on the same wall within 10 ticks (C47)', () => {
    const r = room({ seats: [0, 3], balls: [wireBall(1, 893, 300, 3, 1, { ownerIndex: 3 })] });
    r.tick([scoreItem(0, -1), scoreItem(3, 1)], [ballItem(1, 896, 301, -3, 1)]);
    r.tick([scoreItem(0, -2), scoreItem(3, 2)], [ballItem(1, 895, 302, 2, 1)]);
    r.tick([scoreItem(0, -3), scoreItem(3, 3)], [ballItem(1, 897, 303, -2, 1)]);
    for (let i = 0; i < 12; i++) r.tick([], [ballItem(1, 700 - i, 303, -1, 1)]);
    r.tick([scoreItem(0, -4), scoreItem(3, 4)], [ballItem(1, 895, 310, -3, 1)]);
    expect(r.of('goal').map((g) => g.repeat)).toEqual([0, 1, 2, 0]);
    expect(r.of('goal').every((g) => g.ball === 1 && g.scorer === 3)).toBe(true);
  });

  it('a phasing ball reflects off a connected wall with no goal', () => {
    const t = simRoom([0, 3], (sim) => {
      sim.addBall({ id: 1, x: 885, y: 100, vx: 8, vy: 3, ownerIndex: 3 });
      sim.startPhasing(1);
    });
    t.step();
    expect(t.of('goal')).toEqual([]);
    expect(t.of('score')).toEqual([]);
    expect(t.of('wallBounce')).toMatchObject([{ ball: 1, wall: 0, phasing: true }]);
  });

  it('scores the goal on the tick phasing ends (phasingAtStart)', () => {
    const t = simRoom([0, 3], (sim) => {
      sim.addBall({ id: 1, x: 877, y: 100, vx: 8, vy: 3, ownerIndex: 3 });
      sim.startPhasing(1);
    });
    t.step();
    t.sim.stopPhasing(1);   // the phasing timer fires between ticks
    t.step();
    expect(t.truth.filter((x) => x.kind === 'goal')).toEqual([{ tick: 2, ball: 1, kind: 'goal', wall: 0 }]);
    expect(t.of('goal')).toMatchObject([{ tick: 2, ball: 1, scorer: 3 }]);
    expect(t.of('phaseEnd')).toMatchObject([{ tick: 2, ball: 1 }]);
  });

  it('places a goal with no overlapping ball at the wall centre with conf 0.5', () => {
    const r = room({ seats: [0, 3], balls: [wireBall(1, 450, 450, 5, 5, { ownerIndex: 3 })] });
    r.tick([scoreItem(0, -1)], [ballItem(1, 455, 455, 5, 5)]);
    expect(r.of('goal')).toMatchObject([{ ball: -1, wall: 0, scorer: -1, conf: 0.5, x: 900, y: 450 }]);
  });

  it('gives join scores cause join and scores with an unknown previous value cause unknown', () => {
    const r = room({ seats: [0] });
    r.tick([joinedItem(2, 6)], []);
    expect(r.of('score')).toMatchObject([{ seat: 2, from: null, to: 6, delta: 0, cause: 'join' }]);
  });
});

// ---------------------------------------------------------------------------------------------- R4, R5, R7, R8

describe('R4 wallBounce, R5 absorbed, R7 removals, R8 spawns', () => {
  it('a permanent ball reflects off an empty wall', () => {
    const t = simRoom([3], (sim) => sim.addBall({ id: 1, x: 885, y: 100, vx: 8, vy: 3, ownerIndex: 3 }));
    t.step();
    const [b] = t.of('wallBounce');
    expect(b).toMatchObject({ tick: 1, ball: 1, wall: 0, phasing: false, conf: 0.95, x: 900, y: 103 });
    expect(b.u).toBeCloseTo(103 / 900, 6);
  });

  it('a corner hit gives two bounces', () => {
    const t = simRoom([3], (sim) => sim.addBall({ id: 1, x: 885, y: 15, vx: 8, vy: -8, ownerIndex: 3 }));
    t.step();
    expect(t.truth.map((x) => x.wall)).toEqual([0, 1]);
    expect(t.of('wallBounce').map((e) => e.wall).sort()).toEqual([0, 1]);
  });

  it('a temporary ball hitting an empty wall is absorbed at its predicted position', () => {
    const t = simRoom([3], (sim) => sim.addBall({ id: 7, x: 885, y: 100, vx: 8, vy: 3, ownerIndex: 3, isPermanent: false }));
    t.step();
    expect(t.of('absorbed')).toMatchObject([{ tick: 1, ball: 7, wall: 0, x: 900, y: 103 }]);
    expect(t.of('ballRemoved')).toMatchObject([{ ball: 7, cause: 'absorbed', x: 893, y: 103 }]);
  });

  it('a temporary ball reaching the wall of a seat in grace is absorbed, with no goal', () => {
    const t = simRoom([0, 3], (sim) => sim.addBall({ id: 7, x: 877, y: 100, vx: 8, vy: 3, ownerIndex: 3, isPermanent: false }), { me: 3 });
    t.sim.disconnect(0);   // the first playerLeft: seat 0 is in grace, its paddle stays
    t.step(2);
    expect(t.rt.world.seats[0].conn).toBe(SeatConn.Grace);
    expect(t.truth.filter((x) => x.kind === 'absorbed')).toMatchObject([{ tick: 2, ball: 7, wall: 0 }]);
    expect(t.of('goal')).toEqual([]);
    expect(t.of('absorbed')).toMatchObject([{ tick: 2, ball: 7, wall: 0 }]);
    expect(t.of('ballRemoved')).toMatchObject([{ ball: 7, cause: 'absorbed', conf: 0.95 }]);
  });

  it('a phasing temporary ball on an empty wall is not absorbed; it can only expire', () => {
    const t = simRoom([3], (sim) => {
      sim.addBall({ id: 7, x: 885, y: 100, vx: 8, vy: 3, ownerIndex: 3, isPermanent: false });
      sim.startPhasing(7);
    });
    t.step();
    expect(t.of('absorbed')).toEqual([]);
    expect(t.of('wallBounce')).toMatchObject([{ ball: 7, phasing: true }]);
    t.sim.destroyBall(7);   // the expiry timer, between ticks
    t.step();
    expect(t.of('ballRemoved')).toMatchObject([{ ball: 7, cause: 'expired' }]);
    expect(t.of('absorbed')).toEqual([]);
  });

  it('a grace-expiry removal beside an empty wall is released, not absorbed, inside tick k and in the tail', () => {
    // Seat 1 has no paddle, so the paddle blocks never heal it back into Grace. Its first playerLeft is at tick 1.
    const make = (): ReturnType<typeof room> => {
      const r = room({ seats: [0, 3], players: [[0, 0], [1, 0], [3, 0]], balls: [wireBall(7, 300, 15, 1, -5, { ownerIndex: 1, isPermanent: false })] });
      r.tick([leftItem(1)], [ballItem(7, 301, 10, 1, -5)]);
      return r;
    };
    // Server order (handleStopReconnectTimerMsg): playerLeft, ballRemoved for the leaver's temporary ball, then
    // lobbyState, all before tick 2's positions. The ball's predicted row (302, 5) overlaps wall 1, now Empty.
    const a = make();
    a.tick([leftItem(1), removedItem(7), lobbyItem([0, 3])], []);
    expect(a.of('seat').map((e) => [e.seat, e.to])).toEqual([[1, SeatConn.Grace], [1, SeatConn.Empty]]);
    expect(a.of('absorbed')).toEqual([]);
    expect(a.of('ballRemoved')).toMatchObject([{ ball: 7, owner: 1, cause: 'released', conf: 1 }]);
    // The same items in the batch tail, after tick 2's positions.
    const b = make();
    b.raw([...paddleBlock([0, 3]), ballItem(7, 302, 5, 1, -5), leftItem(1), removedItem(7), lobbyItem([0, 3])]);
    expect(b.of('absorbed')).toEqual([]);
    expect(b.of('ballRemoved')).toMatchObject([{ ball: 7, owner: 1, cause: 'released', conf: 1 }]);
  });

  it('an expiry far from the walls is cause expired', () => {
    const t = simRoom([3], (sim) => sim.addBall({ id: 9, x: 400, y: 400, vx: 5, vy: 5, ownerIndex: 3, isPermanent: false }));
    t.step(3);
    t.sim.destroyBall(9);
    t.step();
    expect(t.of('ballRemoved')).toMatchObject([{ ball: 9, cause: 'expired', owner: 3, conf: 1 }]);
  });

  it('spawns: join for a permanent ball, powerUp for a temporary one', () => {
    const t = simRoom([3], () => {});
    t.sim.join(1);
    t.step();
    expect(t.of('ballSpawned')).toMatchObject([{ owner: 1, permanent: true, cause: 'join' }]);
    const r = room({ seats: [3] });
    r.tick([spawnedItem(wireBall(20, 300, 300, 5, 5, { isPermanent: false, ownerIndex: 3 }))], [ballItem(20, 305, 305, 5, 5)]);
    expect(r.of('ballSpawned')).toMatchObject([{ ball: 20, cause: 'powerUp', owner: 3, x: 300, y: 300 }]);
  });
});

// ---------------------------------------------------------------------------------------------- R6, R12, R13, R14

describe('bricks: R6 bounce, R12 grid diff and attribution, R13 power-ups, R14 radius', () => {
  it('a bounce off a brick records the contact and attributes the damage with conf 0.9', () => {
    const t = simRoom([3], (sim) => {
      sim.setBrick(8, 8, 3);
      sim.addBall({ id: 1, x: 427, y: 380, vx: 1, vy: 6, ownerIndex: 3 });
    });
    t.step(4);
    expect(t.truth.filter((x) => x.kind === 'brick')).toEqual([{ tick: 3, ball: 1, kind: 'brick' }]);
    expect(t.of('brickBounce')).toMatchObject([{ tick: 3, ball: 1, conf: 0.9 }]);
    expect(t.of('brickDamaged')).toMatchObject([{ tick: 3, cell: cellOf(8, 8), from: 3, to: 2, level: 3, ball: 1, conf: 0.9 }]);
  });

  it('attributes to the nearest ball with conf 0.6 without a contact, and to nobody with conf 0.3', () => {
    const r = room({ seats: [3], balls: [wireBall(1, 260, 330, 1, 1, { ownerIndex: 3 })], life: (row, col) => (row === 6 && (col === 5 || col === 15) ? 2 : 0) });
    r.setLife(6, 5, 1);
    r.setLife(6, 15, 1);
    r.tick([], [ballItem(1, 261, 331, 1, 1)], true);
    const d = r.of('brickDamaged');
    expect(d.find((e) => e.cell === cellOf(6, 5))).toMatchObject({ ball: 1, conf: 0.6, x: 261, y: 331 });
    expect(d.find((e) => e.cell === cellOf(6, 15))).toMatchObject({ ball: -1, conf: 0.3, x: 775, y: 325 });
  });

  it('matches points to the brick score of the scorer, else uses the level', () => {
    // A late joiner's first grid can already be damaged: life 2 here, while the server's level was 5.
    const r = room({ seats: [2], balls: [wireBall(1, 275, 240, 1, 6, { ownerIndex: 2 })], life: (row, col) => (row === 5 && col === 5 ? 2 : row === 5 && col === 6 ? 3 : 0) });
    r.setLife(5, 5, 0);
    r.tick([scoreItem(2, 5)], [ballItem(1, 276, 246, 1, -6)], true);
    expect(r.of('brickDestroyed')).toMatchObject([{ cell: cellOf(5, 5), points: 5, scorer: 2, level: 2 }]);
    r.setLife(5, 6, 0);
    r.tick([], [ballItem(1, 310, 240, 1, -6)], true);
    expect(r.of('brickDestroyed')[1]).toMatchObject({ cell: cellOf(5, 6), points: 3, scorer: 2 });
  });

  it('counts chains per scorer within 12 ticks and flags the last brick', () => {
    const r = room({ seats: [2], balls: [wireBall(1, 100, 100, 1, 1, { ownerIndex: 2 })], life: (row, col) => (row === 3 && col >= 3 && col <= 6 ? 1 : 0) });
    const destroy = (col: number): void => {
      r.setLife(3, col, 0);
      const x = col * 50 + 25;
      r.tick([scoreItem(2, 0)], [ballItem(1, x, 190, 1, -6)], true);
    };
    destroy(3);
    r.tick([], [ballItem(1, 200, 300, 1, 1)]);
    destroy(4);
    destroy(5);
    for (let i = 0; i < 15; i++) r.tick([], [ballItem(1, 400, 400 + i, 1, 1)]);
    destroy(6);
    expect(r.of('brickDestroyed').map((e) => [e.chain, e.last])).toEqual([[1, false], [2, false], [3, false], [1, true]]);
    expect(r.rt.summary().bricksAlive).toBe(0);
  });

  it('counts chains and flags the last brick in (tick, cell) order within one batch, not in cell order', () => {
    // One 2-tick batch: a phasing ball of seat 2 crosses cell 118 (centre 525, 325) at tick 1, and another crosses
    // cell 114 (centre 325, 325) at tick 2. They are the last two bricks.
    const r = room({
      seats: [2],
      balls: [wireBall(1, 525, 285, 0, 40, { ownerIndex: 2 }), wireBall(2, 325, 405, 0, -40, { ownerIndex: 2 })],
      life: (row, col) => (row === 6 && (col === 6 || col === 10) ? 1 : 0),
    });
    r.raw([
      ...paddleBlock([2]), ballItem(1, 525, 325, 0, 40, { phasing: true }), ballItem(2, 325, 365, 0, -40, { phasing: true }),
      ...paddleBlock([2]), ballItem(1, 525, 365, 0, 40, { phasing: true }), ballItem(2, 325, 325, 0, -40, { phasing: true }),
      gridItem(() => 0),
    ]);
    expect(r.of('brickDestroyed').map((e) => [e.cell, e.tick, e.ball, e.scorer, e.chain, e.last])).toEqual([
      [cellOf(6, 10), 1, 1, 2, 1, false],
      [cellOf(6, 6), 2, 2, 2, 2, true],
    ]);
    expect(r.rt.summary().bricksAlive).toBe(0);
  });

  it('infers a split from a spawn of the same owner at a Chebyshev corner (+12, +12), not from another owner', () => {
    const r = room({ seats: [1, 2], balls: [wireBall(1, 275, 240, 1, 6, { ownerIndex: 2 })], life: (row, col) => (row === 5 && (col === 5 || col === 9) ? 1 : 0) });
    r.setLife(5, 5, 0);
    r.tick([scoreItem(2, 1), spawnedItem(wireBall(30, 287, 287, 5, 5, { isPermanent: false, ownerIndex: 2 }))], [ballItem(1, 276, 246, 1, -6), ballItem(30, 292, 292, 5, 5)], true);
    expect(r.of('powerUp')).toMatchObject([{ ball: 1, kind: 'split', conf: 1, x: 287, y: 287 }]);
    r.setLife(5, 9, 0);
    r.tick([scoreItem(2, 2), spawnedItem(wireBall(31, 475, 275, 5, 5, { isPermanent: false, ownerIndex: 1 }))], [ballItem(1, 476, 246, 1, -6), ballItem(30, 297, 297, 5, 5), ballItem(31, 480, 280, 5, 5)], true);
    expect(r.of('powerUp').filter((e) => e.kind === 'split')).toHaveLength(1);
  });

  it('detects a boost when a component magnitude changes, which IncreaseVelocity flooring does not always allow', () => {
    // Moving down (6, 7) into a brick top: reflect to (6, -7), then floor(-7 * 1.09) = -8: visible.
    const r = room({ seats: [3], balls: [wireBall(1, 275, 233, 6, 7, { ownerIndex: 3 })], life: (row, col) => (row === 5 && col === 5 ? 1 : 0) });
    r.setLife(5, 5, 0);
    r.tick([scoreItem(3, 1)], [ballItem(1, 281, 240, 6, -8)], true);
    expect(r.of('powerUp')).toMatchObject([{ kind: 'boost', conf: 0.8 }]);
    // Moving up (6, -7) into a brick bottom: reflect to (6, 7), floor(6.54) = 6 and floor(7.63) = 7: invisible,
    // so the destroy only adds a mass candidate.
    const s = room({ seats: [3], balls: [wireBall(1, 275, 317, 6, -7, { ownerIndex: 3 })], life: (row, col) => (row === 5 && col === 5 ? 1 : 0) });
    s.setLife(5, 5, 0);
    s.tick([scoreItem(3, 1)], [ballItem(1, 281, 310, 6, 7)], true);
    expect(s.of('powerUp')).toEqual([]);
    const slot = s.rt.slotOf(1);
    expect([rMin(s.rt.world.balls[slot]), rMax(s.rt.world.balls[slot])]).toEqual([8, 12]);
  });

  it('infers phase when the destroyer starts phasing on the destroy tick', () => {
    const r = room({ seats: [3], balls: [wireBall(1, 275, 233, 6, 7, { ownerIndex: 3 })], life: (row, col) => (row === 5 && col === 5 ? 1 : 0) });
    r.setLife(5, 5, 0);
    r.tick([scoreItem(3, 1)], [ballItem(1, 281, 240, 6, -7, { phasing: true })], true);
    expect(r.of('phaseStart')).toMatchObject([{ ball: 1, tick: 1 }]);
    expect(r.of('powerUp')).toMatchObject([{ kind: 'phase', conf: 1 }]);
  });

  it('resolves a mass candidate at the next wall bounce: ballResized and powerUp mass', () => {
    const r = room({ seats: [3], balls: [wireBall(1, 275, 317, 6, -7, { ownerIndex: 3 })], life: (row, col) => (row === 5 && col === 5 ? 1 : 0) });
    r.setLife(5, 5, 0);
    r.tick([scoreItem(3, 1)], [ballItem(1, 281, 310, 6, 7)], true);   // no evidence: candidate {8, 12}
    // Right wall, empty seat: x 881 -> 889 triggers, so R is in [11, 18]: 12.
    r.tick([], [ballItem(1, 881, 400, 8, 7)]);
    r.tick([], [ballItem(1, 889, 407, -8, 7)]);
    expect(r.of('wallBounce')).toMatchObject([{ ball: 1, wall: 0 }]);
    expect(r.of('ballResized')).toMatchObject([{ ball: 1, from: 8, to: 12 }]);
    expect(r.of('powerUp')).toMatchObject([{ ball: 1, kind: 'mass', conf: 1 }]);
  });

  it('never narrows on a bounce right after a paddle message', () => {
    const r = room({ seats: [3], balls: [wireBall(1, 881, 400, 8, 7, { ownerIndex: 3, radius: 8 })] });
    const slot = r.rt.slotOf(1);
    r.rt.world.balls[slot].radiusSet = 0b111;   // {8, 12, 16}
    r.tick([ownerItem(1, 3)], [ballItem(1, 893, 407, 8, 7)]);
    r.tick([], [ballItem(1, 897, 414, -4, 7)]);
    expect(r.of('wallBounce')).toMatchObject([{ ball: 1, wall: 0 }]);
    expect(r.rt.world.balls[slot].radiusSet).toBe(0b111);
  });
});

// ---------------------------------------------------------------------------------------------- R9, R15, R16, R17, R11

describe('R9 phasing, R11 seats, R15 controls, R16 board, R17 game over', () => {
  it('phase edges come from the phasing flag between rows', () => {
    const t = simRoom([3], (sim) => sim.addBall({ id: 1, x: 400, y: 400, vx: 3, vy: 2, ownerIndex: 3 }));
    t.step();
    t.sim.startPhasing(1);
    t.step(3);
    t.sim.stopPhasing(1);
    t.step();
    expect(t.of('phaseStart')).toMatchObject([{ ball: 1, tick: 2 }]);
    expect(t.of('phaseEnd')).toMatchObject([{ ball: 1, tick: 5 }]);
    expect(t.rt.world.balls[t.rt.slotOf(1)].phaseStartTick).toBe(2);
  });

  it('moves the phase start to the latest destroy when phasing outlasts PHASE_MS + slack (a re-trigger)', () => {
    const cell = cellOf(8, 8);   // centre (425, 425); the phasing ball crosses it at tick 60
    const r = room({ seats: [3], balls: [wireBall(1, 365, 425, 1, 0, { ownerIndex: 3 })], life: (row, col) => (row === 8 && col === 8 ? 1 : 0) });
    const row = (k: number): BallPositionUpdate => ballItem(1, 365 + k, 425, 1, 0, { phasing: true });
    for (let k = 1; k <= 129; k++) {
      if (k === 60) r.setLife(8, 8, 0);
      r.tick([], [row(k)], k === 60);
    }
    const slot = r.rt.slotOf(1);
    expect(r.of('phaseStart')).toMatchObject([{ ball: 1, tick: 1 }]);
    expect(r.of('brickDestroyed')).toMatchObject([{ cell, ball: 1, tick: 60, conf: 0.9 }]);
    // Tick 129 is 3200 ms after the start: not yet past PHASE_MS + phaseRetriggerSlackMs.
    expect(r.rt.world.balls[slot].phaseStartTick).toBe(1);
    r.tick([], [row(130)]);
    expect(r.rt.world.balls[slot].phaseStartTick).toBe(60);
    expect(r.of('phaseStart')).toHaveLength(1);
    expect(r.of('phaseEnd')).toEqual([]);
  });

  it('a join in play gives a seat event (R11)', () => {
    const t = simRoom([3], () => {});
    t.sim.join(0);
    t.step();
    expect(t.of('seat')).toMatchObject([{ seat: 0, from: SeatConn.Empty, to: SeatConn.Connected }]);
  });

  it('control items become IMMEDIATE flow events and controls', () => {
    const { rt, clock, events } = runtime(0);
    rt.ingest(initialItem({ players: [[0, 0]] }), clock.now());
    const r1 = rt.ingest(batch(countdownItem(3)), clock.now());
    const r2 = rt.ingest(batch(cancelledItem('Lobby membership or readiness changed')), clock.now());
    const r3 = rt.ingest(batch(startedItem()), clock.now());
    expect([r1.controls, r2.controls, r3.controls]).toEqual([
      [{ k: 'countdown', seconds: 3 }], [{ k: 'cancelled', reason: 'Lobby membership or readiness changed' }], [{ k: 'started' }],
    ]);
    expect(events.map((e) => [e.k, e.tick])).toEqual([['countdown', IMMEDIATE], ['countdownCancelled', IMMEDIATE], ['go', IMMEDIATE]]);
  });

  it('the first grid is silent and gives boardReady with the live brick count', () => {
    const { rt, clock, events } = runtime(0);
    rt.ingest(initialItem({ players: [[0, 0]] }), clock.now());
    const res = rt.ingest(batch(gridItem((r, c) => (r === 7 && c < 4 ? 2 : 0))), clock.now());
    expect(res.boardReady).toBe(true);
    expect(events.filter((e) => e.k === 'brickDamaged' || e.k === 'brickDestroyed')).toEqual([]);
    expect(events.filter((e) => e.k === 'boardReady')).toMatchObject([{ bricks: 4, tick: IMMEDIATE }]);
  });

  it('ignores an empty grid, which would give the board no size, and takes the next real one as the first', () => {
    const { rt, clock, events } = runtime(0);
    rt.ingest(initialItem({ players: [[0, 0]] }), clock.now());
    const empty = rt.ingest(batch({ messageType: 'fullGridUpdate', cellSize: 50, bricks: [] }), clock.now());
    expect(empty.boardReady).toBe(false);
    expect([rt.world.gridKnown, rt.world.canvas, rt.world.gridSize]).toEqual([false, 900, 18]);
    const res = rt.ingest(batch(gridItem((r, c) => (r === 7 && c === 7 ? 1 : 0))), clock.now());
    expect(res.boardReady).toBe(true);
    expect([rt.world.gridKnown, rt.world.canvas, rt.world.gridSize]).toEqual([true, 900, 18]);
    expect(events.filter((e) => e.k === 'boardReady')).toMatchObject([{ bricks: 1 }]);
  });

  it('ended() pushes gameOver', () => {
    const { rt, events } = runtime(0);
    rt.ended(2, true);
    expect(events).toMatchObject([{ k: 'gameOver', winner: 2, derived: true, tick: IMMEDIATE }]);
  });
});
