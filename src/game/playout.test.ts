import { describe, expect, it } from 'vitest';
import { Playout } from './playout';
import { TUNING } from '../config/tuning';
import type { Tuning } from '../config/tuning';
import { seeded } from '../lib/random';

const FRAME = 1000 / 60;

interface Arrival { at: number; n: number }
interface Sample { now: number; display: number; render: number; delay: number; snaps: number; latest: number }

/** Delivers arrivals as their time comes and advances the clock at 60 Hz until `until`. */
function run(p: Playout, arrivals: Arrival[], until: number, start = 0, onFrame?: (s: Sample) => void): Sample[] {
  const samples: Sample[] = [];
  let a = 0;
  for (let now = start; now <= until; now += FRAME) {
    while (a < arrivals.length && arrivals[a].at <= now) {
      p.onTicks(arrivals[a].n, arrivals[a].at);
      a++;
    }
    p.advance(FRAME, now);
    const s = { now, display: p.displayMs, render: p.renderMs, delay: p.delayMs, snaps: p.snaps, latest: p.latestMs };
    samples.push(s);
    onFrame?.(s);
  }
  return samples;
}

function gaussian(rand: () => number): number {
  return Math.sqrt(-2 * Math.log(Math.max(1e-12, rand()))) * Math.cos(2 * Math.PI * rand());
}

/** 40 Hz arrivals with per-arrival network noise (ms), never out of order. */
function arrivalsWith(noise: (i: number) => number, count: number, start = 100): Arrival[] {
  const out: Arrival[] = [];
  let last = -Infinity;
  for (let i = 0; i < count; i++) {
    const at = Math.max(last, start + i * 25 + noise(i));
    last = at;
    out.push({ at, n: 1 });
  }
  return out;
}

/** Display time never goes back once the clock has started (the start snap itself sets it from 0). */
function monotonic(samples: Sample[]): boolean {
  const from = samples.findIndex((s) => s.snaps > 0);
  for (let i = from + 1; i < samples.length; i++) if (samples[i].display < samples[i - 1].display - 1e-9) return false;
  return from >= 0;
}

const tuning = (patch: Partial<Tuning['hitStop']> = {}): [Tuning['playout'], Tuning['hitStop']] => [TUNING.playout, { ...TUNING.hitStop, ...patch }];

describe('Playout', () => {
  it('stays idle with display time 0 until the first ticks arrive', () => {
    const p = new Playout(...tuning());
    p.advance(16, 1000);
    expect(p.started).toBe(false);
    expect(p.idle).toBe(true);
    expect(p.displayMs).toBe(0);
  });

  it('steady arrivals with typical jitter (3-8 ms): delay 38-45 ms, monotonic display, no snap after warm-up', () => {
    const rand = seeded(7);
    const p = new Playout(...tuning());
    const arr = arrivalsWith(() => gaussian(rand) * 4.5, 40 * 12);
    const jitters: number[] = [];
    const samples = run(p, arr, 100 + 25 * 480, 0, (s) => {
      if (s.now > 3000) jitters.push(p.jitterMs);
    });
    const warm = samples.filter((s) => s.now > 3000);
    expect(monotonic(samples)).toBe(true);
    const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    expect(median(jitters)).toBeGreaterThanOrEqual(3);
    expect(median(jitters)).toBeLessThanOrEqual(8);
    const delays = warm.map((s) => s.delay);
    expect(median(delays)).toBeGreaterThanOrEqual(38);
    expect(median(delays)).toBeLessThanOrEqual(45);
    for (const d of delays) {
      expect(d).toBeGreaterThanOrEqual(TUNING.playout.minDelayMs);
      expect(d).toBeLessThanOrEqual(50);   // 5.2: typical jitter of 3-8 ms keeps the delay within 38-50 ms
    }
    expect(warm[warm.length - 1].snaps).toBe(warm[0].snaps);
    expect(p.snaps).toBe(1);   // the start snap only
  });

  it('+-40 ms jitter: delay stays inside the band and display stays monotonic', () => {
    const rand = seeded(11);
    const p = new Playout(...tuning());
    const arr = arrivalsWith(() => (rand() * 2 - 1) * 40, 40 * 12);
    const samples = run(p, arr, 100 + 25 * 480);
    expect(monotonic(samples)).toBe(true);
    const warm = samples.filter((s) => s.now > 4000);
    for (const s of warm) {
      expect(s.delay).toBeGreaterThanOrEqual(TUNING.playout.minDelayMs);
      expect(s.delay).toBeLessThanOrEqual(TUNING.playout.maxDelayMs);
    }
    expect(Math.max(...warm.map((s) => s.delay))).toBeGreaterThan(45);
  });

  it('a 300 ms stall followed by a burst costs at most one snap', () => {
    const p = new Playout(...tuning());
    const arr: Arrival[] = [];
    for (let i = 0; i < 80; i++) arr.push({ at: 100 + i * 25, n: 1 });
    const stallEnd = 100 + 79 * 25 + 300;
    arr.push({ at: stallEnd, n: 12 });
    for (let i = 1; i < 80; i++) arr.push({ at: stallEnd + i * 25, n: 1 });
    let snapsBefore = -1;
    const samples = run(p, arr, stallEnd + 80 * 25, 0, (s) => {
      if (s.now < stallEnd - 300 && s.now > 1000) snapsBefore = s.snaps;
    });
    expect(samples[samples.length - 1].snaps - snapsBefore).toBeLessThanOrEqual(1);
  });

  it('one dropped tick (a 50 ms gap) is absorbed by the slew within 400 ms, without a snap', () => {
    const p = new Playout(...tuning());
    const arr: Arrival[] = [];
    for (let i = 0; i < 120; i++) arr.push({ at: 100 + i * 25, n: 1 });
    const gapAt = 100 + 120 * 25 + 25;   // the next tick arrives 50 ms after the last one
    for (let i = 0; i < 120; i++) arr.push({ at: gapAt + i * 25, n: 1 });
    const errs: { now: number; err: number; snaps: number }[] = [];
    run(p, arr, gapAt + 119 * 25, 0, (s) => {
      if (s.now >= gapAt) {
        const since = Math.min(25, Math.max(0, s.now - p.lastArrivalMs));
        errs.push({ now: s.now, err: s.latest + since - s.delay - s.render, snaps: s.snaps });
      }
    });
    expect(errs[errs.length - 1].snaps).toBe(errs[0].snaps);
    const e0 = Math.max(...errs.filter((e) => e.now < gapAt + 60).map((e) => Math.abs(e.err)));
    expect(e0).toBeGreaterThan(15);   // the missing tick really moved the target (by 25 ms)
    const at400 = errs.find((e) => e.now >= gapAt + 400) as { err: number };
    expect(Math.abs(at400.err)).toBeLessThanOrEqual(e0 / 2);
    const settled = errs.filter((e) => e.now > gapAt + 1500);
    expect(Math.max(...settled.map((e) => Math.abs(e.err)))).toBeLessThan(3);
  });

  it('idle holds: render time stops within the extrapolation cap once arrivals stop', () => {
    const p = new Playout(...tuning());
    const arr: Arrival[] = [];
    for (let i = 0; i < 40; i++) arr.push({ at: 100 + i * 25, n: 1 });
    const lastArrival = arr[arr.length - 1].at;
    const samples = run(p, arr, lastArrival + 1500);
    expect(p.idle).toBe(true);
    const idle = samples.filter((s) => s.now > lastArrival + TUNING.playout.idleMs + FRAME);
    const held = idle[0].render;
    for (const s of idle) expect(s.render).toBe(held);
    expect(held).toBeLessThanOrEqual(p.latestMs + TUNING.playout.maxExtrapMs);
    expect(Math.max(...samples.map((s) => s.render - s.latest))).toBeLessThanOrEqual(TUNING.playout.maxExtrapMs + 1e-9);
  });

  it('idle holds exactly on the newest sample when render time reaches it from behind (a long delay)', () => {
    const p = new Playout(...tuning());
    // Bursts of 2 and 6 ticks every 100 ms: 40 Hz on average with 50 ms jitter, so the delay reaches its maximum.
    const arr: Arrival[] = [];
    for (let i = 0; i < 40; i++) arr.push({ at: 100 + i * 100, n: i % 2 === 0 ? 2 : 6 });
    const lastArrival = arr[arr.length - 1].at;
    run(p, arr, lastArrival);
    expect(p.delayMs).toBeGreaterThan(100);
    run(p, [], lastArrival + 2000, lastArrival + FRAME);
    expect(p.renderMs).toBe(p.latestMs);
  });

  it('never passes the newest sample while unstable', () => {
    const p = new Playout(...tuning());
    p.setUnstable(true);
    const arr: Arrival[] = [];
    for (let i = 0; i < 40; i++) arr.push({ at: 100 + i * 25 + (i === 20 ? 90 : 0), n: 1 });
    const samples = run(p, arr, 2000);
    expect(Math.max(...samples.map((s) => s.render - s.latest))).toBeLessThanOrEqual(1e-9);
  });

  describe('hit-stop', () => {
    function warmed(patch: Partial<Tuning['hitStop']> = {}): { p: Playout; now: number; arr: Arrival[] } {
      const p = new Playout(...tuning(patch));
      const arr: Arrival[] = [];
      for (let i = 0; i < 400; i++) arr.push({ at: 100 + i * 25, n: 1 });
      run(p, arr.slice(0, 80), 100 + 79 * 25);
      return { p, now: 100 + 79 * 25, arr };
    }

    it('caps one stop at 90 ms, during which display time stands still up to the slew residual', () => {
      const { p, now, arr } = warmed();
      expect(p.hitStop(200, now)).toBe(true);
      expect(p.hitStopActive).toBe(true);
      let t = now;
      let a = 80;
      let activeMs = 0;
      let moved = 0;
      let normalMove = 0;
      let prev = p.displayMs;
      while (t < now + 400) {
        t += FRAME;
        while (a < arr.length && arr[a].at <= t) p.onTicks(arr[a].n, arr[a++].at);
        const wasActive = p.hitStopActive;
        p.advance(FRAME, t);
        if (wasActive) {
          activeMs += FRAME;
          moved += p.displayMs - prev;
        } else if (t > now + 350) {
          normalMove = p.displayMs - prev;
        }
        prev = p.displayMs;
      }
      expect(activeMs).toBeGreaterThanOrEqual(90);
      expect(activeMs).toBeLessThan(90 + FRAME);
      expect(Math.abs(moved)).toBeLessThanOrEqual(TUNING.playout.slewMax * activeMs);
      expect(normalMove).toBeGreaterThan(FRAME * 0.9);   // afterwards it runs again (catching up)
    });

    it('grants at most 150 ms per rolling second, then refuses', () => {
      const { p, now } = warmed();
      expect(p.hitStop(90, now)).toBe(true);
      expect(p.hitStop(90, now + 10)).toBe(true);   // 60 ms left in the window
      expect(p.hitStop(10, now + 20)).toBe(false);
      expect(p.hitStop(90, now + 1011)).toBe(true);  // the first grant left the window
    });

    it('repays the debt at 0.25 ms per ms after the stop', () => {
      const { p, now, arr } = warmed();
      p.hitStop(80, now);
      let debtAtEnd = -1;
      let debtLater = -1;
      run(p, arr.slice(80), now + 600, now + FRAME, (s) => {
        if (debtAtEnd < 0 && !p.hitStopActive) debtAtEnd = p.debtMs;
        if (s.now <= now + 200) debtLater = p.debtMs;
      });
      expect(debtAtEnd).toBeGreaterThan(75);
      expect(debtLater).toBeLessThan(debtAtEnd);
      const elapsedAfterStop = 200 - 80;
      expect(debtLater).toBeCloseTo(Math.max(0, debtAtEnd - 0.25 * (elapsedAfterStop - FRAME)), -1);
      expect(p.debtMs).toBe(0);
    });

    it('does nothing when disabled', () => {
      const { p, now } = warmed({ enabled: false });
      expect(p.hitStop(70, now)).toBe(false);
      expect(p.hitStopActive).toBe(false);
    });
  });

  it('snaps on request and on the first ticks after a reset', () => {
    const p = new Playout(...tuning());
    const arr: Arrival[] = [];
    for (let i = 0; i < 40; i++) arr.push({ at: 100 + i * 25, n: 1 });
    run(p, arr, 1100);
    const n = p.snaps;
    p.snap();
    p.advance(FRAME, 1110);
    expect(p.snaps).toBe(n + 1);
    p.reset();
    expect(p.started).toBe(false);
    expect(p.snaps).toBe(0);
    p.onTicks(1, 5000);
    p.advance(FRAME, 5001);
    expect(p.snaps).toBe(1);
  });
});
