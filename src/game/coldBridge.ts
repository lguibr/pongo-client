// The cold bridge (D20, 2.4 step 6): the only writer of appStore.seats. A trailing timer publishes at most every
// 100 ms. The displayed score is the World's score minus the queue's unreleased deltas, so it bumps when the
// pop flies and can never drift. SeatView objects whose values did not change are reused.

import type { EventQueue, Seat } from './events';
import { SeatConn } from './events';
import type { World } from './types';
import type { AppStore, SeatView } from '../state/appStore';
import type { TimerHost } from '../lib/timers';
import type { Now } from '../lib/clock';
import { SEATS } from './orientation';

const PUBLISH_MS = 100;

function sameView(a: SeatView, b: SeatView): boolean {
  return a.index === b.index && a.conn === b.conn && Object.is(a.score, b.score) && a.ready === b.ready
    && a.isMe === b.isMe && Object.is(a.graceEndsAt, b.graceEndsAt)
    && a.name === b.name && a.color === b.color && a.glyph === b.glyph;
}

export class ColdBridge {
  private readonly store: AppStore;
  private readonly queue: EventQueue;
  private readonly timers: TimerHost;
  private readonly now: Now;
  private readonly world: Readonly<World>;
  private handle: number | null = null;
  private lastPublishAt = -Infinity;
  /** Created once: markDirty() runs inside frame() on score and seat releases, which must not allocate. */
  private readonly onTimer = (): void => {
    this.handle = null;
    this.flushNow();
  };

  constructor(store: AppStore, queue: EventQueue, timers: TimerHost, now: Now, world: Readonly<World>) {
    this.store = store;
    this.queue = queue;
    this.timers = timers;
    this.now = now;
    this.world = world;
  }

  /** Schedules a trailing publish from `world` at most every 100 ms. */
  markDirty(): void {
    if (this.handle !== null) return;
    const since = this.now() - this.lastPublishAt;
    const wait = since >= PUBLISH_MS ? 0 : PUBLISH_MS - since;
    this.handle = this.timers.setTimeout(this.onTimer, wait);
  }

  /** Builds seats; reuses SeatView objects whose values are unchanged, and patches only on a change. */
  flushNow(): void {
    if (this.handle !== null) {
      this.timers.clearTimeout(this.handle);
      this.handle = null;
    }
    this.lastPublishAt = this.now();
    const prev = this.store.get().seats;
    const w = this.world;
    const pending = this.queue.pendingScoreDelta;
    let changed = false;
    const next = prev.map((old, i): SeatView => {
      const seat = i as Seat;
      const s = w.seats[seat];
      const info = SEATS[seat];
      const view: SeatView = {
        index: seat, conn: s.conn,
        score: s.conn === SeatConn.Empty || !s.scoreKnown ? null : s.score - pending[seat],
        ready: s.conn === SeatConn.Connected && s.ready,
        isMe: w.myIndex === seat,
        graceEndsAt: s.conn === SeatConn.Grace ? s.graceEndsAt : NaN,
        name: info.name, color: info.color, glyph: info.glyph,
      };
      if (sameView(old, view)) return old;
      changed = true;
      return view;
    }) as unknown as readonly [SeatView, SeatView, SeatView, SeatView];
    if (changed) this.store.patch({ seats: next });
  }
}
