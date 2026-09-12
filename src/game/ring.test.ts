import { describe, expect, it } from 'vitest';
import { RING_FLAG, SnapshotRing } from './ring';
import { allocSlot, createWorld } from './world';
import type { World } from './types';

function worldWithBall(): World {
  const w = createWorld();
  const p = w.paddles[3];
  p.present = true;
  p.x = 450;
  p.y = 887.5;
  p.w = 150;
  p.h = 25;
  p.vx = 12;
  p.collided = true;
  const slot = allocSlot(w, 42);
  const b = w.balls[slot];
  b.x = 300;
  b.y = 200;
  b.vx = 6;
  b.vy = -7;
  b.owner = 2;
  b.phasing = true;
  b.permanent = true;
  return w;
}

describe('SnapshotRing', () => {
  it('is empty until the first push', () => {
    const r = new SnapshotRing();
    const out = new Float32Array(6);
    expect(r.newest).toBe(-1);
    expect(r.oldest).toBe(-1);
    expect(r.has(0)).toBe(false);
    expect(r.readBall(0, 0, out, 0)).toBe(false);
  });

  it('stores paddle centres and ball rows with their flags', () => {
    const w = worldWithBall();
    const r = new SnapshotRing();
    r.push(0, w);
    const out = new Float32Array(8);
    expect(r.readPaddle(0, 3, out, 1)).toBe(true);
    expect(Array.from(out.slice(1, 6))).toEqual([450, 887.5, 12, 0, RING_FLAG.PRESENT | RING_FLAG.COLLIDED]);
    expect(r.readPaddle(0, 0, out, 0)).toBe(false);
    expect(r.readBall(0, 0, out, 0)).toBe(true);
    expect(Array.from(out.slice(0, 6))).toEqual([300, 200, 6, -7, RING_FLAG.PRESENT | RING_FLAG.PHASING | RING_FLAG.PERMANENT, 2]);
    expect(r.readBall(0, 1, out, 0)).toBe(false);
  });

  it('overwrites the newest row when the same tick is pushed again (frameless batches)', () => {
    const w = worldWithBall();
    const r = new SnapshotRing();
    r.push(3, w);
    w.balls[0].x = 333;
    r.push(3, w);
    const out = new Float32Array(6);
    r.readBall(3, 0, out, 0);
    expect(out[0]).toBe(333);
    expect(r.newest).toBe(3);
  });

  it('keeps the last 64 ticks and reads skipped or overwritten ticks as absent', () => {
    const w = worldWithBall();
    const r = new SnapshotRing();
    for (let t = 0; t <= 70; t++) {
      w.balls[0].x = t;
      r.push(t, w);
    }
    expect(r.newest).toBe(70);
    expect(r.oldest).toBe(7);
    expect(r.has(6)).toBe(false);
    expect(r.has(7)).toBe(true);
    const out = new Float32Array(6);
    r.readBall(7, 0, out, 0);
    expect(out[0]).toBe(7);
    const g = new SnapshotRing();
    g.push(1, w);
    g.push(2, w);
    g.push(5, w);
    expect(g.has(3)).toBe(false);
    expect(g.readBall(4, 0, out, 0)).toBe(false);
  });

  it('ignores an older tick that it no longer holds', () => {
    const w = worldWithBall();
    const r = new SnapshotRing();
    r.push(100, w);
    r.push(20, w);
    expect(r.has(20)).toBe(false);
    expect(r.newest).toBe(100);
  });

  it('writes a slot that is not live as absent', () => {
    const w = worldWithBall();
    w.balls[0].live = false;
    const r = new SnapshotRing();
    r.push(0, w);
    expect(r.readBall(0, 0, new Float32Array(6), 0)).toBe(false);
  });
});
