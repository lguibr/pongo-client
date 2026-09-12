// Effects director (4.12, 6): pool bounds and oldest-first stealing, every event kind's host calls against a spy
// FxHost, stale events, reduced motion, tier budgets, trails, shells, pops, lifecycle, and the allocation-free update.

import { describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import * as THREE from 'three';
import type { CameraFx, EntityFx, FrameCtx, FxHost, PostFx, Tier } from '../render/contracts';
import type { EventBase, EventOf, GameEvent, GameEventKind, Seat } from '../game/events';
import { IMMEDIATE, SeatConn } from '../game/events';
import type { RenderState, World } from '../game/types';
import { BALL_STRIDE, BO, BallVis } from '../game/types';
import { fakeRenderState, fakeWorld } from '../test/fakes/fakeApp';
import { forceGc } from '../test/gc';
import { canvasToBoard } from '../game/orientation';
import { COLORS, HDR, PLAYER_COLORS, lifeColor } from '../config/palette';
import { LIFE_H } from '../config/constants';
import { TUNING } from '../config/tuning';
import { seeded } from '../lib/random';
import { EffectsDirector, createFxDirector } from './director';
import { DEAD_T0, createFxUniforms } from './pools/gpuPool';
import { SparkPool, resetSparkBurst, sparkBurst } from './pools/sparks';
import { resetShardBurst } from './pools/shards';
import { resetRingSpec } from './pools/rings';
import { resetDecalSpec } from './pools/decals';
import { TRAIL_SAMPLE_S, TrailSystem } from './trails';
import { ShellKind, ShellSystem } from './shells';
import { PopLayer } from './pops';

const FRAME = 1000 / 60;

// ---- a DOM stand-in for the pop layer (the tests run in node) ----

class FakeElement {
  readonly style: Record<string, string> = {};
  readonly children: FakeElement[] = [];
  readonly attrs = new Map<string, string>();
  textContent: string | null = '';
  parentNode: FakeElement | null = null;
  readonly ownerDocument = { createElement: (): FakeElement => new FakeElement() };

  appendChild(c: FakeElement): FakeElement {
    c.parentNode = this;
    this.children.push(c);
    return c;
  }

  removeChild(c: FakeElement): FakeElement {
    const i = this.children.indexOf(c);
    if (i >= 0) this.children.splice(i, 1);
    c.parentNode = null;
    return c;
  }

  setAttribute(k: string, v: string): void {
    this.attrs.set(k, v);
  }
}

// ---- host ----

function entitySpies() {
  return {
    flashPaddle: vi.fn(), squashPaddle: vi.fn(), materialisePaddle: vi.fn(), flashWall: vi.fn(), pulseBall: vi.fn(),
    spawnBall: vi.fn(), dissolveBall: vi.fn(), resizeBall: vi.fn(), flashBrick: vi.fn(), brickRise: vi.fn(),
    ripple: vi.fn(), winnerSweep: vi.fn(), setDim: vi.fn(), wallBreathe: vi.fn(),
  } satisfies EntityFx;
}

function cameraSpies() {
  return { addTrauma: vi.fn(), impulse: vi.fn(), kick: vi.fn() } satisfies CameraFx;
}

function postSpies() {
  return { enabled: true, lowBit: false, flash: vi.fn(), aberration: vi.fn(), saturation: vi.fn(), vignettePulse: vi.fn(), bloomBoost: vi.fn() } satisfies PostFx;
}

interface Harness {
  host: FxHost;
  render: RenderState;
  world: World;
  layer: FakeElement;
  entities: ReturnType<typeof entitySpies>;
  camera: ReturnType<typeof cameraSpies>;
  post: ReturnType<typeof postSpies>;
  hitStop: Mock;
}

function buildHost(render: RenderState, world: World, layer: FakeElement, entities: EntityFx, camera: CameraFx, post: PostFx, hitStop: FxHost['hitStop']): FxHost {
  const pt = { x: 0, y: 0 };
  return {
    scene: new THREE.Scene(), board: new THREE.Group(), camera, post, entities, render, world,
    popLayer: layer as unknown as HTMLElement,
    toBoard(x, y, z, out) {
      canvasToBoard(x, y, world.canvas, pt);
      return out.set(pt.x, pt.y, z);
    },
    project(p, out) {
      out.sx = p.x + 450;
      out.sy = 450 - p.y - p.z * 0.5;
      out.visible = true;
    },
    hitStop,
    slotOf: (id) => world.slotById.get(id) ?? -1,
    brickColor: (life, out) => out.set(lifeColor(life)),
  };
}

function harness(): Harness {
  const render = fakeRenderState();
  const world = fakeWorld();
  const layer = new FakeElement();
  const entities = entitySpies();
  const camera = cameraSpies();
  const post = postSpies();
  const hitStop = vi.fn();
  return { host: buildHost(render, world, layer, entities, camera, post, hitStop), render, world, layer, entities, camera, post, hitStop };
}

/** A host whose ports are plain no-ops (spies record calls, which allocates). */
function quietHarness(): { host: FxHost; render: RenderState; world: World } {
  const noop = (): void => {};
  const render = fakeRenderState();
  const world = fakeWorld();
  const entities: EntityFx = {
    flashPaddle: noop, squashPaddle: noop, materialisePaddle: noop, flashWall: noop, pulseBall: noop, spawnBall: noop,
    dissolveBall: noop, resizeBall: noop, flashBrick: noop, brickRise: noop, ripple: noop, winnerSweep: noop, setDim: noop,
    wallBreathe: noop,
  };
  const post: PostFx = { enabled: true, lowBit: false, flash: noop, aberration: noop, saturation: noop, vignettePulse: noop, bloomBoost: noop };
  const host = buildHost(render, world, new FakeElement(), entities, { addTrauma: noop, impulse: noop, kick: noop }, post, noop);
  return { host, render, world };
}

interface BallOpts { owner?: number; phasing?: boolean; r?: number; vis?: number; permanent?: boolean }

/** A ball in RenderState (board space) and the World slot table, at canvas px (cx, cy), velocity in board units. */
function putBall(render: RenderState, world: World, slot: number, id: number, cx: number, cy: number, vx: number, vy: number, o: BallOpts = {}): void {
  const b = render.ball;
  const off = slot * BALL_STRIDE;
  render.ballId[slot] = id;
  b[off + BO.X] = cx - 450;
  b[off + BO.Y] = 450 - cy;
  b[off + BO.VX] = vx;
  b[off + BO.VY] = vy;
  b[off + BO.R] = o.r ?? 8;
  b[off + BO.OWNER] = o.owner ?? -1;
  b[off + BO.PHASING] = o.phasing ? 1 : 0;
  b[off + BO.PERMANENT] = o.permanent === false ? 0 : 1;
  b[off + BO.AGE_S] = 0;
  b[off + BO.VIS] = o.vis ?? BallVis.Live;
  if (render.ballHigh < slot + 1) render.ballHigh = slot + 1;
  const s = world.balls[slot];
  s.id = id;
  s.live = true;
  world.slotById.set(id, slot);
}

/** A plain literal, as the frame loop builds it, so its number fields are written in place. */
function makeCtx(o: { myIndex?: Seat | null; reducedMotion?: boolean } = {}): FrameCtx {
  const ctx: FrameCtx = {
    nowMs: 0, dtMs: FRAME, dtS: FRAME / 1000, fxTimeS: 0, fxDtS: FRAME / 1000, displayMs: 0, reducedMotion: false,
    tier: 'high', myIndex: null, hitStopActive: false, session: 'playing', mode: 'live',
  };
  if (o.myIndex !== undefined) ctx.myIndex = o.myIndex;
  if (o.reducedMotion !== undefined) ctx.reducedMotion = o.reducedMotion;
  return ctx;
}

function step(ctx: FrameCtx, seconds: number): void {
  ctx.dtS = seconds;
  ctx.dtMs = seconds * 1000;
  ctx.fxDtS = seconds;
  ctx.fxTimeS += seconds;
  ctx.nowMs += seconds * 1000;
}

type Fields<K extends GameEventKind> = Omit<EventOf<K>, keyof EventBase | 'k'> & Partial<EventBase>;

function ev<K extends GameEventKind>(k: K, f: Fields<K>): EventOf<K> {
  return { k, tick: 10, seq: 1, x: 450, y: 450, conf: 1, stale: false, ...f } as unknown as EventOf<K>;
}

// cell 97 = row 5, column 7: canvas centre (375, 275), board (-75, 175); the ball hits it from above (canvas y 240)
const CELL = 97;

const SAMPLES: { readonly [K in GameEventKind]: EventOf<K> } = {
  paddleHit: ev('paddleHit', { ball: 7, seat: 3, speed: 12, prevOwner: 1, u: 0.4, x: 450, y: 860 }),
  ownerChanged: ev('ownerChanged', { ball: 7, from: 1, to: 3, cause: 'paddle', x: 450, y: 860 }),
  wallBounce: ev('wallBounce', { ball: 7, wall: 0, phasing: false, u: 0.5, x: 892, y: 450 }),
  goal: ev('goal', { ball: 7, wall: 3, scorer: 1, repeat: 0, u: 0.3, x: 270, y: 895 }),
  absorbed: ev('absorbed', { ball: 7, wall: 2, u: 0.5, x: 0, y: 450, conf: 0.95 }),
  brickBounce: ev('brickBounce', { ball: 7, x: 375, y: 240, conf: 0.9 }),
  brickDamaged: ev('brickDamaged', { cell: CELL, from: 4, to: 3, level: 1, ball: 7, x: 375, y: 240, conf: 0.9 }),
  brickDestroyed: ev('brickDestroyed', { cell: CELL, from: 7, level: 1, ball: 7, scorer: 3, points: 3, chain: 3, last: true, x: 375, y: 240, conf: 0.9 }),
  ballSpawned: ev('ballSpawned', { ball: 9, owner: 3, permanent: true, cause: 'join', x: 450, y: 700 }),
  ballRemoved: ev('ballRemoved', { ball: 7, owner: 3, cause: 'expired', x: 450, y: 860 }),
  phaseStart: ev('phaseStart', { ball: 7 }),
  phaseEnd: ev('phaseEnd', { ball: 7, x: 450, y: 860 }),
  powerUp: ev('powerUp', { ball: 7, kind: 'boost', conf: 0.8 }),
  ballResized: ev('ballResized', { ball: 7, from: 8, to: 12 }),
  score: ev('score', { seat: 3, from: 0, to: 1, delta: 1, cause: 'scored' }),
  seat: ev('seat', { seat: 2, from: SeatConn.Grace, to: SeatConn.Empty, graceEndsAt: Number.NaN, x: 0, y: 450 }),
  boardReady: ev('boardReady', { bricks: 120, tick: IMMEDIATE }),
  countdown: ev('countdown', { seconds: 3, tick: IMMEDIATE }),
  countdownCancelled: ev('countdownCancelled', { tick: IMMEDIATE }),
  go: ev('go', { tick: IMMEDIATE }),
  gameOver: ev('gameOver', { winner: 2, derived: false, tick: IMMEDIATE }),
};
const KINDS = Object.keys(SAMPLES) as GameEventKind[];

function setup(o: { me?: Seat | null; reduced?: boolean; tier?: Tier } = {}) {
  const h = harness();
  putBall(h.render, h.world, 0, 7, 450, 860, 3, 9, { owner: 3 });
  const d = new EffectsDirector(h.host, TUNING, seeded(1));
  d.setTier(o.tier ?? 'high');
  const ctx = makeCtx({ myIndex: o.me === undefined ? 3 : o.me, reducedMotion: o.reduced ?? false });
  step(ctx, 1);
  d.update(ctx);
  return { h, d, ctx };
}

function spawned(d: EffectsDirector) {
  return { sparks: d.sparks.pool.live, shards: d.shards.pool.live, rings: d.rings.pool.live, decals: d.decals.pool.live, pops: d.pops.liveCount };
}

function called(spies: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [name, m] of Object.entries(spies)) if (typeof m === 'function' && (m as Mock).mock.calls.length > 0) out.push(name);
  return out;
}

function linear(hex: string): THREE.Color {
  return new THREE.Color(hex);
}

/** Texts of the spans that were shown and are not hidden. */
function popTexts(h: Harness): string[] {
  return h.layer.children.filter((c) => c.textContent !== '' && c.style.opacity !== '0').map((c) => c.textContent ?? '');
}

function heapUsed(): number {
  const proc = (globalThis as { process?: { memoryUsage(): { heapUsed: number } } }).process;
  if (proc === undefined) throw new Error('process.memoryUsage is not available');
  return proc.memoryUsage().heapUsed;
}

// ---- pools ----

describe('GPU pools', () => {
  function pool(capacity: number, max = capacity) {
    return new SparkPool(createFxUniforms(), max, capacity, seeded(3)).pool;
  }
  let serial = 0;
  const init = (_i: number, a: Float32Array, o: number): void => {
    a[o] = serial++;
    a[o + 3] = 0;
    a[o + 7] = 10;
  };

  it('keep the draw count at capacity and overwrite the oldest instances first', () => {
    const p = pool(8);
    serial = 0;
    p.setTime(0);
    expect(p.spawn(5, init)).toBe(5);
    expect(p.live).toBe(5);
    expect(p.drawCount).toBe(8);
    expect(p.spawn(5, init)).toBe(5);
    expect(p.live).toBe(8);
    expect(p.drawCount).toBe(8);
    expect(Array.from({ length: 8 }, (_, s) => p.array[s * 16])).toEqual([8, 9, 2, 3, 4, 5, 6, 7]);
    expect(p.spawn(20, init)).toBe(8);
    expect(p.live).toBe(8);
    expect(p.spawn(0, init)).toBe(0);
  });

  it('count an instance as live until its spawn time plus life, and clear kills every instance', () => {
    const p = pool(8);
    p.setTime(0);
    const lives = [0.1, 0.2, 0.3];
    p.spawn(3, (i, a, o) => {
      a[o + 3] = 0;
      a[o + 7] = lives[i];
    });
    p.setTime(0.15);
    expect(p.live).toBe(2);
    expect(p.free).toBe(6);
    p.setTime(0.35);
    expect(p.live).toBe(0);
    p.spawn(1, (_i, a, o) => {
      a[o + 3] = 1;   // delayed: holds its slot before it shows
      a[o + 7] = 0.1;
    });
    expect(p.live).toBe(1);
    p.clear();
    expect(p.live).toBe(0);
    for (let s = 0; s < 8; s++) expect(p.array[s * 16 + 3]).toBe(DEAD_T0);
  });

  it('merge the spawns of one frame into one reused upload range; after clear the whole buffer uploads', () => {
    const p = pool(8, 16);
    const buffer = (p.object.geometry.getAttribute('aStart') as THREE.InterleavedBufferAttribute).data;
    serial = 0;
    p.spawn(2, init);                       // the construction's clear asked for a whole upload
    expect(buffer.updateRanges).toHaveLength(0);
    buffer.onUploadCallback();              // three uploads the buffer, then calls this
    const v0 = buffer.version;
    p.spawn(2, init);
    p.spawn(3, init);
    expect(buffer.updateRanges).toHaveLength(1);
    expect(buffer.updateRanges[0]).toEqual({ start: 2 * 16, count: 5 * 16 });
    expect(buffer.version).toBeGreaterThan(v0);
    buffer.clearUpdateRanges();             // three's range upload
    buffer.onUploadCallback();
    p.clear();
    p.spawn(1, init);
    expect(buffer.updateRanges).toHaveLength(0);
  });

  it('change capacity with the tier and never reallocate', () => {
    const { d } = setup();
    const arrays = [d.sparks.pool.array, d.shards.pool.array, d.rings.pool.array, d.decals.pool.array];
    d.setTier('low');
    const low = TUNING.fx.pools.low;
    expect([d.sparks.pool.capacity, d.shards.pool.capacity, d.rings.pool.capacity, d.decals.pool.capacity]).toEqual([low.sparks, low.shards, low.rings, low.decals]);
    expect(d.sparks.pool.drawCount).toBe(low.sparks);
    expect([d.sparks.pool.array, d.shards.pool.array, d.rings.pool.array, d.decals.pool.array]).toEqual(arrays);
    expect(d.sparks.pool.array).toBe(arrays[0]);
    d.setTier('high');
    expect(d.sparks.pool.capacity).toBe(TUNING.fx.pools.high.sparks);
  });

  it('keep live instances across a capacity change; a shrink kills the slots above it and moves the head below it', () => {
    const p = pool(64, 128);
    const buffer = (p.object.geometry.getAttribute('aStart') as THREE.InterleavedBufferAttribute).data;
    serial = 0;
    p.setTime(0);
    expect(p.spawn(10, init)).toBe(10);
    buffer.onUploadCallback();
    p.setCapacity(128);
    expect([p.capacity, p.drawCount, p.live]).toEqual([128, 128, 10]);
    p.spawn(1, init);                       // a growth needs no whole upload: the spawn narrows it to its range
    expect(buffer.updateRanges).toEqual([{ start: 10 * 16, count: 16 }]);
    expect(p.live).toBe(11);
    buffer.clearUpdateRanges();
    buffer.onUploadCallback();
    p.setCapacity(8);
    expect([p.capacity, p.drawCount]).toEqual([8, 8]);
    expect(p.live).toBe(8);
    for (let s = 8; s < 128; s++) {
      expect(p.array[s * 16 + 3]).toBe(DEAD_T0);
      expect(p.array[s * 16 + 7]).toBe(0);
    }
    expect(Array.from({ length: 8 }, (_, s) => p.array[s * 16])).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);   // kept
    serial = 100;
    p.spawn(1, init);                       // the head was at 11: it moved to 0, below the capacity
    expect(p.array[0]).toBe(100);
    expect(buffer.updateRanges).toHaveLength(0);   // a shrink uploads the whole buffer
    p.setCapacity(128);
    expect(p.live).toBe(8);                 // the killed slots stay dead after a growth
  });

  it('start converging sparks on the upper hemisphere, each flying straight at the origin', () => {
    const sp = new SparkPool(createFxUniforms(), 256, 256, seeded(11));
    const b = resetSparkBurst(sparkBurst(), 0);
    b.x = 30;
    b.y = -20;
    b.z = 8;
    b.spread = Math.PI;
    b.converge = 60;
    expect(sp.burst(200, b)).toBe(200);
    const a = sp.pool.array;
    let above = 0;
    for (let s = 0; s < 200; s++) {
      const o = s * 16;
      expect(a[o + 2]).toBeGreaterThanOrEqual(8);
      if (a[o + 2] > 20) above++;
      const tx = b.x - a[o];
      const ty = b.y - a[o + 1];
      const tz = b.z - a[o + 2];
      const dot = (tx * a[o + 4] + ty * a[o + 5] + tz * a[o + 6]) / (Math.hypot(tx, ty, tz) * Math.hypot(a[o + 4], a[o + 5], a[o + 6]));
      expect(dot).toBeGreaterThan(1 - 1e-4);
      expect(a[o] + a[o + 4] * a[o + 7]).toBeCloseTo(b.x, 3);   // and reaching it as it dies
      expect(a[o + 2] + a[o + 6] * a[o + 7]).toBeCloseTo(b.z, 3);
    }
    expect(above).toBeGreaterThan(100);     // spread over the hemisphere, not flattened onto the equator
  });
});

// ---- presets ----

describe('director presets: each event kind makes the expected host calls', () => {
  it('covers every event kind', () => {
    expect(KINDS).toHaveLength(21);
  });

  /** Every one of the first n sparks flies within the 35° cone around (dx, dy, 0.2). */
  function expectCone(d: EffectsDirector, n: number, dx: number, dy: number): void {
    const len = Math.hypot(dx, dy, 0.2);
    const cos = Math.cos((35 * Math.PI) / 180);
    const a = d.sparks.pool.array;
    for (let s = 0; s < n; s++) {
      const o = s * 16;
      const v = Math.hypot(a[o + 4], a[o + 5], a[o + 6]);
      expect((a[o + 4] * dx + a[o + 5] * dy + a[o + 6] * 0.2) / (v * len)).toBeGreaterThan(cos - 1e-5);
    }
  }

  it('paddleHit: flash, squash, pop, ring and 24 sparks leaving the paddle around the reflected velocity; trauma when mine and fast', () => {
    const { h, d, ctx } = setup();
    // At release RenderState still holds the incoming velocity, toward seat 3's wall (board -y).
    putBall(h.render, h.world, 0, 7, 450, 860, 3, -9, { owner: 3 });
    d.consume(SAMPLES.paddleHit, ctx);
    expect(h.entities.flashPaddle).toHaveBeenCalledWith(3, 0.4, 1);
    expect(h.entities.squashPaddle).toHaveBeenCalledWith(3, 1);
    expect(h.entities.pulseBall).toHaveBeenCalledWith(7, 1);
    expect(h.camera.addTrauma).toHaveBeenCalledWith(0.12);
    expect(spawned(d)).toMatchObject({ rings: 1, sparks: 24 });
    const a = d.sparks.pool.array;
    for (let s = 0; s < 24; s++) expect(a[s * 16 + 5]).toBeGreaterThan(0);   // away from the paddle, into the board
    expectCone(d, 24, 3, 9);
    const ring = d.rings.pool.array;
    const c = linear(PLAYER_COLORS[3]);
    expect([ring[8], ring[9], ring[10]].map((x) => x.toFixed(4))).toEqual([c.r, c.g, c.b].map((x) => Math.fround(x).toFixed(4)));
  });

  it('paddleHit: an outgoing velocity is kept as it is; a still ball throws the sparks along the inward normal', () => {
    const out = setup();   // setup's ball already moves away from seat 3's wall
    out.d.consume(SAMPLES.paddleHit, out.ctx);
    expectCone(out.d, 24, 3, 9);
    const left = setup();
    putBall(left.h.render, left.h.world, 0, 7, 20, 450, -7, 2, { owner: 2 });   // into seat 2's wall (board -x)
    left.d.consume({ ...SAMPLES.paddleHit, seat: 2, x: 20, y: 450 }, left.ctx);
    expectCone(left.d, 24, 7, 2);
    const still = setup();
    putBall(still.h.render, still.h.world, 0, 7, 450, 860, 0, 0, { owner: 3 });
    still.d.consume(SAMPLES.paddleHit, still.ctx);
    expectCone(still.d, 24, 0, 1);
  });

  it('paddleHit: no trauma for another seat or a slow hit; reduced motion halves sparks, the shader halves the flash', () => {
    const other = setup({ me: 1 });
    other.d.consume(SAMPLES.paddleHit, other.ctx);
    expect(other.h.camera.addTrauma).not.toHaveBeenCalled();
    const slow = setup();
    slow.d.consume({ ...SAMPLES.paddleHit, speed: 8 }, slow.ctx);
    expect(slow.h.camera.addTrauma).not.toHaveBeenCalled();
    expect(slow.d.sparks.pool.live).toBe(17);
    const rm = setup({ reduced: true });
    rm.d.consume(SAMPLES.paddleHit, rm.ctx);
    expect(rm.h.camera.addTrauma).not.toHaveBeenCalled();
    expect(rm.h.entities.flashPaddle).toHaveBeenCalledWith(3, 0.4, 1);   // the paddle shader halves it (P5)
    expect(rm.d.sparks.pool.live).toBe(12);
    for (let s = 0; s < 12; s++) expect(rm.d.sparks.pool.array[s * 16 + 15]).toBe(0);   // no velocity stretch
  });

  it('ownerChanged: one ring in the new colour; a double bright ring when I gain it, a grey one when I lose it', () => {
    const plain = setup();
    plain.d.consume({ ...SAMPLES.ownerChanged, from: 1, to: 0 }, plain.ctx);
    expect(plain.d.rings.pool.live).toBe(1);
    expect(plain.d.rings.pool.array[11]).toBeCloseTo(HDR.ring, 5);
    expect(plain.d.rings.pool.array[8]).toBeCloseTo(linear(PLAYER_COLORS[0]).r, 5);
    const gained = setup();
    gained.d.consume(SAMPLES.ownerChanged, gained.ctx);
    expect(gained.d.rings.pool.live).toBe(2);
    expect(gained.d.rings.pool.array[11]).toBeCloseTo(HDR.ring * 1.4, 5);
    expect(gained.d.rings.pool.array[12 + 3]).toBeCloseTo(gained.ctx.fxTimeS + 0.08, 5);   // the second ring follows
    const lost = setup();
    lost.d.consume({ ...SAMPLES.ownerChanged, from: 3, to: 0 }, lost.ctx);
    expect(lost.d.rings.pool.live).toBe(2);
    expect(lost.d.rings.pool.array[12 + 11]).toBe(1);   // the desaturated ring does not bloom
    const released = setup();
    released.d.consume({ ...SAMPLES.ownerChanged, from: 3, to: -1, cause: 'released' }, released.ctx);
    expect(released.d.rings.pool.array[8]).toBeCloseTo(linear(COLORS.unownedBall).r, 5);
  });

  it('wallBounce: a wall glow (violet when phasing), a ball pop and 4 sparks (2 reduced)', () => {
    const { h, d, ctx } = setup();
    d.consume(SAMPLES.wallBounce, ctx);
    expect(h.entities.flashWall).toHaveBeenCalledWith(0, 0.5, 1, 'bounce');
    expect(h.entities.pulseBall).toHaveBeenCalledWith(7, 0.6);
    expect(d.sparks.pool.live).toBe(4);
    expect(d.sparks.pool.array[0]).toBeCloseTo(450, 3);   // at the wall, not at the ball
    d.consume({ ...SAMPLES.wallBounce, phasing: true }, ctx);
    expect(h.entities.flashWall).toHaveBeenLastCalledWith(0, 0.5, 1, 'phase');
    const rm = setup({ reduced: true });
    rm.d.consume(SAMPLES.wallBounce, rm.ctx);
    expect(rm.d.sparks.pool.live).toBe(2);
  });

  it('goal conceded by me: wall flood, ripple, ring, two pops, impulse, trauma, aberration, vignette and hit-stop', () => {
    const { h, d, ctx } = setup();
    d.consume(SAMPLES.goal, ctx);
    expect(h.entities.flashWall).toHaveBeenCalledWith(3, 0.3, 1, 'goal');
    expect(h.entities.ripple).toHaveBeenCalledWith(270, 895, 1);
    expect(h.camera.impulse).toHaveBeenCalledWith(0, -1, 0.25);   // seat 3 is not rotated: its wall is screen-down
    expect(h.camera.addTrauma).toHaveBeenCalledWith(0.35);
    expect(h.post.aberration).toHaveBeenCalledWith(0.005, 0.22);
    expect(h.post.vignettePulse).toHaveBeenCalledWith(COLORS.danger, 0.6, 0.3);
    expect(h.hitStop).toHaveBeenCalledWith(TUNING.hitStop.goalConcededMs, 'goalConceded');
    expect(h.post.flash).not.toHaveBeenCalled();
    expect(spawned(d)).toMatchObject({ rings: 1, pops: 2 });
    expect(d.pops.textOf(103)).toBe('−1');
    expect(d.pops.textOf(203)).toBe('+1');
  });

  it('goal repeat (C47): the pops renumber and nothing new spawns', () => {
    const { h, d, ctx } = setup();
    d.consume(SAMPLES.goal, ctx);
    const before = spawned(d);
    h.hitStop.mockClear();
    h.entities.flashWall.mockClear();
    d.consume({ ...SAMPLES.goal, repeat: 1 }, ctx);
    expect(spawned(d)).toEqual(before);
    expect(d.pops.textOf(103)).toBe('−2');
    expect(d.pops.textOf(203)).toBe('+2');
    expect(h.hitStop).not.toHaveBeenCalled();
    expect(h.entities.flashWall).not.toHaveBeenCalled();
  });

  it('goal scored by me gives a gold flash; reduced motion drops the motion and caps the flash', () => {
    const scored = setup({ me: 1 });
    scored.d.consume(SAMPLES.goal, scored.ctx);
    expect(scored.h.post.flash).toHaveBeenCalledWith(COLORS.gold, 0.35, 0.15);
    expect(scored.h.camera.addTrauma).not.toHaveBeenCalled();
    expect(scored.h.hitStop).not.toHaveBeenCalled();
    const rm = setup({ reduced: true });
    rm.d.consume(SAMPLES.goal, rm.ctx);
    expect(called(rm.h.camera)).toEqual([]);
    expect(rm.h.post.aberration).not.toHaveBeenCalled();
    expect(rm.h.hitStop).not.toHaveBeenCalled();
    expect(rm.h.post.vignettePulse).toHaveBeenCalledWith(COLORS.danger, 0.5, 0.3);
    expect(rm.h.entities.flashWall).toHaveBeenCalledWith(3, 0.3, 1, 'goal');   // the wall shader halves it
    expect(rm.d.pops.liveCount).toBe(2);
  });

  it('goal with an unknown ball (conf 0.5): the flash at 70 % and the conceder pop, no ring', () => {
    const { h, d, ctx } = setup({ me: 0 });
    d.consume({ ...SAMPLES.goal, ball: -1, scorer: -1, conf: 0.5, u: 0.5 }, ctx);
    expect(h.entities.flashWall).toHaveBeenCalledWith(3, 0.5, 0.7, 'goal');
    expect(spawned(d)).toMatchObject({ rings: 0, sparks: 0, pops: 1 });
  });

  it('absorbed: the ball flattens, the wall ripples, an inward ring and 14 sparks drawn in (7 reduced)', () => {
    const { h, d, ctx } = setup();
    d.consume(SAMPLES.absorbed, ctx);
    expect(h.entities.dissolveBall).toHaveBeenCalledWith(7, 0.15);
    expect(h.entities.flashWall).toHaveBeenCalledWith(2, 0.5, 0.6, 'absorb');
    expect(spawned(d)).toMatchObject({ rings: 1, sparks: 14 });
    expect(d.rings.pool.array[4]).toBeGreaterThan(d.rings.pool.array[5]);   // r0 > r1: an implosion
    const a = d.sparks.pool.array;
    for (let s = 0; s < 14; s++) {
      const o = s * 16;
      expect(a[o] + a[o + 4] * a[o + 7]).toBeCloseTo(-450, 2);   // every spark meets the contact point as it dies
      expect(a[o + 1] + a[o + 5] * a[o + 7]).toBeCloseTo(0, 2);
    }
    const rm = setup({ reduced: true });
    rm.d.consume(SAMPLES.absorbed, rm.ctx);
    expect(rm.d.sparks.pool.live).toBe(7);
  });

  it('brickBounce (P2): a pop and 3 dust sparks; dropped entirely under reduced motion', () => {
    const { h, d, ctx } = setup();
    d.consume(SAMPLES.brickBounce, ctx);
    expect(h.entities.pulseBall).toHaveBeenCalledWith(7, 0.4);
    expect(d.sparks.pool.live).toBe(3);
    expect(d.sparks.pool.array[11]).toBe(1);   // dust does not bloom
    const rm = setup({ reduced: true });
    rm.d.consume(SAMPLES.brickBounce, rm.ctx);
    expect(called(rm.h.entities)).toEqual([]);
    expect(rm.d.sparks.pool.live).toBe(0);
  });

  it('brickDamaged: a white flash, the top slab, chips from the impact side and 8 sparks', () => {
    const { h, d, ctx } = setup();
    d.consume(SAMPLES.brickDamaged, ctx);
    expect(h.entities.flashBrick).toHaveBeenCalledWith(CELL, 1);
    expect(spawned(d)).toMatchObject({ shards: 9, sparks: 8 });   // slab + 8 chips (from 4)
    const a = d.shards.pool.array;
    expect([a[16], a[17]]).toEqual([44, 44]);                     // the slab spans the brick
    expect(a[18]).toBeCloseTo(LIFE_H / 0.35, 4);                  // and one layer
    expect(a[0]).toBeCloseTo(-75, 3);
    expect(a[1]).toBeCloseTo(175, 3);
    const c = linear(lifeColor(4));
    expect(a[12]).toBeCloseTo(c.r, 5);
    for (let s = 1; s < 9; s++) {
      expect(a[s * 20 + 1]).toBeGreaterThan(175);   // the ball came from above: chips start on that side
      expect(a[s * 20 + 5]).toBeGreaterThan(0);     // and fly toward it
    }
    const rm = setup({ reduced: true });
    rm.d.consume(SAMPLES.brickDamaged, rm.ctx);
    expect(rm.h.entities.flashBrick).toHaveBeenCalledWith(CELL, 1);   // the brick shader halves it (P5)
    expect(rm.d.shards.pool.live).toBe(3);   // the slab and ceil(8 x 0.25) chips
  });

  it('brickDamaged by a phasing ball throws 6 violet zipping sparks as well', () => {
    const { h, d, ctx } = setup();
    putBall(h.render, h.world, 0, 7, 375, 240, 0, -8, { owner: 3, phasing: true });
    d.consume(SAMPLES.brickDamaged, ctx);
    expect(d.sparks.pool.live).toBe(14);
    expect(d.sparks.pool.array[8]).toBeCloseTo(linear(COLORS.phase).r, 5);
  });

  it('brickDestroyed: shards, flash sparks, dust, ring, ripple, scorch, "+N" and chain pops, trauma, last brick', () => {
    const { h, d, ctx } = setup();
    d.consume(SAMPLES.brickDestroyed, ctx);
    expect(spawned(d)).toEqual({ sparks: 22, shards: 24, rings: 1, decals: 1, pops: 2 });
    expect(popTexts(h)).toEqual(expect.arrayContaining(['+3', '×3']));
    expect(h.entities.ripple).toHaveBeenCalledWith(375, 275, 0.8);
    expect(h.camera.addTrauma).toHaveBeenCalledWith(0.1);
    expect(h.hitStop).toHaveBeenCalledWith(TUNING.hitStop.lastBrickMs, 'lastBrick');
    expect(h.post.bloomBoost).toHaveBeenCalledWith(0.4, 0.3);
    expect(d.rings.pool.array[11]).toBeCloseTo(HDR.ring * 1.25, 5);   // E28: brighter with each chain step
    expect(d.shards.pool.array[12]).toBeCloseTo(linear(lifeColor(7)).r, 5);
  });

  it('brickDestroyed: a plain break has no chain pop or hit-stop; reduced motion keeps 25 % of the shards', () => {
    const plain = setup({ me: 0 });
    plain.d.consume({ ...SAMPLES.brickDestroyed, chain: 1, last: false }, plain.ctx);
    expect(popTexts(plain.h)).toEqual(['+3']);
    expect(plain.d.rings.pool.array[11]).toBeCloseTo(HDR.ring, 5);
    expect(plain.h.hitStop).not.toHaveBeenCalled();
    expect(plain.h.camera.addTrauma).not.toHaveBeenCalled();
    const rm = setup({ reduced: true });
    rm.d.consume(SAMPLES.brickDestroyed, rm.ctx);
    expect(rm.d.shards.pool.live).toBe(6);
    expect(rm.h.camera.addTrauma).not.toHaveBeenCalled();
    expect(rm.h.hitStop).not.toHaveBeenCalled();
    expect(rm.h.post.bloomBoost).toHaveBeenCalledWith(0.4, 0.3);
  });

  it('brickDestroyed on the low tier: P0 shards stay, P1 scales, the single P2 scorch survives while its pool has room', () => {
    const { d, ctx } = setup({ tier: 'low' });
    d.consume(SAMPLES.brickDestroyed, ctx);
    expect(spawned(d)).toMatchObject({ shards: 13, sparks: 7, rings: 1, decals: 1 });
    expect(d.stats.droppedP2).toBe(0);
  });

  it('brickDestroyed with low confidence: the brick still shatters (the P0 core, ring, ripple and pop), no P1/P2 particles', () => {
    const { h, d, ctx } = setup();
    putBall(h.render, h.world, 0, 7, 375, 240, 0, -8, { owner: 3, phasing: true });   // no phasing zip either
    d.consume({ ...SAMPLES.brickDestroyed, conf: 0.3, last: false, chain: 1 }, ctx);
    expect(spawned(d)).toEqual({ sparks: 0, shards: 8, rings: 1, decals: 0, pops: 1 });
    expect(h.entities.ripple).toHaveBeenCalledWith(375, 275, expect.closeTo(0.56, 6));
    expect(d.rings.pool.array[11]).toBeCloseTo(HDR.ring * 0.7, 5);            // at 70 %
    const a = d.shards.pool.array;
    for (let s = 0; s < 8; s++) {                                             // at the cell (jittered by 0.3 x 44)
      expect(Math.abs(a[s * 20] + 75)).toBeLessThanOrEqual(13.2 + 1e-3);
      expect(Math.abs(a[s * 20 + 1] - 175)).toBeLessThanOrEqual(13.2 + 1e-3);
    }
    expect(a[12]).toBeCloseTo(linear(lifeColor(7)).r, 5);                    // in its colour
    const rm = setup({ reduced: true });
    rm.d.consume({ ...SAMPLES.brickDestroyed, conf: 0.3, last: false, chain: 1 }, rm.ctx);
    expect(spawned(rm.d)).toEqual({ sparks: 0, shards: 6, rings: 1, decals: 0, pops: 1 });   // 25 % of 24
  });

  it('ballSpawned: the pop and a ring; a join converges 24 sparks; a power-up beams from the cell; a snapshot shows nothing', () => {
    const { h, d, ctx } = setup();
    d.consume(SAMPLES.ballSpawned, ctx);
    expect(h.entities.spawnBall).toHaveBeenCalledWith(9);
    expect(spawned(d)).toMatchObject({ rings: 1, sparks: 24 });
    const rm = setup({ reduced: true });
    rm.d.consume(SAMPLES.ballSpawned, rm.ctx);
    expect(spawned(rm.d)).toMatchObject({ rings: 1, sparks: 0 });
    const snap = setup();
    snap.d.consume({ ...SAMPLES.ballSpawned, cause: 'snapshot' }, snap.ctx);
    expect(called(snap.h.entities)).toEqual([]);
    expect(snap.d.rings.pool.live).toBe(0);
  });

  it('ballSpawned by a power-up beams from the centre of the cell holding the spawn, before its brick is released', () => {
    // The runtime releases the spawn one seq before the brickDestroyed of the same tick, so no brick precedes it.
    for (const [x, y] of [[387, 287], [363, 263]]) {   // the server's spawn lies within 12 px of the cell centre
      const pu = setup();
      pu.d.consume({ ...SAMPLES.ballSpawned, cause: 'powerUp', x, y }, pu.ctx);
      expect(spawned(pu.d)).toMatchObject({ rings: 1, sparks: 1 });
      const a = pu.d.sparks.pool.array;
      expect(a[0]).toBeCloseTo(-75, 3);        // from cell 97's centre, canvas (375, 275)
      expect(a[1]).toBeCloseTo(175, 3);
      const bx = x - 450;                      // toward the ball, board (x - 450, 450 - y)
      const by = 450 - y;
      expect(Math.sign(a[4])).toBe(Math.sign(bx + 75));
      expect(Math.sign(a[5])).toBe(Math.sign(by - 175));
      expect(a[7]).toBeCloseTo(0.2, 5);
      expect(a[0] + a[4] * a[7]).toBeCloseTo(bx, 0);   // the beam reaches the ball as it dies
      expect(a[1] + a[5] * a[7]).toBeCloseTo(by, 0);
    }
  });

  it('ballRemoved: an expired ball dissolves with 8-16 sparks by radius and a ring; an absorbed one is E24', () => {
    const { h, d, ctx } = setup();
    d.consume(SAMPLES.ballRemoved, ctx);
    expect(h.entities.dissolveBall).toHaveBeenCalledWith(7, 0.25);
    expect(spawned(d)).toMatchObject({ sparks: 8, rings: 1 });
    const big = setup();
    putBall(big.h.render, big.h.world, 0, 7, 450, 860, 3, 9, { owner: 3, r: 24 });
    big.d.consume(SAMPLES.ballRemoved, big.ctx);
    expect(big.d.sparks.pool.live).toBe(16);
    const abs = setup();
    abs.d.consume({ ...SAMPLES.ballRemoved, cause: 'absorbed' }, abs.ctx);
    expect(called(abs.h.entities)).toEqual([]);
    expect(spawned(abs.d)).toEqual({ sparks: 0, shards: 0, rings: 0, decals: 0, pops: 0 });
  });

  it('phaseStart is continuous state; phaseEnd collapses the shell with a violet ring pop', () => {
    const { h, d, ctx } = setup();
    d.consume(SAMPLES.phaseStart, ctx);
    expect(called(h.entities)).toEqual([]);
    expect(spawned(d)).toEqual({ sparks: 0, shards: 0, rings: 0, decals: 0, pops: 0 });
    d.consume(SAMPLES.phaseEnd, ctx);
    expect(d.rings.pool.live).toBe(1);
    expect(d.rings.pool.array[8]).toBeCloseTo(linear(COLORS.phase).r, 5);
    step(ctx, 0.05);
    d.update(ctx);
    expect(d.shells.count).toBe(1);
  });

  it('powerUp: from conf 0.7, a gold ring, 24 gold sparks (12 reduced) and the callout', () => {
    const { h, d, ctx } = setup();
    d.consume(SAMPLES.powerUp, ctx);
    expect(spawned(d)).toMatchObject({ rings: 1, sparks: 24, pops: 1 });
    expect(popTexts(h)).toContain('BOOST');
    expect(d.sparks.pool.array[8]).toBeCloseTo(linear(COLORS.gold).r, 5);
    d.consume({ ...SAMPLES.powerUp, kind: 'mass', conf: 1 }, ctx);
    expect(popTexts(h)).toContain('GROW');
    const weak = setup();
    weak.d.consume({ ...SAMPLES.powerUp, conf: 0.6 }, weak.ctx);
    expect(spawned(weak.d)).toEqual({ sparks: 0, shards: 0, rings: 0, decals: 0, pops: 0 });
    const rm = setup({ reduced: true });
    rm.d.consume(SAMPLES.powerUp, rm.ctx);
    expect(rm.d.sparks.pool.live).toBe(12);
  });

  it('ballResized: the radius springs to the new value and a low ring grows from it', () => {
    const { h, d, ctx } = setup();
    d.consume(SAMPLES.ballResized, ctx);
    expect(h.entities.resizeBall).toHaveBeenCalledWith(7, 12);
    expect(d.rings.pool.live).toBe(1);
    expect([d.rings.pool.array[4], d.rings.pool.array[5]]).toEqual([12, 36]);
    expect(d.rings.pool.array[11]).toBeCloseTo(1.2, 5);
  });

  it('score and boardReady present nothing (the scoreboard is P6)', () => {
    for (const k of ['score', 'boardReady'] as const) {
      const { h, d, ctx } = setup();
      d.consume(SAMPLES[k], ctx);
      expect([...called(h.entities), ...called(h.camera), ...called(h.post)]).toEqual([]);
      expect(h.hitStop).not.toHaveBeenCalled();
      expect(spawned(d)).toEqual({ sparks: 0, shards: 0, rings: 0, decals: 0, pops: 0 });
    }
  });

  it('seat: join materialises, return solidifies, removal dissolves into 20 sparks, a drop is continuous state', () => {
    const { h, d, ctx } = setup();
    d.consume({ ...SAMPLES.seat, from: SeatConn.Empty, to: SeatConn.Connected }, ctx);
    expect(h.entities.materialisePaddle).toHaveBeenLastCalledWith(2, 'in');
    d.consume({ ...SAMPLES.seat, from: SeatConn.Grace, to: SeatConn.Connected }, ctx);
    expect(h.entities.materialisePaddle).toHaveBeenLastCalledWith(2, 'solidify');
    h.entities.materialisePaddle.mockClear();
    d.consume({ ...SAMPLES.seat, from: SeatConn.Connected, to: SeatConn.Grace }, ctx);
    expect(h.entities.materialisePaddle).not.toHaveBeenCalled();
    expect(d.sparks.pool.live).toBe(0);
    d.consume(SAMPLES.seat, ctx);
    expect(h.entities.materialisePaddle).toHaveBeenLastCalledWith(2, 'out');
    expect(d.sparks.pool.live).toBe(20);
    const rm = setup({ reduced: true });
    rm.d.consume({ ...SAMPLES.seat, from: SeatConn.Empty, to: SeatConn.Connected }, rm.ctx);
    expect(rm.h.entities.materialisePaddle).toHaveBeenCalledWith(2, 'in');   // P5 makes it instant
    rm.d.consume(SAMPLES.seat, rm.ctx);
    expect(rm.h.entities.materialisePaddle).toHaveBeenLastCalledWith(2, 'out');
    expect(rm.d.sparks.pool.live).toBe(0);
  });

  it('seat: a join after a presented removal materialises the paddle again, reduced motion included', () => {
    for (const reduced of [false, true]) {
      const { h, d, ctx } = setup({ reduced });
      d.consume({ ...SAMPLES.seat, from: SeatConn.Connected, to: SeatConn.Empty }, ctx);
      expect(h.entities.materialisePaddle).toHaveBeenLastCalledWith(2, 'out');
      step(ctx, 0.5);
      d.update(ctx);
      d.consume({ ...SAMPLES.seat, from: SeatConn.Empty, to: SeatConn.Connected }, ctx);
      expect(h.entities.materialisePaddle).toHaveBeenLastCalledWith(2, 'in');   // not left in 'out' (transparent)
    }
  });

  it('countdown: the server\'s "3", "2", "1" give one rise wave, and one floor ring and wall breath per message', () => {
    const { h, d, ctx } = setup();
    const rings = vi.spyOn(d.rings, 'ring');
    const run = (seconds: number): void => {
      const frames = Math.round(seconds * 60);
      for (let f = 0; f < frames; f++) {
        step(ctx, seconds / frames);
        d.update(ctx);
      }
    };
    d.consume({ ...SAMPLES.countdown, seconds: 3 }, ctx);
    expect(h.entities.brickRise).toHaveBeenCalledWith('wave', 1);
    expect(h.entities.wallBreathe).toHaveBeenCalledTimes(1);
    expect(d.rings.pool.live).toBe(1);
    run(1.008);                                  // the "2" arrives about 1008 ms after the "3" (lobby-2p)
    expect(h.entities.wallBreathe).toHaveBeenCalledTimes(1);   // nothing self-scheduled in between
    d.consume({ ...SAMPLES.countdown, seconds: 2 }, ctx);
    run(0.992);
    d.consume({ ...SAMPLES.countdown, seconds: 1 }, ctx);
    run(1);
    const waves = h.entities.brickRise.mock.calls.filter((c) => c[0] === 'wave');
    expect(waves).toHaveLength(1);               // a second wave would drop the risen bricks and rise them again
    expect(h.entities.brickRise).toHaveBeenCalledTimes(1);
    expect(h.entities.wallBreathe).toHaveBeenCalledTimes(3);
    expect(rings).toHaveBeenCalledTimes(3);
    for (const c of rings.mock.calls) expect(c[0].r1).toBe(300);
    expect(h.entities.setDim.mock.calls).toEqual([[1, 3], [1, 2], [1, 1]]);   // the dim ramp re-anchors each second
  });

  it('countdownCancelled: bricks lower and the dim returns over 0.4 s (instantly reduced); the next countdown rises again', () => {
    const { h, d, ctx } = setup();
    d.consume(SAMPLES.countdown, ctx);
    d.consume(SAMPLES.countdownCancelled, ctx);
    expect(h.entities.brickRise).toHaveBeenLastCalledWith('lower', 0.4);
    expect(h.entities.setDim).toHaveBeenLastCalledWith(0.35, 0.4);
    step(ctx, 2.5);
    d.update(ctx);
    expect(h.entities.wallBreathe).toHaveBeenCalledTimes(1);
    d.consume(SAMPLES.countdown, ctx);
    expect(h.entities.brickRise).toHaveBeenLastCalledWith('wave', 1);
    expect(h.entities.brickRise.mock.calls.filter((c) => c[0] === 'wave')).toHaveLength(2);
    const rm = setup({ reduced: true });
    rm.d.consume(SAMPLES.countdownCancelled, rm.ctx);
    expect(rm.h.entities.brickRise).toHaveBeenCalledWith('lower', 0);
    expect(rm.h.entities.setDim).toHaveBeenCalledWith(0.35, 0);
  });

  it('countdown after go or game over starts a new wave; a live "1" after a stale "3" does not', () => {
    const { h, d, ctx } = setup();
    d.consume(SAMPLES.countdown, ctx);
    d.consume(SAMPLES.go, ctx);
    d.consume(SAMPLES.countdown, ctx);
    d.consume(SAMPLES.gameOver, ctx);
    d.consume(SAMPLES.countdown, ctx);
    expect(h.entities.brickRise.mock.calls.filter((c) => c[0] === 'wave')).toHaveLength(3);
    const hidden = setup();
    hidden.d.consume({ ...SAMPLES.countdown, seconds: 3, stale: true }, hidden.ctx);
    hidden.d.consume({ ...SAMPLES.countdown, seconds: 1 }, hidden.ctx);
    expect(hidden.h.entities.brickRise.mock.calls).toEqual([['instant', 0]]);
    expect(hidden.h.entities.wallBreathe).toHaveBeenCalledTimes(1);   // the live "1" still pulses
    expect(hidden.h.entities.setDim).toHaveBeenLastCalledWith(1, 1);
  });

  it('go: bloom boost, centre ripple and ring, aberration and kick, GO! and YOU, and a 2 s pulse along my wall', () => {
    const { h, d, ctx } = setup();
    d.consume(SAMPLES.go, ctx);
    expect(h.post.bloomBoost).toHaveBeenCalledWith(0.6, 0.1);
    expect(h.entities.ripple).toHaveBeenCalledWith(450, 450, 1);
    expect(h.post.aberration).toHaveBeenCalledWith(0.004, 0.2);
    expect(h.camera.kick).toHaveBeenCalledWith(0.03);
    expect(spawned(d)).toMatchObject({ rings: 1, pops: 2 });
    expect(popTexts(h)).toEqual(expect.arrayContaining(['GO!', 'YOU']));
    for (let i = 0; i < 42; i++) {
      step(ctx, 0.05);
      d.update(ctx);
    }
    expect(h.entities.flashWall).toHaveBeenCalledTimes(10);
    h.entities.flashWall.mock.calls.forEach((call, i) => {
      expect(call[0]).toBe(3);
      expect(call[1]).toBeCloseTo(0.1 + 0.2 * (i % 5), 9);   // the pulse travels along the wall
      expect(call[3]).toBe('bounce');
    });
    const rm = setup({ reduced: true });
    rm.d.consume(SAMPLES.go, rm.ctx);
    expect(popTexts(rm.h)).toEqual(expect.arrayContaining(['GO!', 'YOU']));   // pops carry information: kept
    expect(rm.d.pops.liveCount).toBe(2);
    expect(rm.h.post.bloomBoost).toHaveBeenCalledWith(0.5, 0.1);             // a flash, capped at 50 %
    for (let i = 0; i < 42; i++) {
      step(rm.ctx, 0.05);
      rm.d.update(rm.ctx);
    }
    expect(rm.h.post.aberration).not.toHaveBeenCalled();
    expect(rm.h.camera.kick).not.toHaveBeenCalled();
    expect(rm.h.entities.flashWall).toHaveBeenCalledTimes(10);                // E43: the YOU pulse stays, still
  });

  it('go under reduced motion keeps the YOU pulse as a static flash at the middle of my wall, without aberration or kick', () => {
    const { h, d, ctx } = setup({ me: 0, reduced: true });
    d.consume(SAMPLES.go, ctx);
    for (let i = 0; i < 42; i++) {   // 2.1 s
      step(ctx, 0.05);
      d.update(ctx);
    }
    expect(h.entities.flashWall).toHaveBeenCalledTimes(10);   // one per 0.2 s step
    for (const call of h.entities.flashWall.mock.calls) expect(call).toEqual([0, 0.5, 0.7, 'bounce']);
    expect(h.post.aberration).not.toHaveBeenCalled();
    expect(h.camera.kick).not.toHaveBeenCalled();
  });

  it('gameOver: the hit-stop, balls fade over 0.6 s, the winner sweep and 120 confetti from the winner wall', () => {
    const { h, d, ctx } = setup();
    d.consume(SAMPLES.gameOver, ctx);
    expect(h.hitStop).toHaveBeenCalledWith(TUNING.hitStop.lastBrickMs, 'lastBrick');
    expect(h.entities.dissolveBall).toHaveBeenCalledWith(7, 0.6);
    expect(h.entities.winnerSweep).toHaveBeenCalledWith(2, 0.6);
    expect(d.shards.pool.live).toBe(120);
    const a = d.shards.pool.array;
    expect(a[0]).toBeLessThan(-400);   // seat 2's wall is the left one
    expect(a[4]).toBeGreaterThan(0);   // thrown inward
    expect(a[12]).toBeCloseTo(linear(PLAYER_COLORS[2]).r, 5);
  });

  it('gameOver after the last brick does not stop twice; the low tier scales the confetti; reduced motion glows', () => {
    const last = setup();
    last.d.consume(SAMPLES.brickDestroyed, last.ctx);
    last.d.consume(SAMPLES.gameOver, last.ctx);
    expect(last.h.hitStop).toHaveBeenCalledTimes(1);
    // The usual order: gameOver is IMMEDIATE, the final grid's last brick waits for display time (40-120 ms).
    const over = setup();
    over.d.consume(SAMPLES.gameOver, over.ctx);
    step(over.ctx, 0.08);
    over.d.update(over.ctx);
    over.d.consume(SAMPLES.brickDestroyed, over.ctx);
    expect(over.h.hitStop).toHaveBeenCalledTimes(1);
    expect(over.h.post.bloomBoost).toHaveBeenCalledWith(0.4, 0.3);   // the E29 bloom still shows
    const low = setup({ tier: 'low' });
    low.d.consume(SAMPLES.gameOver, low.ctx);
    expect(low.d.shards.pool.live).toBe(36);
    const rm = setup({ reduced: true });
    rm.d.consume(SAMPLES.gameOver, rm.ctx);
    expect(rm.h.hitStop).not.toHaveBeenCalled();
    expect(rm.d.shards.pool.live).toBe(0);
    expect(rm.d.decals.pool.live).toBe(5);
    expect(rm.d.decals.pool.array[7]).toBe(1);   // glow, not scorch
    const tie = setup({ reduced: true });
    tie.d.consume({ ...SAMPLES.gameOver, winner: -1 }, tie.ctx);
    expect(tie.d.decals.pool.live).toBe(1);
    expect(tie.h.entities.winnerSweep).toHaveBeenCalledWith(-1, 0.6);
  });

  it('drops P2 confetti while the shard pool is more than 75 % full', () => {
    const { d, ctx } = setup();
    const s = resetShardBurst(d.shard, ctx.fxTimeS);
    s.lifeMin = 50;
    s.lifeMax = 50;
    d.shards.burst(400, s);
    d.consume(SAMPLES.gameOver, ctx);
    expect(d.shards.pool.live).toBe(400);
    expect(d.stats.droppedP2).toBe(1);
  });
});

// ---- stale ----

describe('director: stale events change state only', () => {
  for (const kind of KINDS) {
    it(`${kind}: nothing spawns and nothing is presented`, () => {
      const { h, d, ctx } = setup();
      d.consume({ ...SAMPLES[kind], stale: true } as GameEvent, ctx);
      step(ctx, 0.05);
      d.update(ctx);
      d.lateUpdate(ctx);
      expect(spawned(d)).toEqual({ sparks: 0, shards: 0, rings: 0, decals: 0, pops: 0 });
      expect(d.shells.count).toBe(0);
      expect([...called(h.camera), ...called(h.post)]).toEqual([]);
      expect(h.hitStop).not.toHaveBeenCalled();
      for (const [name, m] of Object.entries(h.entities)) {
        for (const call of m.mock.calls) {
          expect(['brickRise', 'setDim', 'winnerSweep', 'dissolveBall', 'materialisePaddle']).toContain(name);
          // an end state, applied at once ('solidify' with no ghost is fully visible at once, with no scanline)
          expect(call[call.length - 1]).toBe(name === 'materialisePaddle' ? 'solidify' : 0);
        }
      }
      expect(d.stats.staleSkipped).toBe(1);
    });
  }

  it('a stale game over leaves the ended board: the live balls gone at once and the winner sweep in place', () => {
    const { h, d, ctx } = setup();
    putBall(h.render, h.world, 1, 8, 300, 300, 2, 2, { owner: 1 });
    putBall(h.render, h.world, 2, 9, 600, 600, 2, 2, { owner: 2, vis: BallVis.Dying });
    d.consume({ ...SAMPLES.gameOver, stale: true }, ctx);
    expect(h.entities.dissolveBall.mock.calls).toEqual([[7, 0], [8, 0]]);   // not the one already dissolving
    expect(h.entities.winnerSweep).toHaveBeenCalledWith(2, 0);
  });

  it('a stale seat that ends Connected solidifies the paddle; a stale removal or drop calls nothing', () => {
    for (const from of [SeatConn.Empty, SeatConn.Grace]) {
      const { h, d, ctx } = setup();
      d.consume({ ...SAMPLES.seat, from: SeatConn.Connected, to: SeatConn.Empty }, ctx);   // a presented removal ('out')
      d.consume({ ...SAMPLES.seat, from, to: SeatConn.Connected, stale: true }, ctx);
      expect(h.entities.materialisePaddle).toHaveBeenLastCalledWith(2, 'solidify');
    }
    const { h, d, ctx } = setup();
    d.consume({ ...SAMPLES.seat, from: SeatConn.Connected, to: SeatConn.Empty, stale: true }, ctx);
    d.consume({ ...SAMPLES.seat, from: SeatConn.Connected, to: SeatConn.Grace, stale: true }, ctx);
    expect(h.entities.materialisePaddle).not.toHaveBeenCalled();
  });

  it('a stale countdown raises the bricks at once, a stale cancel lowers them, and no pulse follows', () => {
    const { h, d, ctx } = setup();
    d.consume({ ...SAMPLES.countdown, stale: true }, ctx);
    expect(h.entities.brickRise).toHaveBeenCalledWith('instant', 0);
    expect(h.entities.setDim).toHaveBeenCalledWith(1, 0);
    d.consume({ ...SAMPLES.countdownCancelled, stale: true }, ctx);
    expect(h.entities.brickRise).toHaveBeenLastCalledWith('lower', 0);
    expect(h.entities.setDim).toHaveBeenLastCalledWith(0.35, 0);
    step(ctx, 3);
    d.update(ctx);
    expect(h.entities.wallBreathe).not.toHaveBeenCalled();
  });
});

// ---- trails ----

describe('trails', () => {
  function runTrail(hz: number, seconds: number, move: (r: RenderState, t: number) => void, o: { points?: number; reduced?: boolean } = {}) {
    const render = fakeRenderState();
    render.ballId[0] = 1;
    render.ballHigh = 1;
    render.ball[BO.R] = 8;
    render.ball[BO.VIS] = BallVis.Live;
    render.ball[BO.OWNER] = 0;
    const trails = new TrailSystem(render, createFxUniforms(), 32, o.points ?? 32);
    const ctx = makeCtx({ reducedMotion: o.reduced ?? false });
    ctx.fxTimeS = 1;
    move(render, 0);
    trails.update(ctx);
    const frames = Math.round(seconds * hz);
    for (let f = 1; f <= frames; f++) {
      step(ctx, 1 / hz);
      move(render, ctx.fxTimeS - 1);
      trails.update(ctx);
    }
    return { trails, render, ctx };
  }

  const straight = (r: RenderState, t: number): void => {
    r.ball[BO.X] = -300 + 200 * t;
    r.ball[BO.Y] = 50 + 40 * t;
    r.ball[BO.VX] = 5;
    r.ball[BO.VY] = 1;
  };

  it('commits the same samples, at the same times and places, at 30, 60 and 144 Hz', () => {
    const runs = [30, 60, 144].map((hz) => {
      const { trails } = runTrail(hz, 0.5, straight);
      const times = new Float64Array(64);
      const n = trails.sampleTimes(0, times);
      const pts: number[][] = [];
      const p = new Float64Array(4);
      for (let i = 1; i <= n; i++) {
        trails.pointOf(0, i, p);
        pts.push([p[0], p[1]]);
      }
      trails.pointOf(0, 0, p);
      return { n, times: Array.from(times.subarray(0, n)), pts, head: [p[0], p[1]] };
    });
    expect(runs[0].n).toBe(31);   // P - 1 committed samples; the oldest dropped
    for (const r of runs) {
      expect(r.n).toBe(runs[0].n);
      for (let i = 0; i < r.n; i++) {
        expect(Math.abs(r.times[i] - runs[0].times[i])).toBeLessThan(1e-9);
        expect(Math.abs(r.pts[i][0] - runs[0].pts[i][0])).toBeLessThan(1e-3);
        expect(Math.abs(r.pts[i][1] - runs[0].pts[i][1])).toBeLessThan(1e-3);
      }
      expect(r.head[0]).toBeCloseTo(-200, 3);   // the head is at the ball
      expect(r.head[1]).toBeCloseTo(70, 3);
    }
    // sample times live in a float32 GPU attribute: about 1e-7 s of resolution near t = 1.5 s
    const interval = Math.max(TRAIL_SAMPLE_S, 0.32 / 30);   // 32 points hold 320 ms: about 10.7 ms apart
    for (let i = 1; i < runs[0].n; i++) expect(runs[0].times[i - 1] - runs[0].times[i]).toBeCloseTo(interval, 5);
    // a committed sample lies on the path at its own time
    const t0 = runs[0].times[5] - 1;
    expect(runs[0].pts[5][0]).toBeCloseTo(-300 + 200 * t0, 2);
  });

  it('keeps each point in the colour it was sampled with, so an ownership change sweeps along', () => {
    const { trails, render, ctx } = runTrail(60, 0.1, straight);
    render.ball[BO.OWNER] = 2;
    for (let f = 0; f < 3; f++) {
      step(ctx, 1 / 60);
      straight(render, ctx.fxTimeS - 1);
      trails.update(ctx);
    }
    const p = new Float64Array(4);
    const colors: number[] = [];
    const n = trails.sampleTimes(0, new Float64Array(64));
    expect(n).toBeGreaterThan(12);
    for (let i = 0; i <= n; i++) {   // the head and every committed sample
      trails.pointOf(0, i, p);
      colors.push(p[3]);
    }
    const firstOld = colors.indexOf(0);
    expect(colors[0]).toBe(2);
    expect(firstOld).toBeGreaterThan(1);
    expect(colors.slice(0, firstOld).every((c) => c === 2)).toBe(true);
    expect(colors.slice(firstOld).every((c) => c === 0)).toBe(true);
  });

  it('sets the length by speed, phasing and reduced motion, the same on every tier', () => {
    const slow = (r: RenderState): void => {
      r.ball[BO.VX] = 5;
      r.ball[BO.VY] = 0;
    };
    const fast = (r: RenderState): void => {
      r.ball[BO.VX] = 6;
      r.ball[BO.VY] = 8;
    };
    expect(runTrail(60, 0.02, slow).trails.len[0]).toBeCloseTo(0.12, 6);
    expect(runTrail(60, 0.02, fast).trails.len[0]).toBeCloseTo(0.22, 6);
    expect(runTrail(60, 0.02, fast, { reduced: true }).trails.len[0]).toBeCloseTo(0.11, 6);
    expect(runTrail(60, 0.02, fast, { points: 12 }).trails.len[0]).toBeCloseTo(0.22, 6);
    const phasing = (r: RenderState): void => {
      fast(r);
      r.ball[BO.PHASING] = 1;
    };
    expect(runTrail(60, 0.02, phasing).trails.len[0]).toBeCloseTo(0.32, 6);
    expect(runTrail(60, 0.02, phasing, { points: 12 }).trails.len[0]).toBeCloseTo(0.32, 6);
  });

  it('holds 320 ms of history on every tier: one sample every max(8 ms, 320 ms / (P - 2))', () => {
    const phasing = (r: RenderState, t: number): void => {
      straight(r, t);
      r.ball[BO.VX] = 6;
      r.ball[BO.VY] = 8;
      r.ball[BO.PHASING] = 1;
    };
    const fast = (r: RenderState, t: number): void => {
      straight(r, t);
      r.ball[BO.VX] = 6;
      r.ball[BO.VY] = 8;
    };
    const pt = { x: 0, y: 0, z: 0 };
    const low = runTrail(60, 0.5, phasing, { points: 12 });
    expect(low.trails.len[0]).toBeCloseTo(0.32, 6);
    expect(low.trails.sampleAt(0, 0.12, pt)).toBe(true);   // E34's oldest echo still has history on the low tier
    const lowTimes = new Float64Array(64);
    expect(low.trails.sampleTimes(0, lowTimes)).toBe(11);
    expect(lowTimes[0] - lowTimes[1]).toBeCloseTo(0.032, 5);
    const midPhasing = runTrail(60, 0.5, phasing, { points: 24 }).trails.len[0];
    const midFast = runTrail(60, 0.5, fast, { points: 24 }).trails.len[0];
    expect(midPhasing).toBeCloseTo(0.32, 6);
    expect(midFast).toBeCloseTo(0.22, 6);
    expect(midPhasing).toBeGreaterThan(midFast);
    const high = runTrail(60, 0.5, straight);
    const times = new Float64Array(64);
    const n = high.trails.sampleTimes(0, times);
    expect(n).toBe(31);
    for (let i = 1; i < n; i++) expect(times[i - 1] - times[i]).toBeCloseTo(0.32 / 30, 5);
  });

  it('keeps live trails and their committed samples across a tier change, collapsing the changed points', () => {
    const { trails, render, ctx } = runTrail(60, 0.5, straight, { points: 24 });
    const before = new Float64Array(64);
    expect(trails.sampleTimes(0, before)).toBe(23);
    const p = new Float64Array(4);
    const last = new Float64Array(4);
    const expectCollapsed = (from: number, to: number): void => {
      trails.pointOf(0, from - 1, last);
      for (let i = from; i < to; i++) {
        trails.pointOf(0, i, p);
        expect(Array.from(p)).toEqual(Array.from(last));   // on the last kept point, in its colour
      }
    };
    trails.setPoints(32);
    const grown = new Float64Array(64);
    expect(trails.sampleTimes(0, grown)).toBe(23);        // the added points start dead
    expect(Array.from(grown.subarray(0, 23))).toEqual(Array.from(before.subarray(0, 23)));
    expectCollapsed(24, 32);
    trails.setPoints(12);
    const shrunk = new Float64Array(64);
    expect(trails.sampleTimes(0, shrunk)).toBe(11);       // the newest P - 1 samples stay
    expect(Array.from(shrunk.subarray(0, 11))).toEqual(Array.from(before.subarray(0, 11)));
    expectCollapsed(12, 32);
    expect(trails.sampleAt(0, 0.05, { x: 0, y: 0, z: 0 })).toBe(true);
    step(ctx, 1 / 60);                                    // the trail runs on without restarting
    straight(render, ctx.fxTimeS - 1);
    trails.update(ctx);
    expect(trails.active).toBe(1);
    const after = new Float64Array(64);
    expect(trails.sampleTimes(0, after)).toBe(11);
    expect(after[0]).toBeGreaterThan(before[0]);          // one new sample, then the newest 10 of before
    expect(Array.from(after.subarray(1, 11))).toEqual(Array.from(before.subarray(0, 10)));
  });

  it('fades out after the ball is gone, then frees the slot; a teleport restarts the trail', () => {
    const { trails, render, ctx } = runTrail(60, 0.3, straight);
    expect(trails.active).toBe(1);
    render.ballId[0] = -1;
    step(ctx, 0.1);
    trails.update(ctx);
    expect(trails.active).toBe(1);
    step(ctx, 0.2);
    trails.update(ctx);
    expect(trails.active).toBe(0);
    const tp = runTrail(60, 0.3, straight);
    tp.render.ball[BO.X] += 300;
    step(tp.ctx, 1 / 60);
    tp.trails.update(tp.ctx);
    expect(tp.trails.sampleTimes(0, new Float64Array(64))).toBe(0);
  });
});

// ---- shells ----

describe('phasing shells', () => {
  function rig(reduced: boolean, displayTick = 40) {
    const h = harness();
    putBall(h.render, h.world, 0, 7, 300, 450, 6, 0, { owner: 1, phasing: true });
    h.world.balls[0].phaseStartTick = 0;
    h.render.displayTick = displayTick;
    const u = createFxUniforms();
    const trails = new TrailSystem(h.render, u, 32, 32);
    const shells = new ShellSystem(h.render, h.world, u, trails);
    const ctx = makeCtx({ reducedMotion: reduced });
    ctx.fxTimeS = 1;
    for (let f = 0; f < 12; f++) {
      step(ctx, 1 / 60);
      h.render.ball[BO.X] += 6;
      trails.update(ctx);
      shells.update(ctx);
    }
    return { h, trails, shells, ctx };
  }
  const inst = new Float32Array(8);

  it('a phasing ball gets a shell, three echoes from its trail and a depleting timer ring', () => {
    const { h, shells } = rig(false);
    expect(shells.count).toBe(5);
    const kinds: number[] = [];
    for (let i = 0; i < 5; i++) {
      shells.readInstance(i, inst);
      kinds.push(inst[6]);
      if (inst[6] === ShellKind.Echo) expect(inst[0]).toBeLessThan(h.render.ball[BO.X]);   // behind the ball
      if (inst[6] === ShellKind.Timer) {
        expect(inst[5]).toBeCloseTo(2 / 3, 5);   // 1 s of 3 gone
        expect(inst[4]).toBe(1);                 // no flicker before the last 0.5 s
      }
    }
    expect(kinds).toEqual([ShellKind.Shell, ShellKind.Echo, ShellKind.Echo, ShellKind.Echo, ShellKind.Timer]);
  });

  it('one echo and no flicker under reduced motion; the timer flickers in its last 0.5 s otherwise', () => {
    const rm = rig(true, 110);
    expect(rm.shells.count).toBe(3);
    rm.shells.readInstance(2, inst);
    expect(inst[6]).toBe(ShellKind.Timer);
    expect(inst[4]).toBe(1);
    const full = rig(false, 110);
    full.shells.readInstance(4, inst);
    expect(inst[6]).toBe(ShellKind.Timer);
    expect(inst[5]).toBeCloseTo(0.25 / 3, 5);
    expect(inst[4]).toBeLessThan(1);
  });

  it('collapses over 0.25 s when phaseEnd is released, and not at all for a stale one', () => {
    const { h, shells, trails, ctx } = rig(false);
    h.render.ball[BO.PHASING] = 0;
    shells.collapse(7, ctx.fxTimeS);
    const radii: number[] = [];
    for (let f = 0; f < 18; f++) {   // 0.3 s
      step(ctx, 1 / 60);
      trails.update(ctx);
      shells.update(ctx);
      if (shells.count > 0) {
        shells.readInstance(0, inst);
        expect(inst[6]).toBe(ShellKind.Collapse);
        radii.push(inst[3]);
      }
    }
    expect(radii.length).toBeGreaterThanOrEqual(14);   // 0.25 s at 60 Hz
    expect(radii.length).toBeLessThanOrEqual(15);
    for (let i = 1; i < radii.length; i++) expect(radii[i]).toBeLessThan(radii[i - 1]);
    expect(shells.count).toBe(0);
    shells.collapse(7, ctx.fxTimeS);
    shells.cancel(7);
    shells.update(ctx);
    expect(shells.count).toBe(0);
  });

  it('a phaseEnd released while the display still shows the ball phasing collapses on the frame the display passes k', () => {
    const { h, shells, trails, ctx } = rig(false);
    const frame = (s: number): void => {
      step(ctx, s);
      trails.update(ctx);
      shells.update(ctx);
    };
    const kinds = (): number[] => Array.from({ length: shells.count }, (_, i) => {
      shells.readInstance(i, inst);
      return inst[6];
    });
    shells.collapse(7, ctx.fxTimeS);
    frame(1 / 60);                              // the display is still before the phaseEnd tick
    expect(kinds()).not.toContain(ShellKind.Collapse);
    expect(kinds()[0]).toBe(ShellKind.Shell);
    frame(1 / 60);
    expect(kinds()).not.toContain(ShellKind.Collapse);
    h.render.ball[BO.PHASING] = 0;              // the display passes k
    frame(1 / 60);
    expect(kinds()).toEqual([ShellKind.Collapse]);
    shells.readInstance(0, inst);
    expect(inst[3]).toBeCloseTo(8 * 1.4, 4);    // the collapse starts on this frame: full radius and alpha
    expect(inst[4]).toBe(1);
    frame(0.1);
    shells.readInstance(0, inst);
    expect(inst[3]).toBeCloseTo(8 * 1.4 * (1 - 0.4 * 0.4), 3);
    frame(0.1);
    expect(kinds()).toEqual([ShellKind.Collapse]);
    frame(0.04);                                // 0.24 s in
    expect(kinds()).toEqual([ShellKind.Collapse]);
    frame(0.02);                                // 0.26 s: over
    expect(shells.count).toBe(0);

    const cancelled = rig(false);
    cancelled.shells.collapse(7, cancelled.ctx.fxTimeS);
    step(cancelled.ctx, 1 / 60);
    cancelled.trails.update(cancelled.ctx);
    cancelled.shells.update(cancelled.ctx);
    cancelled.shells.cancel(7);                 // a stale phaseEnd before the display passes k
    cancelled.h.render.ball[BO.PHASING] = 0;
    for (let f = 0; f < 20; f++) {
      step(cancelled.ctx, 1 / 60);
      cancelled.trails.update(cancelled.ctx);
      cancelled.shells.update(cancelled.ctx);
      expect(cancelled.shells.count).toBe(0);
    }
  });

  it('drops a pending collapse when another ball takes the slot', () => {
    const { h, shells, trails, ctx } = rig(false);
    shells.collapse(7, ctx.fxTimeS);
    step(ctx, 1 / 60);
    trails.update(ctx);
    shells.update(ctx);                         // deferred: the display still shows ball 7 phasing
    h.render.ballId[0] = 8;                     // ball 7 is gone; ball 8 takes slot 0, phasing, and ends its phase
    h.world.balls[0].id = 8;
    h.world.slotById.set(8, 0);
    step(ctx, 1 / 60);
    shells.update(ctx);
    h.render.ball[BO.PHASING] = 0;
    for (let f = 0; f < 5; f++) {
      step(ctx, 1 / 60);
      shells.update(ctx);
      expect(shells.count).toBe(0);
    }
  });
});

// ---- pops ----

describe('pops', () => {
  function parse(transform: string | undefined): [number, number, number] {
    const m = /translate3d\(([-\d.]+)px,([-\d.]+)px,0\).*scale\(([-\d.]+)\)/.exec(transform ?? '');
    if (m === null) throw new Error(`no transform in ${transform}`);
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  }

  it('project after the camera, rise, fade and hide when done', () => {
    const h = harness();
    const pops = new PopLayer(h.host);
    expect(h.layer.children).toHaveLength(16);
    expect(h.layer.children[0].attrs.get('aria-hidden')).toBe('true');
    const ctx = makeCtx();
    step(ctx, 1);
    pops.setTime(ctx.fxTimeS);
    pops.show('+2', 450, 450, 0, '#22c55e', 1, 0.8);
    const span = h.layer.children[0];
    expect(span.textContent).toBe('+2');
    expect(span.style.color).toBe('#22c55e');
    pops.lateUpdate(ctx);
    expect(span.style.opacity).toBe('1.000');
    const [x0, y0] = parse(span.style.transform);
    expect(x0).toBe(450);
    step(ctx, 0.3);
    pops.lateUpdate(ctx);
    const [, y1, s1] = parse(span.style.transform);
    expect(y1).toBeLessThan(y0);   // rising
    expect(s1).toBeCloseTo(1, 2);
    step(ctx, 0.45);
    pops.lateUpdate(ctx);
    expect(Number(span.style.opacity)).toBeLessThan(0.5);
    step(ctx, 0.1);
    pops.lateUpdate(ctx);
    expect(span.style.opacity).toBe('0');
    expect(pops.liveCount).toBe(0);
  });

  it('steal the oldest span when all 16 are live', () => {
    const h = harness();
    const pops = new PopLayer(h.host);
    pops.setTime(1);
    for (let i = 0; i <= 16; i++) pops.show(`p${i}`, 450, 450, 0, '#fff', 1, 5);
    expect(pops.liveCount).toBe(16);
    expect(h.layer.children[0].textContent).toBe('p16');
    expect(h.layer.children[1].textContent).toBe('p1');
  });

  it('renumber a keyed pop without spawning another, and replace one shown again with the same key', () => {
    const h = harness();
    const pops = new PopLayer(h.host);
    pops.setTime(1);
    pops.show('−1', 450, 900, 24, '#ef4444', 1.1, 1, 103);
    expect(pops.update(103, '−2')).toBe(true);
    expect(pops.textOf(103)).toBe('−2');
    expect(pops.liveCount).toBe(1);
    expect(pops.update(999, 'x')).toBe(false);
    pops.show('−1', 450, 900, 24, '#ef4444', 1.1, 1, 103);
    expect(pops.liveCount).toBe(1);
  });

  it('neither rise nor scale under reduced motion', () => {
    const h = harness();
    const pops = new PopLayer(h.host);
    const ctx = makeCtx({ reducedMotion: true });
    step(ctx, 1);
    pops.setTime(ctx.fxTimeS);
    pops.show('+1', 450, 450, 0, '#fff', 1, 1);
    pops.lateUpdate(ctx);
    const a = parse(h.layer.children[0].style.transform);
    step(ctx, 0.4);
    pops.lateUpdate(ctx);
    const b = parse(h.layer.children[0].style.transform);
    expect(b[1]).toBe(a[1]);
    expect(a[2]).toBe(1);
    pops.dispose();
    expect(h.layer.children).toHaveLength(0);
  });
});

// ---- lifecycle ----

describe('director lifecycle', () => {
  it('adds six unculled FX draws to the board (6 of the 12 scene draws)', () => {
    const h = harness();
    const d = createFxDirector(h.host);
    expect(d).toBeInstanceOf(EffectsDirector);
    const names = h.host.board.children.map((c) => c.name).sort();
    expect(names).toEqual(['fxDecals', 'fxRings', 'fxShards', 'fxShells', 'fxSparks', 'fxTrails']);
    for (const c of h.host.board.children) expect(c.frustumCulled).toBe(false);
  });

  it('scales the FX HDR by HDR.lowBitScale only while post-processing runs on 8-bit buffers', () => {
    const uHdr = (d: EffectsDirector): unknown => (d.sparks.pool.object.material as THREE.ShaderMaterial).uniforms.uHdr.value;
    const cases: readonly (readonly [boolean, boolean, number])[] = [[true, true, HDR.lowBitScale], [true, false, 1], [false, true, 1]];
    for (const [enabled, lowBit, want] of cases) {
      const h = harness();
      const post = { ...postSpies(), enabled, lowBit };
      const d = new EffectsDirector(buildHost(h.render, h.world, h.layer, h.entities, h.camera, post, h.hitStop), TUNING, seeded(1));
      const ctx = makeCtx();
      step(ctx, 1);
      d.update(ctx);
      expect(uHdr(d)).toBe(want);
      expect((d.trails.object.material as THREE.ShaderMaterial).uniforms.uHdr.value).toBe(want);   // one shared uniform
      post.enabled = !enabled;                  // the composer can be switched on and off at run time
      step(ctx, 1 / 60);
      d.update(ctx);
      expect(uHdr(d)).toBe(!enabled && lowBit ? HDR.lowBitScale : 1);
    }
  });

  it('reset ends every live effect; dispose removes the draws and the pop spans', () => {
    const { h, d, ctx } = setup();
    d.consume(SAMPLES.brickDestroyed, ctx);
    d.consume(SAMPLES.go, ctx);
    step(ctx, 0.05);
    d.update(ctx);
    expect(d.stats.trails).toBe(1);
    expect(d.stats.sparks).toBeGreaterThan(0);
    d.reset();
    expect(spawned(d)).toEqual({ sparks: 0, shards: 0, rings: 0, decals: 0, pops: 0 });
    expect(d.trails.active).toBe(0);
    h.entities.flashWall.mockClear();
    step(ctx, 1);
    d.update(ctx);
    expect(h.entities.flashWall).not.toHaveBeenCalled();   // the YOU pulse was cancelled too
    d.dispose();
    expect(h.host.board.children).toHaveLength(0);
    expect(h.layer.children).toHaveLength(0);
    const boosts = h.post.bloomBoost.mock.calls.length;
    d.update(ctx);
    d.consume(SAMPLES.go, ctx);
    expect(h.post.bloomBoost).toHaveBeenCalledTimes(boosts);   // a disposed director does nothing
  });
});

// ---- allocation ----

describe('director update', () => {
  it('allocates < 64 KB over 1000 saturated update() calls', () => {
    const q = quietHarness();
    const r = q.render;
    for (let slot = 0; slot < 64; slot++) {
      putBall(r, q.world, slot, 100 + slot, 100 + (slot % 8) * 90, 100 + Math.floor(slot / 8) * 90, 6, 4, { owner: slot % 5 - 1, phasing: slot % 4 === 0 });
      q.world.balls[slot].phaseStartTick = 0;
    }
    r.displayTick = 20;
    const d = new EffectsDirector(q.host, TUNING, seeded(9));
    d.setTier('high');
    const ctx = makeCtx({ myIndex: 3 });
    step(ctx, 1);
    d.update(ctx);
    const fill = (): void => {
      const t = ctx.fxTimeS;
      const s = resetSparkBurst(d.spark, t);
      s.lifeMin = 100;
      s.lifeMax = 100;
      d.sparks.burst(d.sparks.pool.capacity + 10, s);
      const sh = resetShardBurst(d.shard, t);
      sh.lifeMin = 100;
      sh.lifeMax = 100;
      d.shards.burst(d.shards.pool.capacity + 10, sh);
      const rs = resetRingSpec(d.ring, t);
      rs.dur = 100;
      for (let i = 0; i < d.rings.pool.capacity + 2; i++) d.rings.ring(rs);
      const dc = resetDecalSpec(d.decal, t);
      dc.dur = 100;
      for (let i = 0; i < d.decals.pool.capacity + 2; i++) d.decals.decal(dc);
    };
    fill();
    const move = (): void => {
      const t = ctx.fxTimeS;
      for (let slot = 0; slot < 64; slot++) {
        const o = slot * BALL_STRIDE;
        r.ball[o + BO.X] = -350 + (slot % 8) * 90 + 40 * Math.sin(t * 3 + slot);
        r.ball[o + BO.Y] = -350 + Math.floor(slot / 8) * 90 + 40 * Math.cos(t * 2 + slot);
      }
    };
    for (let i = 0; i < 300; i++) {
      step(ctx, 1 / 60);
      move();
      d.update(ctx);
    }
    expect(d.sparks.pool.live).toBe(d.sparks.pool.capacity);
    expect(d.shards.pool.live).toBe(d.shards.pool.capacity);
    expect(d.rings.pool.live).toBe(d.rings.pool.capacity);
    expect(d.decals.pool.live).toBe(d.decals.pool.capacity);
    expect(d.trails.active).toBe(64);
    expect(d.shells.count).toBeGreaterThan(64);
    forceGc();
    const h0 = heapUsed();
    for (let i = 0; i < 1000; i++) {
      step(ctx, 1 / 60);
      move();
      d.update(ctx);
    }
    forceGc();
    const delta = heapUsed() - h0;
    expect(delta).toBeLessThan(64 * 1024);
    expect(d.trails.active).toBe(64);
  });
});
