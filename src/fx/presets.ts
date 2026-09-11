// One recipe per event kind (6.1). A preset turns a released, non-stale event into FxHost calls (EntityFx, CameraFx,
// PostFx, hitStop), pool spawns and pops, following the catalogue's priorities, confidence rules and reduced-motion
// column. STALE holds the state-only handling of stale events: end states applied at once, nothing presented.
//
// Positions in events are canvas px (4.5); host.toBoard converts them to board-local space, where the FX pools live.
// Board units equal canvas px, with +y up and +z up. Ball centres sit at z = radius, bricks are life x LIFE_H tall.
// Presets reuse the director's scratch specs (kit.spark, kit.ring, ...), so an event allocates little beyond the
// strings of its pops.

import * as THREE from 'three';
import type { FrameCtx, FxHost } from '../render/contracts';
import type { EventOf, GameEventKind, Owner, Wall } from '../game/events';
import { SeatConn } from '../game/events';
import { BALL_STRIDE, BO, BallVis } from '../game/types';
import { BALL_R0, BRICK_SIZE, CELL, LIFE_H } from '../config/constants';
import { COLORS, HDR, PLAYER_COLORS } from '../config/palette';
import { T } from '../config/tuning';
import { boardToView, isSeat, wallNormal } from '../game/orientation';
import type { FxBudget, Priority } from './budget';
import type { InstancedPool } from './pools/gpuPool';
import type { SparkBurst, SparkPool } from './pools/sparks';
import { resetSparkBurst } from './pools/sparks';
import type { ShardBurst, ShardPool } from './pools/shards';
import { resetShardBurst } from './pools/shards';
import type { RingPool, RingSpec } from './pools/rings';
import { resetRingSpec } from './pools/rings';
import type { DecalPool, DecalSpec } from './pools/decals';
import { DecalKind, resetDecalSpec } from './pools/decals';
import type { TrailSystem } from './trails';
import type { ShellSystem } from './shells';
import type { PopLayer } from './pops';

/** Mutable director state that presets read and write. */
export interface FxRuntimeState {
  countdownActive: boolean;                                         // E41: the rise wave already ran for this countdown
  youT0: number; youSeat: number; youNext: number;                  // E43 YOU pulse along my wall
  lastBrickHitStopT: number;                                        // the last E29/E45 hit-stop, so they stop once
}

export function createRuntimeState(): FxRuntimeState {
  return {
    countdownActive: false,
    youT0: -1e9 - 0.5, youSeat: -1, youNext: 0,
    lastBrickHitStopT: -1e9 - 0.5,
  };
}

/** What a preset may use: the host, the budget, the pools, and the director's scratch objects. */
export interface FxKit {
  readonly host: FxHost;
  readonly budget: FxBudget;
  readonly sparks: SparkPool;
  readonly shards: ShardPool;
  readonly rings: RingPool;
  readonly decals: DecalPool;
  readonly trails: TrailSystem;
  readonly shells: ShellSystem;
  readonly pops: PopLayer;
  readonly spark: SparkBurst;
  readonly shard: ShardBurst;
  readonly ring: RingSpec;
  readonly decal: DecalSpec;
  readonly v: THREE.Vector3;
  readonly c: THREE.Color;
  readonly fx: FxRuntimeState;
  /** The budget's grant for `pool`; counts a P2 request that got nothing in stats.droppedP2. */
  grant(requested: number, p: Priority, pool: InstancedPool): number;
  /** An n-ms vibration on touch devices only. */
  vibrate(ms: number): void;
}

export type Preset<K extends GameEventKind> = (kit: FxKit, e: EventOf<K>, ctx: FrameCtx) => void;
export type PresetTable = { readonly [K in GameEventKind]: Preset<K> };
export type StaleTable = { readonly [K in GameEventKind]?: Preset<K> };

/** Reduced motion caps flashes at 50 % (6.3). The wall, paddle and brick shaders halve their own flashes under
 *  uReduced (P5), so those strengths pass through whole; the cap applies to post flashes, vignettes and bloom boosts. */
const RM_FLASH = 0.5;
const BALL_Z = 8;
const FLOOR_Z = 0.6;
const WAVE_S = 1.0;          // E41: the rise wave runs over 1.0 s
const RISE_LOWER_S = 0.4;    // E42
const COUNT_PULSE_S = 0.9;
const YOU_S = 2;             // E43: the YOU pulse runs for 2 s
const YOU_STEP_S = 0.2;
const CONE_PADDLE = (35 * Math.PI) / 180;
export const GOAL_MINUS_KEY = 100;   // + wall: the "-N" pop at the conceding wall
export const GOAL_PLUS_KEY = 200;    // + wall: the "+N" pop at the ball
export const POWER_LABEL = { split: 'SPLIT', phase: 'PHASE', boost: 'BOOST', mass: 'GROW' } as const;
const MINUS = '−';

// Linear colours: seats 0..3, then unowned, phase violet, gold, white, dust.
const RGB = new Float32Array(9 * 3);
export const RgbIndex = { Unowned: 4, Phase: 5, Gold: 6, White: 7, Dust: 8 } as const;
{
  const hex = [...PLAYER_COLORS, COLORS.unownedBall, COLORS.phase, COLORS.gold, '#ffffff', '#8a8178'];
  const c = new THREE.Color();
  for (let i = 0; i < hex.length; i++) {
    c.set(hex[i]);
    RGB[i * 3] = c.r;
    RGB[i * 3 + 1] = c.g;
    RGB[i * 3 + 2] = c.b;
  }
}

const dir = { x: 0.5, y: 0.5 };
const view = { x: 0.5, y: 0.5 };

function ownerIndex(owner: number): number {
  return owner >= 0 && owner <= 3 ? owner : RgbIndex.Unowned;
}

function rgbOf(s: { r: number; g: number; b: number }, index: number): void {
  s.r = RGB[index * 3];
  s.g = RGB[index * 3 + 1];
  s.b = RGB[index * 3 + 2];
}

function colorOf(s: { r: number; g: number; b: number }, c: THREE.Color): void {
  s.r = c.r;
  s.g = c.g;
  s.b = c.b;
}

function flashCap(ctx: FrameCtx, s: number): number {
  return ctx.reducedMotion && s > RM_FLASH ? RM_FLASH : s;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Canvas px to board-local, into kit.v. */
function at(kit: FxKit, x: number, y: number, z: number): THREE.Vector3 {
  return kit.host.toBoard(x, y, z, kit.v);
}

/** The ball's offset into RenderState.ball, or -1 when its slot is unknown or free. */
function ballOffset(kit: FxKit, ballId: number): number {
  if (ballId < 0) return -1;
  const slot = kit.host.slotOf(ballId);
  return slot >= 0 && kit.host.render.ballId[slot] === ballId ? slot * BALL_STRIDE : -1;
}

/** The colour index of a ball's current owner in RenderState (phasing wins), or `fallback`. */
function ballColor(kit: FxKit, ballId: number, fallback: number): number {
  const o = ballOffset(kit, ballId);
  if (o < 0) return fallback;
  const b = kit.host.render.ball;
  return b[o + BO.PHASING] > 0.5 ? RgbIndex.Phase : ownerIndex(b[o + BO.OWNER] | 0);
}

function cellX(kit: FxKit, cell: number): number {
  const w = kit.host.world;
  return (cell % w.gridSize) * w.cellSize + w.cellSize / 2;
}

function cellY(kit: FxKit, cell: number): number {
  const w = kit.host.world;
  return Math.floor(cell / w.gridSize) * w.cellSize + w.cellSize / 2;
}

function brickSize(kit: FxKit): number {
  return (BRICK_SIZE * kit.host.world.cellSize) / CELL;
}

/** The point on `wall` at `u` (0..1 along it, from the canvas origin), canvas px, into `dir`. */
function wallPoint(kit: FxKit, wall: Wall, u: number): void {
  const c = kit.host.world.canvas;
  if (wall === 0 || wall === 2) {
    dir.x = wall === 0 ? c : 0;
    dir.y = u * c;
  } else {
    dir.x = u * c;
    dir.y = wall === 1 ? 0 : c;
  }
}

function ring(kit: FxKit, ctx: FrameCtx, x: number, y: number, r0: number, r1: number, dur: number, width: number, color: number, hdr: number, p: Priority): void {
  const s = resetRingSpec(kit.ring, ctx.fxTimeS);
  const v = at(kit, x, y, FLOOR_Z);
  s.x = v.x;
  s.y = v.y;
  s.z = v.z;
  s.r0 = r0;
  s.r1 = r1;
  s.dur = dur;
  s.width = width;
  rgbOf(s, color);
  s.hdr = hdr;
  kit.rings.ring(s, kit.grant(1, p, kit.rings.pool));
}

/** Sparks of a phasing ball zipping through a brick (E34). */
function phasingZip(kit: FxKit, ballId: number, x: number, y: number, z: number, ctx: FrameCtx): void {
  const o = ballOffset(kit, ballId);
  const b = kit.host.render.ball;
  if (o < 0 || b[o + BO.PHASING] <= 0.5) return;
  const s = resetSparkBurst(kit.spark, ctx.fxTimeS);
  const v = at(kit, x, y, z);
  s.x = v.x;
  s.y = v.y;
  s.z = v.z;
  s.dx = b[o + BO.VX];
  s.dy = b[o + BO.VY];
  s.dz = 0.1;
  s.spread = 0.45;
  s.speedMin = 300;
  s.speedMax = 520;
  s.lifeMin = 0.15;
  s.lifeMax = 0.25;
  s.drag = 8;
  s.gravity = 0;
  s.stretch = ctx.reducedMotion ? 0 : 0.05;
  rgbOf(s, RgbIndex.Phase);
  kit.sparks.burst(kit.grant(ctx.reducedMotion ? 3 : 6, 1, kit.sparks.pool), s);
}

function countdownPulse(kit: FxKit, ctx: FrameCtx): void {
  const c = kit.host.world.canvas / 2;
  ring(kit, ctx, c, c, 30, 300, 0.8, 8, RgbIndex.White, 1.4, 0);
  kit.host.entities.wallBreathe(COUNT_PULSE_S);
}

/** Runs the director's scheduled effect: the E43 YOU pulse along my wall, which stands still at the wall's middle
 *  under reduced motion (the wall shader caps its strength at 50 %). (E41's per-second pulse needs no schedule: the
 *  server sends one countdown message per second.) */
export function runSchedules(kit: FxKit, ctx: FrameCtx): void {
  const f = kit.fx;
  const t = ctx.fxTimeS;
  if (f.youSeat >= 0) {
    const steps = YOU_S / YOU_STEP_S;
    while (f.youNext < steps && t >= f.youT0 + f.youNext * YOU_STEP_S) {
      const k = f.youNext % 5;
      const u = ctx.reducedMotion ? 0.5 : 0.1 + 0.2 * k;
      kit.host.entities.flashWall(f.youSeat as Wall, u, 0.7, 'bounce');
      f.youNext++;
    }
    if (f.youNext >= steps) f.youSeat = -1;
  }
}

export const PRESETS: PresetTable = {
  // E20: flash (P0); squash, ring and sparks (P1). Mine at speed >= 11: trauma and a short vibration.
  paddleHit(kit, e, ctx) {
    const h = kit.host;
    const inten = kit.budget.intensity(e.conf);
    h.entities.flashPaddle(e.seat, e.u, inten);   // the paddle shader halves it under reduced motion
    h.entities.pulseBall(e.ball, inten);
    h.entities.squashPaddle(e.seat, clamp01((e.speed - 3) / 9) * inten);
    if (ctx.myIndex === e.seat && e.speed >= 11 && !ctx.reducedMotion) {
      h.camera.addTrauma(0.12);
      kit.vibrate(8);
    }
    if (!kit.budget.particles(e.conf)) return;
    ring(kit, ctx, e.x, e.y, 0, 40, 0.25, 3, e.seat, HDR.ring * inten, 1);
    let count = Math.round(12 + 12 * clamp01((e.speed - 5) / 7));
    if (ctx.reducedMotion) count = Math.ceil(count / 2);
    const s = resetSparkBurst(kit.spark, ctx.fxTimeS);
    const o = ballOffset(kit, e.ball);
    wallNormal(e.seat, dir);   // outward
    let vx = o >= 0 ? h.render.ball[o + BO.VX] : 0;
    let vy = o >= 0 ? h.render.ball[o + BO.VY] : 0;
    if (vx !== 0 || vy !== 0) {
      // The frame loop releases events before it samples (2.5), so RenderState still carries the incoming,
      // pre-bounce velocity: reflect it about the paddle's wall so the sparks leave the paddle.
      const d = vx * dir.x + vy * dir.y;
      if (d > 0) {
        vx -= 2 * d * dir.x;
        vy -= 2 * d * dir.y;
      }
      s.dx = vx;
      s.dy = vy;
    } else {
      s.dx = -dir.x;
      s.dy = -dir.y;
    }
    const v = at(kit, e.x, e.y, 6);
    s.x = v.x;
    s.y = v.y;
    s.z = v.z;
    s.dz = 0.2;
    s.spread = CONE_PADDLE;
    s.speedMin = 180;
    s.speedMax = 420;
    s.lifeMin = 0.25;
    s.lifeMax = 0.45;
    s.drag = 6;
    s.stretch = ctx.reducedMotion ? 0 : 0.03;
    rgbOf(s, e.seat);
    s.hdr = HDR.spark * inten;
    kit.sparks.burst(kit.grant(count, 1, kit.sparks.pool), s);
  },

  // E21: a ring in the new colour (the ball's colour fade and the trail sweep are continuous). Gained by me: a double
  // bright ring; lost by me: a desaturated ring in my colour.
  ownerChanged(kit, e, ctx) {
    if (!kit.budget.particles(e.conf)) return;
    const to = ownerIndex(e.to);
    const me = ctx.myIndex;
    const gained = me !== null && e.to === me && e.from !== me;
    const lost = me !== null && e.from === me && e.to !== me;
    const hdr = e.to < 0 ? 1 : HDR.ring * (gained ? 1.4 : 1);
    ring(kit, ctx, e.x, e.y, 6, 30, 0.3, 2.5, to, hdr, 0);
    if (gained) {
      const s = resetRingSpec(kit.ring, ctx.fxTimeS + 0.08);
      const v = at(kit, e.x, e.y, FLOOR_Z);
      s.x = v.x;
      s.y = v.y;
      s.z = v.z;
      s.r0 = 8;
      s.r1 = 46;
      s.dur = 0.35;
      rgbOf(s, to);
      s.hdr = HDR.ring * 1.4;
      kit.rings.ring(s, kit.grant(1, 0, kit.rings.pool));
    } else if (lost && me !== null) {
      const s = resetRingSpec(kit.ring, ctx.fxTimeS);
      const v = at(kit, e.x, e.y, FLOOR_Z);
      s.x = v.x;
      s.y = v.y;
      s.z = v.z;
      s.r0 = 10;
      s.r1 = 26;
      s.dur = 0.35;
      const grey = RGB[RgbIndex.Unowned * 3];
      s.r = RGB[me * 3] * 0.35 + grey * 0.65;
      s.g = RGB[me * 3 + 1] * 0.35 + grey * 0.65;
      s.b = RGB[me * 3 + 2] * 0.35 + grey * 0.65;
      s.hdr = 1;
      kit.rings.ring(s, kit.grant(1, 0, kit.rings.pool));
    }
  },

  // E22: a glow on the wall around u (violet shimmer while phasing), 4 sparks (2 reduced), ball pop.
  wallBounce(kit, e, ctx) {
    const h = kit.host;
    const inten = kit.budget.intensity(e.conf);
    h.entities.flashWall(e.wall, e.u, inten, e.phasing ? 'phase' : 'bounce');
    h.entities.pulseBall(e.ball, 0.6 * inten);
    if (!kit.budget.particles(e.conf)) return;
    const s = resetSparkBurst(kit.spark, ctx.fxTimeS);
    wallPoint(kit, e.wall, e.u);
    const v = at(kit, dir.x, dir.y, BALL_Z);
    s.x = v.x;
    s.y = v.y;
    s.z = v.z;
    wallNormal(e.wall, dir);
    s.dx = -dir.x;
    s.dy = -dir.y;
    s.dz = 0.3;
    s.spread = Math.PI / 3;
    s.speedMin = 100;
    s.speedMax = 220;
    s.lifeMin = 0.2;
    s.lifeMax = 0.35;
    s.size = 2;
    s.stretch = ctx.reducedMotion ? 0 : 0.025;
    rgbOf(s, e.phasing ? RgbIndex.Phase : ballColor(kit, e.ball, RgbIndex.White));
    kit.sparks.burst(kit.grant(ctx.reducedMotion ? 2 : 4, 0, kit.sparks.pool), s);
  },

  // E23: the conceder's wall floods; floor ripple and ring; "-1" at the wall and "+1" at the ball; an impulse toward
  // the wall. Conceded by me: trauma, aberration, red vignette, hit-stop (D07). Scored by me: a gold flash. A repeat
  // (C47) only renumbers the existing pops.
  goal(kit, e, ctx) {
    const h = kit.host;
    if (e.repeat > 0) {
      const n = e.repeat + 1;
      kit.pops.update(GOAL_MINUS_KEY + e.wall, `${MINUS}${n}`);
      kit.pops.update(GOAL_PLUS_KEY + e.wall, `+${n}`);
      return;
    }
    const inten = kit.budget.intensity(e.conf);
    const rm = ctx.reducedMotion;
    h.entities.flashWall(e.wall, e.u, inten, 'goal');
    h.entities.ripple(e.x, e.y, inten);
    wallPoint(kit, e.wall, e.u);
    kit.pops.show(`${MINUS}1`, dir.x, dir.y, 24, PLAYER_COLORS[e.wall], 1.1, 1, GOAL_MINUS_KEY + e.wall);
    if (isSeat(e.scorer)) kit.pops.show('+1', e.x, e.y, 12, PLAYER_COLORS[e.scorer], 1.1, 1, GOAL_PLUS_KEY + e.wall);
    if (!rm) {
      wallNormal(e.wall, dir);
      boardToView(ctx.myIndex, dir.x, dir.y, view);
      h.camera.impulse(view.x, view.y, 0.25);
    }
    const me = ctx.myIndex;
    if (me !== null && e.wall === me) {
      if (!rm) {
        h.camera.addTrauma(0.35);
        h.post.aberration(0.005, 0.22);
        h.hitStop(T.hitStop.goalConcededMs, 'goalConceded');
      }
      h.post.vignettePulse(COLORS.danger, flashCap(ctx, 0.6), 0.3);
    } else if (me !== null && e.scorer === me) {
      h.post.flash(COLORS.gold, flashCap(ctx, 0.35), 0.15);
    }
    if (kit.budget.particles(e.conf)) ring(kit, ctx, e.x, e.y, 0, 90, 0.5, 6, e.wall, HDR.ring * inten, 0);
  },

  // E24: the ball flattens into the grey wall; an inward ring; 14 sparks drawn in (7 reduced); a wall ripple.
  absorbed(kit, e, ctx) {
    const h = kit.host;
    const inten = kit.budget.intensity(e.conf);
    const color = ballColor(kit, e.ball, RgbIndex.Unowned);
    h.entities.dissolveBall(e.ball, 0.15);
    h.entities.flashWall(e.wall, e.u, 0.6 * inten, 'absorb');
    if (!kit.budget.particles(e.conf)) return;
    ring(kit, ctx, e.x, e.y, 30, 2, 0.25, 3, color, HDR.ring * inten, 1);
    const s = resetSparkBurst(kit.spark, ctx.fxTimeS);
    const v = at(kit, e.x, e.y, BALL_Z);
    s.x = v.x;
    s.y = v.y;
    s.z = v.z;
    s.converge = 30;
    s.lifeMin = 0.25;
    s.lifeMax = 0.25;
    s.size = 2;
    s.stretch = ctx.reducedMotion ? 0 : 0.02;
    rgbOf(s, color);
    s.hdr = HDR.spark * inten;
    kit.sparks.burst(kit.grant(ctx.reducedMotion ? 7 : 14, 1, kit.sparks.pool), s);
  },

  // E25 (P2): ball pop and 3 dust sparks; dropped under reduced motion.
  brickBounce(kit, e, ctx) {
    if (ctx.reducedMotion) return;
    kit.host.entities.pulseBall(e.ball, 0.4);
    if (!kit.budget.particles(e.conf)) return;
    const s = resetSparkBurst(kit.spark, ctx.fxTimeS);
    const v = at(kit, e.x, e.y, 4);
    s.x = v.x;
    s.y = v.y;
    s.z = v.z;
    s.dz = 1;
    s.spread = 1.2;
    s.speedMin = 30;
    s.speedMax = 80;
    s.lifeMin = 0.3;
    s.lifeMax = 0.5;
    s.gravity = 150;
    s.drag = 3;
    s.stretch = 0;
    rgbOf(s, RgbIndex.Dust);
    s.hdr = 1;
    kit.sparks.burst(kit.grant(3, 2, kit.sparks.pool), s);
  },

  // E26: white flash (P0; the crack and the spring down one layer are the bricks system's, on release); the top
  // layer as one slab shard and 6-10 chips from the impact side (P1, 25 % reduced); 8 sparks.
  brickDamaged(kit, e, ctx) {
    const h = kit.host;
    const inten = kit.budget.intensity(e.conf);
    const cx = cellX(kit, e.cell);
    const cy = cellY(kit, e.cell);
    const top = e.from * LIFE_H;
    h.entities.flashBrick(e.cell, inten);   // the brick shader halves it under reduced motion
    if (!kit.budget.particles(e.conf)) return;
    phasingZip(kit, e.ball, cx, cy, top, ctx);
    const bs = brickSize(kit);
    h.brickColor(e.from, kit.c);
    // the impact side faces the ball (canvas y down, board y up)
    let ix = e.x - cx;
    let iy = cy - e.y;
    const il = Math.sqrt(ix * ix + iy * iy);
    if (il > 1e-6) {
      ix /= il;
      iy /= il;
    } else {
      ix = 0;
      iy = 0;
    }
    const rm = ctx.reducedMotion;
    const c = at(kit, cx, cy, 0);
    const bx = c.x;
    const by = c.y;
    const sl = resetShardBurst(kit.shard, ctx.fxTimeS);
    sl.x = bx;
    sl.y = by;
    sl.z = top - LIFE_H / 2;
    sl.dx = ix;
    sl.dy = iy;
    sl.spread = 0.5;
    sl.speedMin = 20;
    sl.speedMax = 50;
    sl.vzMin = 90;
    sl.vzMax = 130;
    sl.gravity = 420;
    sl.drag = 0.5;
    sl.spinMin = 3;
    sl.spinMax = 6;
    sl.lifeMin = 0.5;
    sl.lifeMax = 0.5;
    sl.sx = bs;
    sl.sy = bs;
    sl.sz = LIFE_H / 0.35;
    colorOf(sl, kit.c);
    kit.shards.burst(kit.grant(1, 1, kit.shards.pool), sl);
    let chips = 6 + Math.round((4 * (e.from - 1)) / 6);
    if (rm) chips = Math.ceil(chips * 0.25);
    const ch = resetShardBurst(kit.shard, ctx.fxTimeS);
    ch.x = bx + ix * bs * 0.5;
    ch.y = by + iy * bs * 0.5;
    ch.z = top;
    ch.dx = ix;
    ch.dy = iy;
    ch.spread = ix === 0 && iy === 0 ? Math.PI : Math.PI / 3;
    ch.speedMin = 60;
    ch.speedMax = 160;
    ch.vzMin = 60;
    ch.vzMax = 160;
    ch.sizeMin = 3;
    ch.sizeMax = 6;
    ch.lifeMin = 0.6;
    ch.lifeMax = 0.8;
    ch.jitter = bs * 0.2;
    colorOf(ch, kit.c);
    kit.shards.burst(kit.grant(chips, 1, kit.shards.pool), ch);
    const s = resetSparkBurst(kit.spark, ctx.fxTimeS);
    s.x = bx + ix * bs * 0.5;
    s.y = by + iy * bs * 0.5;
    s.z = top;
    s.dx = ix;
    s.dy = iy;
    s.dz = 0.6;
    s.spread = 0.9;
    s.speedMin = 120;
    s.speedMax = 260;
    s.lifeMin = 0.2;
    s.lifeMax = 0.35;
    s.stretch = rm ? 0 : 0.025;
    s.r = 0.4 + 0.6 * kit.c.r;
    s.g = 0.4 + 0.6 * kit.c.g;
    s.b = 0.4 + 0.6 * kit.c.b;
    s.hdr = HDR.spark * inten;
    kit.sparks.burst(kit.grant(8, 1, kit.sparks.pool), s);
  },

  // E27 shatter (P0 core: 8 shards, the ring, the ripple and the pop), E28 chain, E29 last brick. The destruction is
  // certain (a grid diff) and P5 removes the cell at once, relying on this shatter; conf only rates who gets the
  // credit, so the core always shows and conf gates the P1/P2 layers.
  brickDestroyed(kit, e, ctx) {
    const h = kit.host;
    const f = kit.fx;
    const inten = kit.budget.intensity(e.conf);
    const rm = ctx.reducedMotion;
    const cx = cellX(kit, e.cell);
    const cy = cellY(kit, e.cell);
    const top = e.from * LIFE_H;
    h.entities.ripple(cx, cy, 0.8 * inten);
    const bs = brickSize(kit);
    h.brickColor(e.from, kit.c);
    const c = at(kit, cx, cy, 0);
    const bx = c.x;
    const by = c.y;
    const count = 16 + Math.round((8 * (e.from - 1)) / 6);
    const sh = resetShardBurst(kit.shard, ctx.fxTimeS);
    sh.x = bx;
    sh.y = by;
    sh.z = top * 0.5;
    sh.jitter = bs * 0.3;
    sh.sizeMin = (5 * bs) / BRICK_SIZE;
    sh.sizeMax = (11 * bs) / BRICK_SIZE;
    colorOf(sh, kit.c);
    kit.shards.burst(kit.grant(rm ? Math.ceil(count * 0.25) : 8, 0, kit.shards.pool), sh);
    const chainBoost = e.chain >= 3 ? 1 + 0.25 * (e.chain - 2) : 1;
    const rs = resetRingSpec(kit.ring, ctx.fxTimeS);
    rs.x = bx;
    rs.y = by;
    rs.z = FLOOR_Z;
    rs.r0 = 10;
    rs.r1 = 60;
    rs.dur = 0.45;
    rs.width = 5;
    colorOf(rs, kit.c);
    rs.hdr = HDR.ring * inten * chainBoost;
    kit.rings.ring(rs, kit.grant(1, 0, kit.rings.pool));
    if (kit.budget.particles(e.conf)) {
      phasingZip(kit, e.ball, cx, cy, top, ctx);
      if (!rm) kit.shards.burst(kit.grant(count - 8, 1, kit.shards.pool), sh);
      const s = resetSparkBurst(kit.spark, ctx.fxTimeS);
      s.x = bx;
      s.y = by;
      s.z = top;
      s.speedMin = 150;
      s.speedMax = 320;
      s.lifeMin = 0.15;
      s.lifeMax = 0.3;
      s.drag = 6;
      s.stretch = rm ? 0 : 0.03;
      s.r = 0.5 + 0.5 * kit.c.r;
      s.g = 0.5 + 0.5 * kit.c.g;
      s.b = 0.5 + 0.5 * kit.c.b;
      s.hdr = HDR.spark * inten;
      kit.sparks.burst(kit.grant(12, 1, kit.sparks.pool), s);
      const d = resetSparkBurst(kit.spark, ctx.fxTimeS);
      d.x = bx;
      d.y = by;
      d.z = 3;
      d.dz = 1;
      d.spread = 1.3;
      d.speedMin = 20;
      d.speedMax = 60;
      d.lifeMin = 0.5;
      d.lifeMax = 0.8;
      d.size = 3.5;
      d.gravity = 60;
      d.drag = 2;
      d.stretch = 0;
      d.jitter = bs * 0.3;
      rgbOf(d, RgbIndex.Dust);
      d.hdr = 0.9;
      kit.sparks.burst(kit.grant(10, 1, kit.sparks.pool), d);
      const dc = resetDecalSpec(kit.decal, ctx.fxTimeS);
      dc.x = bx;
      dc.y = by;
      dc.size = bs * 0.55;
      dc.r = 0.35 + 0.65 * kit.c.r;
      dc.g = 0.3 + 0.4 * kit.c.g;
      dc.b = 0.15 + 0.3 * kit.c.b;
      kit.decals.decal(dc, kit.grant(1, 2, kit.decals.pool));
    }
    if (e.points !== null && e.points > 0) {
      const color = isSeat(e.scorer) ? PLAYER_COLORS[e.scorer] : COLORS.unownedBall;
      kit.pops.show(`+${e.points}`, cx, cy, top + 8, color, 0.9 + 0.1 * Math.min(e.points, 8), 0.8);
    }
    if (e.chain >= 3) kit.pops.show(`×${e.chain}`, cx, cy - 28, top + 30, COLORS.gold, 1.2, 0.9);
    if (ctx.myIndex !== null && e.scorer === ctx.myIndex && !rm) h.camera.addTrauma(0.1);
    if (e.last) {
      // gameOver is IMMEDIATE and usually released before the final grid's last brick, and E45 already gave the
      // hit-stop: one stop either way.
      if (!rm && ctx.fxTimeS - f.lastBrickHitStopT > 1) {
        h.hitStop(T.hitStop.lastBrickMs, 'lastBrick');
        f.lastBrickHitStopT = ctx.fxTimeS;
      }
      h.post.bloomBoost(flashCap(ctx, 0.4), 0.3);
    }
  },

  // E30: the spawn pop and a ring (P0); a power-up's light beam from the cell, a join's converging particles (P1).
  ballSpawned(kit, e, ctx) {
    if (e.cause === 'snapshot') return;
    const h = kit.host;
    h.entities.spawnBall(e.ball);
    if (!kit.budget.particles(e.conf)) return;
    const color = ownerIndex(e.owner);
    ring(kit, ctx, e.x, e.y, 4, 36, 0.3, 3, color, e.owner >= 0 ? HDR.ring : 1, 0);
    const s = resetSparkBurst(kit.spark, ctx.fxTimeS);
    rgbOf(s, color);
    if (e.cause === 'powerUp') {
      // The runtime releases a power-up spawn before the brickDestroyed that caused it (same tick, lower seq), so
      // the brick cannot supply the origin. The server places the ball within a quarter cell of the broken brick's
      // centre (R8, game_actor_physics.go), so the beam starts at the centre of the cell holding the spawn point.
      const cs = h.world.cellSize;
      if (!(cs > 0)) return;
      const a = at(kit, Math.floor(e.x / cs) * cs + cs / 2, Math.floor(e.y / cs) * cs + cs / 2, 8);
      const ax = a.x;
      const ay = a.y;
      const b = at(kit, e.x, e.y, 8);
      const dx = b.x - ax;
      const dy = b.y - ay;
      const dist = Math.sqrt(dx * dx + dy * dy);
      s.x = ax;
      s.y = ay;
      s.z = 8;
      s.dx = dist > 1e-6 ? dx : 0;
      s.dy = dist > 1e-6 ? dy : 0;
      s.dz = dist > 1e-6 ? 0 : 1;
      s.spread = 0.001;
      s.speedMin = dist / 0.2 + 1;
      s.speedMax = s.speedMin;
      s.lifeMin = 0.2;
      s.lifeMax = 0.2;
      s.drag = 0;
      s.gravity = 0;
      s.size = 4;
      s.stretch = ctx.reducedMotion ? 0 : 0.15;
      kit.sparks.burst(kit.grant(1, 1, kit.sparks.pool), s);
    } else if (!ctx.reducedMotion) {
      const b = at(kit, e.x, e.y, BALL_Z);
      s.x = b.x;
      s.y = b.y;
      s.z = b.z;
      s.converge = 60;
      s.lifeMin = 0.4;
      s.lifeMax = 0.4;
      s.stretch = 0.02;
      kit.sparks.burst(kit.grant(24, 1, kit.sparks.pool), s);
    }
  },

  // E24 covers an absorbed ball; E33: an expired or released ball dissolves with 8-16 sparks (8 reduced) and a ring.
  ballRemoved(kit, e, ctx) {
    if (e.cause === 'absorbed') return;
    const h = kit.host;
    h.entities.dissolveBall(e.ball, 0.25);
    if (!kit.budget.particles(e.conf)) return;
    const o = ballOffset(kit, e.ball);
    const r = o >= 0 ? h.render.ball[o + BO.R] : BALL_R0;
    const color = ownerIndex(e.owner);
    const count = ctx.reducedMotion ? 8 : Math.min(16, Math.max(8, 8 + Math.round((r - BALL_R0) / 2)));
    const s = resetSparkBurst(kit.spark, ctx.fxTimeS);
    const v = at(kit, e.x, e.y, r);
    s.x = v.x;
    s.y = v.y;
    s.z = v.z;
    s.speedMin = 60;
    s.speedMax = 160;
    s.lifeMin = 0.3;
    s.lifeMax = 0.5;
    s.stretch = ctx.reducedMotion ? 0 : 0.02;
    rgbOf(s, color);
    kit.sparks.burst(kit.grant(count, 0, kit.sparks.pool), s);
    ring(kit, ctx, e.x, e.y, 4, 22, 0.25, 2.5, color, e.owner >= 0 ? HDR.ring : 1, 0);
  },

  // E34 is continuous: the shells system reads the phasing flag and phaseStartTick.
  phaseStart() {},

  // E34 end: the shell collapses over 0.25 s with a ring pop.
  phaseEnd(kit, e, ctx) {
    kit.shells.collapse(e.ball, ctx.fxTimeS);
    ring(kit, ctx, e.x, e.y, 8, 34, 0.25, 3, RgbIndex.Phase, HDR.ring, 0);
  },

  // E31 (conf >= 0.7): a gold ring, 24 gold sparks (12 reduced) and a callout.
  powerUp(kit, e, ctx) {
    if (!kit.budget.allow(e.conf)) return;
    ring(kit, ctx, e.x, e.y, 8, 60, 0.4, 5, RgbIndex.Gold, HDR.ring, 1);
    const s = resetSparkBurst(kit.spark, ctx.fxTimeS);
    const v = at(kit, e.x, e.y, BALL_Z);
    s.x = v.x;
    s.y = v.y;
    s.z = v.z;
    s.dz = 1;
    s.spread = 1.4;
    s.speedMin = 100;
    s.speedMax = 260;
    s.lifeMin = 0.35;
    s.lifeMax = 0.6;
    s.stretch = ctx.reducedMotion ? 0 : 0.025;
    rgbOf(s, RgbIndex.Gold);
    kit.sparks.burst(kit.grant(ctx.reducedMotion ? 12 : 24, 1, kit.sparks.pool), s);
    kit.pops.show(POWER_LABEL[e.kind], e.x, e.y, 34, COLORS.gold, 1.15, 0.9);
  },

  // E35: the radius springs to its new value (the balls system; no overshoot under reduced motion) and a low ring.
  ballResized(kit, e, ctx) {
    kit.host.entities.resizeBall(e.ball, e.to);
    if (!kit.budget.particles(e.conf)) return;
    ring(kit, ctx, e.x, e.y, e.to, e.to * 3, 0.35, 3, ballColor(kit, e.ball, RgbIndex.Unowned), 1.2, 1);
  },

  // E50 is the scoreboard's (P6, from the seats slice).
  score() {},

  // E37 join: the paddle materialises; P5 makes 'in' instant under reduced motion, and the call is always needed, since
  // a paddle left in 'out' by an earlier removal stays transparent. E38 drop: the ghost and the wall pulse are
  // continuous paddle state (P5), the grace ring is P6. E39: a return solidifies the ghost; a removal dissolves the
  // paddle into 20 sparks (none under reduced motion) while the wall fades to graphite.
  seat(kit, e, ctx) {
    const ent = kit.host.entities;
    if (e.from === SeatConn.Empty && e.to === SeatConn.Connected) {
      ent.materialisePaddle(e.seat, 'in');
    } else if (e.from === SeatConn.Grace && e.to === SeatConn.Connected) {
      ent.materialisePaddle(e.seat, 'solidify');
    } else if (e.to === SeatConn.Empty && e.from !== SeatConn.Empty) {
      ent.materialisePaddle(e.seat, 'out');
      if (ctx.reducedMotion) return;
      const s = resetSparkBurst(kit.spark, ctx.fxTimeS);
      const v = at(kit, e.x, e.y, 9);
      s.x = v.x;
      s.y = v.y;
      s.z = v.z;
      s.dz = 1;
      s.spread = 1.4;
      s.speedMin = 40;
      s.speedMax = 120;
      s.lifeMin = 0.4;
      s.lifeMax = 0.7;
      s.gravity = 120;
      s.jitter = 60;
      s.stretch = 0.02;
      rgbOf(s, e.seat);
      kit.sparks.burst(kit.grant(20, 0, kit.sparks.pool), s);
    }
  },

  boardReady() {},

  // E41: the server sends "3", "2" and "1" a second apart. The first message starts the rise wave (once per countdown:
  // a second call would restart it from tile height); every message is one second's floor ring and wall breath, and
  // re-anchors the dim ramp to 100 % on the seconds left.
  countdown(kit, e, ctx) {
    const ent = kit.host.entities;
    const f = kit.fx;
    if (!f.countdownActive) ent.brickRise('wave', WAVE_S);
    f.countdownActive = true;
    ent.setDim(1, e.seconds > 0 ? e.seconds : 0);
    countdownPulse(kit, ctx);
  },

  // E42: the bricks lower back to tiles and the dim returns to 35 % (both instant under reduced motion).
  countdownCancelled(kit, _e, ctx) {
    const s = ctx.reducedMotion ? 0 : RISE_LOWER_S;
    kit.host.entities.brickRise('lower', s);
    kit.host.entities.setDim(0.35, s);
    kit.fx.countdownActive = false;
  },

  // E43: bloom boost, a centre ripple and ring, aberration and a camera kick (not reduced), "GO!", and a YOU pulse
  // along my wall for 2 s (a static flash at the wall's middle under reduced motion).
  go(kit, _e, ctx) {
    const h = kit.host;
    const f = kit.fx;
    f.countdownActive = false;
    const c = h.world.canvas / 2;
    h.post.bloomBoost(flashCap(ctx, 0.6), 0.1);
    h.entities.ripple(c, c, 1);
    ring(kit, ctx, c, c, 10, 320, 0.6, 10, RgbIndex.White, HDR.ring, 0);
    if (!ctx.reducedMotion) {
      h.post.aberration(0.004, 0.2);
      h.camera.kick(0.03);
    }
    kit.pops.show('GO!', c, c, 40, COLORS.gold, 2.4, 0.9);
    const me = ctx.myIndex;
    if (me !== null) {
      wallPoint(kit, me, 0.5);
      kit.pops.show('YOU', dir.x, dir.y, 30, PLAYER_COLORS[me], 1.2, YOU_S);
      f.youSeat = me;
      f.youT0 = ctx.fxTimeS;
      f.youNext = 0;
      runSchedules(kit, ctx);
    }
  },

  // E45: the E29 hit-stop first (unless the last brick just gave it), balls fade over 0.6 s, the winner sweep, and
  // confetti from the winner's wall (P2, tier-scaled) or, under reduced motion, a static winner glow.
  gameOver(kit, e, ctx) {
    const h = kit.host;
    const f = kit.fx;
    const rm = ctx.reducedMotion;
    f.countdownActive = false;
    f.youSeat = -1;
    if (!rm && ctx.fxTimeS - f.lastBrickHitStopT > 1) {
      h.hitStop(T.hitStop.lastBrickMs, 'lastBrick');
      f.lastBrickHitStopT = ctx.fxTimeS;
    }
    const r = h.render;
    for (let slot = 0; slot < r.ballHigh; slot++) {
      const id = r.ballId[slot];
      if (id >= 0 && r.ball[slot * BALL_STRIDE + BO.VIS] === BallVis.Live) h.entities.dissolveBall(id, 0.6);
    }
    h.entities.winnerSweep(e.winner, 0.6);
    const canvas = h.world.canvas;
    const color = e.winner >= 0 ? e.winner : RgbIndex.Gold;
    if (rm) {
      winnerGlow(kit, ctx, e.winner, color, canvas);
      return;
    }
    const s = resetShardBurst(kit.shard, ctx.fxTimeS);
    rgbOf(s, color);
    s.z = 20;
    s.speedMin = 80;
    s.speedMax = 260;
    s.vzMin = 200;
    s.vzMax = 420;
    s.gravity = 260;
    s.drag = 1.2;
    s.spinMin = 6;
    s.spinMax = 16;
    s.lifeMin = 2.2;
    s.lifeMax = 3;
    s.sizeMin = 5;
    s.sizeMax = 9;
    s.thick = 0.15;
    const winner = e.winner;
    if (isSeat(winner)) {
      wallPoint(kit, winner, 0.5);
      const v = at(kit, dir.x, dir.y, 20);
      s.x = v.x;
      s.y = v.y;
      wallNormal(winner, dir);
      s.dx = -dir.x;
      s.dy = -dir.y;
      s.spread = 0.6;
      s.spanX = dir.y !== 0 ? canvas * 0.45 : 0;
      s.spanY = dir.x !== 0 ? canvas * 0.45 : 0;
    } else {
      const v = at(kit, canvas / 2, canvas / 2, 20);
      s.x = v.x;
      s.y = v.y;
      s.jitter = canvas * 0.1;
    }
    kit.shards.burst(kit.grant(120, 2, kit.shards.pool), s);
  },
};

/** The reduced-motion replacement for the confetti: soft glows along the winner's wall (the centre on a tie). */
function winnerGlow(kit: FxKit, ctx: FrameCtx, winner: Owner, color: number, canvas: number): void {
  const d = resetDecalSpec(kit.decal, ctx.fxTimeS);
  d.kind = DecalKind.Glow;
  d.dur = T.render.endEffectsMs / 1000;
  d.z = 0.4;
  d.strength = 0.6;
  rgbOf(d, color);
  if (!isSeat(winner)) {
    const v = at(kit, canvas / 2, canvas / 2, 0.4);
    d.x = v.x;
    d.y = v.y;
    d.size = canvas * 0.2;
    kit.decals.decal(d, kit.grant(1, 0, kit.decals.pool));
    return;
  }
  wallNormal(winner, view);
  d.size = canvas * 0.1;
  for (let k = 0; k < 5; k++) {
    wallPoint(kit, winner, 0.1 + 0.2 * k);
    const v = at(kit, dir.x, dir.y, 0.4);
    d.x = v.x - view.x * 50;
    d.y = v.y - view.y * 50;
    kit.decals.decal(d, kit.grant(1, 0, kit.decals.pool));
  }
}

/** Stale events (D21, D34): state only. Flow events apply their end state at once, so a hidden tab comes back to
 *  risen or lowered bricks and the right dim; nothing spawns and nothing is presented. */
export const STALE: StaleTable = {
  // The bricks are up: a live "1" after a hidden-tab "3" must not run the wave again.
  countdown(kit) {
    kit.host.entities.brickRise('instant', 0);
    kit.host.entities.setDim(1, 0);
    kit.fx.countdownActive = true;
  },
  countdownCancelled(kit) {
    kit.host.entities.brickRise('lower', 0);
    kit.host.entities.setDim(0.35, 0);
    kit.fx.countdownActive = false;
  },
  go(kit) {
    kit.fx.countdownActive = false;
  },
  // The ended board, as the live path leaves it: every live ball gone and the winner's sweep in place.
  gameOver(kit, e) {
    const h = kit.host;
    kit.fx.countdownActive = false;
    kit.fx.youSeat = -1;
    const r = h.render;
    for (let slot = 0; slot < r.ballHigh; slot++) {
      const id = r.ballId[slot];
      if (id >= 0 && r.ball[slot * BALL_STRIDE + BO.VIS] === BallVis.Live) h.entities.dissolveBall(id, 0);
    }
    h.entities.winnerSweep(e.winner, 0);
  },
  // A seat that ends Connected is fully visible at once: 'solidify' with no ghost has no scanline. Without it a
  // paddle left in 'out' by an earlier removal would stay transparent. A removal needs nothing: P5 hides an absent
  // paddle unless it is still dissolving.
  seat(kit, e) {
    if (e.to === SeatConn.Connected) kit.host.entities.materialisePaddle(e.seat, 'solidify');
  },
  phaseEnd(kit, e) {
    kit.shells.cancel(e.ball);
  },
};
