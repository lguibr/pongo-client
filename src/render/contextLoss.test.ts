/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import type { ReactNode } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import type * as THREE from 'three';
import {
  ESCALATION_WINDOW_MS, RESTORE_WAIT_MS, attachContextLoss, noteCreationError, noteStageCreated, resetGraphicsHistory,
} from './contextLoss';
import { GameStage } from './GameStage';
import { GraphicsFailedError, StageBoundary } from './StageBoundary';
import { noopFxFactory } from './contracts';
import { FakeClock } from '../test/fakes/FakeClock';
import { createFakeApp } from '../test/fakes/fakeApp';
import type { GfxHealth } from '../state/appStore';

interface Stage {
  health: GfxHealth[];
  remounts: () => number;
  restores: () => number;
  lose: () => Event;
  restore: () => void;
  setLost: (v: boolean) => void;
  detach: () => void;
}

function stage(clock: FakeClock, counters: { remounts: number; restores: number }): Stage {
  const canvas = document.createElement('canvas');
  let lost = false;
  const gl = { getContext: () => ({ isContextLost: () => lost }) } as unknown as THREE.WebGLRenderer;
  const health: GfxHealth[] = [];
  const detach = attachContextLoss(canvas, gl, {
    onHealth: (h) => health.push(h), timers: clock, now: clock.now,
    remount: () => counters.remounts++, restored: () => counters.restores++,
  });
  return {
    health,
    remounts: () => counters.remounts,
    restores: () => counters.restores,
    lose: () => {
      lost = true;
      const e = new Event('webglcontextlost', { cancelable: true });
      canvas.dispatchEvent(e);
      return e;
    },
    restore: () => {
      lost = false;
      canvas.dispatchEvent(new Event('webglcontextrestored'));
    },
    setLost: (v) => {
      lost = v;
    },
    detach,
  };
}

/** A loss that waits out the restore timer: the stage asks for a remount and is then unmounted. */
function loseAndRemount(clock: FakeClock, counters: { remounts: number; restores: number }): Stage {
  const s = stage(clock, counters);
  s.lose();
  clock.advance(RESTORE_WAIT_MS);
  s.detach();
  return s;
}

describe('attachContextLoss (5.8)', () => {
  let clock: FakeClock;
  let counters: { remounts: number; restores: number };
  beforeEach(() => {
    resetGraphicsHistory();
    clock = new FakeClock(1_000_000);
    counters = { remounts: 0, restores: 0 };
  });

  it('lost then restored: lost, then restoring, restored() runs, and nothing remounts', () => {
    const s = stage(clock, counters);
    const e = s.lose();
    expect(e.defaultPrevented).toBe(true);
    expect(s.health).toEqual(['lost']);
    clock.advance(1000);
    s.restore();
    expect(s.health).toEqual(['lost', 'restoring']);
    expect(s.restores()).toBe(1);
    clock.advance(10_000);
    expect(s.remounts()).toBe(0);
  });

  it('lost then remount: the restore wait is 4 s, and a late restore on the old canvas is ignored', () => {
    const s = stage(clock, counters);
    s.lose();
    clock.advance(RESTORE_WAIT_MS - 1);
    expect(s.remounts()).toBe(0);
    clock.advance(1);
    expect(s.remounts()).toBe(1);
    s.restore();
    expect(s.restores()).toBe(0);
    expect(s.health).toEqual(['lost']);
  });

  it('two remounts within 60 s, then another loss, give failed and no further remount', () => {
    loseAndRemount(clock, counters);
    clock.advance(10_000);
    loseAndRemount(clock, counters);
    clock.advance(10_000);
    const third = stage(clock, counters);
    third.lose();
    expect(third.health).toEqual(['failed']);
    clock.advance(RESTORE_WAIT_MS * 3);
    expect(counters.remounts).toBe(2);
  });

  it('remounts older than 60 s do not count toward failed', () => {
    loseAndRemount(clock, counters);
    loseAndRemount(clock, counters);
    clock.advance(ESCALATION_WINDOW_MS + 1);
    const later = stage(clock, counters);
    later.lose();
    expect(later.health).toEqual(['lost']);
    clock.advance(RESTORE_WAIT_MS);
    expect(counters.remounts).toBe(3);
  });

  it('ignores every event from an unmounted stage, which never counts toward escalation', () => {
    const gone = stage(clock, counters);
    gone.detach();
    const e = gone.lose();
    expect(e.defaultPrevented).toBe(false);
    expect(gone.health).toEqual([]);

    // Leaving a room while lost: the pending timer dies with the stage.
    const left = stage(clock, counters);
    left.lose();
    left.detach();
    clock.advance(RESTORE_WAIT_MS * 2);
    expect(counters.remounts).toBe(0);
    expect(left.health).toEqual(['lost']);

    // So two real remounts later, a loss is still only 'lost'.
    loseAndRemount(clock, counters);
    const next = stage(clock, counters);
    next.lose();
    expect(next.health).toEqual(['lost']);
  });

  it('back to visible with a lost context runs the loss path once', () => {
    const vis = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const s = stage(clock, counters);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(s.health).toEqual([]);
    s.setLost(true);
    document.dispatchEvent(new Event('visibilitychange'));
    document.dispatchEvent(new Event('visibilitychange'));
    expect(s.health).toEqual(['lost']);
    clock.advance(RESTORE_WAIT_MS);
    expect(s.remounts()).toBe(1);
    s.detach();
    vis.mockRestore();
  });

  it('creation errors: unsupported before any success, then remounts until the budget is spent', () => {
    expect(noteCreationError(0)).toBe('unsupported');
    noteStageCreated();
    expect(noteCreationError(1000)).toBe('remount');
    expect(noteCreationError(2000)).toBe('remount');
    expect(noteCreationError(3000)).toBe('failed');
    expect(noteCreationError(2000 + ESCALATION_WINDOW_MS)).toBe('remount');
  });

  it('shares one history between losses and creation errors', () => {
    noteStageCreated();
    loseAndRemount(clock, counters);
    expect(noteCreationError(clock.now())).toBe('remount');
    const s = stage(clock, counters);
    s.lose();
    expect(s.health).toEqual(['failed']);
  });
});

describe('GameStage and StageBoundary', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    resetGraphicsHistory();
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    cleanup();
    errorSpy.mockRestore();
  });

  const fallback = createElement('p', null, 'Graphics stopped responding');
  const boundary = (resetKey: number, children: ReactNode, onError?: (e: Error) => void): ReturnType<typeof createElement> =>
    createElement(StageBoundary, { resetKey, fallback, onError, children });

  it.each(['failed', 'unsupported'] as const)('GameStage throws GraphicsFailedError on %s, and the boundary shows its fallback', (health) => {
    const app = createFakeApp({ state: { gfx: { health, tier: 'medium', stageKey: 0 } } });
    const errors: Error[] = [];
    render(boundary(0, createElement(GameStage, { app, fxFactory: noopFxFactory, mode: 'live' }), (e) => errors.push(e)));
    expect(screen.getByText('Graphics stopped responding')).toBeTruthy();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(GraphicsFailedError);
  });

  it('a failed health written to the store takes a mounted stage to the fallback, while the rest of the page stays', () => {
    const app = createFakeApp();
    const errors: Error[] = [];
    render(createElement('div', null,
      createElement('span', null, 'HUD'),
      boundary(0, createElement(GameStage, { app, fxFactory: noopFxFactory, mode: 'live' }), (e) => errors.push(e))));
    expect(screen.queryByText('Graphics stopped responding')).toBeNull();
    act(() => app.store.patch({ gfx: { ...app.store.get().gfx, health: 'failed' } }));
    expect(screen.getByText('Graphics stopped responding')).toBeTruthy();
    expect(screen.getByText('HUD')).toBeTruthy();
    expect(errors[0]).toBeInstanceOf(GraphicsFailedError);
  });

  it('StageBoundary clears an error only when resetKey changes', () => {
    let fail = true;
    const Child = (): ReactNode => {
      if (fail) throw new Error('boom');
      return 'stage';
    };
    const view = render(boundary(0, createElement(Child)));
    expect(screen.getByText('Graphics stopped responding')).toBeTruthy();
    fail = false;
    view.rerender(boundary(0, createElement(Child)));
    expect(screen.getByText('Graphics stopped responding')).toBeTruthy();
    view.rerender(boundary(1, createElement(Child)));
    expect(screen.getByText('stage')).toBeTruthy();
  });
});
