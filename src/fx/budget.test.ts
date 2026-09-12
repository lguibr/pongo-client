// FxBudget (6): grants by priority and tier, the P2 reserve, and confidence gating and scaling.

import { describe, expect, it } from 'vitest';
import { FxBudget } from './budget';
import { TUNING } from '../config/tuning';
import type { Tier } from '../render/contracts';

const TIERS: readonly Tier[] = ['high', 'medium', 'low'];

function budget(tier: Tier): FxBudget {
  const b = new FxBudget(TUNING.fx);
  b.setTier(tier);
  return b;
}

describe('FxBudget.grant', () => {
  it('grants P0 in full on every tier, even into a full pool, capped only by the capacity', () => {
    for (const t of TIERS) {
      const b = budget(t);
      expect(b.tier).toBe(t);
      expect(b.grant(24, 0, 0, 2048)).toBe(24);
      expect(b.grant(8, 0, 0, 128)).toBe(8);
      expect(b.grant(5000, 0, 10, 384)).toBe(384);
      expect(b.grant(7.9, 0, 100)).toBe(7);
    }
  });

  it('scales P1 by the tier spawnScale, rounding up so a single instance survives every tier', () => {
    expect(budget('high').grant(24, 1, 0, 2048)).toBe(24);
    expect(budget('medium').grant(24, 1, 0, 1024)).toBe(15);   // ceil(14.4)
    expect(budget('low').grant(24, 1, 0, 384)).toBe(8);        // ceil(7.2)
    expect(budget('low').grant(1, 1, 0, 32)).toBe(1);
    // P1 may steal: a full pool still gets its share
    expect(budget('medium').grant(10, 1, 0, 48)).toBe(6);
    expect(budget('low').grant(1000, 1, 0, 128)).toBe(128);
  });

  it('keeps at least one P2 instance on every tier while the pool has room, and none once it is more than 75 % full', () => {
    const low = budget('low');
    expect(low.grant(1, 2, 32, 32)).toBe(1);     // floor(0.3) would drop the single scorch the low decal pool holds
    expect(low.grant(3, 2, 32, 32)).toBe(1);     // floor(0.9)
    expect(low.grant(3, 2, 9, 32)).toBe(1);      // 23 of 32 in use: one slot above the reserved quarter (8)
    expect(low.grant(1, 2, 8, 32)).toBe(0);      // exactly 75 % full
    expect(low.grant(3, 2, 5, 32)).toBe(0);      // more than 75 % full
    expect(budget('medium').grant(1, 2, 48, 48)).toBe(1);
    expect(budget('medium').grant(1, 2, 12, 48)).toBe(0);
    expect(low.grant(10, 2, 1)).toBe(1);         // without a capacity: any free slot
    expect(low.grant(1, 2, 0)).toBe(0);
  });

  it('scales P2 down, never steals, and drops it while the pool is more than 75 % full', () => {
    const high = budget('high');
    expect(high.grant(120, 2, 512, 512)).toBe(120);
    expect(high.grant(120, 2, 200, 512)).toBe(72);    // only what is free above the reserved quarter (128)
    expect(high.grant(120, 2, 128, 512)).toBe(0);     // exactly 75 % full: nothing can be added
    expect(high.grant(120, 2, 40, 512)).toBe(0);
    expect(budget('medium').grant(120, 2, 256, 256)).toBe(72);   // floor(120 x 0.6)
    expect(budget('low').grant(120, 2, 128, 128)).toBe(36);      // floor(120 x 0.3)
    expect(budget('low').grant(1, 2, 32, 32)).toBe(1);           // floor(0.3), raised to one while there is room
    // without a capacity, P2 takes free slots only
    expect(high.grant(10, 2, 4)).toBe(4);
    expect(high.grant(10, 2, 0)).toBe(0);
  });

  it('grants nothing for a request that is not a positive finite number', () => {
    const b = budget('high');
    for (const p of [0, 1, 2] as const) {
      expect(b.grant(0, p, 100, 100)).toBe(0);
      expect(b.grant(-3, p, 100, 100)).toBe(0);
      expect(b.grant(Number.NaN, p, 100, 100)).toBe(0);
      expect(b.grant(Number.POSITIVE_INFINITY, p, 100, 100)).toBe(0);
    }
  });
});

describe('FxBudget confidence', () => {
  it('allows E31 from confidenceMin (0.7) upward', () => {
    const b = budget('high');
    expect(TUNING.fx.confidenceMin).toBe(0.7);
    expect(b.allow(0.7)).toBe(true);
    expect(b.allow(1)).toBe(true);
    expect(b.allow(0.69)).toBe(false);
    expect(b.allow(Number.NaN)).toBe(false);
  });

  it('shows full intensity from 0.9, 70 % below, and particles only from 0.6', () => {
    const b = budget('low');
    expect(b.intensity(1)).toBe(1);
    expect(b.intensity(0.9)).toBe(1);
    expect(b.intensity(0.89)).toBe(0.7);
    expect(b.intensity(0.6)).toBe(0.7);
    expect(b.intensity(0.3)).toBe(0.7);
    expect(b.particles(0.6)).toBe(true);
    expect(b.particles(0.95)).toBe(true);
    expect(b.particles(0.59)).toBe(false);
    expect(b.particles(Number.NaN)).toBe(false);
  });
});
