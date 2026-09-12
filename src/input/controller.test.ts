/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from 'vitest';
import { createInputController } from './controller';
import type { InputController, InputSessionView } from './types';
import type { WireDirection } from '../protocol/messages';
import type { Seat } from '../game/events';
import type { SessionStateName } from '../session/types';
import { FakeClock } from '../test/fakes/FakeClock';
import { TUNING } from '../config/tuning';
import { stats } from '../state/stats';

const RECT: DOMRectReadOnly = { left: 0, top: 400, right: 400, bottom: 700, width: 400, height: 300, x: 0, y: 400, toJSON: () => ({}) };

/** Lets the controller's queued microtask flush run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

function view(s: SessionStateName, me: Seat | null = 3, gen = 1, epoch = 1): InputSessionView {
  return { s, gen, epoch, me };
}

let detachers: (() => void)[] = [];

afterEach(() => {
  for (const d of detachers) d();
  detachers = [];
  document.body.innerHTML = '';
  Reflect.deleteProperty(document, 'visibilityState');
});

function setup() {
  const clock = new FakeClock(1000);
  const input: InputController = createInputController({ now: clock.now, timers: clock, tuning: TUNING });
  const sent: { d: WireDirection; at: number }[] = [];
  let accept = true;
  input.setSink((d) => {
    if (!accept) return false;
    sent.push({ d, at: clock.now() });
    return true;
  });
  detachers.push(input.attach(window));
  return {
    clock, input, sent,
    wires: (): WireDirection[] => sent.map((x) => x.d),
    setAccept(v: boolean): void {
      accept = v;
    },
    /** Enters play, lets the entry resync send the current intent, and forgets that send. */
    async enterPlay(me: Seat = 3): Promise<void> {
      input.onSession(view('playing', me));
      await settle();
      sent.length = 0;
    },
  };
}

function key(type: 'keydown' | 'keyup', code: string, init: KeyboardEventInit = {}, target: EventTarget = document.body): KeyboardEvent {
  const e = new KeyboardEvent(type, { code, key: code, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
}
const press = (code: string, init?: KeyboardEventInit, target?: EventTarget) => key('keydown', code, init, target);
const release = (code: string, init?: KeyboardEventInit, target?: EventTarget) => key('keyup', code, init, target);

describe('sending through the session gate', () => {
  it('sends a key held through the countdown as soon as play starts (C18)', async () => {
    const t = setup();
    t.input.onSession(view('lobby'));
    t.input.onSession(view('countdown'));
    press('ArrowLeft');
    await settle();
    expect(t.wires()).toEqual([]);
    expect(t.input.desired).toBe(-1);
    t.input.onSession(view('playing'));
    await settle();
    expect(t.wires()).toEqual(['ArrowLeft']);
    expect(t.input.lastSent).toBe('ArrowLeft');
  });

  it.each([
    [0, 'ArrowRight'],
    [1, 'ArrowRight'],
    [2, 'ArrowLeft'],
    [3, 'ArrowLeft'],
  ] as const)('maps visual left for seat %i to %s', async (seat, wire) => {
    const t = setup();
    await t.enterPlay(seat);
    press('KeyA');
    await settle();
    expect(t.wires()).toEqual([wire]);
    expect(t.input.desired).toBe(-1);
  });

  it('sends nothing outside play or without a seat, then sends once a seat is known', async () => {
    const t = setup();
    for (const s of ['idle', 'connecting', 'requesting', 'lobby', 'countdown', 'reconnecting', 'failed', 'finished'] as const) {
      t.input.onSession(view(s));
      press('ArrowRight');
      await settle();
      release('ArrowRight');
      await settle();
    }
    expect(t.wires()).toEqual([]);
    press('ArrowRight');
    t.input.onSession(view('playing', null));
    await settle();
    expect(t.wires()).toEqual([]);
    t.input.onSession(view('playing', 2));
    await settle();
    expect(t.wires()).toEqual(['ArrowRight']);
  });

  it('dedupes one direction across keys and sends Stop only when the last key is released', async () => {
    const t = setup();
    await t.enterPlay();
    press('ArrowLeft');
    await settle();
    press('KeyA');
    await settle();
    release('KeyA');
    await settle();
    release('ArrowLeft');
    await settle();
    expect(t.wires()).toEqual(['ArrowLeft', 'Stop']);
    expect(t.input.stats.sent).toBe(3);   // plus the Stop sent on entering play
  });

  it('coalesces the edges of one task into one flush with the latest intent', async () => {
    const t = setup();
    await t.enterPlay();
    press('ArrowLeft');
    press('KeyD');
    release('ArrowLeft');
    await settle();
    expect(t.wires()).toEqual(['ArrowRight']);
  });

  it('records lastSent only after the sink accepted the message (C88)', async () => {
    const t = setup();
    await t.enterPlay();
    t.setAccept(false);   // the socket reopened but admission has not happened yet
    press('ArrowLeft');
    await settle();
    expect(t.input.lastSent).toBe('Stop');
    expect(t.input.stats.refused).toBe(1);
    t.setAccept(true);
    // The key stays held; the next edge that maps to the same wire still sends, because nothing was recorded.
    press('KeyA');
    release('KeyA');
    await settle();
    expect(t.wires()).toEqual(['ArrowLeft']);
    expect(t.input.lastSent).toBe('ArrowLeft');
  });

  it('writes the debug counters', async () => {
    const before = { ...stats.input };
    const t = setup();
    await t.enterPlay();
    press('ArrowLeft');
    await settle();
    expect(stats.input.sent - before.sent).toBe(2);   // the entry Stop and ArrowLeft
    expect(t.input.stats).toEqual({ sent: 2, coalesced: 0, refused: 0 });
    // Six more edges spend the rest of the burst of 8; the edges after them are coalesced.
    for (let i = 0; i < 10; i++) {
      if (i % 2 === 0) release('ArrowLeft');
      else press('ArrowLeft');
      await settle();
    }
    expect(t.input.stats.coalesced).toBeGreaterThan(0);
    expect(stats.input.coalesced - before.coalesced).toBe(t.input.stats.coalesced);
    expect(stats.input.sent - before.sent).toBe(t.input.stats.sent);
  });
});

describe('resync', () => {
  it('re-sends the held direction after a gen change', async () => {
    const t = setup();
    await t.enterPlay();
    press('ArrowLeft');
    await settle();
    t.input.onSession(view('playing', 3, 2, 1));
    await settle();
    expect(t.wires()).toEqual(['ArrowLeft', 'ArrowLeft']);
    t.input.onSession(view('playing', 3, 2, 1));   // unchanged view: nothing
    await settle();
    expect(t.wires()).toHaveLength(2);
  });

  it('re-sends the held direction after an epoch change', async () => {
    const t = setup();
    await t.enterPlay();
    press('ArrowRight');
    await settle();
    t.input.onSession(view('playing', 3, 1, 2));
    await settle();
    expect(t.wires()).toEqual(['ArrowRight', 'ArrowRight']);
  });

  it('re-sends through a drop and rejoin, even when the send during the drop was refused', async () => {
    const t = setup();
    await t.enterPlay();
    press('ArrowLeft');
    await settle();
    // T31: the socket closed; the session's input.halt runs while this controller still sees 'playing'.
    t.setAccept(false);
    t.input.halt();
    t.input.onSession(view('reconnecting'));
    t.input.onSession(view('connecting', 3, 2, 1));
    t.input.onSession(view('requesting', 3, 2, 1));
    t.setAccept(true);
    // The key is still physically held: auto-repeat re-adds it.
    press('ArrowLeft', { repeat: true });
    await settle();
    expect(t.wires()).toEqual(['ArrowLeft']);
    t.input.onSession(view('playing', 3, 2, 2));
    await settle();
    expect(t.wires()).toEqual(['ArrowLeft', 'ArrowLeft']);
  });

  it('re-sends through the new seat swap when the seat changes at the same gen and epoch', async () => {
    const t = setup();
    await t.enterPlay(3);
    press('KeyA');
    await settle();
    expect(t.wires()).toEqual(['ArrowLeft']);   // visual left on seat 3 is wire left
    t.input.onSession(view('playing', 1, 1, 1));
    await settle();
    expect(t.wires()).toEqual(['ArrowLeft', 'ArrowRight']);   // and on seat 1 it is wire right
    expect(t.input.lastSent).toBe('ArrowRight');
  });

  it('sends a key re-added during the countdown of a rejoin exactly once when play resumes', async () => {
    const t = setup();
    t.input.onSession(view('countdown'));
    press('ArrowLeft');
    await settle();
    // T31 during the countdown: the socket closed and the session halted input. Nothing is sent, because
    // the controller is not in play.
    t.input.halt();
    expect(t.input.desired).toBe(0);
    t.input.onSession(view('reconnecting'));
    t.input.onSession(view('connecting', 3, 2, 1));
    t.input.onSession(view('requesting', 3, 2, 1));
    t.input.onSession(view('countdown', 3, 2, 2));
    // The key is still physically held: auto-repeat re-adds it.
    press('ArrowLeft', { repeat: true });
    await settle();
    expect(t.wires()).toEqual([]);
    expect(t.input.desired).toBe(-1);
    t.input.onSession(view('playing', 3, 2, 2));
    await settle();
    expect(t.wires()).toEqual(['ArrowLeft']);
    press('ArrowLeft', { repeat: true });
    await settle();
    expect(t.wires()).toEqual(['ArrowLeft']);
  });

  it('resync() re-sends the current intent even when it matches lastSent', async () => {
    const t = setup();
    await t.enterPlay();
    press('ArrowRight');
    await settle();
    t.input.resync();
    t.input.resync();
    await settle();
    expect(t.wires()).toEqual(['ArrowRight', 'ArrowRight']);
  });
});

describe('halt', () => {
  it('sends Stop at once, clears the keys and sends it only once', async () => {
    const t = setup();
    await t.enterPlay();
    press('ArrowLeft');
    await settle();
    t.input.halt();
    expect(t.wires()).toEqual(['ArrowLeft', 'Stop']);
    expect(t.input.desired).toBe(0);
    t.input.halt();
    await settle();
    expect(t.wires()).toEqual(['ArrowLeft', 'Stop']);
  });

  it('sends nothing outside play but still clears the keys', async () => {
    const t = setup();
    t.input.onSession(view('lobby'));
    press('ArrowLeft');
    t.input.halt();
    await settle();
    expect(t.wires()).toEqual([]);
    expect(t.input.desired).toBe(0);
  });

  it('tries again after a refused Stop', async () => {
    const t = setup();
    await t.enterPlay();
    press('ArrowRight');
    await settle();
    t.setAccept(false);
    t.input.halt();
    expect(t.input.lastSent).toBe('ArrowRight');
    t.setAccept(true);
    t.input.halt();
    expect(t.wires()).toEqual(['ArrowRight', 'Stop']);
    expect(t.input.lastSent).toBe('Stop');
  });

  it('is not withheld by an empty token bucket', async () => {
    const t = setup();
    await t.enterPlay();
    for (let i = 0; i < 10; i++) {
      if (i % 2 === 0) press('ArrowLeft');
      else release('ArrowLeft');
      await settle();
    }
    // 7 tokens were left after the entry send. The releases after them found the bucket empty.
    expect(t.wires()).toEqual(['ArrowLeft', 'Stop', 'ArrowLeft', 'Stop', 'ArrowLeft', 'Stop', 'ArrowLeft']);
    expect(t.input.stats.coalesced).toBe(2);
    t.input.halt();   // no time has passed, so no token has come back
    expect(t.wires()).toHaveLength(8);
    expect(t.input.lastSent).toBe('Stop');
  });

  it('cancels an active touch', async () => {
    const t = setup();
    await t.enterPlay();
    t.input.joystick.down(1, 200, 500, 'touch', RECT);
    t.input.joystick.move(1, 120, 500);
    await settle();
    expect(t.wires()).toEqual(['ArrowLeft']);
    t.input.halt();
    expect(t.input.joystick.axis).toBeNull();
    expect(t.input.joystick.knob[0]).toBe(0);
    expect(t.wires()).toEqual(['ArrowLeft', 'Stop']);
  });
});

describe('joystick arbitration (C93)', () => {
  it('lets the joystick win while touched and returns to the keyboard on release', async () => {
    const t = setup();
    await t.enterPlay();
    press('ArrowRight');
    await settle();
    expect(t.input.joystick.down(1, 200, 500, 'touch', RECT)).toBe(true);
    await settle();
    t.input.joystick.move(1, 150, 500);
    await settle();
    t.input.joystick.up(1);
    await settle();
    expect(t.wires()).toEqual(['ArrowRight', 'Stop', 'ArrowLeft', 'ArrowRight']);
    expect(t.input.desired).toBe(1);
  });

  it('ignores a mouse pointer, so a click cannot stop a keyboard-held paddle', async () => {
    const t = setup();
    await t.enterPlay();
    press('ArrowRight');
    await settle();
    expect(t.input.joystick.down(1, 200, 500, 'mouse', RECT)).toBe(false);
    t.input.joystick.move(1, 100, 500);
    await settle();
    expect(t.wires()).toEqual(['ArrowRight']);
    expect(t.input.desired).toBe(1);
    expect(t.input.joystick.down(2, 200, 500, 'pen', RECT)).toBe(true);
  });

  it('sends nothing extra while a thumb jitters around the entry threshold (C92)', async () => {
    const t = setup();
    await t.enterPlay();
    t.input.joystick.down(1, 100, 500, 'touch', RECT);
    for (let i = 0; i < 20; i++) {
      t.input.joystick.move(1, i % 2 === 0 ? 118 : 110, 500);   // 0.32 and 0.18 of the 56 px radius
      await settle();
    }
    t.input.joystick.move(1, 107, 500);   // 0.125: back to none
    await settle();
    expect(t.wires()).toEqual(['ArrowRight', 'Stop']);
  });

  it('re-bases a pen stroke whose end event was lost and sends from the new origin', async () => {
    const t = setup();
    await t.enterPlay();
    expect(t.input.joystick.down(2, 200, 500, 'pen', RECT)).toBe(true);
    t.input.joystick.move(2, 120, 500);
    await settle();
    expect(t.wires()).toEqual(['ArrowLeft']);
    // Same pointer id, no up in between: the pen resting at the new point is at rest, not steering.
    expect(t.input.joystick.down(2, 300, 500, 'pen', RECT)).toBe(true);
    await settle();
    expect(t.input.joystick.knob[1]).toBe(300);
    expect(t.wires()).toEqual(['ArrowLeft', 'Stop']);
    t.input.joystick.move(2, 380, 500);
    await settle();
    expect(t.wires()).toEqual(['ArrowLeft', 'Stop', 'ArrowRight']);
  });

  it('applies the seat swap to the joystick too', async () => {
    const t = setup();
    await t.enterPlay(1);
    t.input.joystick.down(1, 100, 500, 'touch', RECT);
    t.input.joystick.move(1, 180, 500);
    await settle();
    expect(t.wires()).toEqual(['ArrowLeft']);   // visual right on seat 1 is wire left
  });
});

describe('rate limit (C92)', () => {
  it('allows a burst of 8, then coalesces and delivers the latest intent when a token is due', async () => {
    const t = setup();
    await t.enterPlay();
    t.clock.advance(1000);   // refill after the entry send
    for (let i = 0; i < 13; i++) {
      if (i % 2 === 0) press('ArrowLeft');
      else release('ArrowLeft');
      await settle();
    }
    expect(t.wires()).toEqual(['ArrowLeft', 'Stop', 'ArrowLeft', 'Stop', 'ArrowLeft', 'Stop', 'ArrowLeft', 'Stop']);
    expect(t.input.stats.coalesced).toBe(3);
    t.clock.advance(33);
    expect(t.sent).toHaveLength(8);
    t.clock.advance(1);   // one token every 1000/30 ms
    expect(t.wires()).toHaveLength(9);
    expect(t.input.lastSent).toBe('ArrowLeft');
  });

  it('sends nothing from a pending trailing flush once the session has left play', async () => {
    const t = setup();
    await t.enterPlay();
    t.clock.advance(1000);
    for (let i = 0; i < 13; i++) {
      if (i % 2 === 0) press('ArrowLeft');
      else release('ArrowLeft');
      await settle();
    }
    expect(t.input.stats.coalesced).toBeGreaterThan(0);
    expect(t.clock.pending).toBe(1);   // the trailing flush that would deliver the held ArrowLeft
    expect(t.wires()).toHaveLength(8);
    t.input.onSession(view('reconnecting'));
    t.clock.advance(100);
    expect(t.clock.pending).toBe(0);
    expect(t.wires()).toHaveLength(8);
    expect(t.input.lastSent).toBe('Stop');
  });

  it('keeps any one-second window at the burst plus 30 sends and delivers the final state', async () => {
    const t = setup();
    await t.enterPlay();
    const start = t.clock.now();
    for (let i = 0; i < 2000; i++) {   // an edge every 5 ms for 10 s
      t.clock.advance(5);
      if (i % 2 === 0) press('ArrowLeft');
      else release('ArrowLeft');
      await settle();
    }
    const times = t.sent.map((x) => x.at);
    const { burst, tokensPerSecond } = TUNING.input;
    expect(times.length).toBeLessThanOrEqual(burst + tokensPerSecond * 10);
    expect(times.length).toBeGreaterThan(24 * 10);   // the limiter, not some other gate, is what bounds the rate
    for (let i = 0; i < times.length; i++) {
      const inWindow = times.filter((at) => at >= times[i] && at < times[i] + 1000).length;
      expect(inWindow).toBeLessThanOrEqual(burst + tokensPerSecond);
    }
    const lastSecond = times.filter((at) => at > start + 9000).length;
    expect(lastSecond).toBeLessThanOrEqual(tokensPerSecond + 1);
    expect(t.input.stats.coalesced).toBeGreaterThan(0);
    expect(t.input.stats.sent).toBe(times.length + 1);   // plus the Stop sent on entering play
    // The last edge released the key; the trailing flush must deliver that Stop.
    t.clock.advance(100);
    expect(t.input.lastSent).toBe('Stop');
    expect(t.input.desired).toBe(0);
  });
});

describe('attach', () => {
  it('prevents the default of game keys only while playing and never on a form control (C91)', async () => {
    const t = setup();
    document.body.innerHTML = '<input type="range" id="vol"><div role="slider" tabindex="0" id="s"></div>';
    const range = document.getElementById('vol') as HTMLElement;
    const slider = document.getElementById('s') as HTMLElement;
    t.input.onSession(view('lobby'));
    expect(press('ArrowLeft').defaultPrevented).toBe(false);
    release('ArrowLeft');
    await t.enterPlay();
    expect(press('ArrowLeft', {}, range).defaultPrevented).toBe(false);
    expect(press('ArrowRight', {}, slider).defaultPrevented).toBe(false);
    await settle();
    expect(t.wires()).toEqual([]);
    expect(t.input.desired).toBe(0);
    expect(press('Space').defaultPrevented).toBe(false);
    expect(press('ArrowLeft').defaultPrevented).toBe(true);
    await settle();
    expect(t.wires()).toEqual(['ArrowLeft']);
  });

  it('ignores Cmd+A, and a Meta key clears the held keys (C90)', async () => {
    const t = setup();
    await t.enterPlay();
    press('KeyA', { metaKey: true });
    await settle();
    expect(t.wires()).toEqual([]);
    press('KeyA');
    await settle();
    press('MetaLeft', { key: 'Meta', metaKey: true });
    await settle();
    expect(t.wires()).toEqual(['ArrowLeft', 'Stop']);
    expect(t.input.desired).toBe(0);
  });

  it('still steers with Shift held', async () => {
    const t = setup();
    await t.enterPlay();
    expect(press('KeyD', { shiftKey: true }).defaultPrevented).toBe(true);
    await settle();
    expect(t.wires()).toEqual(['ArrowRight']);
  });

  it('halts on window blur, resyncs on focus, and a repeat keydown recovers the held key (C18)', async () => {
    const t = setup();
    await t.enterPlay();
    press('ArrowRight');
    await settle();
    window.dispatchEvent(new FocusEvent('blur'));
    expect(t.wires()).toEqual(['ArrowRight', 'Stop']);
    expect(t.input.desired).toBe(0);
    window.dispatchEvent(new FocusEvent('focus'));
    await settle();
    expect(t.wires()).toEqual(['ArrowRight', 'Stop', 'Stop']);
    press('ArrowRight', { repeat: true });
    await settle();
    expect(t.wires()).toEqual(['ArrowRight', 'Stop', 'Stop', 'ArrowRight']);
  });

  it('does not halt when an element loses focus', async () => {
    const t = setup();
    await t.enterPlay();
    press('ArrowRight');
    await settle();
    document.body.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
    await settle();
    expect(t.wires()).toEqual(['ArrowRight']);
    expect(t.input.desired).toBe(1);
  });

  it('halts when the page is hidden and on pagehide', async () => {
    const t = setup();
    await t.enterPlay();
    let state: DocumentVisibilityState = 'visible';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
    press('ArrowLeft');
    await settle();
    document.dispatchEvent(new Event('visibilitychange'));   // still visible
    expect(t.wires()).toEqual(['ArrowLeft']);
    state = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(t.wires()).toEqual(['ArrowLeft', 'Stop']);
    state = 'visible';
    press('ArrowLeft');
    await settle();
    window.dispatchEvent(new Event('pagehide'));
    expect(t.wires()).toEqual(['ArrowLeft', 'Stop', 'ArrowLeft', 'Stop']);
  });

  it('removes every listener on detach', async () => {
    const t = setup();
    await t.enterPlay();
    const detach = detachers.pop();
    detach?.();
    const e = press('ArrowLeft');
    window.dispatchEvent(new FocusEvent('blur'));
    window.dispatchEvent(new Event('pagehide'));
    await settle();
    expect(e.defaultPrevented).toBe(false);
    expect(t.wires()).toEqual([]);
    expect(t.input.desired).toBe(0);
  });

  it('cancels a pending trailing flush and drops the held keys and touch on detach', async () => {
    const t = setup();
    await t.enterPlay();
    t.clock.advance(1000);
    for (let i = 0; i < 13; i++) {   // ends with ArrowLeft held and its send withheld by the empty bucket
      if (i % 2 === 0) press('ArrowLeft');
      else release('ArrowLeft');
      await settle();
    }
    expect(t.clock.pending).toBe(1);
    expect(t.wires()).toHaveLength(8);
    expect(t.input.desired).toBe(-1);
    t.input.joystick.down(1, 200, 500, 'touch', RECT);
    expect(t.input.joystick.axis).toBe(0);
    const detach = detachers.pop();
    detach?.();
    expect(t.clock.pending).toBe(0);
    await settle();
    t.clock.advance(100);
    expect(t.wires()).toHaveLength(8);
    expect(t.input.desired).toBe(0);
    expect(t.input.joystick.axis).toBeNull();
    expect(t.input.joystick.knob[0]).toBe(0);
  });

  it('keeps tracking keys when a component stops their propagation', async () => {
    const t = setup();
    document.body.innerHTML = '<div id="w"><button id="b">x</button></div>';
    const button = document.getElementById('b') as HTMLElement;
    document.getElementById('w')?.addEventListener('keyup', (e) => e.stopPropagation());
    await t.enterPlay();
    press('ArrowLeft', {}, button);
    await settle();
    release('ArrowLeft', {}, button);
    await settle();
    expect(t.wires()).toEqual(['ArrowLeft', 'Stop']);
  });
});
