import { describe, expect, it } from 'vitest';
import { createRenderState, sampleInto } from './interpolate';
import { SnapshotRing } from './ring';
import { allocSlot, createWorld } from './world';
import { BALL_STRIDE, BO, BallVis, PADDLE_STRIDE, PO } from './types';
import type { RenderState, World } from './types';
import { SeatConn } from './events';

const HALF = 450;

function ballAt(r: RenderState, slot: number): { x: number; y: number; vx: number; vy: number; owner: number; vis: number; phasing: number } {
  const o = slot * BALL_STRIDE;
  return {
    x: r.ball[o + BO.X] + HALF, y: HALF - r.ball[o + BO.Y], vx: r.ball[o + BO.VX], vy: -r.ball[o + BO.VY],
    owner: r.ball[o + BO.OWNER], vis: r.ball[o + BO.VIS], phasing: r.ball[o + BO.PHASING],
  };
}

/** A ball moving in a straight line (vx, vy) per tick, pushed for ticks [from, to]. */
function straight(from: number, to: number, vx = 7, vy = -5): { w: World; ring: SnapshotRing; slot: number } {
  const w = createWorld();
  const ring = new SnapshotRing();
  const slot = allocSlot(w, 9);
  const b = w.balls[slot];
  b.radius = 8;
  b.vx = vx;
  b.vy = vy;
  b.spawnTick = 0;
  for (let t = from; t <= to; t++) {
    b.x = 100 + vx * t;
    b.y = 600 + vy * t;
    w.tick = t;
    ring.push(t, w);
  }
  return { w, ring, slot };
}

describe('sampleInto', () => {
  it('reproduces straight-line motion exactly between rows', () => {
    const { w, ring, slot } = straight(0, 20);
    const r = createRenderState();
    for (const t of [3, 3.25, 7.5, 12.8, 19.999]) {
      sampleInto(w, ring, t, r, 2);
      const b = ballAt(r, slot);
      expect(b.x).toBeCloseTo(100 + 7 * t, 3);
      expect(b.y).toBeCloseTo(600 - 5 * t, 3);
      expect(b.vx).toBeCloseTo(7, 5);
      expect(b.vy).toBeCloseTo(-5, 5);
      expect(r.extrapolating).toBe(false);
    }
    expect(r.ballHigh).toBe(slot + 1);
    expect(r.ballId[slot]).toBe(9);
    expect(r.ballId[slot + 1]).toBe(-1);
  });

  it('extrapolates past the newest row by at most maxExtrapTicks', () => {
    const { w, ring, slot } = straight(0, 10);
    const r = createRenderState();
    sampleInto(w, ring, 11, r, 2);
    expect(ballAt(r, slot).x).toBeCloseTo(100 + 7 * 11, 3);
    expect(r.extrapolating).toBe(true);
    sampleInto(w, ring, 13.5, r, 2);
    expect(ballAt(r, slot).x).toBeCloseTo(100 + 7 * 12, 3);
    sampleInto(w, ring, 13.5, r, 0);
    expect(ballAt(r, slot).x).toBeCloseTo(100 + 7 * 10, 3);
    expect(r.extrapolating).toBe(false);
  });

  it('keeps a paddle at the far rail while extrapolating: centre canvas - len/2', () => {
    const w = createWorld();
    const ring = new SnapshotRing();
    const p = w.paddles[0];
    p.present = true;
    p.w = 25;
    p.h = 150;
    p.x = 887.5;
    p.vy = 12;   // Paddle.Move keeps reporting its step while clamped at the rail
    for (let t = 0; t <= 4; t++) {
      p.y = Math.min(825, 800 + 12 * t);
      ring.push(t, w);
    }
    const r = createRenderState();
    sampleInto(w, ring, 5.5, r, 2);
    expect(HALF - r.paddle[0 * PADDLE_STRIDE + PO.CY]).toBe(825);
    expect(r.paddle[PO.PRESENT]).toBe(1);
  });

  it('switches owner and phasing as a step at the tick, never mid-way', () => {
    const { w, ring, slot } = straight(0, 4);
    const b = w.balls[slot];
    b.owner = 1;
    ring.push(4, w);
    b.owner = 3;
    b.phasing = true;
    b.x += 7;
    w.tick = 5;
    ring.push(5, w);
    const r = createRenderState();
    sampleInto(w, ring, 4.9, r, 2);
    expect(ballAt(r, slot)).toMatchObject({ owner: 1, phasing: 0 });
    sampleInto(w, ring, 5, r, 2);
    expect(ballAt(r, slot)).toMatchObject({ owner: 3, phasing: 1 });
  });

  it('hides a spawned ball until display time reaches its tick', () => {
    const { w, ring, slot } = straight(0, 8);
    w.balls[slot].spawnTick = 5;
    const r = createRenderState();
    sampleInto(w, ring, 4.5, r, 2);
    expect(ballAt(r, slot).vis).toBe(BallVis.Hidden);
    sampleInto(w, ring, 5, r, 2);
    expect(ballAt(r, slot).vis).toBe(BallVis.Live);
  });

  it('keeps a removed ball Dying at its last position for 250 ms of display time, then Hidden', () => {
    const { w, ring, slot } = straight(0, 9);
    const b = w.balls[slot];
    const lastX = b.x;
    b.live = false;
    b.removedTick = 10;
    w.tick = 10;
    ring.push(10, w);
    const r = createRenderState();
    sampleInto(w, ring, 9.5, r, 2);
    expect(ballAt(r, slot).vis).toBe(BallVis.Live);
    sampleInto(w, ring, 15, r, 2);
    expect(ballAt(r, slot)).toMatchObject({ vis: BallVis.Dying, x: lastX });
    sampleInto(w, ring, 20, r, 2);
    expect(ballAt(r, slot).vis).toBe(BallVis.Hidden);
    expect(r.ballId[slot]).toBe(9);
  });

  it('holds the oldest row when display time is before it (the first frames after the start snap)', () => {
    const { w, ring, slot } = straight(5, 8);
    w.balls[slot].spawnTick = 0;
    const r = createRenderState();
    sampleInto(w, ring, 2.3, r, 2);
    expect(ballAt(r, slot).x).toBe(100 + 7 * 5);
  });

  it('judges visibility and age at the held oldest row, so a ball is Live with age >= 0 at a negative display tick', () => {
    const { w, ring, slot } = straight(0, 3);
    const r = createRenderState();
    sampleInto(w, ring, -0.52, r, 2);   // 25 + 2 - 40 ms: the first play frame after the start snap
    const o = slot * BALL_STRIDE;
    expect(ballAt(r, slot)).toMatchObject({ x: 100, vis: BallVis.Live });
    expect(r.ball[o + BO.AGE_S]).toBe(0);
    // A ball spawned at the oldest row's tick is shown by that row too.
    const held = straight(5, 8);
    held.w.balls[held.slot].spawnTick = 5;
    sampleInto(held.w, held.ring, 2.3, r, 2);
    expect(ballAt(r, held.slot).vis).toBe(BallVis.Live);
    expect(r.ball[held.slot * BALL_STRIDE + BO.AGE_S]).toBe(0);
  });

  it('before play copies the row at w.tick exactly', () => {
    const w = createWorld();
    const ring = new SnapshotRing();
    const slot = allocSlot(w, 1);
    const b = w.balls[slot];
    Object.assign(b, { x: 431, y: 219, vx: 5, vy: 9, radius: 8, spawnTick: 0, owner: 2 });
    w.paddles[3] = { present: true, x: 450, y: 887.5, w: 150, h: 25, vx: 0, vy: 0, collided: false };
    w.seats[3].conn = SeatConn.Connected;
    ring.push(0, w);
    const r = createRenderState();
    sampleInto(w, ring, w.tick, r, 0);
    expect(ballAt(r, slot)).toMatchObject({ x: 431, y: 219, vis: BallVis.Live, owner: 2 });
    const o = 3 * PADDLE_STRIDE;
    expect([r.paddle[o + PO.PRESENT], r.paddle[o + PO.CX], r.paddle[o + PO.CY], r.paddle[o + PO.W], r.paddle[o + PO.CONN]])
      .toEqual([1, 0, 450 - 887.5, 150, SeatConn.Connected]);
  });

  it('falls back to the World when the ring is empty', () => {
    const w = createWorld();
    const slot = allocSlot(w, 3);
    Object.assign(w.balls[slot], { x: 50, y: 60, radius: 8 });
    const r = createRenderState();
    sampleInto(w, new SnapshotRing(), 0, r, 2);
    expect(ballAt(r, slot)).toMatchObject({ x: 50, y: 60 });
  });
});
