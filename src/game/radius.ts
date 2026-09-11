// Radius inference (5.4.6, C12). A ball's radius is r0 + 4k (ball.go:196-202). Each ball keeps a bitmask over
// k = 0..RADIUS_K-1. Only a brick destroy by the ball adds a candidate; a wall trigger at tick k (not at k-1)
// bounds the radius to the integers [lo, hi], and the set keeps its intersection with that interval when it is
// non-empty. Everything here follows RADIUS_K, which may be at most 31 so the set stays a non-negative int32.

import type { Wall } from './events';
import type { BallSlot } from './types';
import { MASS_R_STEP, RADIUS_K } from '../config/constants';

const K: number = RADIUS_K;
if (!(K >= 1 && K <= 31)) throw new Error(`RADIUS_K must be in 1..31, got ${K}`);

/** Every candidate k = 0..RADIUS_K-1: the set of a ball whose radius is unknown (a healed ball). */
export const FULL_RADIUS_SET = K === 31 ? 0x7fffffff : (1 << K) - 1;

/** Bits k (0..RADIUS_K-1) with lo <= r0 + 4k <= hi. */
export function latticeMask(r0: number, lo: number, hi: number): number {
  let m = 0;
  for (let k = 0; k < RADIUS_K; k++) {
    const r = r0 + MASS_R_STEP * k;
    if (r >= lo && r <= hi) m |= 1 << k;
  }
  return m;
}

function lowestBit(set: number): number {
  for (let k = 0; k < RADIUS_K; k++) if ((set & (1 << k)) !== 0) return k;
  return 0;
}

function highestBit(set: number): number {
  for (let k = RADIUS_K - 1; k >= 0; k--) if ((set & (1 << k)) !== 0) return k;
  return 0;
}

/** The smallest candidate: what is drawn, so a ball is never over-drawn. */
export function rMin(slot: BallSlot): number {
  return slot.r0 + MASS_R_STEP * lowestBit(slot.radiusSet);
}

/** The largest candidate: what overlap tests use, so a larger ball is never missed. */
export function rMax(slot: BallSlot): number {
  return slot.r0 + MASS_R_STEP * highestBit(slot.radiusSet);
}

/** A destroy by this ball may have been a mass power-up: add max + 4 to the set (no effect at k = RADIUS_K-1). */
export function addMassCandidate(slot: BallSlot): void {
  if (slot.radiusSet === 0) slot.radiusSet = 1;
  const hb = highestBit(slot.radiusSet);
  if (hb + 1 < RADIUS_K) slot.radiusSet |= 1 << (hb + 1);
}

/** The server's wall trigger (game_actor_physics.go:42-56) for a circle of radius r at (x, y), widened by slack. */
export function overlapsWall(wall: Wall, x: number, y: number, r: number, canvas: number, slack = 0): boolean {
  switch (wall) {
    case 0:
      return x + r + slack >= canvas;
    case 1:
      return y - r - slack <= 0;
    case 2:
      return x - r - slack <= 0;
    default:
      return y + r + slack >= canvas;
  }
}

/** When not to narrow (5.4.6): the hi bound assumes the wall test did not fire at k-1. A paddle message at k-1
 *  or k (paddle collisions run after the wall loop, so a corner hit can turn an overlapping ball back), or a
 *  k-1 row that already overlaps the wall with rMin, breaks that assumption. */
export function canNarrow(slot: BallSlot, wall: Wall, prevX: number, prevY: number, canvas: number, paddleHitNear: boolean): boolean {
  if (paddleHitNear) return false;
  return !overlapsWall(wall, prevX, prevY, rMin(slot), canvas);
}

/** Narrows the set with the wall bounds of a trigger at k (row k-1 = prev). True if rMin changed. */
export function narrowOnWall(slot: BallSlot, wall: Wall, prevX: number, prevY: number, x: number, y: number, canvas: number): boolean {
  let lo: number;
  let hi: number;
  switch (wall) {
    case 0:
      lo = canvas - x;
      hi = canvas - prevX - 1;
      break;
    case 1:
      lo = y;
      hi = prevY - 1;
      break;
    case 2:
      lo = x;
      hi = prevX - 1;
      break;
    default:
      lo = canvas - y;
      hi = canvas - prevY - 1;
  }
  const m = latticeMask(slot.r0, lo, hi);
  if ((slot.radiusSet & m) === 0) return false;   // an inconsistent sample (misclassification): ignore
  const before = rMin(slot);
  slot.radiusSet &= m;
  slot.radius = rMin(slot);
  return slot.radius !== before;
}
