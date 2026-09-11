// Entity systems in headless three: instance attributes after a fixture replay, the bricks system reading only the
// display arrays, packing, fades, springs, lobby tiles, the material patches against three r176, and the frame
// path allocating nothing.

import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { FIXTURES, loadFixture } from '../../test/fixtures/load';
import { decode } from '../../net/decode';
import { createGameRuntime } from '../../game/runtime';
import type { GameRuntime, RenderState, World } from '../../game/types';
import type { BrickCell } from '../../protocol/messages';
import { BALL_STRIDE, BO, BallVis, PADDLE_STRIDE, PO } from '../../game/types';
import type { Owner, Seat } from '../../game/events';
import { SeatConn } from '../../game/events';
import { createStore } from '../../lib/store';
import { initialAppState } from '../../state/appStore';
import { FakeClock } from '../../test/fakes/FakeClock';
import { fakeRenderState, fakeWorld } from '../../test/fakes/fakeApp';
import { forceGc } from '../../test/gc';
import { log } from '../../lib/log';
import { BRICK_SIZE, CELLS, CellType, GRID, LIFE_H, MAX_BALLS } from '../../config/constants';
import { COLORS, PLAYER_COLORS, lifeColor } from '../../config/palette';
import type { FrameCtx } from '../contracts';
import type { Visual } from '../../input/types';
import { ANCHORS, createSharedUniforms, missingAnchors } from '../materials/patch';
import type { StandardPatch } from '../materials/patch';
import { RISE, createBrickMaterial } from '../materials/brick';
import { createWallMaterial } from '../materials/wall';
import { createPaddleMaterial } from '../materials/paddle';
import { createBallMaterial } from '../materials/ball';
import { createGlowTexture } from '../textures';
import { CameraRig } from '../camera';
import { TUNING } from '../../config/tuning';
import { FloorSystem } from './floor';
import { WallsSystem } from './walls';
import { BricksSystem } from './bricks';
import { PaddlesSystem } from './paddles';
import { BallsSystem } from './balls';
import { HalosSystem } from './halos';

const FRAME = 1000 / 60;

/** A plain literal, as the frame loop builds it, so its number fields are written in place (a spread copy can
 *  leave them tagged, and every write would then box a number). */
function makeCtx(over: Partial<FrameCtx> = {}): FrameCtx {
  const ctx: FrameCtx = {
    nowMs: 0, dtMs: FRAME, dtS: FRAME / 1000, fxTimeS: 0, fxDtS: FRAME / 1000, displayMs: 0, reducedMotion: false,
    tier: 'high', myIndex: null, hitStopActive: false, session: 'playing', mode: 'live',
  };
  if (over.myIndex !== undefined) ctx.myIndex = over.myIndex;
  if (over.mode !== undefined) ctx.mode = over.mode;
  if (over.session !== undefined) ctx.session = over.session;
  if (over.reducedMotion !== undefined) ctx.reducedMotion = over.reducedMotion;
  return ctx;
}

function advance(ctx: FrameCtx, seconds = FRAME / 1000): void {
  ctx.dtS = seconds;
  ctx.dtMs = seconds * 1000;
  ctx.fxDtS = seconds;
  ctx.fxTimeS += seconds;
  ctx.nowMs += seconds * 1000;
}

function build(render: Readonly<RenderState>, world: Readonly<World>, intent: () => Visual = () => 0) {
  const board = new THREE.Group();
  const shared = createSharedUniforms();
  const deps = { board, render, world, shared };
  const floor = new FloorSystem(deps);
  const walls = new WallsSystem(deps);
  const bricks = new BricksSystem(deps);
  const paddles = new PaddlesSystem(deps);
  const balls = new BallsSystem(deps);
  const halos = new HalosSystem(deps, balls, intent, createGlowTexture());
  return { board, shared, floor, walls, bricks, paddles, balls, halos, all: [floor, walls, bricks, paddles, balls, halos] };
}

function linear(hex: string): THREE.Color {
  return new THREE.Color(hex);
}

function setCell(r: RenderState, i: number, life: number, fade = 0): void {
  r.brickType[i] = life > 0 ? CellType.Brick : CellType.Empty;
  r.brickLife[i] = life;
  r.brickFade[i] = fade;
}

function matrixOf(mesh: THREE.InstancedMesh, k: number): Float32Array {
  return (mesh.instanceMatrix.array as Float32Array).subarray(k * 16, k * 16 + 16);
}

/** Replays quick-solo (client A) at 60 Hz through decode and a real game runtime, updating the systems every
 *  rendered frame, then keeps framing without data until the queue has drained and every animation settled. `grid`
 *  is the first fullGridUpdate's cells, whose x and y the server computed itself (mapToR3FCoords). */
function replayQuickSolo(): { rt: GameRuntime; stage: ReturnType<typeof build>; ctx: FrameCtx; kinds: Map<string, number>; grid: BrickCell[] | null } {
  const clock = new FakeClock(0);
  const rt = createGameRuntime({ store: createStore(initialAppState()), now: clock.now, timers: clock });
  const stage = build(rt.render, rt.world);
  const ctx = makeCtx();
  const kinds = new Map<string, number>();
  rt.onIngestEvents((events) => {
    for (const e of events) kinds.set(e.k, (kinds.get(e.k) ?? 0) + 1);
  });
  const fire = (): void => {};
  let t = 0;
  let epoch = 0;
  let grid: BrickCell[] | null = null;
  const step = (): void => {
    t += FRAME;
    clock.setTime(t);
    rt.frame(FRAME, t, fire);
    advance(ctx);
    ctx.myIndex = rt.world.myIndex;
    if (rt.render.ready) for (const s of stage.all) s.update(ctx);
  };
  for (const f of loadFixture(FIXTURES['quick-solo'])) {
    if (f.c !== 'A' || f.dir !== 'in') continue;
    while (t + FRAME <= f.t) step();
    const d = decode(f.d);
    if (!d.ok) continue;
    const msg = d.msg;
    if (msg.messageType === 'playerAssignment') rt.reset(++epoch, msg.playerIndex as Seat);
    else if (msg.messageType === 'initialPlayersAndBallsState' || msg.messageType === 'gameUpdates') rt.ingest(msg, f.t);
    else if (msg.messageType === 'gameOver') rt.ended(msg.winnerIndex as Owner, false);
    if (grid === null && msg.messageType === 'gameUpdates') {
      for (const u of msg.updates) {
        if (u.messageType === 'fullGridUpdate') {
          grid = u.bricks;
          break;
        }
      }
    }
  }
  for (let i = 0; i < 120; i++) step();
  return { rt, stage, ctx, kinds, grid };
}

describe('entity systems after a fixture replay (headless three)', () => {
  const { rt, stage, kinds, grid } = replayQuickSolo();
  const r = rt.render;
  const w = rt.world;

  it('replayed a game with brick damage and destruction (not vacuous)', () => {
    expect(r.ready).toBe(true);
    expect(kinds.get('brickDestroyed') ?? 0).toBeGreaterThan(0);
    expect(kinds.get('brickDamaged') ?? 0).toBeGreaterThan(0);
    expect(w.bricksAlive).toBeLessThan(w.bricksAtStart);
    expect(w.bricksAlive).toBeGreaterThan(0);
  });

  it('bricks: one packed instance per live display cell, at the server\'s cell centre, life x 6 tall, in its life colour', () => {
    // The expected centres come from the recorded grid, not from the system's own formula, so a swapped row and
    // column or a flipped y fails here.
    expect(grid).not.toBeNull();
    const cells = grid ?? [];
    expect(cells.length).toBe(w.gridSize * w.gridSize);
    const live: number[] = [];
    for (let i = 0; i < CELLS; i++) if (r.brickType[i] === CellType.Brick && r.brickLife[i] > 0) live.push(i);
    expect(live.length).toBe(w.bricksAlive);
    expect(stage.bricks.liveCount).toBe(live.length);
    expect(stage.bricks.mesh.count).toBe(live.length);
    const used = new Set<number>();
    const colors = stage.bricks.mesh.instanceColor?.array as Float32Array;
    const fx = stage.bricks.mesh.geometry.getAttribute('aFx').array as Float32Array;
    for (const i of live) {
      const k = stage.bricks.instanceOf(i);
      expect(k).toBeGreaterThanOrEqual(0);
      expect(k).toBeLessThan(live.length);
      used.add(k);
      const m = matrixOf(stage.bricks.mesh, k);
      expect(m[12]).toBeCloseTo(cells[i].x, 4);
      expect(m[13]).toBeCloseTo(cells[i].y, 4);
      expect(m[0]).toBeCloseTo(BRICK_SIZE, 4);
      expect(m[5]).toBeCloseTo(BRICK_SIZE, 4);
      expect(m[10]).toBeCloseTo(r.brickLife[i] * LIFE_H, 3);
      const col = linear(lifeColor(r.brickLife[i]));
      expect(colors[k * 3]).toBeCloseTo(col.r, 5);
      expect(colors[k * 3 + 1]).toBeCloseTo(col.g, 5);
      expect(colors[k * 3 + 2]).toBeCloseTo(col.b, 5);
      const level = Math.max(w.brickLevel[i], r.brickLife[i]);
      expect(fx[k * 4 + 1]).toBeCloseTo(1 - r.brickLife[i] / level, 5);
    }
    expect(used.size).toBe(live.length);
  });

  it('balls: live slots sit at the sampled position with the displayed radius; hidden slots draw nothing', () => {
    let seen = 0;
    const b = r.ball;
    expect(stage.balls.mesh.count).toBe(r.ballHigh);
    for (let slot = 0; slot < r.ballHigh; slot++) {
      const o = slot * BALL_STRIDE;
      const m = matrixOf(stage.balls.mesh, slot);
      if (r.ballId[slot] < 0 || b[o + BO.VIS] === BallVis.Hidden) {
        expect(m[0]).toBe(0);
        expect(m[5]).toBe(0);
        expect(m[10]).toBe(0);
        continue;
      }
      if (b[o + BO.VIS] !== BallVis.Live) continue;
      seen++;
      const radius = b[o + BO.R];
      expect(m[12]).toBeCloseTo(b[o + BO.X], 4);
      expect(m[13]).toBeCloseTo(b[o + BO.Y], 4);
      expect(m[14]).toBeCloseTo(radius, 4);
      expect(m[10]).toBeCloseTo(radius, 4);
      const along = Math.hypot(m[0], m[1]);
      expect(along).toBeGreaterThanOrEqual(radius - 1e-4);
      expect(along).toBeLessThanOrEqual(radius * 1.12 + 1e-4);
    }
    expect(seen).toBeGreaterThan(0);
  });

  it('paddles: my paddle at its centre and size; empty seats draw nothing', () => {
    const p = r.paddle;
    expect(p[0 * PADDLE_STRIDE + PO.PRESENT]).toBe(1);
    for (let seat = 0; seat < 4; seat++) {
      const o = seat * PADDLE_STRIDE;
      const m = matrixOf(stage.paddles.mesh, seat);
      if (p[o + PO.PRESENT] === 1) {
        expect(m[12]).toBeCloseTo(p[o + PO.CX], 4);
        expect(m[13]).toBeCloseTo(p[o + PO.CY], 4);
        expect(m[0]).toBeCloseTo(p[o + PO.W], 4);
        expect(m[5]).toBeCloseTo(p[o + PO.H], 4);
      } else {
        expect(m[0]).toBe(0);
        expect(m[5]).toBe(0);
      }
    }
  });

  it('walls: the connected seat in its colour, empty seats in graphite', () => {
    const out = new THREE.Color();
    for (let seat = 0; seat < 4; seat++) {
      const conn = r.paddle[seat * PADDLE_STRIDE + PO.CONN];
      const expected = linear(conn === SeatConn.Empty ? COLORS.wallEmpty : PLAYER_COLORS[seat]);
      stage.walls.colorOf(seat as Seat, out);
      expect(out.r).toBeCloseTo(expected.r, 5);
      expect(out.g).toBeCloseTo(expected.g, 5);
      expect(out.b).toBeCloseTo(expected.b, 5);
    }
    expect(r.paddle[PO.CONN]).toBe(SeatConn.Connected);
  });

  it('floor: the occupancy texture mirrors render.brickType, and blobs follow the balls', () => {
    const occ = stage.floor.occupancy;
    expect(occ.grid).toBe(GRID);
    for (let row = 0; row < GRID; row++) {
      for (let col = 0; col < GRID; col++) {
        const alive = r.brickType[row * GRID + col] === CellType.Brick;
        expect(occ.data[(GRID - 1 - row) * GRID + col]).toBe(alive ? 255 : 0);
      }
    }
    const blobs = stage.floor.uniforms.uBlobs.value;
    for (let slot = 0; slot < MAX_BALLS; slot++) {
      const o = slot * BALL_STRIDE;
      const shown = slot < r.ballHigh && r.ball[o + BO.VIS] !== BallVis.Hidden;
      if (!shown) {
        expect(blobs[slot * 4 + 3]).toBe(0);
        continue;
      }
      expect(blobs[slot * 4]).toBe(r.ball[o + BO.X]);
      expect(blobs[slot * 4 + 1]).toBe(r.ball[o + BO.Y]);
      expect(blobs[slot * 4 + 2]).toBe(r.ball[o + BO.R]);
    }
  });

  it('halos: one disc under each live ball, a light pool under each paddle', () => {
    const halo = stage.halos.mesh.geometry.getAttribute('aHalo').array as Float32Array;
    for (let slot = 0; slot < r.ballHigh; slot++) {
      const o = slot * BALL_STRIDE;
      if (r.ball[o + BO.VIS] !== BallVis.Live) continue;
      expect(halo[slot * 4]).toBe(r.ball[o + BO.X]);
      expect(halo[slot * 4 + 1]).toBe(r.ball[o + BO.Y]);
      expect(halo[slot * 4 + 2]).toBeGreaterThan(r.ball[o + BO.R] * 3);
    }
    expect(halo[MAX_BALLS * 4 + 2]).toBeGreaterThan(r.paddle[PO.W]);
  });
});

describe('BricksSystem (5.11, D32)', () => {
  it('reads the display arrays, never World.brick*', () => {
    const world = fakeWorld();
    const render = fakeRenderState();
    const { bricks } = build(render, world);
    const ctx = makeCtx();
    // The World already holds a row the display has not released.
    for (let i = 0; i < GRID; i++) {
      world.brickType[i] = CellType.Brick;
      world.brickLife[i] = 7;
      world.brickLevel[i] = 7;
    }
    world.brickVersion++;
    const A = 5 * GRID + 3;
    const B = 9 * GRID + 12;
    setCell(render, A, 3);
    setCell(render, B, 4);
    render.brickVersion++;
    bricks.update(ctx);
    expect(bricks.liveCount).toBe(2);
    for (let i = 0; i < GRID; i++) expect(bricks.instanceOf(i)).toBe(-1);
    const before = Float32Array.from((bricks.mesh.instanceMatrix.array as Float32Array).subarray(0, 32));

    world.brickLife.fill(1);
    world.brickType.fill(CellType.Brick);
    world.brickVersion++;
    for (let f = 0; f < 10; f++) {
      advance(ctx);
      bricks.update(ctx);
    }
    expect(bricks.liveCount).toBe(2);
    expect(Array.from((bricks.mesh.instanceMatrix.array as Float32Array).subarray(0, 32))).toEqual(Array.from(before));

    // A released destroy hides the cell at once (the shatter covers it) and packs the last instance into its place.
    setCell(render, A, 0, 0);
    render.brickVersion++;
    bricks.update(ctx);
    expect(bricks.liveCount).toBe(1);
    expect(bricks.instanceOf(A)).toBe(-1);
    expect(bricks.instanceOf(B)).toBe(0);
    // Cell B is row 9, column 12 of the 18 x 50 grid on a 900 canvas: x = 12 * 50 + 25 - 450, and y = 450 -
    // (9 * 50 + 25), because board y points up and row 0 is the top row (mapToR3FCoords).
    expect(matrixOf(bricks.mesh, 0)[12]).toBeCloseTo(175, 4);
    expect(matrixOf(bricks.mesh, 0)[13]).toBeCloseTo(-25, 4);
  });

  it('a silent removal (brickFade 1) fades over 200 ms before the instance goes', () => {
    const render = fakeRenderState();
    const { bricks } = build(render, fakeWorld());
    const ctx = makeCtx();
    setCell(render, 40, 2);
    render.brickVersion++;
    bricks.update(ctx);
    setCell(render, 40, 0, 1);
    render.brickVersion++;
    advance(ctx);
    bricks.update(ctx);
    const fx = bricks.mesh.geometry.getAttribute('aFx').array as Float32Array;
    expect(bricks.liveCount).toBe(1);
    expect(fx[2]).toBeCloseTo(ctx.fxTimeS, 6);
    for (let f = 0; f < 9; f++) {
      advance(ctx);
      bricks.update(ctx);
    }
    expect(bricks.liveCount).toBe(1);
    for (let f = 0; f < 4; f++) {
      advance(ctx);
      bricks.update(ctx);
    }
    expect(bricks.liveCount).toBe(0);
  });

  it('a damaged brick springs down one layer with a squash, takes its new colour and deepens its cracks', () => {
    const render = fakeRenderState();
    const { bricks } = build(render, fakeWorld());
    const ctx = makeCtx();
    setCell(render, 100, 3);
    render.brickVersion++;
    bricks.update(ctx);
    expect(matrixOf(bricks.mesh, 0)[10]).toBeCloseTo(3 * LIFE_H, 5);
    setCell(render, 100, 2);
    render.brickVersion++;
    let lowest = Infinity;
    for (let f = 0; f < 90; f++) {
      advance(ctx);
      bricks.update(ctx);
      lowest = Math.min(lowest, matrixOf(bricks.mesh, 0)[10]);
    }
    expect(lowest).toBeLessThan(2 * LIFE_H - 0.3);
    expect(matrixOf(bricks.mesh, 0)[10]).toBe(2 * LIFE_H);
    const col = linear(lifeColor(2));
    expect((bricks.mesh.instanceColor?.array as Float32Array)[0]).toBeCloseTo(col.r, 5);
    expect((bricks.mesh.geometry.getAttribute('aFx').array as Float32Array)[1]).toBeCloseTo(1 / 3, 5);
  });

  it('holds the springs during hit-stop', () => {
    const render = fakeRenderState();
    const { bricks } = build(render, fakeWorld());
    const ctx = makeCtx();
    setCell(render, 7, 5);
    render.brickVersion++;
    bricks.update(ctx);
    setCell(render, 7, 4);
    render.brickVersion++;
    advance(ctx);
    bricks.update(ctx);
    const h = matrixOf(bricks.mesh, 0)[10];
    ctx.fxDtS = 0;
    for (let f = 0; f < 5; f++) bricks.update(ctx);
    expect(matrixOf(bricks.mesh, 0)[10]).toBe(h);
  });

  it('sits at tile height in the lobby until the wave; flat bricks rise by themselves once play starts', () => {
    const render = fakeRenderState();
    const lobby = build(render, fakeWorld()).bricks;
    const ctx = makeCtx({ mode: 'lobby', session: 'lobby' });
    lobby.update(ctx);
    expect(lobby.rise).toBe(RISE.tiles);
    expect(lobby.uniforms.uRise.value.z).toBe(RISE.tiles);
    expect(lobby.uniforms.uRise.value.w).toBe(1.5);
    lobby.brickRise('wave', 1);
    expect(lobby.rise).toBe(RISE.rising);
    expect(lobby.uniforms.uRise.value.y).toBeCloseTo(0.5, 9);
    expect(lobby.uniforms.uRiseSpread.value).toBeCloseTo(0.5, 9);
    lobby.brickRise('lower', 0.4);
    expect(lobby.rise).toBe(RISE.lowering);
    advance(ctx);
    lobby.update(ctx);
    expect(lobby.rise).toBe(RISE.lowering);   // an E42 lowering is not cut short

    const reduced = build(render, fakeWorld()).bricks;
    const rctx = makeCtx({ mode: 'lobby', session: 'lobby', reducedMotion: true });
    reduced.update(rctx);
    reduced.brickRise('wave', 1);
    expect(reduced.uniforms.uRise.value.y).toBeCloseTo(0.3, 9);
    expect(reduced.uniforms.uRiseSpread.value).toBe(0);

    const auto = build(render, fakeWorld()).bricks;
    const actx = makeCtx({ mode: 'lobby', session: 'lobby' });
    auto.update(actx);
    actx.mode = 'live';
    actx.session = 'countdown';
    advance(actx);
    auto.update(actx);
    expect(auto.rise).toBe(RISE.tiles);
    actx.session = 'playing';
    advance(actx);
    auto.update(actx);
    expect(auto.rise).toBe(RISE.rising);

    const direct = build(render, fakeWorld()).bricks;
    direct.update(makeCtx());
    expect(direct.rise).toBe(RISE.full);
  });

  it('reset empties the mesh, and the next sync rebuilds it from the display arrays', () => {
    const render = fakeRenderState();
    const { bricks } = build(render, fakeWorld());
    const ctx = makeCtx();
    for (let i = 0; i < 30; i++) setCell(render, 50 + i, 1 + (i % 7));
    render.brickVersion++;
    bricks.update(ctx);
    expect(bricks.liveCount).toBe(30);
    bricks.reset();
    expect(bricks.liveCount).toBe(0);
    bricks.update(ctx);
    expect(bricks.liveCount).toBe(30);
  });

  it('a new epoch keeps the instances, so the cells a rejoin removed fade over 200 ms (5.11, D33)', () => {
    const render = fakeRenderState();
    const world = fakeWorld();
    const { bricks } = build(render, world);
    const ctx = makeCtx();
    for (let i = 0; i < 30; i++) setCell(render, 50 + i, 2);
    render.brickVersion++;
    bricks.update(ctx);
    bricks.flashBrick(60, 1);
    const fx = bricks.mesh.geometry.getAttribute('aFx').array as Float32Array;
    expect(fx[bricks.instanceOf(60) * 4]).toBe(ctx.fxTimeS);
    expect(fx[bricks.instanceOf(70) * 4 + 1]).toBe(0);

    bricks.newEpoch();
    expect(bricks.liveCount).toBe(30);
    // The new epoch's first grid (runtime showFirstGrid): five cells were destroyed while away, so they come back
    // empty with brickFade 1, and the new epoch's brickLevel gives cell 70 a higher starting life.
    for (let i = 0; i < 5; i++) setCell(render, 50 + i, 0, 1);
    world.brickLevel[70] = 6;
    render.brickVersion++;
    advance(ctx);
    bricks.update(ctx);
    expect(bricks.liveCount).toBe(30);
    expect(fx[bricks.instanceOf(50) * 4 + 2]).toBeCloseTo(ctx.fxTimeS, 6);   // fading from this frame
    expect(fx[bricks.instanceOf(60) * 4]).toBe(-100);                        // the old epoch's flash ended
    expect(fx[bricks.instanceOf(70) * 4 + 1]).toBeCloseTo(1 - 2 / 6, 5);     // crack weight from the new level
    for (let f = 0; f < 10; f++) {
      advance(ctx);
      bricks.update(ctx);
    }
    expect(bricks.liveCount).toBe(30);   // 183 ms into the fade
    for (let f = 0; f < 3; f++) {
      advance(ctx);
      bricks.update(ctx);
    }
    expect(bricks.liveCount).toBe(25);
    for (let i = 0; i < 5; i++) expect(bricks.instanceOf(50 + i)).toBe(-1);
    for (let i = 5; i < 30; i++) expect(bricks.instanceOf(50 + i)).toBeGreaterThanOrEqual(0);

    // reset() instead would have emptied the mesh, and the five cells could not fade.
    const other = build(render, world).bricks;
    for (let i = 0; i < 30; i++) setCell(render, 50 + i, 2);
    render.brickVersion++;
    other.update(ctx);
    other.reset();
    for (let i = 0; i < 5; i++) setCell(render, 50 + i, 0, 1);
    render.brickVersion++;
    advance(ctx);
    other.update(ctx);
    expect(other.liveCount).toBe(25);
  });
});

describe('paddles, balls and chevrons', () => {
  it('a Grace seat shows the ghost; a leaving paddle keeps its place while it dissolves', () => {
    const render = fakeRenderState();
    const { paddles } = build(render, fakeWorld());
    const ctx = makeCtx();
    const o = 1 * PADDLE_STRIDE;
    render.paddle[o + PO.PRESENT] = 1;
    render.paddle[o + PO.CX] = 10;
    render.paddle[o + PO.CY] = 437;
    render.paddle[o + PO.W] = 150;
    render.paddle[o + PO.H] = 25;
    render.paddle[o + PO.CONN] = SeatConn.Grace;
    paddles.update(ctx);
    const fx = paddles.mesh.geometry.getAttribute('aFx').array as Float32Array;
    expect(fx[1 * 4 + 2]).toBe(1);
    paddles.materialisePaddle(1, 'out');
    render.paddle[o + PO.PRESENT] = 0;
    render.paddle[o + PO.CONN] = SeatConn.Empty;
    advance(ctx);
    paddles.update(ctx);
    expect(matrixOf(paddles.mesh, 1)[12]).toBe(10);
    for (let f = 0; f < 30; f++) {
      advance(ctx);
      paddles.update(ctx);
    }
    expect(matrixOf(paddles.mesh, 1)[0]).toBe(0);
  });

  it('squash springs back through about 1.05 to rest', () => {
    const render = fakeRenderState();
    const { paddles } = build(render, fakeWorld());
    const ctx = makeCtx();
    const o = 3 * PADDLE_STRIDE;
    render.paddle[o + PO.PRESENT] = 1;
    render.paddle[o + PO.W] = 150;
    render.paddle[o + PO.H] = 25;
    paddles.update(ctx);
    paddles.squashPaddle(3, 1);
    let peak = 0;
    let low = Infinity;
    for (let f = 0; f < 60; f++) {
      advance(ctx);
      paddles.update(ctx);
      const thick = matrixOf(paddles.mesh, 3)[5] / 25;
      peak = Math.max(peak, thick);
      low = Math.min(low, thick);
    }
    expect(low).toBeLessThan(0.9);
    expect(peak).toBeGreaterThan(1.02);
    expect(peak).toBeLessThan(1.08);
    expect(matrixOf(paddles.mesh, 3)[5]).toBeCloseTo(25, 3);
  });

  it('a ball cross-fades to its new owner and stretches along its velocity, but not under reduced motion', () => {
    const render = fakeRenderState();
    const world = fakeWorld();
    const { balls } = build(render, world);
    const ctx = makeCtx();
    const o = 0;
    render.ballId[0] = 42;
    render.ballHigh = 1;
    render.ball[o + BO.X] = 100;
    render.ball[o + BO.Y] = -50;
    render.ball[o + BO.VX] = 0;
    render.ball[o + BO.VY] = 12;
    render.ball[o + BO.R] = 8;
    render.ball[o + BO.OWNER] = 0;
    render.ball[o + BO.VIS] = BallVis.Live;
    render.ball[o + BO.PERMANENT] = 1;
    balls.update(ctx);
    const m = matrixOf(balls.mesh, 0);
    expect(Math.hypot(m[0], m[1])).toBeCloseTo(8 * 1.12, 4);   // along v (+y)
    expect(Math.atan2(m[1], m[0])).toBeCloseTo(Math.PI / 2, 5);
    const blue = linear(PLAYER_COLORS[0]);
    expect(balls.colors[2]).toBeCloseTo(blue.b, 5);

    // The owner changes: the colour leaves blue on this frame and is red 0.15 s later, not before.
    render.ball[o + BO.OWNER] = 3;
    const red = linear(PLAYER_COLORS[3]);
    balls.update(ctx);
    expect(balls.colors[0]).toBeCloseTo(blue.r, 6);
    for (let f = 0; f < 4; f++) {
      advance(ctx);
      balls.update(ctx);
    }
    expect(balls.colors[0]).toBeGreaterThan(blue.r + 0.05);
    expect(balls.colors[0]).toBeLessThan(red.r - 0.05);
    advance(ctx, 0.15 - 4 * (FRAME / 1000) - 0.001);
    balls.update(ctx);
    expect(balls.colors[0]).toBeLessThan(red.r);
    advance(ctx, 0.002);
    balls.update(ctx);
    expect(balls.colors[0]).toBeCloseTo(red.r, 6);

    ctx.reducedMotion = true;
    balls.update(ctx);
    expect(Math.hypot(m[0], m[1])).toBeCloseTo(8, 5);
  });

  it('a Dying slot dissolves over 250 ms', () => {
    const render = fakeRenderState();
    const { balls } = build(render, fakeWorld());
    const ctx = makeCtx();
    render.ballId[0] = 7;
    render.ballHigh = 1;
    render.ball[BO.R] = 8;
    render.ball[BO.VIS] = BallVis.Live;
    balls.update(ctx);
    render.ball[BO.VIS] = BallVis.Dying;
    advance(ctx);
    balls.update(ctx);
    expect(balls.alpha[0]).toBe(1);
    for (let f = 0; f < 8; f++) {
      advance(ctx);
      balls.update(ctx);
    }
    expect(balls.alpha[0]).toBeGreaterThan(0);
    expect(balls.alpha[0]).toBeLessThan(0.6);
    for (let f = 0; f < 10; f++) {
      advance(ctx);
      balls.update(ctx);
    }
    expect(balls.alpha[0]).toBe(0);
  });

  it('dissolveBall fades the ball and shrinks it to 35 % of its radius (E24, E33)', () => {
    const render = fakeRenderState();
    const world = fakeWorld();
    world.slotById.set(7, 0);
    const { balls } = build(render, world);
    const ctx = makeCtx();
    render.ballId[0] = 7;
    render.ballHigh = 1;
    render.ball[BO.R] = 8;
    render.ball[BO.VIS] = BallVis.Live;
    render.ball[BO.PERMANENT] = 1;
    balls.update(ctx);
    expect(balls.radius[0]).toBeCloseTo(8, 6);
    expect(balls.alpha[0]).toBe(1);
    balls.dissolveBall(7, 0.25);
    advance(ctx, 0.125);
    balls.update(ctx);
    expect(balls.alpha[0]).toBeCloseTo(0.5, 5);
    expect(balls.radius[0]).toBeCloseTo(8 * (0.35 + 0.65 * 0.5), 4);
    expect(matrixOf(balls.mesh, 0)[10]).toBeCloseTo(balls.radius[0], 5);
    advance(ctx, 0.125);
    balls.update(ctx);
    expect(balls.alpha[0]).toBe(0);
    expect(balls.radius[0]).toBeCloseTo(8 * 0.35, 4);
  });

  it('shows the intent chevrons beside my paddle on the side I steer toward, only while playing', () => {
    const render = fakeRenderState();
    let intent: Visual = 0;
    const { halos } = build(render, fakeWorld(), () => intent);
    const ctx = makeCtx({ myIndex: 0 });
    const o = 0;
    render.paddle[o + PO.PRESENT] = 1;
    render.paddle[o + PO.CX] = 437;
    render.paddle[o + PO.CY] = 0;
    render.paddle[o + PO.W] = 25;
    render.paddle[o + PO.H] = 150;
    const halo = halos.mesh.geometry.getAttribute('aHalo').array as Float32Array;
    const chevron = (MAX_BALLS + 4) * 4;
    halos.update(ctx);
    expect(halo[chevron + 2]).toBe(0);
    // Seat 0 sits on the right wall and its view is rotated 270 degrees, so screen left is board -y (canvas +y,
    // where toWire sends visual left as ArrowRight).
    intent = -1;
    halos.update(ctx);
    expect(halo[chevron + 2]).toBeGreaterThan(0);
    expect(halo[chevron]).toBeCloseTo(437, 5);
    expect(halo[chevron + 1]).toBeLessThan(-75);
    intent = 1;
    halos.update(ctx);
    expect(halo[chevron + 1]).toBeGreaterThan(75);
    ctx.session = 'countdown';
    halos.update(ctx);
    expect(halo[chevron + 2]).toBe(0);
  });
});

describe('materials (6.6)', () => {
  const standard = (): { vertexShader: string; fragmentShader: string; uniforms: Record<string, THREE.IUniform> } => ({
    vertexShader: THREE.ShaderLib.standard.vertexShader,
    fragmentShader: THREE.ShaderLib.standard.fragmentShader,
    uniforms: {},
  });
  const compile = (m: THREE.Material, shader: ReturnType<typeof standard>): void => {
    m.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, {} as THREE.WebGLRenderer);
  };

  it('every patched material applies cleanly to three r176 and keeps a fixed program key', () => {
    const shared = createSharedUniforms();
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const materials: [THREE.MeshStandardMaterial, string][] = [
      [createBrickMaterial(shared).material, 'brick'], [createWallMaterial(shared, 900).material, 'wall'],
      [createPaddleMaterial(shared), 'paddle'], [createBallMaterial(shared), 'ball'],
    ];
    for (const [m, name] of materials) {
      const shader = standard();
      compile(m, shader);
      expect(m.customProgramCacheKey()).toBe(`pongo:${name}`);
      expect(shader.uniforms.uTime).toBe(shared.uTime);
      expect(shader.uniforms.uDim).toBe(shared.uDim);
      expect(shader.vertexShader).not.toBe(THREE.ShaderLib.standard.vertexShader);
      expect(shader.fragmentShader).toContain('totalEmissiveRadiance +=');
    }
    for (const [m] of materials.filter(([mm]) => mm.alphaHash)) expect(m.alphaHash).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('injects after (or before) its anchors', () => {
    const { material, uniforms } = createBrickMaterial(createSharedUniforms());
    const shader = standard();
    compile(material, shader);
    const vs = shader.vertexShader;
    const fs = shader.fragmentShader;
    expect(vs.indexOf('transformed.z *= pongoZf')).toBeGreaterThan(vs.indexOf(ANCHORS.begin));
    expect(vs.indexOf('float pongoRise(')).toBeGreaterThan(vs.indexOf(ANCHORS.common));
    expect(vs.indexOf('float pongoRise(')).toBeLessThan(vs.indexOf('void main()'));
    expect(fs.indexOf('pongoBevel')).toBeGreaterThan(fs.indexOf(ANCHORS.color));
    expect(fs.indexOf('clamp((uTime - vBrickFx.z) / 0.2')).toBeLessThan(fs.indexOf(ANCHORS.alphaHash));
    expect(fs.indexOf('pongoFlash *=')).toBeGreaterThan(fs.indexOf(ANCHORS.emissive));
    expect(shader.uniforms.uRise).toBe(uniforms.uRise);
  });

  it('warns in DEV and skips the part whose anchor is missing', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const { material } = createBrickMaterial(createSharedUniforms());
    const shader = standard();
    shader.fragmentShader = shader.fragmentShader.replace(ANCHORS.alphaHash, '');
    compile(material, shader);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('alphahash_fragment');
    expect(shader.fragmentShader).not.toContain('clamp((uTime - vBrickFx.z) / 0.2');
    warn.mockRestore();
    const patch: StandardPatch = { name: 'x', uniforms: {}, fragmentColor: 'x', vertexBegin: 'y' };
    expect(missingAnchors('', '', patch)).toEqual([`vertex ${ANCHORS.begin}`, `fragment ${ANCHORS.color}`]);
  });
});

function heapUsed(): number {
  const proc = (globalThis as { process?: { memoryUsage(): { heapUsed: number } } }).process;
  if (proc === undefined) throw new Error('process.memoryUsage is not available');
  return proc.memoryUsage().heapUsed;
}

describe('per-frame allocation (G4)', () => {
  it('in steady play the six systems and the camera rig allocate nothing per frame', () => {
    expect(typeof (globalThis as { gc?: unknown }).gc).toBe('function');
    const render = fakeRenderState();
    const world = fakeWorld();
    const stage = build(render, world, () => 1);
    const rig = new CameraRig(new THREE.PerspectiveCamera(), TUNING.camera);
    rig.setBoard(stage.board, world);
    const ctx = makeCtx({ myIndex: 3 });
    for (let i = 0; i < 60; i++) setCell(render, 100 + i, 1 + (i % 7));
    render.brickVersion++;
    for (let seat = 0; seat < 4; seat++) {
      const o = seat * PADDLE_STRIDE;
      render.paddle[o + PO.PRESENT] = 1;
      render.paddle[o + PO.W] = seat % 2 === 0 ? 25 : 150;
      render.paddle[o + PO.H] = seat % 2 === 0 ? 150 : 25;
      render.paddle[o + PO.CONN] = seat === 2 ? SeatConn.Grace : SeatConn.Connected;
    }
    render.ballHigh = 8;
    for (let slot = 0; slot < 8; slot++) {
      const o = slot * BALL_STRIDE;
      render.ballId[slot] = 100 + slot;
      render.ball[o + BO.R] = 8 + slot;
      render.ball[o + BO.OWNER] = (slot % 5) - 1;
      render.ball[o + BO.VIS] = BallVis.Live;
      render.ball[o + BO.VY] = 6;
    }
    const parts: { name: string; update: () => void }[] = [
      ...stage.all.map((s) => ({ name: s.name, update: () => s.update(ctx) })),
      { name: 'rig', update: () => rig.update(ctx, 1280, 720) },
    ];
    let enabled = parts.map(() => true);
    let damage = true;
    const frames = (n: number): void => {
      for (let f = 0; f < n; f++) {
        advance(ctx);
        for (let slot = 0; slot < 8; slot++) {
          const o = slot * BALL_STRIDE;
          render.ball[o + BO.X] = ((f * 3 + slot * 50) % 800) - 400;
          render.ball[o + BO.Y] = ((f * 2 + slot * 70) % 800) - 400;
          render.ball[o + BO.VX] = (f % 7) - 3;
        }
        if (damage && f % 97 === 0) {
          // Warm-up only: damage releases run the spring and dirty-range paths, which are event-driven.
          render.brickLife[120] = render.brickLife[120] > 1 ? render.brickLife[120] - 1 : 7;
          render.brickVersion++;
        }
        for (let p = 0; p < parts.length; p++) if (enabled[p]) parts[p].update();
        // Stand in for the renderer, which clears pending ranges after each upload.
        stage.bricks.mesh.instanceMatrix.clearUpdateRanges();
      }
    };
    // Measured windows of 3 000 frames with no collection inside, so even one boxed number per frame (16 B, so
    // 48 000 B per window) fails the 12 KB limit, while the cost of reading the heap and JIT noise stay under it. A
    // per-frame allocation shows in every window, so the best of three is judged: a one-off spike from the JIT
    // recompiling after the parts change (its code objects live on the same heap) is not an allocation of the
    // frame path.
    const WINDOW = 3000;
    const LIMIT = 12 * 1024;
    const measure = (): number => {
      forceGc();
      const before = heapUsed();
      frames(WINDOW);
      return heapUsed() - before;
    };
    frames(20_000);
    damage = false;
    frames(20_000);   // the last spring settles and the code settles on the steady path
    for (let i = 0; i < parts.length; i++) {
      enabled = parts.map((_, j) => j === i);
      frames(20_000);
      const best = Math.min(measure(), measure(), measure());
      expect(best, `${parts[i].name} allocates ${best} B per ${WINDOW} frames`).toBeLessThan(LIMIT);
    }
    enabled = parts.map(() => true);
    frames(20_000);
    const h0 = heapUsed();
    const best = Math.min(measure(), measure(), measure());
    expect(best, `all parts together allocate ${best} B per ${WINDOW} frames`).toBeLessThan(LIMIT);
    forceGc();
    expect(heapUsed() - h0).toBeLessThan(64 * 1024);
  });
});
