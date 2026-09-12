// Effect budgets (6, 6.1). P0 always shows, because it carries information. P1 is scaled by the tier's spawnScale.
// P2 is scaled by spawnScale, with at least one instance, and dropped whenever its pool is more than 75 % full (so the
// medium and low decal pools still hold scorches). Confidence gates E31 at confidenceMin (0.7) and
// scales every other effect: conf >= 0.9 full, 0.6..0.9 at 70 %, below 0.6 a flash only (at 70 %), no particles.

import type { Tuning } from '../config/tuning';
import type { Tier } from '../render/contracts';

export type Priority = 0 | 1 | 2;   // P0 always, P1 scaled by budget, P2 dropped first

/** The share of a pool that P2 spawns leave to P0 and P1. */
export const P2_RESERVE = 0.25;

export class FxBudget {
  private readonly t: Tuning['fx'];
  private tierV: Tier = 'high';
  private scale = 0.5;

  constructor(t: Tuning['fx']) {
    this.t = t;
    this.scale = t.spawnScale.high;
  }

  get tier(): Tier {
    return this.tierV;
  }

  setTier(t: Tier): void {
    this.tierV = t;
    this.scale = this.t.spawnScale[t];
  }

  /** How many of `requested` instances to spawn into a pool with `poolFree` free slots out of `capacity`.
   *  - P0: all of them, capped at the capacity. A full pool overwrites its oldest instances.
   *  - P1: ceil(requested x spawnScale), capped at the capacity, so a single ring survives every tier. It may steal.
   *  - P2: floor(requested x spawnScale) but at least one, taken only from free slots above the reserved quarter of
   *    the pool, so it never steals and is dropped while the pool is more than 75 % full.
   *  `capacity` extends the 4.12 signature grant(requested, p, poolFree): the 75 % rule needs the pool's size, which
   *  poolFree alone does not give. Without it the reserve is 0 and P2 takes any free slot (reported as a contract gap;
   *  the director always passes it). */
  grant(requested: number, p: Priority, poolFree: number, capacity = Infinity): number {
    const req = requested > 0 && requested < Infinity ? Math.floor(requested) : 0;
    if (req === 0) return 0;
    const cap = capacity > 0 ? capacity : 0;
    if (p === 0) return req < cap ? req : cap;
    if (p === 1) {
      const n = Math.ceil(req * this.scale);
      return n < cap ? n : cap;
    }
    const free = poolFree > 0 ? Math.floor(poolFree) : 0;
    const reserve = cap < Infinity ? Math.ceil(cap * P2_RESERVE) : 0;
    const room = free - reserve;
    if (room <= 0) return 0;
    const n = Math.max(1, Math.floor(req * this.scale));
    return n < room ? n : room;
  }

  /** E31's gate: true when conf >= confidenceMin. */
  allow(conf: number): boolean {
    return conf >= this.t.confidenceMin;
  }

  /** The intensity multiplier for an inference of confidence `conf`: 1 at >= 0.9, else 0.7. */
  intensity(conf: number): number {
    return conf >= 0.9 ? 1 : 0.7;
  }

  /** False below 0.6: the effect shows its flash only, with no particles, rings or shards. */
  particles(conf: number): boolean {
    return conf >= 0.6;
  }
}
