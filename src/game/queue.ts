// The event queue (4.5, 4.7): released in (tick, seq) order, IMMEDIATE (-1) first. A fixed circular buffer
// kept sorted by insertion, so drain() and releaseAllStale() never allocate.

import type { EventQueue, GameEvent } from './events';
import { IMMEDIATE } from './events';

const DEFAULT_CAPACITY = 1024;

function before(a: GameEvent, b: GameEvent): boolean {
  return a.tick < b.tick || (a.tick === b.tick && a.seq < b.seq);
}

/** Overflow drops the oldest event after releasing it stale, so pendingScoreDelta stays exact. The optional
 *  `onOverflow` receives that event (already marked stale), so the runtime can apply its release bookkeeping. */
export function createEventQueue(capacity: number = DEFAULT_CAPACITY, onOverflow?: (e: GameEvent) => void): EventQueue {
  const cap = Math.max(1, Math.floor(capacity));
  const buf: (GameEvent | null)[] = new Array<GameEvent | null>(cap).fill(null);
  const pendingScoreDelta = new Int32Array(4);
  let head = 0;
  let count = 0;
  let seq = 0;

  const settle = (e: GameEvent): void => {
    if (e.k === 'score') pendingScoreDelta[e.seat] -= e.delta;
  };

  const shift = (): GameEvent => {
    const e = buf[head] as GameEvent;
    buf[head] = null;
    head = head + 1 === cap ? 0 : head + 1;
    count--;
    return e;
  };

  return {
    get size(): number {
      return count;
    },
    pendingScoreDelta,

    push(e: GameEvent): void {
      if (count === cap) {
        const dropped = shift();
        dropped.stale = true;
        settle(dropped);
        onOverflow?.(dropped);
      }
      // Insertion step: events mostly arrive in order, so the walk back is short.
      let j = count;
      let idx = (head + j) % cap;
      while (j > 0) {
        const prevIdx = idx === 0 ? cap - 1 : idx - 1;
        const prev = buf[prevIdx] as GameEvent;
        if (!before(e, prev)) break;
        buf[idx] = prev;
        idx = prevIdx;
        j--;
      }
      buf[idx] = e;
      count++;
      if (e.k === 'score') pendingScoreDelta[e.seat] += e.delta;
    },

    drain(displayTick: number, idle: boolean, staleTicks: number, fire: (e: GameEvent) => void): void {
      while (count > 0) {
        const e = buf[head] as GameEvent;
        if (!(idle || e.tick === IMMEDIATE || e.tick <= displayTick)) break;
        shift();
        if (e.tick !== IMMEDIATE && displayTick - e.tick > staleTicks) e.stale = true;
        settle(e);
        fire(e);
      }
    },

    releaseAllStale(fire: (e: GameEvent) => void): void {
      while (count > 0) {
        const e = shift();
        e.stale = true;
        settle(e);
        fire(e);
      }
    },

    clear(): void {
      for (let i = 0; i < cap; i++) buf[i] = null;
      head = 0;
      count = 0;
      pendingScoreDelta.fill(0);
    },

    nextSeq(): number {
      return seq++;
    },
  };
}
