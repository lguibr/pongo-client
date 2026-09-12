import { describe, expect, it } from 'vitest';
import { createEventQueue } from './queue';
import type { EventQueue, GameEvent, Seat } from './events';
import { IMMEDIATE } from './events';

function bounce(q: EventQueue, tick: number): GameEvent {
  return { k: 'brickBounce', ball: 1, tick, seq: q.nextSeq(), x: 0, y: 0, conf: 1, stale: false };
}

function score(q: EventQueue, tick: number, seat: Seat, delta: number): GameEvent {
  return { k: 'score', seat, from: 0, to: delta, delta, cause: 'brick', tick, seq: q.nextSeq(), x: 0, y: 0, conf: 1, stale: false };
}

function drainAll(q: EventQueue, displayTick: number, idle = false, staleTicks = 100): GameEvent[] {
  const out: GameEvent[] = [];
  q.drain(displayTick, idle, staleTicks, (e) => out.push(e));
  return out;
}

describe('createEventQueue', () => {
  it('releases in (tick, seq) order whatever the push order', () => {
    const q = createEventQueue();
    const a = bounce(q, 5);
    const b = bounce(q, 3);
    const c = bounce(q, 5);
    const d = bounce(q, 4);
    const e = bounce(q, 3);
    for (const ev of [a, b, c, d, e]) q.push(ev);
    expect(drainAll(q, 10)).toEqual([b, e, d, a, c]);
    expect(q.size).toBe(0);
  });

  it('releases only events whose tick has been reached', () => {
    const q = createEventQueue();
    const [e2, e3, e4] = [bounce(q, 2), bounce(q, 3), bounce(q, 4)];
    q.push(e4);
    q.push(e2);
    q.push(e3);
    expect(drainAll(q, 3.5)).toEqual([e2, e3]);
    expect(q.size).toBe(1);
    expect(drainAll(q, 4)).toEqual([e4]);
  });

  it('releases IMMEDIATE events on the next drain, before timed ones, even before display time reaches 0', () => {
    const q = createEventQueue();
    const late = bounce(q, 7);
    const now: GameEvent = { k: 'go', tick: IMMEDIATE, seq: q.nextSeq(), x: 0, y: 0, conf: 1, stale: false };
    q.push(late);
    q.push(now);
    expect(drainAll(q, -3.2)).toEqual([now]);
    expect(now.stale).toBe(false);
    expect(q.size).toBe(1);
  });

  it('releases everything when idle, without marking future events stale', () => {
    const q = createEventQueue();
    const future = bounce(q, 50);
    q.push(future);
    q.push(bounce(q, 1));
    const out = drainAll(q, 2, true);
    expect(out.map((e) => e.tick)).toEqual([1, 50]);
    expect(future.stale).toBe(false);
  });

  it('marks events more than staleTicks behind display time as stale', () => {
    const q = createEventQueue();
    const old = bounce(q, 5);
    const recent = bounce(q, 12);
    q.push(old);
    q.push(recent);
    drainAll(q, 20, false, 10);
    expect(old.stale).toBe(true);
    expect(recent.stale).toBe(false);
  });

  it('releaseAllStale fires every queued event marked stale', () => {
    const q = createEventQueue();
    q.push(bounce(q, 100));
    q.push(bounce(q, 1));
    const out: GameEvent[] = [];
    q.releaseAllStale((e) => out.push(e));
    expect(out.map((e) => [e.tick, e.stale])).toEqual([[1, true], [100, true]]);
    expect(q.size).toBe(0);
  });

  it('keeps pendingScoreDelta as the sum of unreleased score deltas', () => {
    const q = createEventQueue();
    q.push(score(q, 3, 1, 3));
    q.push(score(q, 4, 0, -1));
    q.push(score(q, 9, 1, 2));
    expect(Array.from(q.pendingScoreDelta)).toEqual([-1, 5, 0, 0]);
    drainAll(q, 4);
    expect(Array.from(q.pendingScoreDelta)).toEqual([0, 2, 0, 0]);
    q.releaseAllStale(() => {});
    expect(Array.from(q.pendingScoreDelta)).toEqual([0, 0, 0, 0]);
  });

  it('on overflow drops the oldest event released stale, so pendingScoreDelta stays exact', () => {
    const dropped: GameEvent[] = [];
    const q = createEventQueue(4, (e) => dropped.push(e));
    const evs = [0, 1, 2, 3, 4, 5].map((t) => score(q, t, 2, 1));
    for (const e of evs) q.push(e);
    expect(q.size).toBe(4);
    expect(dropped).toEqual([evs[0], evs[1]]);
    expect(dropped.every((e) => e.stale)).toBe(true);
    expect(q.pendingScoreDelta[2]).toBe(4);
    const out = drainAll(q, 10);
    expect(out).toEqual(evs.slice(2));
    expect(q.pendingScoreDelta[2]).toBe(0);
  });

  it('clear empties the queue and zeroes the pending deltas', () => {
    const q = createEventQueue();
    q.push(score(q, 1, 3, 7));
    q.clear();
    expect(q.size).toBe(0);
    expect(Array.from(q.pendingScoreDelta)).toEqual([0, 0, 0, 0]);
    expect(drainAll(q, 100, true)).toEqual([]);
  });

  it('hands out increasing sequence numbers', () => {
    const q = createEventQueue();
    const a = q.nextSeq();
    const b = q.nextSeq();
    expect(b).toBeGreaterThan(a);
  });
});
