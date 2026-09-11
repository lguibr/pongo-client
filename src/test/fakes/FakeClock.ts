// A controllable clock: `now` plus a TimerHost whose timers fire only when the test moves time.
// Pass `clock.now` wherever a module takes `now?: Now`, and `clock` wherever it takes `timers?: TimerHost`.

import type { TimerHost } from '../../lib/timers';
import type { Now } from '../../lib/clock';

interface Entry { id: number; at: number; order: number; fn: () => void }

export class FakeClock implements TimerHost {
  private t: number;
  private nextId = 1;
  private order = 0;
  private readonly entries = new Map<number, Entry>();

  constructor(startMs = 0) {
    this.t = startMs;
  }

  readonly now: Now = () => this.t;

  readonly setTimeout = (fn: () => void, ms: number): number => {
    const id = this.nextId++;
    const delay = Number.isFinite(ms) && ms > 0 ? ms : 0;
    this.entries.set(id, { id, at: this.t + delay, order: this.order++, fn });
    return id;
  };

  readonly clearTimeout = (h: number): void => {
    this.entries.delete(h);
  };

  /** Number of timers waiting to fire. */
  get pending(): number {
    return this.entries.size;
  }

  /** Due time of the next timer, or null when none is pending. */
  nextDueAt(): number | null {
    return this.earliest()?.at ?? null;
  }

  /** Moves time forward by `ms`, firing due timers in (due time, creation) order, each at its own due time.
   *  Timers scheduled while advancing also fire if they fall inside the window. */
  advance(ms: number): void {
    const end = this.t + Math.max(0, ms);
    for (;;) {
      const e = this.earliest();
      if (e === null || e.at > end) break;
      this.fire(e);
    }
    this.t = end;
  }

  /** Moves to an absolute time (never backwards), firing due timers on the way. */
  setTime(ms: number): void {
    this.advance(ms - this.t);
  }

  /** Fires the next timer, jumping time to it. False when none is pending. */
  runNext(): boolean {
    const e = this.earliest();
    if (e === null) return false;
    this.fire(e);
    return true;
  }

  /** Fires timers until none is pending. Throws after `limit` firings, which means a timer loop. */
  runAll(limit = 10_000): number {
    let n = 0;
    while (this.runNext()) {
      if (++n >= limit && this.entries.size > 0) throw new Error(`FakeClock.runAll: more than ${limit} timers fired`);
    }
    return n;
  }

  private fire(e: Entry): void {
    this.entries.delete(e.id);
    if (e.at > this.t) this.t = e.at;
    e.fn();
  }

  private earliest(): Entry | null {
    let best: Entry | null = null;
    for (const e of this.entries.values()) {
      if (best === null || e.at < best.at || (e.at === best.at && e.order < best.order)) best = e;
    }
    return best;
  }
}
