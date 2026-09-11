// Sampling (5.3). Server motion is piecewise linear per tick and collisions change only velocity, so a lerp
// between consecutive rows reproduces the server path exactly, wall penetration included. Everything is
// written in place into RenderState: board space (bx = x - canvas/2, by = canvas/2 - y), velocities in board
// units per tick with vy negated. No allocation: doubles never cross a call boundary inside the loops (they
// live in the typed scratch arrays below), so nothing is boxed whether or not the engine inlines.

import type { RenderState, World } from './types';
import { BALL_STRIDE, BO, BallVis, PADDLE_STRIDE, PO } from './types';
import type { Seat } from './events';
import type { SnapshotRing } from './ring';
import { RING_FLAG } from './ring';
import { CELLS, CellType, MAX_BALLS, TICK_MS } from '../config/constants';

const DYING_MS = 250;

export function createRenderState(): RenderState {
  return {
    displayMs: 0, displayTick: 0,
    paddle: new Float32Array(4 * PADDLE_STRIDE), paddleLead: new Float32Array(4),
    ball: new Float32Array(MAX_BALLS * BALL_STRIDE), ballId: new Int32Array(MAX_BALLS).fill(-1), ballHigh: 0,
    brickLife: new Uint8Array(CELLS), brickType: new Uint8Array(CELLS).fill(CellType.Empty),
    brickFade: new Uint8Array(CELLS), brickVersion: 0,
    extrapolating: false, frozen: false, ready: false,
  };
}

const A = new Float32Array(6);
const B = new Float32Array(6);
/** The sample being built: x, y, vx, vy, flags, owner. */
const S = new Float64Array(6);
/** The current call: [t (ticks), maxExtrapTicks]. */
const P = new Float64Array(2);
/** Set by sampleRing when the sample went past its row; [0] this entity, [1] any entity this call. */
const X = new Uint8Array(2);
/** The inputs of sampleIntoAt, written in place by the caller: [displayTick, maxExtrapTicks]. The per-frame
 *  path passes its fractional tick here, because a double handed to a call that is not inlined is boxed. */
export const SAMPLE_AT = new Float64Array(2);

function take(src: Float32Array): void {
  S[0] = src[0];
  S[1] = src[1];
  S[2] = src[2];
  S[3] = src[3];
  S[4] = src[4];
  S[5] = src[5];
}

/** One ring row of a ball (`ball` true, idx = slot) or a paddle (idx = seat). Every tick passed is an int32. */
function readRow(ring: SnapshotRing, ball: boolean, idx: number, tick: number, out: Float32Array): boolean {
  return ball ? ring.readBall(tick, idx, out, 0) : ring.readPaddle(tick, idx as Seat, out, 0);
}

/** Fills S for one entity at time P[0]. False when the ring has nothing for it then. Callers pass `ball` as a
 *  constant, so each call site specialises to one reader. */
function sampleRing(ring: SnapshotRing, ball: boolean, idx: number): boolean {
  const t = P[0];
  const maxExtrap = P[1];
  const newest = ring.newest;
  const oldest = ring.oldest;
  X[0] = 0;
  if (t <= oldest) {
    // Before the oldest row (the first play frames after the start snap): hold it.
    if (!readRow(ring, ball, idx, oldest, A)) return false;
    take(A);
    return true;
  }
  if (t >= newest) {
    if (!readRow(ring, ball, idx, newest, A)) return false;
    take(A);
    const e = t - newest < maxExtrap ? t - newest : maxExtrap;
    if (e > 0) {
      S[0] += A[2] * e;
      S[1] += A[3] * e;
      X[0] = 1;
    }
    return true;
  }
  // oldest < t < newest, so t is non-negative and below 2^31: t | 0 is floor(t) as an int32 (never boxed).
  const i = t | 0;
  const a = t - i;
  const hasA = readRow(ring, ball, idx, i, A);
  const hasB = readRow(ring, ball, idx, i + 1, B);
  if (hasA && hasB) {
    S[0] = A[0] + (B[0] - A[0]) * a;
    S[1] = A[1] + (B[1] - A[1]) * a;
    S[2] = B[0] - A[0];
    S[3] = B[1] - A[1];
    S[4] = A[4];   // flags and owner step at the tick, never lerp
    S[5] = A[5];
    return true;
  }
  if (hasA) {
    take(A);
    const e = a < maxExtrap ? a : maxExtrap;
    if (e > 0) {
      S[0] += A[2] * e;
      S[1] += A[3] * e;
      X[0] = 1;
    }
    return true;
  }
  if (hasB) {
    take(B);
    return true;
  }
  return false;
}

/** The bounds for clampS: [lo, hi]. Written by the caller, so the computed doubles never cross the call. */
const C = new Float64Array(2);

/** Clamps S[i] to [C[0], C[1]] (no-op when the range is empty). */
function clampS(i: number): void {
  const lo = C[0];
  const hi = C[1];
  if (lo > hi) return;
  if (S[i] < lo) S[i] = lo;
  else if (S[i] > hi) S[i] = hi;
}

/** The runtime passes displayTick = playout.started ? playout.displayMs / 25 : w.tick, so before play
 *  (lobby, countdown) the row at w.tick is copied exactly, with no interpolation or extrapolation. */
export function sampleInto(w: World, ring: SnapshotRing, displayTick: number, out: RenderState, maxExtrapTicks: number): void {
  SAMPLE_AT[0] = displayTick;
  SAMPLE_AT[1] = maxExtrapTicks;
  sampleIntoAt(w, ring, out);
}

/** sampleInto with displayTick and maxExtrapTicks read from SAMPLE_AT: the per-frame entry, so no double crosses
 *  the call. */
export function sampleIntoAt(w: World, ring: SnapshotRing, out: RenderState): void {
  const canvas = w.canvas;
  const half = canvas / 2;
  const t = SAMPLE_AT[0];
  P[0] = t;
  P[1] = SAMPLE_AT[1] > 0 ? SAMPLE_AT[1] : 0;
  const displayMs = t * TICK_MS;
  const empty = ring.newest < 0;
  // The tick the sampler actually shows: before the oldest row (the first play frames after the start snap put
  // display time below tick 0) sampleRing holds that row, so visibility and age are judged at its tick.
  const tv = !empty && t < ring.oldest ? ring.oldest : t;
  out.displayTick = t;
  out.displayMs = displayMs;
  X[1] = 0;

  for (let seat = 0; seat < 4; seat++) {
    const row = w.paddles[seat];
    const o = seat * PADDLE_STRIDE;
    let present: boolean;
    if (empty) {
      present = row.present;
      if (present) {
        S[0] = row.x;
        S[1] = row.y;
        S[2] = row.vx;
        S[3] = row.vy;
      }
    } else {
      present = sampleRing(ring, false, seat);
      if (present && X[0] === 1) {
        // Rows hold centres: keep the centre on the rail, [len/2, canvas - len/2] along the paddle's axis.
        const vertical = seat === 0 || seat === 2;
        C[0] = (vertical ? row.h : row.w) / 2;
        C[1] = canvas - C[0];
        clampS(vertical ? 1 : 0);
        X[1] = 1;
      }
    }
    const p = out.paddle;
    p[o + PO.CONN] = w.seats[seat].conn;
    if (!present) {
      p[o + PO.PRESENT] = 0;
      continue;
    }
    p[o + PO.PRESENT] = 1;
    p[o + PO.CX] = S[0] - half;
    p[o + PO.CY] = half - S[1];
    p[o + PO.W] = row.w;
    p[o + PO.H] = row.h;
    p[o + PO.VX] = S[2];
    p[o + PO.VY] = -S[3];
  }

  let high = 0;
  const bo = out.ball;
  for (let slot = 0; slot < MAX_BALLS; slot++) {
    const s = w.balls[slot];
    const o = slot * BALL_STRIDE;
    if (s === undefined || (!s.live && s.removedTick < 0)) {
      out.ballId[slot] = -1;
      bo[o + BO.VIS] = BallVis.Hidden;
      continue;
    }
    out.ballId[slot] = s.id;
    high = slot + 1;
    let vis: number = BallVis.Live;
    let owner: number = s.owner;
    let phasing = s.phasing;
    if (s.removedTick >= 0 && t >= s.removedTick) {
      // Hold the last present row (the slot keeps it) and dissolve for DYING_MS of display time.
      S[0] = s.x;
      S[1] = s.y;
      S[2] = 0;
      S[3] = 0;
      vis = displayMs - s.removedTick * TICK_MS < DYING_MS ? BallVis.Dying : BallVis.Hidden;
    } else {
      let found = false;
      if (!empty) {
        found = sampleRing(ring, true, slot);
        if (found) {
          if (X[0] === 1) {
            C[0] = s.radius;
            C[1] = canvas - s.radius;
            clampS(0);
            clampS(1);
            X[1] = 1;
          }
          owner = S[5];
          phasing = (S[4] & RING_FLAG.PHASING) !== 0;
        }
      }
      if (!found) {
        S[0] = s.x;
        S[1] = s.y;
        S[2] = s.vx;
        S[3] = s.vy;
      }
      if (s.spawnTick > tv) vis = BallVis.Hidden;
    }
    bo[o + BO.X] = S[0] - half;
    bo[o + BO.Y] = half - S[1];
    bo[o + BO.VX] = S[2];
    bo[o + BO.VY] = -S[3];
    bo[o + BO.R] = s.radius;
    bo[o + BO.OWNER] = owner;
    bo[o + BO.PHASING] = phasing ? 1 : 0;
    bo[o + BO.PERMANENT] = s.permanent ? 1 : 0;
    bo[o + BO.AGE_S] = ((tv - s.spawnTick) * TICK_MS) / 1000;
    bo[o + BO.VIS] = vis;
  }
  out.ballHigh = high;
  out.extrapolating = X[1] === 1;
}
