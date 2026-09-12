import { describe, expect, it } from 'vitest';
import { ColdBridge } from './coldBridge';
import { createEventQueue } from './queue';
import { createWorld } from './world';
import { SeatConn } from './events';
import type { EventQueue, GameEvent, Seat } from './events';
import { createStore } from '../lib/store';
import { initialAppState } from '../state/appStore';
import { FakeClock } from '../test/fakes/FakeClock';
import type { TimerHost } from '../lib/timers';

function setup(): { bridge: ColdBridge; store: ReturnType<typeof createStore<ReturnType<typeof initialAppState>>>; queue: EventQueue; world: ReturnType<typeof createWorld>; clock: FakeClock; patches: () => number } {
  const store = createStore(initialAppState());
  const queue = createEventQueue();
  const world = createWorld();
  const clock = new FakeClock(1000);
  let n = 0;
  store.subscribe(() => n++);
  const bridge = new ColdBridge(store, queue, clock, clock.now, world);
  return { bridge, store, queue, world, clock, patches: () => n };
}

function score(q: EventQueue, seat: Seat, delta: number): GameEvent {
  return { k: 'score', seat, from: 0, to: 0, delta, cause: 'brick', tick: 5, seq: q.nextSeq(), x: 0, y: 0, conf: 1, stale: false };
}

describe('ColdBridge', () => {
  it('publishes seats from the world and reuses unchanged SeatView objects', () => {
    const { bridge, store, world } = setup();
    world.myIndex = 1;
    world.seats[1].conn = SeatConn.Connected;
    world.seats[1].scoreKnown = true;
    world.seats[1].score = 3;
    world.seats[1].ready = true;
    bridge.flushNow();
    const first = store.get().seats;
    expect(first[1]).toMatchObject({ index: 1, conn: SeatConn.Connected, score: 3, ready: true, isMe: true, name: 'Green' });
    expect(first[0].score).toBeNull();
    world.seats[2].conn = SeatConn.Grace;
    world.seats[2].graceEndsAt = 40_000;
    bridge.flushNow();
    const second = store.get().seats;
    expect(second).not.toBe(first);
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
    expect(second[2]).not.toBe(first[2]);
    expect(second[2].graceEndsAt).toBe(40_000);
  });

  it('does not patch the store when nothing changed', () => {
    const { bridge, patches } = setup();
    bridge.flushNow();
    const n = patches();
    bridge.flushNow();
    expect(patches()).toBe(n);
  });

  it('shows the world score minus the unreleased deltas', () => {
    const { bridge, store, queue, world } = setup();
    world.seats[0].conn = SeatConn.Connected;
    world.seats[0].scoreKnown = true;
    world.seats[0].score = 10;
    queue.push(score(queue, 0, 3));
    bridge.flushNow();
    expect(store.get().seats[0].score).toBe(7);
    queue.releaseAllStale(() => {});
    bridge.flushNow();
    expect(store.get().seats[0].score).toBe(10);
  });

  it('publishes at most once per 100 ms, trailing, with the latest values', () => {
    const { bridge, store, world, clock, patches } = setup();
    world.seats[3].conn = SeatConn.Connected;
    world.seats[3].scoreKnown = true;
    const start = patches();
    for (let i = 1; i <= 100; i++) {
      world.seats[3].score = i;
      bridge.markDirty();
      clock.advance(10);
    }
    clock.advance(200);
    const count = patches() - start;
    expect(count).toBeGreaterThanOrEqual(9);
    expect(count).toBeLessThanOrEqual(11);
    expect(store.get().seats[3].score).toBe(100);
  });

  it('schedules every publish with one callback made up front, so marking from frame() allocates nothing', () => {
    const store = createStore(initialAppState());
    const clock = new FakeClock(1000);
    const scheduled: (() => void)[] = [];
    const host: TimerHost = {
      setTimeout: (fn, ms) => {
        scheduled.push(fn);
        return clock.setTimeout(fn, ms);
      },
      clearTimeout: clock.clearTimeout,
    };
    const world = createWorld();
    world.seats[2].conn = SeatConn.Connected;
    const bridge = new ColdBridge(store, createEventQueue(), host, clock.now, world);
    for (let i = 0; i < 4; i++) {
      bridge.markDirty();
      bridge.markDirty();   // already pending: no second timer
      clock.advance(150);
    }
    expect(scheduled).toHaveLength(4);
    expect(new Set(scheduled).size).toBe(1);
    expect(store.get().seats[2].conn).toBe(SeatConn.Connected);   // the shared callback still publishes
  });
});
