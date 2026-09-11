import { describe, expect, it } from 'vitest';
import { createOracle, ServerSim } from './oracle';
import type { BallPositionUpdate, BatchItem } from '../../protocol/messages';
import { createBatchPlan, segmentBatch } from '../segment';

function ballUpdate(items: BatchItem[], id: number): BallPositionUpdate | undefined {
  return items.find((u): u is BallPositionUpdate => u.messageType === 'ballPositionUpdate' && u.id === id);
}

describe('ServerSim matches hand-computed server ticks', () => {
  it('a permanent ball reflects off an empty wall', () => {
    const sim = new ServerSim({ seed: 1, seats: [3] }, { spawnBalls: false });
    sim.addBall({ id: 1, x: 885, y: 100, vx: 8, vy: 3, ownerIndex: 3 });
    const { items, truth } = sim.step();
    expect(ballUpdate(items, 1)).toMatchObject({ x: 893, y: 103, vx: -8, vy: 3, collided: true });
    expect(items.filter((u) => u.messageType === 'scoreUpdate')).toEqual([]);
    expect(truth).toEqual([{ tick: 1, ball: 1, kind: 'wallBounce', wall: 0, phasing: false }]);
  });

  it('a goal: conceder -1, then the owner +1, in that order', () => {
    const sim = new ServerSim({ seed: 1, seats: [0, 3] }, { spawnBalls: false });
    sim.addBall({ id: 1, x: 885, y: 100, vx: 8, vy: 3, ownerIndex: 3 });
    const { items, truth } = sim.step();
    expect(items.slice(0, 2)).toEqual([
      { messageType: 'scoreUpdate', index: 0, score: -1 },
      { messageType: 'scoreUpdate', index: 3, score: 1 },
    ]);
    expect(items.slice(2).map((u) => u.messageType)).toEqual(['paddlePositionUpdate', 'paddlePositionUpdate', 'ballPositionUpdate']);
    expect(ballUpdate(items, 1)).toMatchObject({ x: 893, vx: -8 });
    expect(truth).toEqual([{ tick: 1, ball: 1, kind: 'goal', wall: 0 }]);
  });

  it('an own goal: -1 for the owner and the ball released, no +1', () => {
    const sim = new ServerSim({ seed: 1, seats: [0] }, { spawnBalls: false });
    sim.addBall({ id: 4, x: 885, y: 100, vx: 8, vy: 3, ownerIndex: 0 });
    const { items } = sim.step();
    expect(items.slice(0, 2)).toEqual([
      { messageType: 'scoreUpdate', index: 0, score: -1 },
      { messageType: 'ballOwnerChanged', id: 4, newOwnerIndex: -1 },
    ]);
  });

  it('a paddle corner hit: reflection angle clamped to pi/2.8, velocity truncated', () => {
    const sim = new ServerSim({ seed: 1, seats: [3] }, { spawnBalls: false });
    sim.addBall({ id: 2, x: 531, y: 866, vx: -3, vy: 6, ownerIndex: -1 });
    const { items, truth } = sim.step();
    // Moved to (528, 872); nearest paddle point (525, 875): 3^2 + 3^2 < 8^2. rel 78 of 75 -> norm clamps to 1,
    // angle pi/2.8; base (0, -1) -> (0.90097, -0.43388) x speed sqrt(45) -> trunc (6, -2).
    expect(items[0]).toEqual({ messageType: 'ballOwnerChanged', id: 2, newOwnerIndex: 3 });
    expect(items[1]).toMatchObject({ messageType: 'paddlePositionUpdate', index: 3, collided: true });
    expect(ballUpdate(items, 2)).toMatchObject({ x: 528, y: 872, vx: 6, vy: -2, collided: true });
    expect(truth).toEqual([{ tick: 1, ball: 2, kind: 'paddle', seat: 3 }]);
  });

  it('a temporary ball hitting an empty seat wall is absorbed and removed in the same tick', () => {
    const sim = new ServerSim({ seed: 1, seats: [3] }, { spawnBalls: false });
    sim.addBall({ id: 7, x: 885, y: 100, vx: 8, vy: 3, ownerIndex: 3, isPermanent: false });
    const { items, truth } = sim.step();
    expect(items[0]).toEqual({ messageType: 'ballRemoved', id: 7 });
    expect(ballUpdate(items, 7)).toBeUndefined();
    expect(truth).toEqual([{ tick: 1, ball: 7, kind: 'absorbed', wall: 0 }]);
  });

  it('a phasing ball reflects off a connected wall without scoring', () => {
    const sim = new ServerSim({ seed: 1, seats: [0, 3] }, { spawnBalls: false });
    sim.addBall({ id: 1, x: 885, y: 100, vx: 8, vy: 3, ownerIndex: 3 });
    sim.startPhasing(1);
    const { items, truth } = sim.step();
    expect(items.filter((u) => u.messageType === 'scoreUpdate')).toEqual([]);
    expect(ballUpdate(items, 1)).toMatchObject({ vx: -8, phasing: true });
    expect(truth).toEqual([{ tick: 1, ball: 1, kind: 'wallBounce', wall: 0, phasing: true }]);
  });

  it('is deterministic for a seed', () => {
    const a = createOracle({ seed: 5, seats: [0, 1, 2, 3], bricks: true });
    const b = createOracle({ seed: 5, seats: [0, 1, 2, 3], bricks: true });
    for (let i = 0; i < 200; i++) expect(a.step()).toEqual(b.step());
  });
});

describe('oracle output follows the server emission order (5.1)', () => {
  it('every step is exactly one frame: paddles ascending, each ball once, scores and paddle owners in pre', () => {
    const oracle = createOracle({ seed: 21, seats: [0, 1, 2, 3], bricks: true });
    expect(oracle.initialState().paddles).toHaveLength(4);
    expect(oracle.grid().bricks).toHaveLength(324);
    const plan = createBatchPlan();
    let owners = 0;
    let scores = 0;
    let spawns = 0;
    for (let i = 0; i < 4000; i++) {
      const { items } = oracle.step();
      segmentBatch(items, plan);
      expect(plan.frameCount).toBe(1);
      const f = plan.frames[0];
      expect(f.paddles.map((p) => p.index)).toEqual([0, 1, 2, 3]);
      expect(new Set(f.balls.map((b) => b.id)).size).toBe(f.balls.length);
      for (const u of plan.tail) {
        expect(u.messageType).not.toBe('scoreUpdate');
        if (u.messageType === 'ballOwnerChanged') expect(u.newOwnerIndex).toBe(-1);
      }
      for (const u of f.pre) {
        if (u.messageType === 'ballOwnerChanged' && u.newOwnerIndex >= 0) owners++;
        if (u.messageType === 'scoreUpdate') scores++;
        if (u.messageType === 'ballSpawned') spawns++;
      }
    }
    expect(owners).toBeGreaterThan(20);
    expect(scores).toBeGreaterThan(20);
    expect(spawns).toBeGreaterThan(0);
    expect(oracle.tick).toBe(4000);
  });
});
