// The reducer (4.7, 5.4): applies the initial state and each batch to the World, one tick frame at a time.
// For each frame: apply pre items in order (logging them), save row k-1, apply the positions, close tick k
// (w.tick = k, ring.push), derive its events, then the seat safety check. After the frames: the tail (or the
// headless items), the grid diff, the lobby, the controls, the playout clock, and slot freeing.

import type { EventQueue, Seat } from './events';
import { IMMEDIATE } from './events';
import type { BallSlot, World } from './types';
import type { SnapshotRing } from './ring';
import type { Playout } from './playout';
import type { BatchPlan, TickFrame } from './segment';
import type { DeriveScratch } from './derive';
import type { Tuning } from '../config/tuning';
import type { ControlEvent } from '../session/types';
import type { BatchItem, GameUpdates, InitialState, WireBall } from '../protocol/messages';
import { SnapshotRing as Ring } from './ring';
import { segmentBatch } from './segment';
import { deriveLoose, deriveTick, diffGrid } from './derive';
import { allocSlot, freeSlot } from './world';
import { FULL_RADIUS_SET, rMin } from './radius';
import { seatOnJoined, seatOnLeft, seatOnLobby, seatOnPaddle, seatTickSafety, seatsFromInitial } from './seats';
import { BALL_R0 } from '../config/constants';

export interface ReducerCtx { world: World; ring: SnapshotRing; playout: Playout; queue: EventQueue; scratch: DeriveScratch; nowMs: number; tuning: Tuning }
export interface MutableIngestResult { controls: ControlEvent[]; ticks: number; boardReady: boolean }

function fillBall(s: BallSlot, b: WireBall, tick: number, nowMs: number): void {
  s.owner = b.ownerIndex as BallSlot['owner'];
  s.permanent = b.isPermanent;
  s.phasing = b.phasing;
  s.x = b.x;
  s.y = b.y;
  s.vx = b.vx;
  s.vy = b.vy;
  s.collided = b.collided;
  s.r0 = b.radius;
  s.radiusSet = 1;
  s.radius = b.radius;
  s.spawnTick = tick;
  s.spawnedAtMs = nowMs;
  s.phaseStartTick = -1;
  s.removedTick = -1;
}

/** Applies the admission snapshot. Balls are cause `snapshot` (no presentation). Ends with ring.push(0, w). */
export function applyInitial(ctx: ReducerCtx, msg: InitialState): void {
  const w = ctx.world;
  // The runtime resets before every admission; a second snapshot in one epoch replaces the entities.
  for (let slot = 0; slot < w.balls.length; slot++) if (w.balls[slot].live || w.balls[slot].removedTick >= 0) freeSlot(w, slot);
  if (w.tick !== 0) {
    ctx.ring.clear();
    w.tick = 0;
  }
  seatsFromInitial(ctx, msg);
  const q = ctx.queue;
  for (const b of msg.balls) {
    const slot = allocSlot(w, b.id);
    if (slot < 0) continue;
    fillBall(w.balls[slot], b, 0, ctx.nowMs);
    q.push({
      k: 'ballSpawned', ball: b.id, owner: w.balls[slot].owner, permanent: b.isPermanent, cause: 'snapshot',
      tick: 0, seq: q.nextSeq(), x: b.x, y: b.y, conf: 1, stale: false,
    });
  }
  ctx.ring.push(0, w);
}

/** One item that is not a position update, applied in list order and logged for derivation. Lobby and
 *  control items are handled once per batch, after the frames. */
function applyItem(ctx: ReducerCtx, u: BatchItem, tick: number): void {
  const w = ctx.world;
  const sc = ctx.scratch;
  switch (u.messageType) {
    case 'ballOwnerChanged': {
      const slot = w.slotById.get(u.id);
      if (slot === undefined || !w.balls[slot].live) break;
      const s = w.balls[slot];
      const to = u.newOwnerIndex as BallSlot['owner'];
      sc.logOwner(slot, s.owner, to);
      s.owner = to;
      break;
    }
    case 'scoreUpdate': {
      const s = w.seats[u.index as Seat];
      sc.logScore(u.index as Seat, u.score, s.score, s.scoreKnown);
      s.score = u.score;
      s.scoreKnown = true;
      break;
    }
    case 'ballSpawned': {
      const slot = allocSlot(w, u.ball.id);
      if (slot < 0) break;
      fillBall(w.balls[slot], u.ball, tick, ctx.nowMs);
      sc.startOwner[slot] = w.balls[slot].owner;
      sc.prevPresent[slot] = 0;
      sc.missing[slot] = 0;
      sc.logSpawn(slot, u.ball.x, u.ball.y, false);
      break;
    }
    case 'ballRemoved': {
      const slot = w.slotById.get(u.id);
      if (slot === undefined || !w.balls[slot].live) break;
      const s = w.balls[slot];
      s.live = false;
      s.removedTick = tick;
      sc.logRemoval(slot, false);
      break;
    }
    case 'playerJoined':
      seatOnJoined(ctx, u, tick);
      break;
    case 'playerLeft':
      seatOnLeft(ctx, u, tick);
      break;
    default:
      break;   // lobbyState and controls: after the frames; fullGridUpdate never reaches here
  }
  sc.ord++;
}

/** Captures row k-1 of every slot before tick k's items and positions are applied. */
function captureRows(w: World, sc: DeriveScratch): void {
  for (let slot = 0; slot < w.balls.length; slot++) {
    const s = w.balls[slot];
    sc.startOwner[slot] = s.owner;
    sc.prevPresent[slot] = s.live ? 1 : 0;
    sc.prevX[slot] = s.x;
    sc.prevY[slot] = s.y;
    sc.prevVx[slot] = s.vx;
    sc.prevVy[slot] = s.vy;
    sc.prevPhasing[slot] = s.phasing ? 1 : 0;
  }
}

function applyFrame(ctx: ReducerCtx, f: TickFrame, k: number): void {
  const w = ctx.world;
  const sc = ctx.scratch;
  sc.beginTick(k);
  captureRows(w, sc);
  for (let n = 0; n < f.pre.length; n++) applyItem(ctx, f.pre[n], k);
  let seenMask = 0;
  for (let n = 0; n < f.paddles.length; n++) {
    seatOnPaddle(ctx, f.paddles[n], k);
    seenMask |= 1 << f.paddles[n].index;
  }
  for (let n = 0; n < f.balls.length; n++) {
    const u = f.balls[n];
    let slot = w.slotById.get(u.id);
    if (slot === undefined || !w.balls[slot].live) {
      // A ball the client never saw spawn (a dropped item, or a trimmed recording): heal it with an unknown
      // owner and radius, so the lattice starts full and the first wall bounces settle it.
      slot = allocSlot(w, u.id);
      if (slot < 0) continue;
      const s = w.balls[slot];
      s.owner = -1;
      s.r0 = BALL_R0;
      s.radiusSet = FULL_RADIUS_SET;
      s.radius = BALL_R0;
      s.radius = rMin(s);
      s.spawnTick = k;
      s.spawnedAtMs = ctx.nowMs;
      s.phaseStartTick = u.phasing ? k : -1;
      sc.startOwner[slot] = -1;
      sc.prevPresent[slot] = 0;
      sc.prevPhasing[slot] = u.phasing ? 1 : 0;
      sc.logSpawn(slot, u.x, u.y, true);
    }
    const s = w.balls[slot];
    s.x = u.x;
    s.y = u.y;
    s.vx = u.vx;
    s.vy = u.vy;
    s.phasing = u.phasing;
    s.collided = u.collided;
    sc.seen[slot] = 1;
    sc.missing[slot] = 0;
  }
  // The server sends every ball every tick: a ball missing for missingPaddleTicks ticks was lost silently.
  const limit = ctx.tuning.derive.missingPaddleTicks;
  for (let slot = 0; slot < w.balls.length; slot++) {
    const s = w.balls[slot];
    if (!s.live || sc.seen[slot] === 1 || s.spawnTick >= k) continue;
    if (++sc.missing[slot] >= limit) {
      s.live = false;
      s.removedTick = k;
      sc.logRemoval(slot, true);
    }
  }
  w.tick = k;
  ctx.ring.push(k, w);
  deriveTick(ctx, k, f);
  seatTickSafety(ctx, seenMask, k);
}

/** Applies one gameUpdates batch. With frameCount === 0 it ends with ring.push(w.tick, w); it frees every slot
 *  whose removedTick >= 0 && w.tick - removedTick >= SnapshotRing.CAP (and, while the playout has not started,
 *  every removed slot at once). Only this function frees slots. */
export function applyBatch(ctx: ReducerCtx, msg: GameUpdates, plan: BatchPlan, out: MutableIngestResult): void {
  const w = ctx.world;
  const sc = ctx.scratch;
  const q = ctx.queue;
  out.controls.length = 0;
  out.ticks = 0;
  out.boardReady = false;
  segmentBatch(msg.updates, plan);
  sc.beginBatch();

  const kFirst = w.tick + 1;
  for (let j = 0; j < plan.frameCount; j++) applyFrame(ctx, plan.frames[j], w.tick + 1);

  // Items between ticks take the next tick once play has started (the queue releases them when display time
  // gets there); before play they take the current tick, whose row is overwritten below, so they show at once.
  const playing = ctx.playout.started || plan.frameCount > 0;
  const stamp = playing ? w.tick + 1 : w.tick;
  const loose = plan.frameCount === 0 ? plan.headless : plan.tail;
  if (loose.length > 0) {
    sc.beginLoose();
    for (let n = 0; n < loose.length; n++) applyItem(ctx, loose[n], stamp);
    deriveLoose(ctx, stamp);
  }

  if (plan.grid !== null) {
    const firstGrid = !w.gridKnown;
    const kLast = w.tick;
    diffGrid(ctx, plan.grid, plan.frameCount > 0 ? kFirst : kLast, kLast);
    if (firstGrid && w.gridKnown) out.boardReady = true;
  }

  if (plan.lobby !== null) seatOnLobby(ctx, plan.lobby, stamp);

  for (let n = 0; n < plan.controls.length; n++) {
    const c = plan.controls[n];
    const x = w.canvas / 2;
    if (c.messageType === 'gameStartCountdown') {
      q.push({ k: 'countdown', seconds: c.seconds, tick: IMMEDIATE, seq: q.nextSeq(), x, y: x, conf: 1, stale: false });
      out.controls.push({ k: 'countdown', seconds: c.seconds });
    } else if (c.messageType === 'gameStartCancelled') {
      q.push({ k: 'countdownCancelled', tick: IMMEDIATE, seq: q.nextSeq(), x, y: x, conf: 1, stale: false });
      out.controls.push({ k: 'cancelled', reason: c.reason });
    } else {
      q.push({ k: 'go', tick: IMMEDIATE, seq: q.nextSeq(), x, y: x, conf: 1, stale: false });
      out.controls.push({ k: 'started' });
    }
  }

  ctx.playout.onTicks(plan.frameCount, ctx.nowMs);
  out.ticks = plan.frameCount;
  if (plan.frameCount === 0) ctx.ring.push(w.tick, w);

  const started = ctx.playout.started;
  for (let slot = 0; slot < w.balls.length; slot++) {
    const s = w.balls[slot];
    if (s.removedTick < 0) continue;
    if (!started || w.tick - s.removedTick >= Ring.CAP) {
      freeSlot(w, slot);
      sc.missing[slot] = 0;
    }
  }
}
