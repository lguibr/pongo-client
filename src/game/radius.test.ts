import { describe, expect, it } from 'vitest';
import { FULL_RADIUS_SET, addMassCandidate, canNarrow, latticeMask, narrowOnWall, overlapsWall, rMax, rMin } from './radius';
import { createWorld } from './world';
import type { BallSlot } from './types';
import type { Wall } from './events';
import { seeded } from '../lib/random';
import { MASS_R_STEP, RADIUS_K } from '../config/constants';

const CANVAS = 900;
/** Every lattice bit, computed without bit operators (2^31 - 1 is still exact). */
const ALL_BITS = 2 ** RADIUS_K - 1;

function slot(r0: number, set: number): BallSlot {
  const s = createWorld().balls[0];
  s.r0 = r0;
  s.radiusSet = set;
  s.radius = rMin(s);
  return s;
}

describe('latticeMask', () => {
  it('selects the candidates r0 + 4k inside [lo, hi]', () => {
    expect(latticeMask(8, 7, 14)).toBe(0b11);
    expect(latticeMask(8, 13, 20)).toBe(0b1100);
    expect(latticeMask(8, 0, 7)).toBe(0);
    expect(latticeMask(8, 36, 36)).toBe(0b1000_0000);
    // Every candidate up to r0 + 4 (RADIUS_K - 1) fits under 1000 px.
    expect(latticeMask(8, 0, 1000)).toBe(ALL_BITS);
  });

  it('FULL_RADIUS_SET holds every candidate, as a non-negative int32, from r0 to r0 + 4 (RADIUS_K - 1)', () => {
    expect(FULL_RADIUS_SET).toBe(ALL_BITS);
    expect(FULL_RADIUS_SET | 0).toBe(FULL_RADIUS_SET);
    const s = slot(8, FULL_RADIUS_SET);
    expect([rMin(s), rMax(s)]).toEqual([8, 8 + MASS_R_STEP * (RADIUS_K - 1)]);
  });
});

describe('narrowOnWall', () => {
  it('bounds the radius from a right-wall trigger: x 885 -> 893 with r0 8 leaves {8, 12}', () => {
    const s = slot(8, 0b111);
    expect(narrowOnWall(s, 0, 885, 400, 893, 400, CANVAS)).toBe(false);   // rMin stays 8
    expect(s.radiusSet).toBe(0b11);
    expect([rMin(s), rMax(s)]).toEqual([8, 12]);
  });

  it('reports a growth when the smallest candidates are excluded', () => {
    const s = slot(8, 0b111);
    // top wall: y 20 -> 13 gives lo 13, hi 19: only 16 fits
    expect(narrowOnWall(s, 1, 400, 20, 400, 13, CANVAS)).toBe(true);
    expect(s.radius).toBe(16);
    expect(s.radiusSet).toBe(0b100);
  });

  it('ignores an inconsistent sample', () => {
    const s = slot(8, 0b10);
    expect(narrowOnWall(s, 2, 30, 400, 22, 400, CANVAS)).toBe(false);   // lo 22, hi 29: 24, 28 only
    expect(s.radiusSet).toBe(0b10);
    expect(s.radius).toBe(12);
  });
});

describe('candidates', () => {
  it('addMassCandidate adds max + 4 and stops at the top of the lattice (k = RADIUS_K - 1)', () => {
    const s = slot(8, 0b1);
    addMassCandidate(s);
    expect([rMin(s), rMax(s)]).toEqual([8, 12]);
    addMassCandidate(s);
    expect(rMax(s)).toBe(16);
    const top = 2 ** (RADIUS_K - 1);
    const full = slot(8, top);
    addMassCandidate(full);
    expect(full.radiusSet).toBe(top);
    expect(rMax(full)).toBe(8 + MASS_R_STEP * (RADIUS_K - 1));
  });

  it('canNarrow refuses after a paddle message and when row k-1 already overlaps the wall with rMin', () => {
    const s = slot(8, 0b11);
    expect(canNarrow(s, 0, 880, 400, CANVAS, false)).toBe(true);
    expect(canNarrow(s, 0, 880, 400, CANVAS, true)).toBe(false);
    expect(canNarrow(s, 0, 893, 400, CANVAS, false)).toBe(false);
    expect(overlapsWall(3, 400, 892, 8, CANVAS)).toBe(true);
    expect(overlapsWall(3, 400, 891, 8, CANVAS, 1)).toBe(true);
    expect(overlapsWall(3, 400, 891, 8, CANVAS)).toBe(false);
  });
});

/** Canvas position of a ball at distance `a` from wall w (measured along the wall's normal). */
function place(w: Wall, a: number): { x: number; y: number } {
  switch (w) {
    case 0: return { x: CANVAS - a, y: 450 };
    case 1: return { x: 450, y: a };
    case 2: return { x: a, y: 450 };
    default: return { x: 450, y: CANVAS - a };
  }
}

/** Independent wall approaches under the server's Move and wall test (ball.go:121-124, game_actor_physics.go:42-56,
 *  158-177): each picks a wall, |v_axis| in [5, 12] and a random phase, which is what paddle and brick bounces in
 *  between do to a real ball. With `paddleHits`, a corner paddle hit (paddle collisions run after the wall loop)
 *  sometimes sends the overlapping ball straight back, so the next tick triggers again with row k-1 already inside
 *  the wall. The client sees only rows and R1 messages; it narrows on a visible flip toward the wall. */
function simulate(seed: number, trials: number, paddleHits: boolean, respectSkip: boolean): { violations: number; meanBounces: number; resolved: number } {
  const rand = seeded(seed);
  let violations = 0;
  let bouncesTotal = 0;
  let resolved = 0;
  for (let trial = 0; trial < trials; trial++) {
    const R = 8 + 4 * Math.floor(rand() * 8);
    const s = slot(8, 0xff);   // the radius is unknown: all eight candidates
    let bounces = 0;
    for (let approach = 0; approach < 200 && (s.radiusSet & (s.radiusSet - 1)) !== 0; approach++) {
      const w = Math.floor(rand() * 4) as Wall;
      const v = 5 + Math.floor(rand() * 8);
      let a = R + 1 + Math.floor(rand() * v) + v * (2 + Math.floor(rand() * 5));   // no overlap yet
      let prev = a;
      while (a > R) {
        prev = a;
        a -= v;   // Move toward the wall; the trigger fires at the first a <= R
      }
      const hit = paddleHits && rand() < 0.3;
      if (!hit) {
        // Reflected at k: the client sees a flip between rows k-1 and k.
        const p0 = place(w, prev);
        const p1 = place(w, a);
        if (!overlapsWall(w, p1.x, p1.y, rMax(s), CANVAS)) continue;
        if (respectSkip && !canNarrow(s, w, p0.x, p0.y, CANVAS, false)) continue;
        narrowOnWall(s, w, p0.x, p0.y, p1.x, p1.y, CANVAS);
      } else {
        // Reflected by the wall and sent back by the paddle at k (an R1 message, no flip); at k+1 it triggers
        // again from inside the wall and reflects: a flip whose row k-1 already overlaps.
        const inside = a;
        a -= v;
        const p0 = place(w, inside);
        const p1 = place(w, a);
        if (!overlapsWall(w, p1.x, p1.y, rMax(s), CANVAS)) continue;
        if (respectSkip && !canNarrow(s, w, p0.x, p0.y, CANVAS, true)) continue;
        narrowOnWall(s, w, p0.x, p0.y, p1.x, p1.y, CANVAS);
      }
      bounces++;
      if (rMin(s) > R || rMax(s) < R) violations++;
    }
    if ((s.radiusSet & (s.radiusSet - 1)) === 0) {
      resolved++;
      bouncesTotal += bounces;
      if (rMin(s) !== R) violations++;
    }
  }
  return { violations, meanBounces: bouncesTotal / Math.max(1, resolved), resolved };
}

describe('radius inference against the server physics', () => {
  it('keeps rMin <= R <= rMax and resolves in at most 3.2 wall bounces on average', () => {
    const r = simulate(1234, 600, false, true);
    expect(r.violations).toBe(0);
    expect(r.resolved).toBe(600);
    expect(r.meanBounces).toBeLessThanOrEqual(3.2);
  });

  it('keeps the invariant with corner paddle hits at k-1, because narrowing is skipped there', () => {
    const r = simulate(99, 600, true, true);
    expect(r.violations).toBe(0);
    expect(r.resolved).toBe(600);
  });

  it('would lose the true radius without the skip rule (the rule is load-bearing)', () => {
    const r = simulate(99, 600, true, false);
    expect(r.violations).toBeGreaterThan(0);
  });
});
