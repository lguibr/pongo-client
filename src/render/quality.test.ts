import { describe, expect, it } from 'vitest';
import { QualityController, RefreshEstimator, initialTier, selectQuantile, snapPeriod } from './quality';
import type { Tier } from './contracts';
import { TUNING } from '../config/tuning';
import { seeded } from '../lib/random';

const Q = TUNING.quality;
const P60 = 1000 / 60;

/** Feeds whole windows of a constant interval. */
function feed(c: QualityController, dtMs: number, windows: number, refresh = P60): void {
  const per = Math.ceil(Q.windowMs / dtMs);
  for (let w = 0; w < windows; w++) for (let i = 0; i < per; i++) c.sample(dtMs, refresh);
}

/** Feeds one window as `n` fast frames then slow ones, ending exactly as the window closes. */
function feedPattern(c: QualityController, fast: number, fastMs: number, slow: number, slowMs: number): void {
  for (let i = 0; i < fast; i++) c.sample(fastMs, P60);
  for (let i = 0; i < slow; i++) c.sample(slowMs, P60);
}

function controller(start: Tier): { c: QualityController; changes: Tier[] } {
  const changes: Tier[] = [];
  return { c: new QualityController(Q, start, (t) => changes.push(t)), changes };
}

describe('initialTier (5.13)', () => {
  it('lets a setting other than auto win', () => {
    expect(initialTier('low', { deviceMemory: 16, hardwareConcurrency: 16 }, false)).toBe('low');
    expect(initialTier('high', { deviceMemory: 1, hardwareConcurrency: 2 }, true)).toBe('high');
  });

  it('reads memory, cores and the pointer', () => {
    expect(initialTier('auto', { deviceMemory: 2, hardwareConcurrency: 12 }, false)).toBe('low');
    expect(initialTier('auto', { deviceMemory: 8, hardwareConcurrency: 4 }, true)).toBe('low');
    expect(initialTier('auto', { deviceMemory: 8, hardwareConcurrency: 4 }, false)).toBe('medium');
    expect(initialTier('auto', { deviceMemory: 8, hardwareConcurrency: 8 }, false)).toBe('high');
    expect(initialTier('auto', { deviceMemory: 8, hardwareConcurrency: 8 }, true)).toBe('medium');
    expect(initialTier('auto', {}, false)).toBe('medium');
  });
});

describe('QualityController (5.13)', () => {
  it('steps down after three slow windows, not two, one tier at a time', () => {
    const { c, changes } = controller('high');
    feed(c, 30, 2);
    expect(c.tier).toBe('high');
    feed(c, 30, 1);
    expect(c.tier).toBe('medium');
    expect(changes).toEqual(['medium']);
    feed(c, 30, 3);
    expect(c.tier).toBe('low');
    feed(c, 30, 6);
    expect(changes).toEqual(['medium', 'low']);
  });

  it('restarts the slow streak after a window in band', () => {
    const { c, changes } = controller('high');
    feed(c, 30, 2);
    feed(c, P60, 1);
    feed(c, 30, 2);
    expect(c.tier).toBe('high');
    expect(changes).toEqual([]);
  });

  it('judges the p90 frame interval, not the mean', () => {
    // 15 % slow frames put the p90 above 1.35 x the period.
    const a = controller('high');
    for (let w = 0; w < 3; w++) feedPattern(a.c, 85, 16, 15, 43);
    expect(a.c.tier).toBe('medium');
    // 5 % very slow frames raise the mean to 20 ms, but the p90 stays at 16 ms.
    const b = controller('high');
    for (let w = 0; w < 3; w++) feedPattern(b.c, 95, 16, 5, 96);
    expect(b.c.tier).toBe('high');
  });

  it('steps up after ten fast windows, at most once', () => {
    const { c, changes } = controller('low');
    feed(c, 10, 9);
    expect(c.tier).toBe('low');
    feed(c, 10, 1);
    expect(c.tier).toBe('medium');
    feed(c, 10, 30);
    expect(c.tier).toBe('medium');
    expect(changes).toEqual(['medium']);
  });

  it('ignores pauses and nonsense intervals', () => {
    const { c, changes } = controller('high');
    for (let i = 0; i < 100; i++) {
      c.sample(5000, P60);
      c.sample(Number.NaN, P60);
      c.sample(-3, P60);
      c.sample(30, 0);
    }
    expect(c.tier).toBe('high');
    expect(changes).toEqual([]);
  });

  it('setTier forces a tier without onChange and restarts the streaks', () => {
    const { c, changes } = controller('high');
    feed(c, 30, 2);
    c.setTier('medium');
    expect(c.tier).toBe('medium');
    feed(c, 30, 2);
    expect(c.tier).toBe('medium');
    feed(c, 30, 1);
    expect(c.tier).toBe('low');
    expect(changes).toEqual(['low']);
  });
});

describe('frame statistics helpers', () => {
  it('selectQuantile matches a sort', () => {
    const rand = seeded(7);
    for (let trial = 0; trial < 50; trial++) {
      const n = 1 + Math.floor(rand() * 300);
      const values = new Float32Array(n);
      for (let i = 0; i < n; i++) values[i] = Math.round(rand() * 40);
      const sorted = Array.from(values).sort((x, y) => x - y);
      for (const q of [0, 0.5, 0.9, 0.95, 1]) {
        const k = Math.min(n - 1, Math.max(0, Math.ceil(q * n) - 1));
        expect(selectQuantile(new Float32Array(values), n, q)).toBe(sorted[k]);
      }
    }
  });

  it('snaps to the nearest common refresh rate', () => {
    expect(snapPeriod(16.9)).toBeCloseTo(1000 / 60, 9);
    expect(snapPeriod(8.2)).toBeCloseTo(1000 / 120, 9);
    expect(snapPeriod(6.9)).toBeCloseTo(1000 / 144, 9);
  });

  it('RefreshEstimator keeps the shortest period it has seen', () => {
    const r = new RefreshEstimator();
    expect(r.periodMs).toBeCloseTo(P60, 9);
    const rand = seeded(3);
    for (let i = 0; i < 130; i++) r.push(1000 / 120 + (rand() - 0.5) * 1.5);
    expect(r.periodMs).toBeCloseTo(1000 / 120, 9);
    for (let i = 0; i < 100; i++) r.push(1000 / 30);
    expect(r.periodMs).toBeCloseTo(1000 / 120, 9);
    r.push(4000);
    expect(r.periodMs).toBeCloseTo(1000 / 120, 9);
  });

  it('RefreshEstimator starts at 60 Hz and never learns a slower display from slow frames', () => {
    const r = new RefreshEstimator();
    for (let i = 0; i < 90; i++) r.push(1000 / 30);   // 3 s at a steady 30 fps
    expect(r.periodMs).toBeCloseTo(P60, 9);
    for (let i = 0; i < 100; i++) r.push(1000 / 48);
    expect(r.periodMs).toBeCloseTo(P60, 9);
    // So a device slow all the time still reads as slow against the display.
    const { c, changes } = controller('high');
    feed(c, 28, 3, r.periodMs);
    expect(changes).toEqual(['medium']);
  });
});
