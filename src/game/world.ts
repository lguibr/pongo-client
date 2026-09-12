// The World (4.6): the single mutable model of the room, written only by the game runtime. Paddle rows hold
// centres (wire top-left + size / 2), balls live in a fixed slot table whose index is the instance index.

import type { Seat } from './events';
import { SeatConn } from './events';
import type { BallSlot, PaddleRow, SeatRow, World } from './types';
import { CANVAS, CELL, CELLS, GRID, MAX_BALLS, CellType } from '../config/constants';
import { log } from '../lib/log';

function seatRow(): SeatRow {
  return {
    conn: SeatConn.Empty, score: 0, scoreKnown: false, ready: false, graceEndsAt: NaN,
    everSeen: false, leftCount: 0, missingPaddleTicks: 0,
  };
}

function paddleRow(): PaddleRow {
  return { present: false, x: 0, y: 0, w: 0, h: 0, vx: 0, vy: 0, collided: false };
}

function ballSlot(): BallSlot {
  return {
    live: false, id: -1, owner: -1, permanent: false, phasing: false,
    x: 0, y: 0, vx: 0, vy: 0, collided: false, r0: 0, radiusSet: 0, radius: 0,
    spawnTick: 0, spawnedAtMs: 0, phaseStartTick: -1,
    lastDestroyTick: -1, lastBrickContactTick: -1, brickContactX: 0, brickContactY: 0,
    removedTick: -1, lastGoalTick: -1, lastGoalWall: -1,
  };
}

function clearSeat(s: SeatRow): void {
  s.conn = SeatConn.Empty;
  s.score = 0;
  s.scoreKnown = false;
  s.ready = false;
  s.graceEndsAt = NaN;
  s.everSeen = false;
  s.leftCount = 0;
  s.missingPaddleTicks = 0;
}

function clearPaddle(p: PaddleRow): void {
  p.present = false;
  p.x = 0;
  p.y = 0;
  p.w = 0;
  p.h = 0;
  p.vx = 0;
  p.vy = 0;
  p.collided = false;
}

/** Resets a slot to its free state. */
export function clearSlot(b: BallSlot): void {
  b.live = false;
  b.id = -1;
  b.owner = -1;
  b.permanent = false;
  b.phasing = false;
  b.x = 0;
  b.y = 0;
  b.vx = 0;
  b.vy = 0;
  b.collided = false;
  b.r0 = 0;
  b.radiusSet = 0;
  b.radius = 0;
  b.spawnTick = 0;
  b.spawnedAtMs = 0;
  b.phaseStartTick = -1;
  b.lastDestroyTick = -1;
  b.lastBrickContactTick = -1;
  b.brickContactX = 0;
  b.brickContactY = 0;
  b.removedTick = -1;
  b.lastGoalTick = -1;
  b.lastGoalWall = -1;
}

export function createWorld(): World {
  return {
    epoch: 0, myIndex: null, tick: 0, ready: false, frozen: false,
    canvas: CANVAS, gridSize: GRID, cellSize: CELL,
    seats: [seatRow(), seatRow(), seatRow(), seatRow()],
    paddles: [paddleRow(), paddleRow(), paddleRow(), paddleRow()],
    balls: Array.from({ length: MAX_BALLS }, ballSlot),
    slotById: new Map(),
    brickLife: new Uint8Array(CELLS), brickType: new Uint8Array(CELLS).fill(CellType.Empty),
    brickLevel: new Uint8Array(CELLS), brickDirty: new Uint8Array(CELLS),
    brickVersion: 0, bricksAlive: 0, bricksAtStart: 0, gridKnown: false,
  };
}

/** Clears everything for a new epoch. The brick version keeps counting, so a reader never mistakes the
 *  cleared arrays for the ones it last saw. */
export function resetWorld(w: World, epoch: number, myIndex: Seat | null): void {
  w.epoch = epoch;
  w.myIndex = myIndex;
  w.tick = 0;
  w.ready = false;
  w.frozen = false;
  w.canvas = CANVAS;
  w.gridSize = GRID;
  w.cellSize = CELL;
  for (let i = 0; i < 4; i++) {
    clearSeat(w.seats[i]);
    clearPaddle(w.paddles[i]);
  }
  for (let i = 0; i < w.balls.length; i++) clearSlot(w.balls[i]);
  w.slotById.clear();
  w.brickLife.fill(0);
  w.brickType.fill(CellType.Empty);
  w.brickLevel.fill(0);
  w.brickDirty.fill(0);
  w.brickVersion++;
  w.bricksAlive = 0;
  w.bricksAtStart = 0;
  w.gridKnown = false;
}

const warnedFull = new WeakSet<World>();

/** The lowest free slot, bound to `id` and marked live with default fields; -1 when full (logged once per
 *  World). A slot is free when it is not live and not waiting to be freed after a removal. An id that is
 *  already bound keeps its live slot. */
export function allocSlot(w: World, id: number): number {
  const existing = w.slotById.get(id);
  if (existing !== undefined) {
    if (w.balls[existing].live) return existing;
    freeSlot(w, existing);
  }
  for (let i = 0; i < w.balls.length; i++) {
    const b = w.balls[i];
    if (b.live || b.removedTick >= 0) continue;
    clearSlot(b);
    b.live = true;
    b.id = id;
    w.slotById.set(id, i);
    return i;
  }
  if (!warnedFull.has(w)) {
    warnedFull.add(w);
    log.warn(`ball slots full (${w.balls.length}); ball ${id} is not tracked`);
  }
  return -1;
}

export function freeSlot(w: World, slot: number): void {
  const b = w.balls[slot];
  if (b === undefined) return;
  if (b.id >= 0 && w.slotById.get(b.id) === slot) w.slotById.delete(b.id);
  clearSlot(b);
}

/** Seats other than myIndex whose conn is Grace (WorldSummary.graceSeats). */
export function graceSeats(w: Readonly<World>): number {
  let n = 0;
  for (let i = 0; i < 4; i++) if (i !== w.myIndex && w.seats[i].conn === SeatConn.Grace) n++;
  return n;
}
