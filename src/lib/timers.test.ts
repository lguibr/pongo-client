import { describe, expect, it } from 'vitest';
import { Timers } from './timers';
import type { TimerHost } from './timers';
import { FakeClock } from '../test/fakes/FakeClock';

type Name = 'a' | 'b';

describe('Timers', () => {
  it('set replaces a pending timer of the same name', () => {
    const clock = new FakeClock();
    const timers = new Timers<Name>(clock);
    const fired: string[] = [];
    timers.set('a', 100, () => fired.push('first'));
    timers.set('a', 50, () => fired.push('second'));
    expect(clock.pending).toBe(1);
    expect(timers.pending('a')).toBe(true);
    clock.advance(200);
    expect(fired).toEqual(['second']);
    expect(timers.pending('a')).toBe(false);
  });

  it('isCurrent rejects stale tokens', () => {
    const timers = new Timers<Name>(new FakeClock());
    const first = timers.set('a', 100, () => {});
    const second = timers.set('a', 100, () => {});
    expect(first).not.toBe(second);
    expect(timers.isCurrent('a', first)).toBe(false);
    expect(timers.isCurrent('a', second)).toBe(true);
    expect(timers.isCurrent('b', second)).toBe(false);
    timers.clear('a');
    expect(timers.isCurrent('a', second)).toBe(false);
  });

  it('keeps the token current inside its own callback', () => {
    const clock = new FakeClock();
    const timers = new Timers<Name>(clock);
    let seen: boolean | null = null;
    const token = timers.set('a', 10, (name) => {
      seen = timers.isCurrent(name, token);
    });
    clock.advance(10);
    expect(seen).toBe(true);
  });

  it('clearAll cancels every timer', () => {
    const clock = new FakeClock();
    const timers = new Timers<Name>(clock);
    const fired: Name[] = [];
    const ta = timers.set('a', 10, (n) => fired.push(n));
    const tb = timers.set('b', 20, (n) => fired.push(n));
    timers.clearAll();
    expect(clock.pending).toBe(0);
    clock.advance(100);
    expect(fired).toEqual([]);
    expect(timers.isCurrent('a', ta)).toBe(false);
    expect(timers.isCurrent('b', tb)).toBe(false);
  });

  it('drops a late callback when the host could not cancel it', () => {
    const clock = new FakeClock();
    const leaky: TimerHost = { setTimeout: clock.setTimeout, clearTimeout: () => {} };
    const timers = new Timers<Name>(leaky);
    const fired: string[] = [];
    timers.set('a', 10, () => fired.push('old'));
    timers.set('a', 30, () => fired.push('new'));
    timers.set('b', 5, () => fired.push('b'));
    timers.clear('b');
    clock.advance(100);
    expect(fired).toEqual(['new']);
  });
});
