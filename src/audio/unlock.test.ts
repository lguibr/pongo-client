import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UnlockMachine, GESTURE_EVENTS, toAudioState } from './unlock';
import type { AudioState } from './types';
import { FakeAudioContext } from '../test/fakes/FakeAudioContext';
import type { FakeAudioOptions } from '../test/fakes/FakeAudioContext';

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function setup(opts: FakeAudioOptions = {}) {
  const win = new EventTarget();
  const add = vi.spyOn(win, 'addEventListener');
  let ctx: FakeAudioContext | null = null;
  const created: FakeAudioContext[] = [];
  const states: AudioState[] = [];
  const m = new UnlockMachine(
    win as unknown as Window,
    () => (ctx === null ? null : ctx.asAudioContext()),
    () => {
      ctx = new FakeAudioContext(opts);
      created.push(ctx);
      return ctx.asAudioContext();
    },
    (s) => states.push(s),
  );
  const fire = (type: string): void => {
    win.dispatchEvent(new Event(type));
  };
  return { win, add, m, created, states, fire, ctx: () => ctx };
}

beforeEach(() => FakeAudioContext.reset());

describe('UnlockMachine', () => {
  it('arms capture-phase passive listeners for the four gestures and creates no context before one', () => {
    const t = setup();
    t.m.arm();
    t.m.arm();
    const types = t.add.mock.calls.map((c) => c[0]);
    expect(types.sort()).toEqual([...GESTURE_EVENTS].sort());
    for (const call of t.add.mock.calls) expect(call[2]).toEqual({ capture: true, passive: true });
    expect(t.created).toHaveLength(0);
    expect(t.states).toEqual([]);
  });

  it('keydown creates the context inside the gesture, resumes it, then disarms on running', async () => {
    const t = setup();
    t.m.arm();
    t.fire('keydown');
    expect(t.created).toHaveLength(1);
    expect(t.created[0].calls.resume).toBe(1);
    await flush();
    expect(t.states).toEqual(['running']);
    expect(t.m.isArmed).toBe(false);
    t.fire('pointerdown');
    expect(t.created).toHaveLength(1);
    expect(t.created[0].calls.resume).toBe(1);
  });

  it.each(['pointerdown', 'touchend', 'click'])('%s also unlocks', async (type) => {
    const t = setup();
    t.m.arm();
    t.fire(type);
    await flush();
    expect(t.created).toHaveLength(1);
    expect(t.states).toEqual(['running']);
  });

  it('re-arms on suspended and on interrupted, every time, and the next gesture resumes', async () => {
    const t = setup();
    t.m.arm();
    t.fire('click');
    await flush();
    const ctx = t.ctx()!;
    for (const s of ['suspended', 'interrupted', 'suspended'] as const) {
      ctx.setState(s);
      expect(t.m.isArmed).toBe(true);
      const before = ctx.calls.resume;
      t.fire('keydown');
      expect(ctx.calls.resume).toBe(before + 1);
      await flush();
      expect(ctx.state).toBe('running');
      expect(t.m.isArmed).toBe(false);
    }
    expect(t.states).toEqual(['running', 'suspended', 'running', 'interrupted', 'running', 'suspended', 'running']);
    expect(t.created).toHaveLength(1);
  });

  it('keeps watching through a replaced onstatechange (as Tone does)', async () => {
    const t = setup();
    t.m.arm();
    t.fire('click');
    await flush();
    const ctx = t.ctx()!;
    ctx.onstatechange = () => {};
    ctx.setState('interrupted');
    expect(t.states[t.states.length - 1]).toBe('interrupted');
    expect(t.m.isArmed).toBe(true);
  });

  it('a context created running reports running at once, with no resume call', () => {
    const t = setup({ state: 'running' });
    t.m.arm();
    t.fire('pointerdown');
    expect(t.states).toEqual(['running']);
    expect(t.created[0].calls.resume).toBe(0);
    expect(t.m.isArmed).toBe(false);
  });

  it('a refused resume leaves the context locked and armed; the next gesture retries', async () => {
    const t = setup({ resume: 'reject' });
    t.m.arm();
    t.fire('touchend');
    await flush();
    expect(t.states).toEqual(['locked']);
    expect(t.m.isArmed).toBe(true);
    const ctx = t.ctx()!;
    ctx.resumeBehavior = 'resolve';
    t.fire('click');
    await flush();
    expect(t.states).toEqual(['locked', 'running']);
    expect(t.created).toHaveLength(1);
  });

  it('dispose removes the gesture and statechange listeners', async () => {
    const t = setup();
    t.m.arm();
    t.fire('click');
    await flush();
    const ctx = t.ctx()!;
    ctx.setState('suspended');
    t.m.dispose();
    t.fire('keydown');
    expect(ctx.calls.resume).toBe(1);
    ctx.setState('running');
    expect(t.states).toEqual(['running', 'suspended']);
    t.m.arm();
    t.fire('click');
    expect(ctx.calls.resume).toBe(1);
  });

  it('maps raw states, distinguishing locked from suspended', () => {
    expect(toAudioState('suspended', false)).toBe('locked');
    expect(toAudioState('suspended', true)).toBe('suspended');
    expect(toAudioState('interrupted', false)).toBe('interrupted');
    expect(toAudioState('closed', true)).toBe('closed');
    expect(toAudioState('running', false)).toBe('running');
  });
});
