// Quality tiers (5.13). The initial tier comes from the setting or the device; the controller steps down after
// three consecutive 2 s windows whose p90 frame interval is above 1.35 x the display period, and up after ten
// below 0.8 x, at most once per controller (one per session). A tier changes DPR, post and spawn counts only.

import type { Tier } from './contracts';
import type { QualityPref } from '../lib/settings';
import type { Tuning } from '../config/tuning';

const ORDER: readonly Tier[] = ['low', 'medium', 'high'];
const MAX_SAMPLES = 2048;          // 2 s at 1 000 Hz
const PAUSE_MS = 250;              // a longer interval is a pause (hidden tab, demand frameloop), not load
const RATES_HZ = [30, 48, 50, 60, 72, 75, 90, 100, 120, 144, 165, 240] as const;

export function initialTier(pref: QualityPref, nav: { deviceMemory?: number; hardwareConcurrency?: number }, coarse: boolean): Tier {
  if (pref !== 'auto') return pref;
  const mem = nav.deviceMemory;
  const cores = nav.hardwareConcurrency;
  if (mem !== undefined && mem <= 2) return 'low';
  if (coarse && cores !== undefined && cores <= 4) return 'low';
  if (!coarse && cores !== undefined && cores >= 8) return 'high';
  return 'medium';
}

/** The value at quantile q (nearest rank) of values[0 .. n), by quickselect. Reorders values[0 .. n). */
export function selectQuantile(values: Float32Array, n: number, q: number): number {
  if (n <= 0) return 0;
  let k = Math.ceil(q * n) - 1;
  if (k < 0) k = 0;
  if (k > n - 1) k = n - 1;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const pivot = values[(lo + hi) >> 1];
    let i = lo;
    let j = hi;
    while (i <= j) {
      while (values[i] < pivot) i++;
      while (values[j] > pivot) j--;
      if (i <= j) {
        const tmp = values[i];
        values[i] = values[j];
        values[j] = tmp;
        i++;
        j--;
      }
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else break;
  }
  return values[k];
}

export class QualityController {
  private readonly t: Tuning['quality'];
  private readonly onChange: (t: Tier) => void;
  private readonly samples = new Float32Array(MAX_SAMPLES);
  private n = 0;
  private elapsed = 0;
  private slow = 0;
  private fast = 0;
  private steppedUp = false;
  private current: Tier;

  constructor(t: Tuning['quality'], start: Tier, onChange: (t: Tier) => void) {
    this.t = t;
    this.current = start;
    this.onChange = onChange;
  }

  get tier(): Tier {
    return this.current;
  }

  /** One frame interval. refreshMs is the display period. */
  sample(dtMs: number, refreshMs: number): void {
    if (!(dtMs > 0) || dtMs > PAUSE_MS || !(refreshMs > 0)) return;
    if (this.n < MAX_SAMPLES) this.samples[this.n++] = dtMs;
    this.elapsed += dtMs;
    if (this.elapsed < this.t.windowMs) return;
    const p90 = selectQuantile(this.samples, this.n, 0.9);
    this.n = 0;
    this.elapsed = 0;
    if (p90 > this.t.downFactor * refreshMs) {
      this.slow++;
      this.fast = 0;
    } else if (p90 < this.t.upFactor * refreshMs) {
      this.fast++;
      this.slow = 0;
    } else {
      this.slow = 0;
      this.fast = 0;
    }
    if (this.slow >= this.t.downWindows) {
      this.slow = 0;
      this.step(-1);
    } else if (this.fast >= this.t.upWindows && !this.steppedUp) {
      this.fast = 0;
      if (this.step(1)) this.steppedUp = true;
    }
  }

  /** Forces the tier (a manual setting, or a new initial tier) without calling onChange; streaks restart. */
  setTier(t: Tier): void {
    this.current = t;
    this.n = 0;
    this.elapsed = 0;
    this.slow = 0;
    this.fast = 0;
  }

  private step(dir: -1 | 1): boolean {
    const i = ORDER.indexOf(this.current) + dir;
    if (i < 0 || i >= ORDER.length) return false;
    this.current = ORDER[i];
    this.onChange(this.current);
    return true;
  }
}

/** The display period: each second's median frame interval, snapped to a common refresh rate. It starts at 60 Hz
 *  and only ever gets shorter, because frames can run slower than the display but never faster: a device that is
 *  slow all the time must not teach the controller that its own frame rate is the display's. Feed it only frames
 *  of a continuous frameloop. */
export class RefreshEstimator {
  private readonly buf = new Float32Array(256);
  private n = 0;
  private elapsed = 0;
  private period = 1000 / 60;

  get periodMs(): number {
    return this.period;
  }

  push(dtMs: number): void {
    if (!(dtMs > 2) || dtMs > PAUSE_MS) return;
    this.buf[this.n++] = dtMs;
    this.elapsed += dtMs;
    if (this.elapsed < 1000 && this.n < this.buf.length) return;
    const snapped = snapPeriod(selectQuantile(this.buf, this.n, 0.5));
    if (snapped < this.period) this.period = snapped;
    this.n = 0;
    this.elapsed = 0;
  }
}

/** The period of the common refresh rate nearest to `ms` (relative distance). */
export function snapPeriod(ms: number): number {
  let best: number = RATES_HZ[0];
  let bestErr = Infinity;
  for (const hz of RATES_HZ) {
    const err = Math.abs(ms * hz - 1000) / 1000;
    if (err < bestErr) {
      bestErr = err;
      best = hz;
    }
  }
  return 1000 / best;
}
