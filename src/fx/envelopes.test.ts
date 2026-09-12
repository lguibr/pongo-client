// Envelopes (6): their shapes, and rate independence where it matters. The consumers that turn presentation time
// into what is drawn (the phase shell's collapse, a pop's opacity, position and scale) give the same values whether
// that time is accumulated at 30, 60 or 144 Hz (C21, C60, C61). The trails' samples are checked in director.test.ts.

import { describe, expect, it } from 'vitest';
import type * as THREE from 'three';
import type { FrameCtx, FxHost } from '../render/contracts';
import { BO, BallVis } from '../game/types';
import { canvasToBoard } from '../game/orientation';
import { fakeRenderState, fakeWorld } from '../test/fakes/fakeApp';
import { attackDecay, easeOutBack, fadeOut, flicker, springStep } from './envelopes';
import { createFxUniforms } from './pools/gpuPool';
import { TrailSystem } from './trails';
import { ShellKind, ShellSystem } from './shells';
import { PopLayer } from './pops';

const RATES = [30, 60, 144] as const;
const START = 1;

function frameCtx(): FrameCtx {
  return {
    nowMs: START * 1000, dtMs: 0, dtS: 0, fxTimeS: START, fxDtS: 0, displayMs: 0, reducedMotion: false, tier: 'high',
    myIndex: null, hitStopActive: false, session: 'playing', mode: 'live',
  };
}

/** Runs a frame loop at `hz` for `until` seconds, accumulating presentation time frame by frame as the frame loop
 *  does. `frame` runs on every frame; `sample` runs on the frames that land on multiples of 1/6 s, which all three
 *  rates share (5, 10 and 24 frames). */
function runAt(hz: number, until: number, frame: (ctx: FrameCtx) => void, sample: () => number[]): number[][] {
  const ctx = frameCtx();
  const perSixth = hz / 6;
  const out: number[][] = [];
  const frames = Math.round(until * hz);
  frame(ctx);
  for (let f = 1; f <= frames; f++) {
    ctx.dtS = 1 / hz;
    ctx.dtMs = 1000 / hz;
    ctx.fxDtS = 1 / hz;
    ctx.fxTimeS += 1 / hz;
    ctx.nowMs += 1000 / hz;
    ctx.displayMs += 1000 / hz;
    frame(ctx);
    if (f % perSixth === 0) out.push(sample());
  }
  return out;
}

/** Runs `run` at every rate and requires the samples to agree within 1e-6; returns the 30 Hz samples. */
function sameAtEveryRate(run: (hz: number) => number[][]): number[][] {
  const ref = run(RATES[0]);
  for (const hz of RATES.slice(1)) {
    const got = run(hz);
    expect(got.length).toBe(ref.length);
    for (let i = 0; i < ref.length; i++) {
      expect(got[i].length).toBe(ref[i].length);
      for (let j = 0; j < ref[i].length; j++) expect(Math.abs(got[i][j] - ref[i][j])).toBeLessThan(1e-6);
    }
  }
  return ref;
}

// ---- a DOM stand-in for the pop layer (the tests run in node) ----

class FakeSpan {
  readonly style: Record<string, string> = {};
  textContent: string | null = '';
  setAttribute(): void {}
}

function popHost(): { host: FxHost; spans: FakeSpan[] } {
  const spans: FakeSpan[] = [];
  const layer = {
    ownerDocument: { createElement: (): FakeSpan => new FakeSpan() },
    appendChild: (c: FakeSpan): FakeSpan => {
      spans.push(c);
      return c;
    },
  };
  const pt = { x: 0, y: 0 };
  const host = {
    popLayer: layer,
    toBoard(x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3 {
      canvasToBoard(x, y, 900, pt);
      return out.set(pt.x, pt.y, z);
    },
    project(p: THREE.Vector3, out: { sx: number; sy: number; visible: boolean }): void {
      out.sx = p.x + 450;
      out.sy = 450 - p.y - p.z * 0.5;
      out.visible = true;
    },
  } as unknown as FxHost;
  return { host, spans };
}

/** [x, y, scale] of a live pop's transform. */
function parseTransform(transform: string | undefined): [number, number, number] {
  const m = /translate3d\(([-\d.]+)px,([-\d.]+)px,0\).*scale\(([-\d.]+)\)/.exec(transform ?? '');
  if (m === null) throw new Error(`no transform in ${transform}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

describe('envelopes', () => {
  it('attackDecay rises linearly to 1 at the attack and decays to 0 at attack + decay', () => {
    expect(attackDecay(-0.01, 0.02, 0.18)).toBe(0);
    expect(attackDecay(0.01, 0.02, 0.18)).toBeCloseTo(0.5, 12);
    expect(attackDecay(0.02, 0.02, 0.18)).toBe(1);
    expect(attackDecay(0.11, 0.02, 0.18)).toBeCloseTo(0.25, 12);
    expect(attackDecay(0.2, 0.02, 0.18)).toBe(0);
    expect(attackDecay(5, 0.02, 0.18)).toBe(0);
    expect(attackDecay(0, 0, 0.1)).toBe(1);                    // no attack: starts at the peak
    expect(attackDecay(Number.NaN, 0.02, 0.18)).toBe(0);
  });

  it('springStep starts at 0, overshoots when underdamped and settles at 1', () => {
    expect(springStep(0, 37, 0.35)).toBe(0);
    let peak = 0;
    for (let t = 0; t < 0.5; t += 0.001) peak = Math.max(peak, springStep(t, 37, 0.35));
    expect(peak).toBeGreaterThan(1.2);
    expect(Math.abs(springStep(3, 37, 0.35) - 1)).toBeLessThan(1e-3);
    // critically and over-damped: never above 1, monotonic, the overdamped one slower
    let prevC = 0;
    let prevO = 0;
    for (let t = 0.01; t < 1; t += 0.01) {
      const c = springStep(t, 20, 1);
      const o = springStep(t, 20, 2);
      expect(c).toBeLessThanOrEqual(1);
      expect(o).toBeLessThanOrEqual(1);
      expect(c).toBeGreaterThanOrEqual(prevC);
      expect(o).toBeGreaterThanOrEqual(prevO);
      expect(o).toBeLessThan(c);
      prevC = c;
      prevO = o;
    }
    expect(springStep(1, 0, 0.5)).toBe(1);
  });

  it('easeOutBack overshoots on its way from 0 to 1 over its duration', () => {
    expect(easeOutBack(0, 0.28)).toBe(0);
    expect(easeOutBack(0.28, 0.28)).toBe(1);
    expect(easeOutBack(1, 0.28)).toBe(1);
    let peak = 0;
    for (let t = 0; t < 0.28; t += 0.002) peak = Math.max(peak, easeOutBack(t, 0.28));
    expect(peak).toBeGreaterThan(1.05);
  });

  it('fadeOut holds 1, then falls linearly over its tail to 0 at its duration', () => {
    expect(fadeOut(0, 1, 0.4)).toBe(1);
    expect(fadeOut(0.6, 1, 0.4)).toBe(1);
    expect(fadeOut(0.8, 1, 0.4)).toBeCloseTo(0.5, 12);
    expect(fadeOut(1, 1, 0.4)).toBe(0);
    expect(fadeOut(-0.1, 1, 0.4)).toBe(0);
  });

  it('flicker stays in 0.3..1 and gives the same value for the same time', () => {
    let lo = 1;
    let hi = 0;
    for (let t = 0; t < 3; t += 0.004) {
      const v = flicker(t, 14, 5);
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
      expect(flicker(t, 14, 5)).toBe(v);
    }
    expect(lo).toBeGreaterThanOrEqual(0.3);
    expect(hi).toBeLessThanOrEqual(1);
    expect(hi - lo).toBeGreaterThan(0.3);
    expect(flicker(1.234, 14, 5)).not.toBe(flicker(1.234, 14, 6));
  });
});

describe('envelope consumers at 30, 60 and 144 Hz', () => {
  it('a collapsing phase shell has the same radius and alpha at every rate', () => {
    const RAD = 8;
    const T0 = START + 1 / 6 - 0.03;   // two shared instants fall inside the 0.25 s collapse, the third after it
    const samples = sameAtEveryRate((hz) => {
      const render = fakeRenderState();
      const world = fakeWorld();
      render.ballId[0] = 7;
      render.ballHigh = 1;
      render.ball[BO.X] = -100;
      render.ball[BO.Y] = 50;
      render.ball[BO.R] = RAD;
      render.ball[BO.VIS] = BallVis.Live;
      render.ball[BO.PHASING] = 0;
      world.balls[0].id = 7;
      world.balls[0].live = true;
      world.slotById.set(7, 0);
      const u = createFxUniforms();
      const trails = new TrailSystem(render, u, 32, 32);
      const shells = new ShellSystem(render, world, u, trails);
      shells.collapse(7, T0);
      const inst = new Float32Array(8);
      return runAt(hz, 0.5, (ctx) => {
        trails.update(ctx);
        shells.update(ctx);
      }, () => {
        if (shells.count === 0) return [0, 0, 0, -1];
        shells.readInstance(0, inst);
        return [shells.count, inst[3], inst[4], inst[6]];
      });
    });
    expect(samples).toHaveLength(3);
    const shell = RAD * 1.4;
    const k0 = 0.03 / 0.25;
    const k1 = (0.03 + 1 / 6) / 0.25;
    expect(samples[0][0]).toBe(1);
    expect(samples[0][3]).toBe(ShellKind.Collapse);
    expect(samples[0][1]).toBeCloseTo(shell * (1 - k0 * k0), 4);
    expect(samples[0][2]).toBeCloseTo(1 - k0, 5);
    expect(samples[1][0]).toBe(1);
    expect(samples[1][1]).toBeCloseTo(shell * (1 - k1 * k1), 4);
    expect(samples[1][2]).toBeCloseTo(1 - k1, 5);
    expect(samples[2][0]).toBe(0);   // over after 0.25 s
  });

  it('a pop has the same opacity, position and scale at every rate, through its pop-in, rise and fade', () => {
    const SHOW = START + 1 / 6 - 0.08;   // the first shared instant falls inside the 0.16 s pop-in
    const LIFE = 1.2;
    const samples = sameAtEveryRate((hz) => {
      const { host, spans } = popHost();
      const pops = new PopLayer(host, 1);
      pops.setTime(SHOW);
      pops.show('+3', 450, 450, 0, '#ffffff', 1, LIFE);
      const span = spans[0];
      return runAt(hz, 1.5, (ctx) => pops.lateUpdate(ctx), () => {
        const o = Number(span.style.opacity);
        return o === 0 ? [0, 0, 0, 0] : [o, ...parseTransform(span.style.transform)];
      });
    });
    expect(samples).toHaveLength(9);
    const live = samples.filter((s) => s[0] > 0);
    expect(live).toHaveLength(7);                      // shown for 1.2 s from 0.08 s before the first sample
    expect(live[0][3]).toBeGreaterThan(1.01);          // mid pop-in, overshooting
    for (const s of live.slice(1)) expect(s[3]).toBe(1);
    for (let i = 1; i < live.length; i++) expect(live[i][2]).toBeLessThan(live[i - 1][2]);   // rising
    expect(live[0][0]).toBe(1);
    expect(live[4][0]).toBeCloseTo((LIFE - (0.08 + 4 / 6)) / (LIFE * 0.4), 3);               // fading
    expect(live[6][0]).toBeLessThan(live[5][0]);
    expect(samples[8][0]).toBe(0);                     // hidden once its life is over
  });
});
