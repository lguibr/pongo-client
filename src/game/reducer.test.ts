import { beforeEach, describe, expect, it } from 'vitest';
import { applyBatch, applyInitial } from './reducer';
import type { MutableIngestResult, ReducerCtx } from './reducer';
import { createWorld } from './world';
import { SnapshotRing } from './ring';
import { Playout } from './playout';
import { createEventQueue } from './queue';
import { DeriveScratch } from './derive';
import { createBatchPlan } from './segment';
import type { BatchPlan } from './segment';
import type { EventOf, GameEvent } from './events';
import { SeatConn } from './events';
import { TUNING } from '../config/tuning';
import { BALL_R0, MASS_R_STEP, RADIUS_K } from '../config/constants';
import { FULL_RADIUS_SET, rMax, rMin } from './radius';
import type { BatchItem } from '../protocol/messages';
import {
  ballItem, batch, countdownItem, gridItem, initialItem, joinedItem, lobbyItem, paddleBlock, removedItem, spawnedItem,
  startedItem, wireBall,
} from './testing/synth';

let ctx: ReducerCtx;
let plan: BatchPlan;
let out: MutableIngestResult;
let events: GameEvent[];

function apply(items: BatchItem[], at = 1000): void {
  ctx.nowMs = at;
  applyBatch(ctx, batch(...items), plan, out);
  ctx.queue.releaseAllStale((e) => events.push(e));
}

function kinds<K extends GameEvent['k']>(k: K): EventOf<K>[] {
  return events.filter((e): e is EventOf<K> => e.k === k);
}

const readBall = (tick: number, slot: number): Float32Array | null => {
  const o = new Float32Array(6);
  return ctx.ring.readBall(tick, slot, o, 0) ? o : null;
};

beforeEach(() => {
  ctx = {
    world: createWorld(), ring: new SnapshotRing(), playout: new Playout(TUNING.playout, TUNING.hitStop),
    queue: createEventQueue(), scratch: new DeriveScratch(), nowMs: 1000, tuning: TUNING,
  };
  plan = createBatchPlan();
  out = { controls: [], ticks: 0, boardReady: false };
  events = [];
});

describe('applyInitial', () => {
  it('applies seats, paddles and balls with their exact radius, and pushes row 0', () => {
    applyInitial(ctx, initialItem({ players: [[0, 3]], paddles: [0, 2], balls: [wireBall(7, 300, 310, 5, -6, { radius: 16, ownerIndex: 0 })] }));
    const w = ctx.world;
    expect(w.tick).toBe(0);
    expect(w.seats[0].conn).toBe(SeatConn.Connected);
    expect(w.seats[2].conn).toBe(SeatConn.Grace);
    const slot = w.slotById.get(7) as number;
    expect(w.balls[slot]).toMatchObject({ r0: 16, radiusSet: 1, radius: 16, owner: 0, spawnTick: 0 });
    expect(readBall(0, slot)?.[0]).toBe(300);
    ctx.queue.releaseAllStale((e) => events.push(e));
    expect(kinds('ballSpawned')).toMatchObject([{ ball: 7, cause: 'snapshot', tick: 0 }]);
  });
});

describe('applyBatch', () => {
  beforeEach(() => {
    applyInitial(ctx, initialItem({ players: [[0, 0]], balls: [wireBall(1, 450, 450, 5, 5)] }));
    ctx.queue.releaseAllStale(() => {});
  });

  it('before play: frameless batches stamp items at w.tick and overwrite that row, so joins and spawns show at once', () => {
    apply([joinedItem(3), spawnedItem(wireBall(2, 450, 800, 4, -6, { ownerIndex: 3 })), lobbyItem([0, 3])]);
    expect(out.ticks).toBe(0);
    expect(ctx.world.tick).toBe(0);
    expect(ctx.playout.started).toBe(false);
    const slot = ctx.world.slotById.get(2) as number;
    expect(readBall(0, slot)?.[1]).toBe(800);
    expect(ctx.world.balls[slot].spawnTick).toBe(0);
    expect(kinds('ballSpawned')).toMatchObject([{ ball: 2, cause: 'join', tick: 0 }]);
    expect(kinds('seat')).toMatchObject([{ seat: 3, to: SeatConn.Connected, tick: 0 }]);
  });

  it('assigns tick w.tick + 1 + j to frame j and starts the playout clock', () => {
    const f = [...paddleBlock([0]), ballItem(1, 455, 455, 5, 5)];
    const g = [...paddleBlock([0]), ballItem(1, 460, 460, 5, 5)];
    apply([...f, ...g], 2000);
    expect(out.ticks).toBe(2);
    expect(ctx.world.tick).toBe(2);
    expect(ctx.playout.started).toBe(true);
    expect(ctx.playout.latestMs).toBe(50);
    expect(readBall(1, 0)?.[0]).toBe(455);
    expect(readBall(2, 0)?.[0]).toBe(460);
  });

  it('after play starts, tail items take the next tick', () => {
    apply([...paddleBlock([0]), ballItem(1, 455, 455, 5, 5), spawnedItem(wireBall(3, 100, 100, 5, 5, { isPermanent: false }))]);
    const slot = ctx.world.slotById.get(3) as number;
    expect(ctx.world.balls[slot].spawnTick).toBe(2);
    expect(kinds('ballSpawned')[0]).toMatchObject({ ball: 3, tick: 2, cause: 'powerUp' });
  });

  it('frees removed slots at once before play, and only after 64 ticks during play', () => {
    apply([spawnedItem(wireBall(5, 100, 100, 5, 5, { isPermanent: false }))]);
    const s5 = ctx.world.slotById.get(5) as number;
    apply([removedItem(5)]);
    expect(ctx.world.balls[s5].live).toBe(false);
    expect(ctx.world.slotById.has(5)).toBe(false);   // freed: the playout has not started

    apply([spawnedItem(wireBall(6, 100, 100, 5, 5, { isPermanent: false })), ...paddleBlock([0]), ballItem(1, 455, 455, 5, 5), ballItem(6, 105, 105, 5, 5)]);
    const s6 = ctx.world.slotById.get(6) as number;
    apply([removedItem(6), ...paddleBlock([0]), ballItem(1, 460, 460, 5, 5)]);
    const removedAt = ctx.world.balls[s6].removedTick;
    expect(removedAt).toBe(ctx.world.tick);
    while (ctx.world.tick - removedAt < 63) apply([...paddleBlock([0]), ballItem(1, 450, 450, 5, 5)]);
    expect(ctx.world.balls[s6].removedTick).toBe(removedAt);   // 63 ticks later: still held for the ring
    apply([...paddleBlock([0]), ballItem(1, 450, 450, 5, 5)]);   // 64 ticks: freed
    expect(ctx.world.balls[s6].removedTick).toBe(-1);
    expect(ctx.world.slotById.has(6)).toBe(false);
  });

  it('heals a ball it never saw spawn, with an unknown radius, and drops one that stops arriving', () => {
    apply([...paddleBlock([0]), ballItem(1, 455, 455, 5, 5), ballItem(40, 200, 200, 7, 7)]);
    const s40 = ctx.world.slotById.get(40) as number;
    expect(ctx.world.balls[s40]).toMatchObject({ live: true, owner: -1, r0: BALL_R0, radiusSet: FULL_RADIUS_SET, radius: BALL_R0 });
    // The heal spans the whole lattice: overlap tests use its largest radius, drawing uses the smallest.
    expect(rMax(ctx.world.balls[s40])).toBe(BALL_R0 + MASS_R_STEP * (RADIUS_K - 1));
    expect(rMin(ctx.world.balls[s40])).toBe(BALL_R0);
    for (let k = 0; k < 3; k++) apply([...paddleBlock([0]), ballItem(1, 455, 455, 5, 5)]);
    expect(ctx.world.balls[s40].live).toBe(false);
    expect(kinds('ballRemoved')).toMatchObject([{ ball: 40, cause: 'expired', conf: 0.5 }]);
    expect(kinds('ballSpawned').find((e) => e.ball === 40)).toMatchObject({ cause: 'snapshot' });
  });

  it('turns controls into flow events and returns them in order', () => {
    apply([countdownItem(3), countdownItem(2), startedItem()]);
    expect(out.controls).toEqual([{ k: 'countdown', seconds: 3 }, { k: 'countdown', seconds: 2 }, { k: 'started' }]);
    expect(kinds('countdown').map((e) => [e.seconds, e.tick])).toEqual([[3, -1], [2, -1]]);
    expect(kinds('go')).toHaveLength(1);
  });

  it('reports boardReady for the first grid only', () => {
    apply([gridItem((r, c) => (r === 5 && c === 5 ? 2 : 0))]);
    expect(out.boardReady).toBe(true);
    expect(ctx.world.gridKnown).toBe(true);
    expect(ctx.world.bricksAlive).toBe(1);
    apply([gridItem((r, c) => (r === 5 && c === 5 ? 1 : 0))]);
    expect(out.boardReady).toBe(false);
  });
});
