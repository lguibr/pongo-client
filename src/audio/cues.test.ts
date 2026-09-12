import { beforeEach, describe, expect, it } from 'vitest';
import { CueMixer, CUE_CAPS, STEAL_FADE_S } from './cues';
import { SampleBank, SAMPLE_NAMES } from './samples';
import { PENTATONIC, playSynth, synthLength } from './synth';
import type { CueId } from './types';
import type { GameEvent, IngestEventCtx, Seat } from '../game/events';
import { IMMEDIATE, SeatConn } from '../game/events';
import { TUNING } from '../config/tuning';
import { seeded } from '../lib/random';
import { stats } from '../state/stats';
import {
  FakeAudioContext, FakeAudioNode, FakeBufferSource, FakeGainNode, FakeOscillator, FakeStereoPanner,
} from '../test/fakes/FakeAudioContext';
import type { FakeAudioParam, FakeAudioState, ParamEvent } from '../test/fakes/FakeAudioContext';

const NOW = 10;
const A = TUNING.audio;
let seq = 0;

function ev(e: { k: GameEvent['k']; tick: number } & Record<string, unknown>): GameEvent {
  return { seq: seq++, x: 450, y: 450, conf: 1, stale: false, ...e } as unknown as GameEvent;
}
const paddle = (ball: number, seat: Seat, tick: number, pos: { x?: number; y?: number } = {}) =>
  ev({ k: 'paddleHit', ball, seat, speed: 8, prevOwner: -1, u: 0.5, tick, ...pos });
const owner = (ball: number, from: number, to: number, tick: number, cause = 'paddle') =>
  ev({ k: 'ownerChanged', ball, from, to, cause, tick });
const wall = (ball: number, w: Seat, tick: number) => ev({ k: 'wallBounce', ball, wall: w, phasing: false, u: 0.5, tick });
const goal = (ball: number, w: Seat, scorer: number, tick: number, repeat = 0) =>
  ev({ k: 'goal', ball, wall: w, scorer, repeat, u: 0.5, tick });
const crack = (cell: number, tick: number, level: number, to: number, ball = -1) =>
  ev({ k: 'brickDamaged', cell, from: to + 1, to, level, ball, tick });
const shatter = (cell: number, tick: number, level: number, from: number, chain = 1, ball = -1) =>
  ev({ k: 'brickDestroyed', cell, from, level, ball, scorer: -1, points: null, chain, last: false, tick });
const grow = (ball: number, tick: number, pos: { x?: number; y?: number } = {}) =>
  ev({ k: 'ballResized', ball, from: 8, to: 12, tick, ...pos });
const touch = (ball: number, tick: number) => ev({ k: 'brickBounce', ball, tick });
const seatEv = (seat: Seat, from: SeatConn, to: SeatConn) => ev({ k: 'seat', seat, from, to, graceEndsAt: NaN, tick: IMMEDIATE });
const at = (e: GameEvent, x: number, y: number): GameEvent => Object.assign(e, { x, y });
const kinds = (names: string[]): string[] => names.map((n) => n.replace(/\d$/, '')).sort();

/** The automation left on a param once each cancel has removed the events at or after its time. */
function effective(p: FakeAudioParam): ParamEvent[] {
  let out: ParamEvent[] = [];
  for (const e of p.events) {
    if (e.type === 'cancel' || e.type === 'cancelAndHold') out = out.filter((x) => x.time < e.time);
    else out.push(e);
  }
  return out;
}
const ic = (displayMs = 1000, myIndex: Seat | null = 3, headless = false): IngestEventCtx =>
  ({ nowMs: 0, displayMs, myIndex, headless });

async function setup(opts: { state?: FakeAudioState; loaded?: boolean } = {}) {
  FakeAudioContext.reset();
  const ctx = new FakeAudioContext({ state: opts.state ?? 'running' });
  ctx.currentTime = NOW;
  const sfx = ctx.createGain();
  const bank = new SampleBank(ctx.asAudioContext(), async () => new ArrayBuffer(8));
  if (opts.loaded !== false) await bank.load();
  const mixer = new CueMixer(ctx.asAudioContext(), sfx as unknown as GainNode, bank, A, seeded(7));
  const cues: { cue: CueId; when: number }[] = [];
  mixer.onCue = (cue, when) => cues.push({ cue, when });
  const nameOf = (buf: unknown): string | null => SAMPLE_NAMES.find((n) => bank.get(n) === (buf as AudioBuffer)) ?? null;
  const samplesStarted = () => ctx.started
    .filter((s) => s.node instanceof FakeBufferSource && nameOf(s.node.buffer) !== null)
    .map((s) => ({ name: nameOf((s.node as FakeBufferSource).buffer)!, when: s.when, node: s.node as FakeBufferSource }));
  const voiceGains = () => ctx.nodes.filter((n): n is FakeGainNode =>
    n instanceof FakeGainNode && n.outputs.some((o) => o instanceof FakeStereoPanner));
  const cueNames = () => cues.map((c) => c.cue);
  return { ctx, sfx, bank, mixer, cues, cueNames, samplesStarted, voiceGains };
}

beforeEach(() => {
  stats.audio.dropped = 0;
  stats.audio.voices = 0;
});

describe('CueMixer drops', () => {
  it('drops everything while the context is not running, and queues nothing', async () => {
    const t = await setup({ state: 'suspended' });
    t.mixer.onEvents([paddle(1, 0, 40), wall(2, 1, 40), crack(5, 40, 3, 2)], ic());
    t.mixer.playUi('uiTap');
    expect(t.ctx.started).toEqual([]);
    expect(t.cues).toEqual([]);
    expect(stats.audio.dropped).toBe(4);
    await t.ctx.resume();
    // The next batch plays only itself: nothing dropped while locked comes back.
    t.mixer.onEvents([grow(9, 40)], ic());
    expect(t.cueNames()).toEqual(['grow']);
    const gains = t.voiceGains();
    expect(gains).toHaveLength(1);
    expect(t.ctx.started.length).toBeGreaterThan(0);
    for (const s of t.ctx.started) expect(t.ctx.reaches(s.node, gains[0])).toBe(true);
    expect(t.samplesStarted()).toEqual([]);
    expect(stats.audio.dropped).toBe(4);
  });

  it('drops a headless batch', async () => {
    const t = await setup();
    t.mixer.onEvents([paddle(1, 0, 40), grow(2, 40)], ic(1000, 3, true));
    expect(t.ctx.started).toEqual([]);
    expect(stats.audio.dropped).toBe(2);
  });

  it('skips stale events and unconfident power-ups', async () => {
    const t = await setup();
    const stale = paddle(1, 0, 40);
    stale.stale = true;
    t.mixer.onEvents([stale, ev({ k: 'powerUp', ball: 3, kind: 'split', tick: 40, conf: 0.5 })], ic());
    expect(t.cues).toEqual([]);
    t.mixer.onEvents([ev({ k: 'powerUp', ball: 3, kind: 'split', tick: 40, conf: 0.9 })], ic());
    expect(t.cueNames()).toEqual(['powerUp']);
  });
});

describe('CueMixer scheduling', () => {
  it('clamps when to [now, now + maxLeadS] and drops events older than staleS', async () => {
    const t = await setup();
    // displayMs 1000 is tick 40.
    t.mixer.onEvents([
      grow(1, 42),            // lead +0.05
      grow(2, 60),            // lead +0.5 -> clamped to 0.15
      grow(3, 38),            // lead -0.05 -> now
      grow(4, 30),            // lead -0.25 -> now (not older than staleS)
      grow(5, 29),            // lead -0.275 -> dropped
      ev({ k: 'countdown', seconds: 3, tick: IMMEDIATE }),
    ], ic(1000));
    expect(t.cues.map((c) => [c.cue, +c.when.toFixed(6)])).toEqual([
      ['grow', NOW + 0.05], ['grow', NOW + A.maxLeadS], ['grow', NOW], ['grow', NOW], ['countTick', NOW],
    ]);
    for (const c of t.cues) {
      expect(c.when).toBeGreaterThanOrEqual(NOW);
      expect(c.when).toBeLessThanOrEqual(NOW + 0.15 + 1e-9);
    }
    for (const s of t.ctx.started) expect(s.when).toBeGreaterThanOrEqual(NOW);
    expect(stats.audio.dropped).toBe(1);
  });

  it('keeps only the highest-priority cue per ball per tick', async () => {
    const t = await setup();
    t.mixer.onEvents([
      wall(1, 2, 40), ev({ k: 'brickBounce', ball: 1, tick: 40 }), paddle(1, 0, 40),   // ball 1: paddle wins
      wall(2, 0, 40), wall(2, 1, 40),                                                  // ball 2: corner, one wall
      goal(3, 1, 0, 41), wall(3, 2, 41),                                               // ball 3: goal wins
      ev({ k: 'brickBounce', ball: 4, tick: 40 }),                                     // ball 4: touch alone
    ], ic(1000, null));
    expect(t.cueNames().sort()).toEqual(['goalOther', 'paddle', 'touch', 'wall']);
  });

  it('layers gained on my paddle cue in one voice instead of stacking a second voice', async () => {
    const t = await setup();
    t.mixer.onEvents([paddle(1, 3, 40), owner(1, 0, 3, 40)], ic());
    expect(t.cueNames()).toEqual(['paddleMine']);
    expect(t.mixer.voices).toBe(1);
    const started = t.samplesStarted();
    expect(started.map((s) => s.name.replace(/\d$/, '')).sort()).toEqual(['gained', 'hit']);
    const gains = t.voiceGains();
    expect(gains).toHaveLength(1);
    for (const s of started) expect(s.node.outputs).toEqual([gains[0]]);
    // The 60 Hz thump of paddleMine is in the same voice.
    const thump = t.ctx.nodesOf('oscillator')[0] as FakeOscillator;
    expect(thump.frequency.events[0].value).toBe(60);
    expect(t.ctx.reaches(thump, gains[0])).toBe(true);
  });

  it('plays lost once on an own goal (the goal cue carries it) and keeps other players changes silent', async () => {
    const t = await setup();
    t.mixer.onEvents([goal(1, 3, -1, 40), owner(1, 3, -1, 40, 'ownGoal'), owner(2, 0, 1, 40)], ic());
    expect(t.cueNames()).toEqual(['goalAgainst']);
    expect(t.samplesStarted().map((s) => s.name.replace(/\d$/, ''))).toEqual(['lost']);
  });

  it('merges goal repeats (C47): one boom, one lost and one onCue (so one duck), and a repeat still wins its tick', async () => {
    const t = await setup();
    t.mixer.onEvents([goal(1, 3, -1, 40), owner(1, 3, -1, 40, 'ownGoal')], ic());
    t.mixer.onEvents([goal(1, 3, -1, 43, 1), wall(1, 2, 43)], ic());   // +75 ms: past the retrigger interval
    t.mixer.onEvents([goal(1, 3, -1, 46, 2)], ic());                   // +150 ms
    expect(t.cueNames()).toEqual(['goalAgainst']);
    expect(kinds(t.samplesStarted().map((s) => s.name))).toEqual(['lost']);
    expect(t.mixer.voices).toBe(1);
    expect(stats.audio.dropped).toBe(2);
  });

  it('clears a reused slot pan, so a voice stolen before it started cannot re-pan its successor', async () => {
    const t = await setup();
    // 16 voices scheduled maxLeadS ahead (tick 46 at displayMs 1000), all hard right.
    t.mixer.onEvents([
      ...[0, 1, 2, 3, 4, 5].map((c) => crack(c, 46, 3, 2)),
      ...[10, 11, 12, 13, 14, 15].map((c) => shatter(c, 46, 2, 2)),
      ...[1, 2, 3, 4].map((b) => paddle(b, 0, 46)),
    ].map((e) => at(e, 900, 900)), ic());
    expect(t.mixer.voices).toBe(A.voicesTotal);
    const slot = t.voiceGains()[0].outputs[0] as FakeStereoPanner;
    expect(effective(slot.pan)).toEqual([{ type: 'set', value: 0.8, time: NOW + A.maxLeadS }]);

    // A hard-left wall now steals the oldest voice, which had not started, and reuses its slot.
    t.mixer.onEvents([at(wall(20, 1, 40), 0, 900)], ic());
    const gains = t.voiceGains();
    expect(gains[gains.length - 1].outputs[0]).toBe(slot);
    expect(effective(slot.pan)).toEqual([{ type: 'set', value: -0.8, time: NOW + STEAL_FADE_S }]);
  });

  interface MixRow { name: string; me: Seat | null; events: () => GameEvent[]; cues: CueId[]; samples: string[] }
  const MIX_ROWS: MixRow[] = [
    { name: 'goal outranks shatter', me: null, events: () => [shatter(7, 40, 3, 2, 1, 1), goal(1, 1, 0, 40)], cues: ['goalOther'], samples: [] },
    { name: 'shatter outranks paddle', me: null, events: () => [paddle(1, 0, 40), shatter(7, 40, 3, 2, 1, 1)], cues: ['brickShatter'], samples: [] },
    { name: 'paddle outranks crack', me: null, events: () => [crack(5, 40, 3, 2, 1), paddle(1, 0, 40)], cues: ['paddle'], samples: ['hit'] },
    { name: 'crack outranks wall', me: null, events: () => [wall(1, 2, 40), crack(5, 40, 3, 2, 1)], cues: ['brickCrack'], samples: [] },
    { name: 'wall outranks touch', me: null, events: () => [touch(1, 40), wall(1, 2, 40)], cues: ['wall'], samples: [] },
    { name: 'the same ball on different ticks does not compete', me: null, events: () => [paddle(1, 0, 40), wall(1, 2, 41)], cues: ['paddle', 'wall'], samples: ['hit'] },
    { name: 'a standalone lost when my ball is released', me: 3, events: () => [owner(1, 3, -1, 40, 'released')], cues: ['lost'], samples: ['lost'] },
    { name: 'my gained layers on a goal between others', me: 3, events: () => [goal(1, 0, 1, 40), owner(1, 1, 3, 40)], cues: ['goalOther'], samples: ['gained'] },
    { name: 'goalFor carries its gained once', me: 3, events: () => [goal(1, 0, 3, 40), owner(1, 2, 3, 40)], cues: ['goalFor'], samples: ['gained'] },
    { name: 'my lost layers on whatever wins the tick', me: 3, events: () => [crack(5, 40, 3, 2, 1), owner(1, 3, 2, 40)], cues: ['brickCrack'], samples: ['lost'] },
    { name: 'a silent goal repeat leaves my gained standalone', me: 3, events: () => [goal(1, 0, 1, 40, 1), owner(1, 1, 3, 40)], cues: ['gained'], samples: ['gained'] },
    { name: 'join on Grace to Connected', me: 3, events: () => [seatEv(1, SeatConn.Grace, SeatConn.Connected)], cues: ['join'], samples: [] },
    { name: 'leave on Connected to Empty', me: 3, events: () => [seatEv(2, SeatConn.Connected, SeatConn.Empty)], cues: ['leave'], samples: [] },
  ];
  it.each(MIX_ROWS)('mix rule: $name', async (row) => {
    const t = await setup();
    t.mixer.onEvents(row.events(), ic(1000, row.me));
    expect(t.cueNames()).toEqual(row.cues);
    expect(kinds(t.samplesStarted().map((s) => s.name))).toEqual(row.samples);
    expect(t.mixer.voices).toBe(row.cues.length);
  });

  it('caps each cue, stealing the oldest with a 15 ms fade', async () => {
    const t = await setup();
    t.mixer.onEvents([1, 2, 3, 4, 5].map((b) => paddle(b, 0, 40)), ic());
    expect(t.cueNames()).toEqual(['paddle', 'paddle', 'paddle', 'paddle', 'paddle']);
    expect(t.mixer.voices).toBe(CUE_CAPS.paddle);
    const first = t.voiceGains()[0];
    const ev0 = first.gain.events[first.gain.events.length - 1];
    expect(ev0).toMatchObject({ type: 'linear', value: 0 });
    expect(ev0.time).toBeCloseTo(NOW + STEAL_FADE_S, 9);
    const firstSample = t.samplesStarted()[0].node;
    expect(firstSample.stoppedAt).toBeCloseTo(NOW + STEAL_FADE_S, 9);
    expect(t.samplesStarted()[4].node.stoppedAt).toBeNull();
  });

  it('never plays more than voicesTotal voices', async () => {
    const t = await setup();
    const events = [
      ...[0, 1, 2, 3, 4, 5].map((c) => crack(c, 40, 3, 2)),
      ...[10, 11, 12, 13, 14, 15].map((c) => shatter(c, 40, 2, 2)),
      ...[1, 2, 3, 4].map((b) => paddle(b, 0, 40)),
      wall(5, 0, 40), wall(6, 1, 40), wall(7, 2, 40),
    ];
    t.mixer.onEvents(events, ic());
    expect(t.cues).toHaveLength(19);
    expect(t.mixer.voices).toBe(A.voicesTotal);
    expect(stats.audio.voices).toBe(A.voicesTotal);
  });

  it('applies the retrigger interval per (cue, entity)', async () => {
    const t = await setup();
    t.mixer.onEvents([wall(1, 2, 40), wall(2, 2, 41), wall(3, 2, 42), wall(4, 1, 41)], ic());
    expect(t.cues.map((c) => [c.cue, +c.when.toFixed(6)])).toEqual([
      ['wall', NOW], ['wall', NOW + 0.05], ['wall', NOW + 0.025],
    ]);
    expect(stats.audio.dropped).toBe(1);
  });

  it('dedupes bricks: one crack per cell per tick, and a shatter suppresses the cell crack', async () => {
    const t = await setup();
    t.mixer.onEvents([crack(4, 40, 3, 2), crack(4, 40, 3, 2), crack(9, 40, 3, 2), crack(7, 40, 3, 2), shatter(7, 41, 3, 1)], ic());
    expect(t.cueNames()).toEqual(['brickCrack', 'brickCrack', 'brickShatter']);
  });

  it('pitches cracks up the pentatonic scale as the brick weakens, and adds a sub to heavy shatters', async () => {
    const t = await setup();
    t.mixer.onEvents([crack(1, 40, 5, 4)], ic());
    const firstHz = (t.ctx.nodesOf('oscillator')[0] as FakeOscillator).frequency.events[0].value;
    expect(firstHz).toBeCloseTo(440 * Math.pow(2, PENTATONIC[1] / 12), 6);
    t.mixer.onEvents([crack(2, 40, 5, 1)], ic());
    const weakHz = (t.ctx.nodesOf('oscillator')[2] as FakeOscillator).frequency.events[0].value;
    expect(weakHz).toBeCloseTo(440 * Math.pow(2, PENTATONIC[4] / 12), 6);
    expect(weakHz).toBeGreaterThan(firstHz);

    const before = t.ctx.nodesOf('oscillator').length;
    t.mixer.onEvents([shatter(3, 40, 3, 5, 3)], ic());
    const osc = t.ctx.nodesOf('oscillator').slice(before) as FakeOscillator[];
    expect(osc[0].frequency.events[0].value).toBeCloseTo(440 * Math.pow(2, (PENTATONIC[3] + 2) / 12), 6);
    expect(osc.some((o) => o.frequency.events[0].value === 55)).toBe(true);
    const lightBefore = t.ctx.nodesOf('oscillator').length;
    t.mixer.onEvents([shatter(6, 40, 2, 2)], ic());
    const light = t.ctx.nodesOf('oscillator').slice(lightBefore) as FakeOscillator[];
    expect(light.some((o) => o.frequency.events[0].value === 55)).toBe(false);
  });

  it('pans by the rotated view, clamped to 0.8, and attenuates the far half by 3 dB', async () => {
    const t = await setup();
    const panOf = (g: FakeGainNode): number => {
      const p = g.outputs[0] as FakeStereoPanner;
      return p.pan.events[p.pan.events.length - 1].value;
    };
    // `grow` has a cap of 1, so each call steals the previous voice: read each gain before the next call.
    const levels: number[] = [];
    const play = (e: GameEvent, me: Seat): void => {
      t.mixer.onEvents([e], ic(1000, me));
      const g = t.voiceGains();
      levels.push(g[g.length - 1].gain.value);
    };
    play(grow(1, 40, { x: 900, y: 900 }), 3);
    play(grow(2, 40, { x: 900, y: 900 }), 1);
    play(grow(3, 40, { x: 450, y: 0 }), 0);
    play(grow(4, 40, { x: 675, y: 0 }), 3);
    expect(t.voiceGains().map(panOf)).toEqual([0.8, -0.8, 0.8, 0.5]);
    expect(levels[0]).toBeCloseTo(1, 9);                        // near half (bottom of my view)
    expect(levels[1]).toBeCloseTo(Math.pow(10, -3 / 20), 9);    // seat 1 is rotated 180: canvas bottom is far
    expect(levels[3]).toBeCloseTo(Math.pow(10, -3 / 20), 9);    // far half
  });

  it('sends win or lose to onCue for gameOver and starts no voice', async () => {
    const t = await setup();
    t.mixer.onEvents([ev({ k: 'gameOver', winner: 3, derived: false, tick: IMMEDIATE })], ic(1000, 3));
    t.mixer.onEvents([ev({ k: 'gameOver', winner: 3, derived: false, tick: IMMEDIATE })], ic(1000, 2));
    expect(t.cues).toEqual([{ cue: 'win', when: NOW }, { cue: 'lose', when: NOW }]);
    expect(t.ctx.started).toEqual([]);
  });

  it('maps seats, flow and ball-life events to their cues', async () => {
    const t = await setup();
    t.mixer.onEvents([
      ev({ k: 'seat', seat: 1, from: SeatConn.Empty, to: SeatConn.Connected, graceEndsAt: NaN, tick: IMMEDIATE }),
      ev({ k: 'seat', seat: 2, from: SeatConn.Connected, to: SeatConn.Grace, graceEndsAt: 1, tick: IMMEDIATE }),
      ev({ k: 'go', tick: IMMEDIATE }),
      ev({ k: 'ballSpawned', ball: 5, owner: 1, permanent: false, cause: 'powerUp', tick: 40 }),
      ev({ k: 'ballSpawned', ball: 6, owner: 1, permanent: true, cause: 'join', tick: 40 }),
      ev({ k: 'ballRemoved', ball: 7, owner: 1, cause: 'expired', tick: 40 }),
      ev({ k: 'ballRemoved', ball: 8, owner: 1, cause: 'absorbed', tick: 40 }),
      ev({ k: 'absorbed', ball: 8, wall: 2, u: 0.5, tick: 40 }),
      ev({ k: 'phaseStart', ball: 9, tick: 40 }),
      ev({ k: 'phaseEnd', ball: 10, tick: 40 }),
      ev({ k: 'score', seat: 1, from: 0, to: 1, delta: 1, cause: 'brick', tick: 40 }),
    ], ic());
    expect(t.cueNames()).toEqual(['join', 'leave', 'go', 'spawn', 'expire', 'absorb', 'phaseOn', 'phaseOff']);
  });

  it('never repeats a hit sample index twice in a row', async () => {
    const t = await setup();
    for (let i = 0; i < 60; i++) {
      t.ctx.advanceTime(0.1);
      t.mixer.onEvents([paddle(i, 0, 40)], ic(1000));
    }
    const names = t.samplesStarted().map((s) => s.name);
    expect(names).toHaveLength(60);
    for (let i = 1; i < names.length; i++) expect(names[i]).not.toBe(names[i - 1]);
    expect(new Set(names).size).toBe(5);
  });

  it('drops a sample-only cue until the samples arrive, but still plays procedural layers', async () => {
    const t = await setup({ loaded: false });
    t.mixer.onEvents([paddle(1, 0, 40)], ic());
    expect(t.cues).toEqual([]);
    expect(t.mixer.voices).toBe(0);
    t.mixer.onEvents([paddle(2, 3, 40)], ic());
    expect(t.cueNames()).toEqual(['paddleMine']);
    await t.bank.load();
    t.mixer.onEvents([paddle(3, 0, 40)], ic());
    expect(t.cueNames()).toEqual(['paddleMine', 'paddle']);
  });

  it('frees voices when their sources end, and stopAll fades and stops every voice', async () => {
    const t = await setup();
    t.mixer.onEvents([paddle(1, 0, 40)], ic());
    expect(t.mixer.voices).toBe(1);
    t.samplesStarted()[0].node.fireEnded();
    expect(t.mixer.voices).toBe(0);
    expect(t.voiceGains()).toHaveLength(0);   // disconnected

    t.mixer.onEvents([paddle(2, 0, 40), grow(3, 40), wall(4, 1, 40)], ic());
    expect(t.mixer.voices).toBe(3);
    const gains = t.voiceGains();
    t.mixer.stopAll(0.05);
    expect(t.mixer.voices).toBe(0);
    expect(stats.audio.voices).toBe(0);
    for (const g of gains) {
      const last = g.gain.events[g.gain.events.length - 1];
      expect(last).toMatchObject({ type: 'linear', value: 0 });
      expect(last.time).toBeCloseTo(NOW + 0.05, 9);
    }
    const sources = t.ctx.started.map((s) => s.node).filter((n) => n !== t.samplesStarted()[0].node);
    for (const s of sources) expect(s.stoppedAt).not.toBeNull();
  });

  it('each procedural layer ends at synthLength, which is what voice reclaim relies on', () => {
    FakeAudioContext.reset();
    const ctx = new FakeAudioContext({ state: 'running' });
    const dest = ctx.createGain();
    const all: CueId[] = ['paddle', 'paddleMine', 'wall', 'goalAgainst', 'goalFor', 'goalOther', 'absorb', 'brickCrack',
      'brickShatter', 'gained', 'lost', 'phaseOn', 'phaseOff', 'spawn', 'expire', 'powerUp', 'grow', 'join', 'leave',
      'countTick', 'go', 'win', 'lose', 'touch', 'uiTap'];
    for (const cue of all) {
      const src = playSynth(ctx.asAudioContext(), dest as unknown as AudioNode, cue, 5, { rate: 1, pan: 0, gain: 1, semitone: 0 });
      if (synthLength(cue) === 0) {
        expect(src).toBeNull();
        continue;
      }
      const node = src as unknown as FakeOscillator;
      expect(node.stoppedAt! - 5).toBeCloseTo(synthLength(cue), 9);
      for (const s of ctx.started.filter((x) => x.when >= 5)) {
        expect(s.node.stoppedAt!).toBeLessThanOrEqual(node.stoppedAt! + 1e-9);
      }
      expect(ctx.reaches(node, dest)).toBe(true);
      ctx.started.length = 0;
    }
  });

  it('plays the UI tap only while running', async () => {
    const t = await setup();
    t.mixer.playUi('uiTap');
    expect(t.cueNames()).toEqual(['uiTap']);
    expect(t.ctx.reaches(t.voiceGains()[0] as FakeAudioNode, t.sfx)).toBe(true);
  });
});
