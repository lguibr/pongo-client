// The playout clock (D05, 5.2). Render time follows latestTick*25 + min(now - lastArrival, 25) - delay in the
// tick domain, slewing at most +-8 % and snapping beyond snapMs. Hit-stop is display-time debt only (D07): it
// never feeds the delay or the target.

import type { Tuning } from '../config/tuning';
import { TICK_MS } from '../config/constants';
import { clamp } from '../lib/math';

const STOP_LOG = 32;
const INITIAL_JITTER_MS = 5;
const INITIAL_DELAY_MS = 40;

export class Playout {
  private readonly t: Tuning['playout'];
  private readonly h: Tuning['hitStop'];

  private isStarted = false;
  private latest = 0;
  private lastArrival = 0;
  private jitter = INITIAL_JITTER_MS;
  private delayTarget = INITIAL_DELAY_MS;
  private delay = INITIAL_DELAY_MS;
  private r = 0;
  private display = 0;
  private snapPending = false;
  private isIdle = true;
  private snapCount = 0;
  private debt = 0;
  private stopRemaining = 0;
  private unstable = false;
  private readonly stopAt = new Float64Array(STOP_LOG);
  private readonly stopMs = new Float64Array(STOP_LOG);
  private stopHead = 0;

  constructor(t: Tuning['playout'], h: Tuning['hitStop']) {
    this.t = t;
    this.h = h;
    this.reset();
  }

  reset(): void {
    this.isStarted = false;
    this.latest = 0;
    this.lastArrival = 0;
    this.jitter = INITIAL_JITTER_MS;
    this.delayTarget = INITIAL_DELAY_MS;
    this.delay = INITIAL_DELAY_MS;
    this.r = 0;
    this.display = 0;
    this.snapPending = false;
    this.isIdle = true;
    this.snapCount = 0;
    this.debt = 0;
    this.stopRemaining = 0;
    this.unstable = false;
    this.stopAt.fill(-Infinity);
    this.stopMs.fill(0);
    this.stopHead = 0;
  }

  /** Records n closed ticks that arrived at arrivalMs. The first call after reset anchors the clock. */
  onTicks(n: number, arrivalMs: number): void {
    if (n <= 0) return;
    if (!this.isStarted) {
      this.latest = n * TICK_MS;
      this.lastArrival = arrivalMs;
      this.isStarted = true;
      this.snapPending = true;
      return;
    }
    const gap = arrivalMs - (this.lastArrival + TICK_MS * n);   // > 0 late, < 0 early (bunching)
    this.jitter += this.t.jitterAlpha * (Math.abs(gap) - this.jitter);
    this.latest += TICK_MS * n;
    this.lastArrival = arrivalMs;
    this.delayTarget = clamp(this.t.baseDelayMs + this.t.jitterGain * this.jitter, this.t.minDelayMs, this.t.maxDelayMs);
  }

  /** Per display frame; allocates nothing (the clamps are written out so no double crosses a call). */
  advance(dtMs: number, nowMs: number): void {
    const t = this.t;
    const dt = dtMs < 0 ? 0 : dtMs > t.dtClampMs ? t.dtClampMs : dtMs;
    if (!this.isStarted) {
      this.isIdle = true;
      return;
    }
    const step = t.delaySlewPerMs * dt;
    const dd = this.delayTarget - this.delay;
    this.delay += dd < -step ? -step : dd > step ? step : dd;
    const since = nowMs - this.lastArrival;
    this.isIdle = since > t.idleMs;
    const lead = since < 0 ? 0 : since > TICK_MS ? TICK_MS : since;
    const target = this.isIdle ? this.latest : this.latest + lead - this.delay;
    // The error of the free-running step (r + dt), so render time settles on the target itself rather than one
    // frame ahead of it, at any frame rate.
    const err = target - (this.r + dt);
    if (this.snapPending || Math.abs(err) > t.snapMs) {
      this.r = target;
      this.snapPending = false;
      this.snapCount++;
    } else {
      const g = err * t.slewGainPerMs;
      const next = this.r + dt * (1 + (g < -t.slewMax ? -t.slewMax : g > t.slewMax ? t.slewMax : g));
      // While idle the target stands still on the newest sample: approach it and hold there, never pass it
      // (a rate slew alone would run on to the extrapolation cap) and never step back.
      this.r = this.isIdle ? (this.r < target ? Math.min(next, target) : this.r) : next;
    }
    this.r = Math.min(this.r, this.latest + (this.unstable ? 0 : this.t.maxExtrapMs));
    if (this.stopRemaining > 0) {
      this.debt += dt;
      this.stopRemaining -= dt;
    } else {
      this.debt = Math.max(0, this.debt - this.h.repayRate * dt);
    }
    this.display = this.r - this.debt;
  }

  snap(): void {
    this.snapPending = true;
  }

  /** Grants up to min(ms, maxPerEventMs, what is left of maxPerSecondMs); false when capped or disabled. */
  hitStop(ms: number, nowMs: number): boolean {
    if (!this.h.enabled || !(ms > 0)) return false;
    let used = 0;
    for (let i = 0; i < STOP_LOG; i++) if (this.stopAt[i] > nowMs - 1000) used += this.stopMs[i];
    const grant = Math.min(ms, this.h.maxPerEventMs, this.h.maxPerSecondMs - used);
    if (grant <= 0) return false;
    // The slot about to be reused must have left the one-second window, or its budget would be lost.
    if (this.stopAt[this.stopHead] > nowMs - 1000) return false;
    this.stopRemaining = Math.max(this.stopRemaining, grant);
    this.stopAt[this.stopHead] = nowMs;
    this.stopMs[this.stopHead] = grant;
    this.stopHead = (this.stopHead + 1) % STOP_LOG;
    return true;
  }

  /** While set (a soft stall), render time never passes the newest sample. */
  setUnstable(unstable: boolean): void {
    this.unstable = unstable;
  }

  get renderMs(): number {
    return this.r;
  }
  get displayMs(): number {
    return this.display;
  }
  get latestMs(): number {
    return this.latest;
  }
  get delayMs(): number {
    return this.delay;
  }
  get jitterMs(): number {
    return this.jitter;
  }
  /** The first onTicks since reset has happened. */
  get started(): boolean {
    return this.isStarted;
  }
  /** !started, or no arrival for more than idleMs at the last advance. */
  get idle(): boolean {
    return !this.isStarted || this.isIdle;
  }
  get snaps(): number {
    return this.snapCount;
  }
  /** Display time is standing still for a hit-stop. */
  get hitStopActive(): boolean {
    return this.stopRemaining > 0;
  }
  /** Wall time left in the current hit-stop (ms); 0 when none is active. */
  get hitStopRemainingMs(): number {
    return this.stopRemaining > 0 ? this.stopRemaining : 0;
  }
  /** Arrival time of the newest ticks (ms); 0 before start. */
  get lastArrivalMs(): number {
    return this.lastArrival;
  }
  /** Current hit-stop debt (ms). */
  get debtMs(): number {
    return this.debt;
  }
}
