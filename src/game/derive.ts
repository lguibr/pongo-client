// Event derivation from the frozen protocol (5.4). Every event names its wire evidence: paddle hits come from
// ownership messages, goals from negative score deltas, bounces from velocity sign flips, brick events from
// grid diffs, the radius from bounce geometry, power-ups from same-batch correlation.
//
// The reducer applies each tick's `pre` items first and logs them here (DeriveScratch), then applies the
// positions, pushes the ring row, and calls deriveTick. Items between ticks (a batch's tail) go through
// deriveLoose. The grid is diffed once per batch by diffGrid.

import type { Owner, Seat, Wall } from './events';
import { IMMEDIATE, SeatConn } from './events';
import type { BallSlot, World } from './types';
import type { ReducerCtx } from './reducer';
import type { TickFrame } from './segment';
import type { FullGridUpdate } from '../protocol/messages';
import { RING_FLAG } from './ring';
import { addMassCandidate, canNarrow, narrowOnWall, overlapsWall, rMax, rMin } from './radius';
import { seatPoint } from './seats';
import { BALL_R0, BRICK_FIELD, CELLS, CellType, MAX_BALLS, PHASE_MS, SPAWN_JITTER_PX, TICK_MS } from '../config/constants';
import { log } from '../lib/log';

const B = MAX_BALLS;
/** History depth in ticks (attribution looks at a batch's ticks plus 2 earlier). */
export const HISTORY = 16;
const LOG = 64;          // per-tick log capacity per kind
const H_SCORES = 16;     // score entries kept per history tick
const H_SPAWNS = 16;     // spawns kept per history tick
const CHAIN = 32;        // destroy ticks kept per scorer for chain counting
const ROLE_NONE = 0, ROLE_CONCEDED = 1, ROLE_SCORED = 2;

/** Typed arrays zeroed per tick, plus a history of the last 16 ticks for attribution. */
export class DeriveScratch {
  k = -1;
  // ---- per-tick logs of pre (or tail) items, in list order
  ord = 0;
  scoreN = 0;
  readonly scoreSeat = new Int8Array(LOG);
  readonly scoreValue = new Int32Array(LOG);
  readonly scorePrev = new Int32Array(LOG);
  readonly scorePrevKnown = new Uint8Array(LOG);
  readonly scoreOrd = new Int32Array(LOG);
  readonly scoreRole = new Uint8Array(LOG);
  ownerN = 0;
  readonly ownerSlot = new Int16Array(LOG);
  readonly ownerFrom = new Int8Array(LOG);
  readonly ownerTo = new Int8Array(LOG);
  readonly ownerOrd = new Int32Array(LOG);
  spawnN = 0;
  readonly spawnSlot = new Int16Array(LOG);
  readonly spawnX = new Float64Array(LOG);
  readonly spawnY = new Float64Array(LOG);
  readonly spawnHealed = new Uint8Array(LOG);
  removeN = 0;
  readonly removeSlot = new Int16Array(LOG);
  readonly removeMissing = new Uint8Array(LOG);
  readonly removeOrd = new Int32Array(LOG);
  // ---- per slot, captured at the start of each tick (row k-1)
  readonly startOwner = new Int8Array(B);
  readonly prevPresent = new Uint8Array(B);
  readonly prevX = new Float64Array(B);
  readonly prevY = new Float64Array(B);
  readonly prevVx = new Float64Array(B);
  readonly prevVy = new Float64Array(B);
  readonly prevPhasing = new Uint8Array(B);
  readonly seen = new Uint8Array(B);
  readonly goalWalls = new Uint8Array(B);
  // ---- per slot, across ticks
  readonly missing = new Uint8Array(B);
  readonly repeatCount = new Int32Array(B);
  readonly repeatId = new Int32Array(B).fill(-1);
  // ---- history ring of HISTORY ticks
  readonly hTick = new Int32Array(HISTORY).fill(-1);
  readonly hPaddleHit = new Uint8Array(HISTORY * B);
  readonly hContact = new Uint8Array(HISTORY * B);
  readonly hPhaseStart = new Uint8Array(HISTORY * B);
  readonly hVelChange = new Uint8Array(HISTORY * B);
  readonly hScoreN = new Int32Array(HISTORY);
  readonly hScoreSeat = new Int8Array(HISTORY * H_SCORES);
  readonly hScoreDelta = new Int32Array(HISTORY * H_SCORES);
  readonly hScoreBrick = new Uint8Array(HISTORY * H_SCORES);
  readonly hScoreUsed = new Uint8Array(HISTORY * H_SCORES);
  readonly hSpawnN = new Int32Array(HISTORY);
  readonly hSpawnX = new Float64Array(HISTORY * H_SPAWNS);
  readonly hSpawnY = new Float64Array(HISTORY * H_SPAWNS);
  readonly hSpawnOwner = new Int8Array(HISTORY * H_SPAWNS);
  readonly hSpawnPerm = new Uint8Array(HISTORY * H_SPAWNS);
  readonly hSpawnUsed = new Uint8Array(HISTORY * H_SPAWNS);
  // ---- per batch
  goneMask = 0;             // seats that went Grace -> Empty in this batch (their second playerLeft)
  readonly goneTick = new Int32Array(4).fill(-1);   // the tick stamp of that playerLeft, -1 when none
  readonly goneOrd = new Int32Array(4);             // its list position among that tick's (or the tail's) items
  silentN = 0;              // grid cells that changed with no event; the runtime shows them at once, faded
  readonly silentCells = new Int32Array(1024);
  // ---- chains, per scorer seat 0..3 and 4 for unowned
  readonly chainTicks = new Int32Array(5 * CHAIN).fill(-1_000_000);
  readonly chainHead = new Int32Array(5);
  warnedGrid = false;

  reset(): void {
    this.k = -1;
    this.clearLogs();
    this.missing.fill(0);
    this.repeatCount.fill(0);
    this.repeatId.fill(-1);
    this.hTick.fill(-1);
    this.hPaddleHit.fill(0);
    this.hContact.fill(0);
    this.hPhaseStart.fill(0);
    this.hVelChange.fill(0);
    this.hScoreN.fill(0);
    this.hSpawnN.fill(0);
    this.goneMask = 0;
    this.goneTick.fill(-1);
    this.silentN = 0;
    this.chainTicks.fill(-1_000_000);
    this.chainHead.fill(0);
    this.warnedGrid = false;
  }

  /** Starts tick k: clears the per-tick logs and claims the history row for k. */
  beginTick(k: number): void {
    this.k = k;
    this.clearLogs();
    this.seen.fill(0);
    this.goalWalls.fill(0);
    const h = ((k % HISTORY) + HISTORY) % HISTORY;
    this.hTick[h] = k;
    this.hPaddleHit.fill(0, h * B, h * B + B);
    this.hContact.fill(0, h * B, h * B + B);
    this.hPhaseStart.fill(0, h * B, h * B + B);
    this.hVelChange.fill(0, h * B, h * B + B);
    this.hScoreN[h] = 0;
    this.hSpawnN[h] = 0;
  }

  /** Starts a run of between-tick items (a tail): clears the logs, leaves the history alone. */
  beginLoose(): void {
    this.clearLogs();
  }

  beginBatch(): void {
    this.goneMask = 0;
    this.goneTick.fill(-1);
    this.silentN = 0;
  }

  /** History row of `tick`, or -1 when it is no longer (or not yet) held. */
  hIndex(tick: number): number {
    if (tick < 0) return -1;
    const h = tick % HISTORY;
    return this.hTick[h] === tick ? h : -1;
  }

  /** A slot's owner at list position `ord` of the current tick: the tick-start owner, then its logged changes. */
  ownerAt(slot: number, ord: number): Owner {
    let o = this.startOwner[slot];
    for (let j = 0; j < this.ownerN; j++) if (this.ownerSlot[j] === slot && this.ownerOrd[j] < ord) o = this.ownerTo[j];
    return o as Owner;
  }

  logScore(seat: Seat, value: number, prev: number, prevKnown: boolean): void {
    if (this.scoreN >= LOG) return;
    const j = this.scoreN++;
    this.scoreSeat[j] = seat;
    this.scoreValue[j] = value;
    this.scorePrev[j] = prev;
    this.scorePrevKnown[j] = prevKnown ? 1 : 0;
    this.scoreOrd[j] = this.ord;
    this.scoreRole[j] = ROLE_NONE;
  }

  logOwner(slot: number, from: Owner, to: Owner): void {
    if (this.ownerN >= LOG) return;
    const j = this.ownerN++;
    this.ownerSlot[j] = slot;
    this.ownerFrom[j] = from;
    this.ownerTo[j] = to;
    this.ownerOrd[j] = this.ord;
  }

  logSpawn(slot: number, x: number, y: number, healed: boolean): void {
    if (this.spawnN >= LOG) return;
    const j = this.spawnN++;
    this.spawnSlot[j] = slot;
    this.spawnX[j] = x;
    this.spawnY[j] = y;
    this.spawnHealed[j] = healed ? 1 : 0;
  }

  logRemoval(slot: number, missing: boolean): void {
    if (this.removeN >= LOG) return;
    const j = this.removeN++;
    this.removeSlot[j] = slot;
    this.removeMissing[j] = missing ? 1 : 0;
    this.removeOrd[j] = this.ord;
  }

  private clearLogs(): void {
    this.ord = 0;
    this.scoreN = 0;
    this.ownerN = 0;
    this.spawnN = 0;
    this.removeN = 0;
  }
}

// ---------------------------------------------------------------------------------------------- helpers

const pt = { x: 0, y: 0 };
const rowTmp = new Float32Array(6);

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Position along a wall: y/canvas for walls 0 and 2, x/canvas for walls 1 and 3. */
function wallU(wall: Wall, x: number, y: number, canvas: number): number {
  return clamp01((wall === 0 || wall === 2 ? y : x) / canvas);
}

/** The point on the wall nearest (x, y). */
function wallPoint(wall: Wall, x: number, y: number, canvas: number, out: { x: number; y: number }): void {
  const cx = x < 0 ? 0 : x > canvas ? canvas : x;
  const cy = y < 0 ? 0 : y > canvas ? canvas : y;
  switch (wall) {
    case 0:
      out.x = canvas;
      out.y = cy;
      return;
    case 1:
      out.x = cx;
      out.y = 0;
      return;
    case 2:
      out.x = 0;
      out.y = cy;
      return;
    default:
      out.x = cx;
      out.y = canvas;
  }
}

/** How far a circle reaches past the wall's trigger line (larger is deeper). */
function penetration(wall: Wall, x: number, y: number, r: number, canvas: number): number {
  switch (wall) {
    case 0:
      return x + r - canvas;
    case 1:
      return r - y;
    case 2:
      return r - x;
    default:
      return y + r - canvas;
  }
}

/** Where along paddle `seat` a ball centre projects, 0..1 from the wire's top-left corner. */
function paddleU(w: Readonly<World>, seat: Seat, x: number, y: number): number {
  const p = w.paddles[seat];
  if (seat === 0 || seat === 2) return p.h > 0 ? clamp01((y - (p.y - p.h / 2)) / p.h) : 0.5;
  return p.w > 0 ? clamp01((x - (p.x - p.w / 2)) / p.w) : 0.5;
}

function circleHitsRect(x: number, y: number, r: number, x0: number, y0: number, x1: number, y1: number): boolean {
  const cx = x < x0 ? x0 : x > x1 ? x1 : x;
  const cy = y < y0 ? y0 : y > y1 ? y1 : y;
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy < r * r;
}

function sign(v: number): number {
  return v > 0 ? 1 : v < 0 ? -1 : 0;
}

/** Narrows the radius on an R3/R4 trigger and reports a change (R14, and R13 mass after a destroy). */
function narrowAndReport(ctx: ReducerCtx, slot: number, s: BallSlot, wall: Wall, k: number, hitNear: boolean): void {
  const sc = ctx.scratch;
  const canvas = ctx.world.canvas;
  if (!sc.prevPresent[slot] || !canNarrow(s, wall, sc.prevX[slot], sc.prevY[slot], canvas, hitNear)) return;
  const from = rMin(s);
  if (!narrowOnWall(s, wall, sc.prevX[slot], sc.prevY[slot], s.x, s.y, canvas)) return;
  const q = ctx.queue;
  q.push({ k: 'ballResized', ball: s.id, from, to: s.radius, tick: k, seq: q.nextSeq(), x: s.x, y: s.y, conf: 1, stale: false });
  if (s.lastDestroyTick >= 0) {
    q.push({ k: 'powerUp', ball: s.id, kind: 'mass', tick: k, seq: q.nextSeq(), x: s.x, y: s.y, conf: 1, stale: false });
  }
}

// ---------------------------------------------------------------------------------------------- emitters

/** R1 and R2 for the owner log's paddle messages (newOwnerIndex >= 0). `withPaddle` is false between ticks,
 *  where no paddle contact can happen. */
function emitPaddleOwners(ctx: ReducerCtx, tick: number, withPaddle: boolean): void {
  const sc = ctx.scratch;
  const w = ctx.world;
  const q = ctx.queue;
  const h = withPaddle ? sc.hIndex(tick) : -1;
  for (let j = 0; j < sc.ownerN; j++) {
    const to = sc.ownerTo[j] as Owner;
    if (to < 0) continue;
    const slot = sc.ownerSlot[j];
    const s = w.balls[slot];
    const from = sc.ownerFrom[j] as Owner;
    const seat = to as Seat;
    if (withPaddle) {
      q.push({
        k: 'paddleHit', ball: s.id, seat, speed: Math.hypot(s.vx, s.vy), prevOwner: from, u: paddleU(w, seat, s.x, s.y),
        tick, seq: q.nextSeq(), x: s.x, y: s.y, conf: 1, stale: false,
      });
      if (h >= 0) sc.hPaddleHit[h * B + slot] = 1;
    }
    if (to !== from) {
      q.push({ k: 'ownerChanged', ball: s.id, from, to, cause: 'paddle', tick, seq: q.nextSeq(), x: s.x, y: s.y, conf: 1, stale: false });
    }
  }
}

/** R2 for the owner log's releases (newOwnerIndex -1), run after R3 has marked this tick's goal walls. The server
 *  has two sources of -1: an own-wall concede (game_actor_physics.go:209-212), which is cause ownGoal when R3
 *  matched this ball to a goal on the owner's wall at this tick, and the grace expiry (game_actor_disconnect.go:
 *  88-93), which is cause released when the batch holds the owner seat's second playerLeft. Any other -1 keeps
 *  ownGoal as a fallback with conf 0.5. Between ticks (`inTick` false) no goal can happen. */
function emitReleasedOwners(ctx: ReducerCtx, tick: number, inTick: boolean): void {
  const sc = ctx.scratch;
  const w = ctx.world;
  const q = ctx.queue;
  for (let j = 0; j < sc.ownerN; j++) {
    const to = sc.ownerTo[j] as Owner;
    const from = sc.ownerFrom[j] as Owner;
    if (to >= 0 || from < 0) continue;
    const slot = sc.ownerSlot[j];
    const s = w.balls[slot];
    const ownGoal = inTick && (sc.goalWalls[slot] & (1 << from)) !== 0;
    const released = !ownGoal && (sc.goneMask & (1 << from)) !== 0;
    q.push({
      k: 'ownerChanged', ball: s.id, from, to, cause: released ? 'released' : 'ownGoal',
      tick, seq: q.nextSeq(), x: s.x, y: s.y, conf: ownGoal || released ? 1 : 0.5, stale: false,
    });
  }
}

/** R10 for every logged scoreUpdate, with the cause R3 assigned; also fills the history for points matching. */
function emitScores(ctx: ReducerCtx, tick: number): void {
  const sc = ctx.scratch;
  const w = ctx.world;
  const q = ctx.queue;
  const h = sc.hIndex(tick);
  for (let j = 0; j < sc.scoreN; j++) {
    const seat = sc.scoreSeat[j] as Seat;
    const known = sc.scorePrevKnown[j] === 1;
    const to = sc.scoreValue[j];
    const delta = known ? to - sc.scorePrev[j] : 0;
    const role = sc.scoreRole[j];
    const cause = role === ROLE_CONCEDED ? 'conceded' : role === ROLE_SCORED ? 'scored' : known && delta > 0 ? 'brick' : 'unknown';
    seatPoint(w, seat, pt);
    q.push({
      k: 'score', seat, from: known ? sc.scorePrev[j] : null, to, delta, cause,
      tick, seq: q.nextSeq(), x: pt.x, y: pt.y, conf: 1, stale: false,
    });
    if (h >= 0 && sc.hScoreN[h] < H_SCORES) {
      const i = h * H_SCORES + sc.hScoreN[h]++;
      sc.hScoreSeat[i] = seat;
      sc.hScoreDelta[i] = delta;
      sc.hScoreBrick[i] = cause === 'brick' ? 1 : 0;
      sc.hScoreUsed[i] = 0;
    }
  }
}

/** R8 for logged spawns; power-up spawns go to the history for split inference. */
function emitSpawns(ctx: ReducerCtx, tick: number): void {
  const sc = ctx.scratch;
  const w = ctx.world;
  const q = ctx.queue;
  const h = sc.hIndex(tick);
  for (let j = 0; j < sc.spawnN; j++) {
    const slot = sc.spawnSlot[j];
    const s = w.balls[slot];
    const healed = sc.spawnHealed[j] === 1;
    const x = sc.spawnX[j];
    const y = sc.spawnY[j];
    q.push({
      k: 'ballSpawned', ball: s.id, owner: s.owner, permanent: s.permanent,
      cause: healed ? 'snapshot' : s.permanent ? 'join' : 'powerUp',
      tick, seq: q.nextSeq(), x, y, conf: 1, stale: false,
    });
    if (!healed && h >= 0 && sc.hSpawnN[h] < H_SPAWNS) {
      const i = h * H_SPAWNS + sc.hSpawnN[h]++;
      sc.hSpawnX[i] = x;
      sc.hSpawnY[i] = y;
      sc.hSpawnOwner[i] = s.owner;
      sc.hSpawnPerm[i] = s.permanent ? 1 : 0;
      sc.hSpawnUsed[i] = 0;
    }
  }
}

/** R5 and R7 for logged removals. Absorption needs tick physics, so `inTick` is false between ticks. A removal
 *  listed after its owner's second playerLeft in the same run of items is that grace expiry removing the leaver's
 *  temporary balls (game_actor_disconnect.go, handleStopReconnectTimerMsg): it is released, never tested for
 *  absorption, even when the ball sits beside an Empty or Grace wall. */
function emitRemovals(ctx: ReducerCtx, tick: number, inTick: boolean): void {
  const sc = ctx.scratch;
  const w = ctx.world;
  const q = ctx.queue;
  const canvas = w.canvas;
  for (let j = 0; j < sc.removeN; j++) {
    const s = w.balls[sc.removeSlot[j]];
    const missing = sc.removeMissing[j] === 1;
    const expiredGrace = s.owner >= 0 && sc.goneTick[s.owner] === tick && sc.goneOrd[s.owner] < sc.removeOrd[j];
    // The slot still holds row k-1: the server removes an absorbed ball right after Move at k.
    const px = s.x + s.vx;
    const py = s.y + s.vy;
    let absorbed = -1;
    if (inTick && !missing && !expiredGrace && !s.permanent && !s.phasing) {
      const r = rMax(s);
      for (let i = 0; i < 4; i++) {
        const wall = i as Wall;
        if (w.seats[wall].conn !== SeatConn.Connected && overlapsWall(wall, px, py, r, canvas)) {
          absorbed = wall;
          break;
        }
      }
    }
    if (absorbed >= 0) {
      const wall = absorbed as Wall;
      wallPoint(wall, px, py, canvas, pt);
      q.push({ k: 'absorbed', ball: s.id, wall, u: wallU(wall, px, py, canvas), tick, seq: q.nextSeq(), x: pt.x, y: pt.y, conf: 0.95, stale: false });
      q.push({ k: 'ballRemoved', ball: s.id, owner: s.owner, cause: 'absorbed', tick, seq: q.nextSeq(), x: px, y: py, conf: 0.95, stale: false });
    } else {
      const released = s.owner >= 0 && (sc.goneMask & (1 << s.owner)) !== 0;
      q.push({
        k: 'ballRemoved', ball: s.id, owner: s.owner, cause: released ? 'released' : 'expired',
        tick, seq: q.nextSeq(), x: s.x, y: s.y, conf: missing ? 0.5 : 1, stale: false,
      });
    }
  }
}

/** R3 over the ordered score log. Marks roles for R10 and matched walls for R4. The server lists each goal as the
 *  conceder's -1 followed either by the scorer's +1 or, for an own goal, by ballOwnerChanged(-1) from the
 *  conceder (game_actor_physics.go:192-212). So the item after a -1 can name its ball: a +1 names the ball's
 *  tick-start owner, an own-goal release names the ball itself. Points with such evidence pick first; the rest
 *  then take the deepest overlap among the balls still free on their wall, so a depth pick never takes a ball
 *  another point is bound to. Goals are pushed in list order. */
function deriveGoals(ctx: ReducerCtx, k: number, frame: TickFrame): void {
  const sc = ctx.scratch;
  const w = ctx.world;
  const q = ctx.queue;
  const canvas = w.canvas;
  const mergeTicks = ctx.tuning.fx.goalMergeTicks;
  const h = sc.hIndex(k);
  const h1 = sc.hIndex(k - 1);
  for (let j = 0; j < sc.scoreN; j++) {
    gState[j] = G_NONE;
    if (sc.scorePrevKnown[j] !== 1 || sc.scoreValue[j] >= sc.scorePrev[j]) continue;
    const wall = sc.scoreSeat[j];
    const ord = sc.scoreOrd[j];
    // The +1 immediately after the -1 in the list, for a seat other than the conceder.
    const n = j + 1;
    gCand[j] = n < sc.scoreN && sc.scoreOrd[n] === ord + 1 && sc.scorePrevKnown[n] === 1
      && sc.scoreValue[n] - sc.scorePrev[n] === 1 && sc.scoreSeat[n] !== wall ? sc.scoreSeat[n] : -2;
    // The own-goal release immediately after the -1: the conceder's ball, which no +1 follows.
    gForced[j] = -1;
    for (let o = 0; o < sc.ownerN; o++) {
      if (sc.ownerOrd[o] === ord + 1 && sc.ownerTo[o] === -1 && sc.ownerFrom[o] === wall) gForced[j] = sc.ownerSlot[o];
    }
    gState[j] = G_PENDING;
    gSlot[j] = -1;
    gScorer[j] = -1;
    gRemoved[j] = 0;
  }
  // Pass 1: the points whose ball the next item names.
  for (let j = 0; j < sc.scoreN; j++) {
    if (gState[j] !== G_PENDING || (gCand[j] < 0 && gForced[j] < 0)) continue;
    selectGoalBall(ctx, j, frame, true);
    if (sel.pref) resolveGoal(sc, j, gCand[j] >= 0 ? gCand[j] : -1);
  }
  // Pass 2: the rest (including those whose named ball did not qualify), by deepest overlap.
  for (let j = 0; j < sc.scoreN; j++) {
    if (gState[j] !== G_PENDING) continue;
    selectGoalBall(ctx, j, frame, false);
    if (sel.slot >= 0) resolveGoal(sc, j, -1);
    else gState[j] = G_DONE;
  }
  for (let j = 0; j < sc.scoreN; j++) {
    if (gState[j] === G_NONE) continue;
    const wall = sc.scoreSeat[j] as Wall;
    sc.scoreRole[j] = ROLE_CONCEDED;
    const best = gSlot[j];
    if (best < 0) {
      wallPoint(wall, canvas / 2, canvas / 2, canvas, pt);
      q.push({ k: 'goal', ball: -1, wall, scorer: -1, repeat: 0, u: 0.5, tick: k, seq: q.nextSeq(), x: pt.x, y: pt.y, conf: 0.5, stale: false });
      continue;
    }
    const s = w.balls[best];
    const gx = gX[j];
    const gy = gY[j];
    const scorer = gScorer[j] as Owner;
    if (scorer >= 0) sc.scoreRole[j + 1] = ROLE_SCORED;
    let repeat = 0;
    if (s.lastGoalWall === wall && s.lastGoalTick >= 0 && k - s.lastGoalTick <= mergeTicks) {
      repeat = (sc.repeatId[best] === s.id ? sc.repeatCount[best] : 0) + 1;
    }
    sc.repeatCount[best] = repeat;
    sc.repeatId[best] = s.id;
    s.lastGoalTick = k;
    s.lastGoalWall = wall;
    wallPoint(wall, gx, gy, canvas, pt);
    q.push({
      k: 'goal', ball: s.id, wall, scorer, repeat, u: wallU(wall, gx, gy, canvas),
      tick: k, seq: q.nextSeq(), x: pt.x, y: pt.y, conf: 0.9, stale: false,
    });
    if (gRemoved[j] === 1) continue;   // no row at k to bound the radius with
    const hitNear = (h >= 0 && sc.hPaddleHit[h * B + best] === 1) || (h1 >= 0 && sc.hPaddleHit[h1 * B + best] === 1);
    narrowAndReport(ctx, best, s, wall, k, hitNear);
  }
}

/** R3 per conceded point, indexed like the score log; filled by deriveGoals. */
const G_NONE = 0, G_PENDING = 1, G_DONE = 2;
const gState = new Uint8Array(LOG);
const gCand = new Int8Array(LOG);      // the seat of the +1 that follows, -2 when none
const gForced = new Int16Array(LOG);   // the slot the own-goal ballOwnerChanged(-1) that follows names, -1 when none
const gSlot = new Int16Array(LOG);     // the matched ball, -1 when none
const gScorer = new Int8Array(LOG);
const gRemoved = new Uint8Array(LOG);  // the matched ball was removed at k (tested at its predicted position)
const gX = new Float64Array(LOG);
const gY = new Float64Array(LOG);

/** Records `sel` as the ball of conceded point j and takes its wall for this tick. */
function resolveGoal(sc: DeriveScratch, j: number, scorer: number): void {
  const slot = sel.slot;
  gState[j] = G_DONE;
  gSlot[j] = slot;
  gScorer[j] = scorer;
  gRemoved[j] = sel.removed ? 1 : 0;
  gX[j] = sel.x;
  gY[j] = sel.y;
  sc.goalWalls[slot] |= 1 << sc.scoreSeat[j];
}

/** The R3 selection for conceded point j, into `sel`. Present balls come first. A temporary ball can score on a
 *  connected wall and be absorbed at an empty adjacent wall in the same tick (game_actor_physics.go:41-56,
 *  213-218), so it has no row at k; balls removed at k are tested at their predicted position, as R5 does. With
 *  `prefer` the point's named ball ranks first and removed balls are tried until one is found; without it (the
 *  depth pass) removed balls are tried only when no present ball qualifies. */
function selectGoalBall(ctx: ReducerCtx, j: number, frame: TickFrame, prefer: boolean): void {
  const sc = ctx.scratch;
  const w = ctx.world;
  const canvas = w.canvas;
  const slack = ctx.tuning.derive.goalOverlapSlackPx;
  const wall = sc.scoreSeat[j] as Wall;
  const ord = sc.scoreOrd[j];
  const cand = prefer ? gCand[j] : -2;
  const forced = prefer ? gForced[j] : -1;
  sel.slot = -1;
  sel.pref = false;
  sel.depth = -Infinity;
  sel.removed = false;
  for (let b = 0; b < frame.balls.length; b++) {
    const slot = w.slotById.get(frame.balls[b].id);
    if (slot === undefined || sc.seen[slot] !== 1) continue;
    const s = w.balls[slot];
    if (!s.live) continue;
    if (sc.prevPresent[slot] === 1 && sc.prevPhasing[slot] === 1 && s.phasing) continue;   // phasingAtStart(k)
    const pref = slot === forced || (cand >= 0 && sc.ownerAt(slot, ord) === cand);
    considerGoalBall(sc, slot, wall, s.x, s.y, rMax(s), canvas, slack, pref, false);
  }
  if (prefer ? sel.pref : sel.slot >= 0) return;
  for (let r = 0; r < sc.removeN; r++) {
    if (sc.removeMissing[r] === 1) continue;
    const slot = sc.removeSlot[r];
    if (sc.prevPresent[slot] !== 1 || sc.prevPhasing[slot] === 1) continue;
    const px = sc.prevX[slot] + sc.prevVx[slot];
    const py = sc.prevY[slot] + sc.prevVy[slot];
    const pref = slot === forced || (cand >= 0 && sc.ownerAt(slot, ord) === cand);
    considerGoalBall(sc, slot, wall, px, py, rMax(w.balls[slot]), canvas, slack, pref, true);
  }
}

/** The R3 ball chosen so far for one conceded point: preferred (named) ball first, then the deepest overlap. */
const sel = { slot: -1, pref: false, depth: -Infinity, x: 0, y: 0, removed: false };

/** Offers one ball at (x, y) with overlap radius r to the R3 selection in `sel`. */
function considerGoalBall(
  sc: DeriveScratch, slot: number, wall: Wall, x: number, y: number, r: number, canvas: number, slack: number, pref: boolean,
  removed: boolean,
): void {
  if ((sc.goalWalls[slot] & (1 << wall)) !== 0) return;
  if (!overlapsWall(wall, x, y, r, canvas, slack)) return;
  const depth = penetration(wall, x, y, r, canvas);
  if (sel.slot < 0 || (pref && !sel.pref) || (pref === sel.pref && depth > sel.depth)) {
    sel.slot = slot;
    sel.pref = pref;
    sel.depth = depth;
    sel.x = x;
    sel.y = y;
    sel.removed = removed;
  }
}

/** R4, R6, R9 and the velocity history, for every ball present at k-1 and k. */
function deriveMotion(ctx: ReducerCtx, k: number, frame: TickFrame): void {
  const sc = ctx.scratch;
  const w = ctx.world;
  const q = ctx.queue;
  const canvas = w.canvas;
  const h = sc.hIndex(k);
  const h1 = sc.hIndex(k - 1);
  const phaseLimitMs = PHASE_MS + ctx.tuning.derive.phaseRetriggerSlackMs;
  for (let b = 0; b < frame.balls.length; b++) {
    const slot = w.slotById.get(frame.balls[b].id);
    if (slot === undefined || sc.seen[slot] !== 1) continue;
    const s = w.balls[slot];
    if (!s.live) continue;
    const i = h * B + slot;
    if (sc.prevPresent[slot] !== 1) continue;
    const hit = h >= 0 && sc.hPaddleHit[i] === 1;
    const hitNear = hit || (h1 >= 0 && sc.hPaddleHit[h1 * B + slot] === 1);
    const phasingAtStart = sc.prevPhasing[slot] === 1 && s.phasing;
    const pvx = sc.prevVx[slot];
    const pvy = sc.prevVy[slot];
    const r = rMax(s);
    const flipX = sign(pvx) * sign(s.vx) < 0;
    const flipY = sign(pvy) * sign(s.vy) < 0;
    const gw = sc.goalWalls[slot];
    let explX = hit || (gw & 0b0101) !== 0;
    let explY = hit || (gw & 0b1010) !== 0;
    if (!hit) {
      let wallX = -1;
      if (pvx > 0 && s.vx < 0 && (gw & 1) === 0 && overlapsWall(0, s.x, s.y, r, canvas)) wallX = 0;
      else if (pvx < 0 && s.vx > 0 && (gw & 4) === 0 && overlapsWall(2, s.x, s.y, r, canvas)) wallX = 2;
      let wallY = -1;
      if (pvy < 0 && s.vy > 0 && (gw & 2) === 0 && overlapsWall(1, s.x, s.y, r, canvas)) wallY = 1;
      else if (pvy > 0 && s.vy < 0 && (gw & 8) === 0 && overlapsWall(3, s.x, s.y, r, canvas)) wallY = 3;
      for (let n = 0; n < 2; n++) {
        const ww = n === 0 ? wallX : wallY;
        if (ww < 0) continue;
        const wall = ww as Wall;
        wallPoint(wall, s.x, s.y, canvas, pt);
        q.push({
          k: 'wallBounce', ball: s.id, wall, phasing: phasingAtStart, u: wallU(wall, s.x, s.y, canvas),
          tick: k, seq: q.nextSeq(), x: pt.x, y: pt.y, conf: 0.95, stale: false,
        });
        if (n === 0) explX = true;
        else explY = true;
        narrowAndReport(ctx, slot, s, wall, k, hitNear);
      }
    }
    if ((flipX && !explX) || (flipY && !explY)) {
      const v = Math.max(Math.abs(pvx), Math.abs(pvy), Math.abs(s.vx), Math.abs(s.vy));
      const lo = BRICK_FIELD[0] - r - v;
      const hi = BRICK_FIELD[1] + r + v;
      if (s.x >= lo && s.x <= hi && s.y >= lo && s.y <= hi) {
        q.push({ k: 'brickBounce', ball: s.id, tick: k, seq: q.nextSeq(), x: s.x, y: s.y, conf: 0.9, stale: false });
        s.lastBrickContactTick = k;
        s.brickContactX = s.x;
        s.brickContactY = s.y;
        if (h >= 0) sc.hContact[i] = 1;
      }
    }
    if (!hit && h >= 0 && (Math.abs(s.vx) !== Math.abs(pvx) || Math.abs(s.vy) !== Math.abs(pvy))) sc.hVelChange[i] = 1;
    // R9: phasing edges; a phase still set past PHASE_MS + slack was re-triggered by a later destroy.
    if (sc.prevPhasing[slot] !== 1 && s.phasing) {
      s.phaseStartTick = k;
      if (h >= 0) sc.hPhaseStart[i] = 1;
      q.push({ k: 'phaseStart', ball: s.id, tick: k, seq: q.nextSeq(), x: s.x, y: s.y, conf: 1, stale: false });
    } else if (sc.prevPhasing[slot] === 1 && !s.phasing) {
      q.push({ k: 'phaseEnd', ball: s.id, tick: k, seq: q.nextSeq(), x: s.x, y: s.y, conf: 1, stale: false });
    } else if (s.phasing && s.phaseStartTick >= 0 && (k - s.phaseStartTick) * TICK_MS > phaseLimitMs
      && s.lastDestroyTick > s.phaseStartTick) {
      s.phaseStartTick = s.lastDestroyTick;
    }
  }
}

/** Events for tick k, after its pre items were applied and logged and its row was pushed. */
export function deriveTick(ctx: ReducerCtx, k: number, frame: TickFrame): void {
  emitPaddleOwners(ctx, k, true);
  deriveGoals(ctx, k, frame);
  emitReleasedOwners(ctx, k, true);
  emitScores(ctx, k);
  deriveMotion(ctx, k, frame);
  emitRemovals(ctx, k, true);
  emitSpawns(ctx, k);
}

/** Events for items applied between ticks (a batch tail, or a batch with no frames), stamped at `tick`. */
export function deriveLoose(ctx: ReducerCtx, tick: number): void {
  emitPaddleOwners(ctx, tick, false);
  emitReleasedOwners(ctx, tick, false);
  emitScores(ctx, tick);
  emitRemovals(ctx, tick, false);
  emitSpawns(ctx, tick);
}

// ---------------------------------------------------------------------------------------------- grid

interface Attribution { slot: number; tick: number; conf: number; x: number; y: number; owner: Owner }
const attr: Attribution = { slot: -1, tick: 0, conf: 0, x: 0, y: 0, owner: -1 };

/** 5.4.4 attribute(i), over ticks kFirst-2..kLast. */
function attribute(ctx: ReducerCtx, cell: number, kFirst: number, kLast: number): Attribution {
  const w = ctx.world;
  const sc = ctx.scratch;
  const ring = ctx.ring;
  const cs = w.cellSize;
  const half = cs / 2;
  const cx = (cell % w.gridSize) * cs + half;
  const cy = Math.floor(cell / w.gridSize) * cs + half;
  const halfDiag = half * Math.SQRT2;
  const from = Math.max(kFirst - 2, ring.oldest, 0);
  let bestD = Infinity;
  attr.slot = -1;
  for (let t = kLast; t >= from; t--) {
    const ht = sc.hIndex(t);
    for (let slot = 0; slot < B; slot++) {
      // A ball spawned during tick t (a split child, placed on the very cell) did not take part in t's collisions.
      if (w.balls[slot].spawnTick >= t || !ring.readBall(t, slot, rowTmp, 0)) continue;
      const x = rowTmp[0];
      const y = rowTmp[1];
      const r = Math.max(rMax(w.balls[slot]), BALL_R0);
      const d = Math.hypot(x - cx, y - cy);
      if (d > halfDiag + r + Math.max(Math.abs(rowTmp[2]), Math.abs(rowTmp[3]))) continue;
      const contact = ht >= 0 && sc.hContact[ht * B + slot] === 1;
      const phasingHit = (rowTmp[4] & RING_FLAG.PHASING) !== 0 && circleHitsRect(x, y, r, cx - half, cy - half, cx + half, cy + half);
      if ((contact || phasingHit) && d < bestD) {
        bestD = d;
        attr.slot = slot;
        attr.tick = t;
        attr.x = x;
        attr.y = y;
        attr.owner = rowTmp[5] as Owner;
      }
    }
  }
  if (attr.slot >= 0) {
    attr.conf = 0.9;
    return attr;
  }
  for (let slot = 0; slot < B; slot++) {
    if (w.balls[slot].spawnTick >= kLast || !ring.readBall(kLast, slot, rowTmp, 0)) continue;
    const x = rowTmp[0];
    const y = rowTmp[1];
    const r = Math.max(rMax(w.balls[slot]), BALL_R0);
    const d = Math.hypot(x - cx, y - cy);
    if (d > halfDiag + r + Math.max(Math.abs(rowTmp[2]), Math.abs(rowTmp[3])) || d >= bestD) continue;
    bestD = d;
    attr.slot = slot;
    attr.x = x;
    attr.y = y;
    attr.owner = rowTmp[5] as Owner;
  }
  attr.tick = kLast;
  if (attr.slot >= 0) {
    attr.conf = 0.6;
    return attr;
  }
  attr.conf = 0.3;
  attr.x = cx;
  attr.y = cy;
  attr.owner = -1;
  return attr;
}

/** The first unmatched positive brick score of `seat` recorded at `tick`, consumed; null when none. */
function takeBrickScore(sc: DeriveScratch, seat: Seat, tick: number): number | null {
  const h = sc.hIndex(tick);
  if (h < 0) return null;
  for (let j = 0; j < sc.hScoreN[h]; j++) {
    const i = h * H_SCORES + j;
    if (sc.hScoreSeat[i] === seat && sc.hScoreBrick[i] === 1 && sc.hScoreUsed[i] === 0 && sc.hScoreDelta[i] > 0) {
      sc.hScoreUsed[i] = 1;
      return sc.hScoreDelta[i];
    }
  }
  return null;
}

function chainOf(sc: DeriveScratch, scorer: Owner, tick: number, windowTicks: number): number {
  const idx = scorer >= 0 ? scorer : 4;
  const base = idx * CHAIN;
  let n = 1;
  for (let j = 0; j < CHAIN; j++) {
    const t = sc.chainTicks[base + j];
    if (t >= tick - windowTicks && t <= tick) n++;
  }
  sc.chainTicks[base + sc.chainHead[idx]] = tick;
  sc.chainHead[idx] = (sc.chainHead[idx] + 1) % CHAIN;
  return n;
}

/** 5.4.5: a destroy by slot at tick t may have triggered split, phase, boost or (unobserved) mass. */
function inferPowerUp(ctx: ReducerCtx, a: Attribution, cellX: number, cellY: number): void {
  const sc = ctx.scratch;
  const q = ctx.queue;
  const s = ctx.world.balls[a.slot];
  const h = sc.hIndex(a.tick);
  if (h >= 0) {
    for (let j = 0; j < sc.hSpawnN[h]; j++) {
      const i = h * H_SPAWNS + j;
      if (sc.hSpawnUsed[i] === 1 || sc.hSpawnPerm[i] === 1 || sc.hSpawnOwner[i] !== a.owner) continue;
      const sx = sc.hSpawnX[i];
      const sy = sc.hSpawnY[i];
      if (Math.max(Math.abs(sx - cellX), Math.abs(sy - cellY)) > SPAWN_JITTER_PX) continue;
      sc.hSpawnUsed[i] = 1;
      q.push({ k: 'powerUp', ball: s.id, kind: 'split', tick: a.tick, seq: q.nextSeq(), x: sx, y: sy, conf: 1, stale: false });
      return;
    }
    if (sc.hPhaseStart[h * B + a.slot] === 1) {
      q.push({ k: 'powerUp', ball: s.id, kind: 'phase', tick: a.tick, seq: q.nextSeq(), x: a.x, y: a.y, conf: 1, stale: false });
      return;
    }
    if (sc.hVelChange[h * B + a.slot] === 1) {
      q.push({ k: 'powerUp', ball: s.id, kind: 'boost', tick: a.tick, seq: q.nextSeq(), x: a.x, y: a.y, conf: 0.8, stale: false });
      return;
    }
  }
  addMassCandidate(s);
}

/** Diffs the batch's grid into the World (R12, R16); events carry the attributed tick (5.4.4). */
export function diffGrid(ctx: ReducerCtx, grid: FullGridUpdate, kFirst: number, kLast: number): void {
  const w = ctx.world;
  const sc = ctx.scratch;
  const q = ctx.queue;
  const bricks = grid.bricks;
  const n = bricks.length;
  const side = Math.round(Math.sqrt(n));
  // An empty grid passes decode (a perfect square of 0) but would set the canvas to 0 for the whole epoch.
  if (side < 1 || side * side !== n || n > w.brickLife.length || !(grid.cellSize > 0)) {
    if (!sc.warnedGrid) log.warn(`grid of ${n} cells (cell ${grid.cellSize}) ignored`);
    sc.warnedGrid = true;
    return;
  }
  if (!w.gridKnown) {
    w.gridSize = side;
    w.cellSize = grid.cellSize;
    w.canvas = side * grid.cellSize;
    let alive = 0;
    for (let i = 0; i < w.brickLife.length; i++) {
      const c = i < n ? bricks[i] : null;
      const life = c === null ? 0 : Math.max(0, Math.min(255, Math.round(c.life)));
      const type = c === null ? CellType.Empty : c.type;
      w.brickLife[i] = life;
      w.brickType[i] = type;
      w.brickLevel[i] = life;
      w.brickDirty[i] = 1;
      if (type === CellType.Brick) alive++;
    }
    w.bricksAlive = alive;
    w.bricksAtStart = alive;
    w.gridKnown = true;
    w.ready = true;
    w.brickVersion++;
    q.push({ k: 'boardReady', bricks: alive, tick: IMMEDIATE, seq: q.nextSeq(), x: w.canvas / 2, y: w.canvas / 2, conf: 1, stale: false });
    return;
  }
  if (side !== w.gridSize || grid.cellSize !== w.cellSize) {
    if (!sc.warnedGrid) log.warn(`grid ${side}x${side} (cell ${grid.cellSize}) differs from the first grid; ignored`);
    sc.warnedGrid = true;
    return;
  }
  const cs = w.cellSize;
  const windowTicks = ctx.tuning.fx.chainWindowTicks;
  // Pass 1, in cell order: damages and silent changes are final here; destroys are attributed and scored into
  // the d* scratch (takeBrickScore is keyed by tick, so its order does not matter).
  let dN = 0;
  for (let i = 0; i < n; i++) {
    const nl = Math.max(0, Math.min(255, Math.round(bricks[i].life)));
    const nt = bricks[i].type;
    const ol = w.brickLife[i];
    const ot = w.brickType[i];
    if (nl === ol && nt === ot) continue;
    if (ot === CellType.Brick && nt === CellType.Empty) {
      const a = attribute(ctx, i, kFirst, kLast);
      w.bricksAlive--;
      const scorer: Owner = a.slot >= 0 ? a.owner : -1;
      let points: number | null = null;
      if (scorer >= 0 && w.seats[scorer as Seat].conn === SeatConn.Connected) {
        const seat = scorer as Seat;
        points = takeBrickScore(sc, seat, a.tick);
        for (let t = kLast; points === null && t >= kFirst; t--) if (t !== a.tick) points = takeBrickScore(sc, seat, t);
        if (points === null) points = w.brickLevel[i];
      }
      const d = dN++;
      dCell[d] = i;
      dFrom[d] = ol;
      dLevel[d] = w.brickLevel[i];
      dSlot[d] = a.slot;
      dOwner[d] = a.owner;
      dScorer[d] = scorer;
      dPoints[d] = points ?? 0;
      dHasPoints[d] = points === null ? 0 : 1;
      dTick[d] = a.tick;
      dX[d] = a.x;
      dY[d] = a.y;
      dConf[d] = a.conf;
      w.brickLevel[i] = 0;
    } else if (ot === CellType.Brick && nt === CellType.Brick && nl < ol) {
      const a = attribute(ctx, i, kFirst, kLast);
      q.push({
        k: 'brickDamaged', cell: i, from: ol, to: nl, level: w.brickLevel[i], ball: a.slot >= 0 ? w.balls[a.slot].id : -1,
        tick: a.tick, seq: q.nextSeq(), x: a.x, y: a.y, conf: a.conf, stale: false,
      });
    } else {
      // A change the rules have no event for (a brick appearing or gaining life): shown at once, faded.
      if (nt === CellType.Brick && ot !== CellType.Brick) {
        w.bricksAlive++;
        w.brickLevel[i] = nl;
      } else if (ot === CellType.Brick && nt !== CellType.Brick) {
        w.bricksAlive--;
        w.brickLevel[i] = 0;
      }
      if (sc.silentN < sc.silentCells.length) sc.silentCells[sc.silentN++] = i;
    }
    w.brickLife[i] = nl;
    w.brickType[i] = nt;
    w.brickDirty[i] = 1;
    w.brickVersion++;
  }
  // Pass 2: destroys in release order, (tick, cell), so chains count earlier ticks first and only the destroy
  // released last is `last`. Insertion sort on dOrder; the cell loop already gives ascending cells.
  for (let d = 0; d < dN; d++) {
    let m = d;
    while (m > 0 && (dTick[dOrder[m - 1]] > dTick[d] || (dTick[dOrder[m - 1]] === dTick[d] && dCell[dOrder[m - 1]] > dCell[d]))) {
      dOrder[m] = dOrder[m - 1];
      m--;
    }
    dOrder[m] = d;
  }
  for (let m = 0; m < dN; m++) {
    const d = dOrder[m];
    const cell = dCell[d];
    const slot = dSlot[d];
    const scorer = dScorer[d] as Owner;
    const tick = dTick[d];
    q.push({
      k: 'brickDestroyed', cell, from: dFrom[d], level: dLevel[d], ball: slot >= 0 ? w.balls[slot].id : -1, scorer,
      points: dHasPoints[d] === 1 ? dPoints[d] : null, chain: chainOf(sc, scorer, tick, windowTicks),
      last: m === dN - 1 && w.bricksAlive === 0,
      tick, seq: q.nextSeq(), x: dX[d], y: dY[d], conf: dConf[d], stale: false,
    });
    if (slot >= 0) {
      w.balls[slot].lastDestroyTick = tick;
      attr.slot = slot;
      attr.tick = tick;
      attr.conf = dConf[d];
      attr.x = dX[d];
      attr.y = dY[d];
      attr.owner = dOwner[d] as Owner;
      inferPowerUp(ctx, attr, (cell % side) * cs + cs / 2, Math.floor(cell / side) * cs + cs / 2);
    }
  }
}

/** diffGrid's destroys of one batch, by discovery index (at most one per cell). */
const dCell = new Int32Array(CELLS);
const dFrom = new Int32Array(CELLS);
const dLevel = new Int32Array(CELLS);
const dSlot = new Int32Array(CELLS);
const dOwner = new Int8Array(CELLS);
const dScorer = new Int8Array(CELLS);
const dPoints = new Int32Array(CELLS);
const dHasPoints = new Uint8Array(CELLS);
const dTick = new Int32Array(CELLS);
const dX = new Float64Array(CELLS);
const dY = new Float64Array(CELLS);
const dConf = new Float64Array(CELLS);
const dOrder = new Int32Array(CELLS);
