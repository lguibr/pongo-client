// Input controller (8.3): arbitrates keyboard and joystick, maps visual intent to the wire through the
// seat table, and sends through one dedupe and one rate limit.
//
//   desired = joystick.axis ?? keyboard.dir     the joystick wins while touched (C93)
//   wire    = toWire(me, desired)               orientation swap for seats 0 and 1 (4.8)
//
// Every edge and every resync queues one flush in a microtask, so a burst of edges in one task sends at
// most once. `lastSent` is recorded only after the sink accepted the message (C88), and it is invalidated
// whenever the socket generation, the room epoch or the seat changes. Keys are tracked in every phase and
// entering play resyncs, so a key held through the countdown or a rejoin is sent at once (C18).
// Nothing here depends on React, so there are no effect dependency lists to get wrong (C97).

import type { InputController, InputDeps, JoystickModel, Visual } from './types';
import type { WireDirection } from '../protocol/messages';
import type { Seat } from '../game/events';
import type { SessionStateName } from '../session/types';
import type { Now } from '../lib/clock';
import { now as defaultNow } from '../lib/clock';
import { browserTimers } from '../lib/timers';
import { T } from '../config/tuning';
import { toWire } from '../game/orientation';
import { stats as debugStats } from '../state/stats';
import { KeyboardTracker } from './keyboard';
import { createJoystick } from './joystick';

/** Token bucket. The server allows 60 messages per second with a burst of 120 and then closes the socket
 *  (pongo/server/connection_handler.go:13,164-173); the client stays well below that. */
class TokenBucket {
  private static readonly EPS = 1e-6;
  private tokens: number;
  private last: number;

  constructor(private readonly perSecond: number, private readonly burst: number, private readonly now: Now) {
    this.tokens = burst;
    this.last = now();
  }

  take(): boolean {
    this.refill();
    if (this.tokens < 1 - TokenBucket.EPS) return false;
    this.tokens = Math.max(0, this.tokens - 1);
    return true;
  }

  /** Milliseconds until one whole token is available; 0 when one already is. */
  msUntilToken(): number {
    this.refill();
    const missing = 1 - this.tokens;
    return missing <= TokenBucket.EPS ? 0 : Math.ceil((missing * 1000) / this.perSecond);
  }

  private refill(): void {
    const t = this.now();
    if (t > this.last) this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) * this.perSecond) / 1000);
    this.last = t;
  }
}

export function createInputController(deps: InputDeps = {}): InputController {
  const now = deps.now ?? defaultNow;
  const timers = deps.timers ?? browserTimers;
  const tuning = deps.tuning ?? T;

  const keyboard = new KeyboardTracker();
  const stick = createJoystick({
    radiusPx: tuning.input.joystickRadiusPx,
    enter: tuning.input.enter,
    exit: tuning.input.exit,
  });
  const bucket = new TokenBucket(tuning.input.tokensPerSecond, tuning.input.burst, now);
  const counters = { sent: 0, coalesced: 0, refused: 0 };

  let sink: ((d: WireDirection) => boolean) | null = null;
  let s: SessionStateName = 'idle';
  let gen = 0;
  let epoch = 0;
  let me: Seat | null = null;
  let lastSent: WireDirection | null = null;
  let flushQueued = false;
  let trailing: number | null = null;

  function desired(): Visual {
    const axis = stick.axis;
    return axis !== null ? axis : keyboard.dir;
  }

  function send(wire: WireDirection): boolean {
    if (sink !== null && sink(wire)) {
      lastSent = wire;   // only after a real send (C88)
      counters.sent++;
      debugStats.input.sent++;
      return true;
    }
    counters.refused++;
    return false;
  }

  function flush(): void {
    if (s !== 'playing' || me === null) return;   // keys are still tracked in every phase (C18)
    const wire = toWire(me, desired());
    if (wire === lastSent) return;
    if (!bucket.take()) {
      scheduleTrailing();
      counters.coalesced++;
      debugStats.input.coalesced++;
      return;
    }
    send(wire);
  }

  /** One flush when the next token is due; it re-reads the intent then, so only the latest state goes out. */
  function scheduleTrailing(): void {
    if (trailing !== null) return;
    trailing = timers.setTimeout(() => {
      trailing = null;
      flush();
    }, Math.max(1, bucket.msUntilToken()));
  }

  function scheduleFlush(): void {
    if (flushQueued) return;
    flushQueued = true;
    queueMicrotask(() => {
      flushQueued = false;
      flush();
    });
  }

  function resync(): void {
    lastSent = null;
    scheduleFlush();
  }

  function halt(): void {
    keyboard.clear();
    stick.cancelAll();
    if (lastSent === 'Stop' || s !== 'playing') return;
    bucket.take();   // metered like every send, but a Stop is never withheld
    send('Stop');
  }

  /** The joystick the view drives. Every change of its axis is an edge. */
  const joystick: JoystickModel = {
    down(pointerId, clientX, clientY, pointerType, zone) {
      const captured = stick.down(pointerId, clientX, clientY, pointerType, zone);
      if (captured) scheduleFlush();
      return captured;
    },
    move(pointerId, clientX, clientY) {
      const before = stick.axis;
      stick.move(pointerId, clientX, clientY);
      if (stick.axis !== before) scheduleFlush();
    },
    up(pointerId) {
      const before = stick.axis;
      stick.up(pointerId);
      if (stick.axis !== before) scheduleFlush();
    },
    cancelAll() {
      const before = stick.axis;
      stick.cancelAll();
      if (stick.axis !== before) scheduleFlush();
    },
    get axis() {
      return stick.axis;
    },
    get knob() {
      return stick.knob;
    },
  };

  return {
    resync,
    halt,

    attach(win) {
      const doc = win.document;
      const onKeyDown = (e: KeyboardEvent): void => {
        if (keyboard.onKeyDown(e, s === 'playing')) scheduleFlush();
      };
      const onKeyUp = (e: KeyboardEvent): void => {
        if (keyboard.onKeyUp(e)) scheduleFlush();
      };
      // Window focus changes only. Element focus events do not bubble, and the at-target check keeps a
      // synthetic bubbling one out as well. It compares with currentTarget rather than `win`, because test
      // environments can expose a global that is not the object events report as their target.
      const onBlur = (e: FocusEvent): void => {
        if (e.target === e.currentTarget) halt();
      };
      const onFocus = (e: FocusEvent): void => {
        if (e.target === e.currentTarget) resync();
      };
      const onVisibility = (): void => {
        if (doc.visibilityState === 'hidden') halt();
      };
      const onPageHide = (): void => halt();

      // Capture phase, so a component that stops propagation can never hide a keyup and leave a key stuck.
      win.addEventListener('keydown', onKeyDown, true);
      win.addEventListener('keyup', onKeyUp, true);
      win.addEventListener('blur', onBlur);
      win.addEventListener('focus', onFocus);
      win.addEventListener('pagehide', onPageHide);
      doc.addEventListener('visibilitychange', onVisibility);
      return () => {
        win.removeEventListener('keydown', onKeyDown, true);
        win.removeEventListener('keyup', onKeyUp, true);
        win.removeEventListener('blur', onBlur);
        win.removeEventListener('focus', onFocus);
        win.removeEventListener('pagehide', onPageHide);
        doc.removeEventListener('visibilitychange', onVisibility);
        // Detached, the tracker can no longer see keyups, so nothing it holds can be trusted: drop the held
        // keys and any touch, and cancel a pending trailing flush so nothing reaches the sink afterwards.
        if (trailing !== null) {
          timers.clearTimeout(trailing);
          trailing = null;
        }
        keyboard.clear();
        stick.cancelAll();
      };
    },

    setSink(next) {
      sink = next;
    },

    onSession(v) {
      // A new socket, a new room epoch or a new seat makes lastSent meaningless: the server holds no
      // direction for this connection or seat yet.
      const invalidated = v.gen !== gen || v.epoch !== epoch || v.me !== me;
      if (invalidated) {
        lastSent = null;
        gen = v.gen;
        epoch = v.epoch;
      }
      const entering = v.s === 'playing' && s !== 'playing';   // admission into play, gameStarted, every rejoin
      s = v.s;
      me = v.me;
      if (invalidated || entering) resync();
    },

    joystick,
    get desired() {
      return desired();
    },
    get lastSent() {
      return lastSent;
    },
    get stats() {
      return counters;
    },
  };
}
