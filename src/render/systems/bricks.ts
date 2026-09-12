// E03 bricks as one instanced mesh (5.11, C19, C22, C63, C67). The system reads only the display-time copies
// render.brickLife, render.brickType and render.brickFade (D32), plus World.brickLevel for the crack weight and the
// World's canvas, gridSize and cellSize for layout (risk 11). It rebuilds when render.brickVersion changes.
//
// Live cells are packed into the first `count` instances; a removed cell swaps with the last live instance, so
// `count` is the number of bricks on screen. Each cell's height follows a spring (omega 18, zeta 0.55) toward
// life x LIFE_H, and only the dirty instance range is uploaded.
//
// An epoch change on a retained stage (a rejoin, D33) calls newEpoch(), not reset(): the instances stay, and the
// next sync diffs them against the new epoch's first grid, so a cell that vanished during the rejoin fades out
// over 200 ms (brickFade 1, 5.4.3) instead of disappearing. reset() empties the mesh.

import * as THREE from 'three';
import type { FrameCtx, FrameSystem, StageMode } from '../contracts';
import { BRICK_MAX_LIFE, BRICK_SIZE, CELL, CELLS, CellType, LIFE_H } from '../../config/constants';
import { lifeColor } from '../../config/palette';
import { createBrickMaterial, RISE } from '../materials/brick';
import type { BrickUniforms } from '../materials/brick';
import { TRS, instanceAttribute, instanceColors, linearRGB, markAll, markRange, unitBox, writeTRS } from '../materials/patch';
import type { SystemDeps, UploadRange } from '../materials/patch';

const FADE_S = 0.2;            // silent removal (5.11)
const TILE_H = 1.5;            // lobby tile height (5.11)
const SPRING_W = 18;           // 5.11
const SPRING_Z = 0.55;
const WAVE_S = 1.0;            // E41: the radial rise takes 1.0 s
const REDUCED_RISE_S = 0.3;    // 6.3: a 0.3 s ease instead of the wave
const NO_HIT = -100;

const LIFE_RGB = new Float32Array((BRICK_MAX_LIFE + 1) * 3);
for (let l = 1; l <= BRICK_MAX_LIFE; l++) linearRGB(lifeColor(l), LIFE_RGB, l * 3);

type RiseMode = (typeof RISE)[keyof typeof RISE];

export class BricksSystem implements FrameSystem {
  readonly name = 'bricks';
  readonly mesh: THREE.InstancedMesh;
  readonly uniforms: BrickUniforms;
  private readonly deps: SystemDeps;
  private readonly geometry: THREE.BoxGeometry;
  private readonly material: THREE.MeshStandardMaterial;
  private readonly matrix: Float32Array;
  private readonly colors: Float32Array;
  private readonly fx: Float32Array;
  private readonly colorAttr: THREE.InstancedBufferAttribute;
  private readonly fxAttr: THREE.InstancedBufferAttribute;
  private readonly rm: UploadRange = { start: 0, count: 0 };
  private readonly rc: UploadRange = { start: 0, count: 0 };
  private readonly rf: UploadRange = { start: 0, count: 0 };
  private readonly instOf = new Int16Array(CELLS).fill(-1);
  private readonly cellOf = new Int16Array(CELLS);
  private readonly life = new Uint8Array(CELLS);       // life shown per cell (the spring's target / LIFE_H)
  private readonly level = new Uint8Array(CELLS);      // life at the start of the epoch (crack weight)
  private readonly height = new Float32Array(CELLS);   // spring position, board units
  private readonly velocity = new Float32Array(CELLS);
  private readonly moving = new Uint8Array(CELLS);
  private readonly fadeEnd = new Float32Array(CELLS).fill(-1);   // presentation time a fading cell goes; -1 = none
  private count = 0;
  private version = -1;
  private time = 0;
  private frameDt = 0;
  private reduced = false;
  private dirtyLo = CELLS;
  private dirtyHi = -1;
  private full = true;
  private epochPending = false;   // the next sync refreshes the crack weight of every kept cell
  private riseMode: RiseMode = RISE.full;
  private riseInit = false;
  private lastMode: StageMode | '' = '';
  private layoutCanvas = -1;
  private layoutGrid = -1;

  constructor(deps: SystemDeps) {
    this.deps = deps;
    const { material, uniforms } = createBrickMaterial(deps.shared);
    this.material = material;
    this.uniforms = uniforms;
    this.geometry = unitBox();
    this.fxAttr = instanceAttribute(this.geometry, 'aFx', CELLS, 4);
    this.fx = this.fxAttr.array as Float32Array;
    this.mesh = new THREE.InstancedMesh(this.geometry, material, CELLS);
    this.mesh.name = 'bricks';
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.matrix = this.mesh.instanceMatrix.array as Float32Array;
    this.colorAttr = instanceColors(this.mesh, CELLS);
    this.colors = this.colorAttr.array as Float32Array;
    for (let k = 0; k < CELLS; k++) {
      this.fx[k * 4] = NO_HIT;
      this.fx[k * 4 + 2] = -1;
    }
    this.mesh.count = 0;
    deps.board.add(this.mesh);
  }

  /** Bricks on screen (instances drawn). */
  get liveCount(): number {
    return this.count;
  }

  /** The instance showing `cell`, or -1. */
  instanceOf(cell: number): number {
    return this.instOf[cell];
  }

  /** 0 tiles, 1 rising, 2 lowering, 3 full (materials/brick RISE). */
  get rise(): RiseMode {
    return this.riseMode;
  }

  update(ctx: FrameCtx): void {
    this.time = ctx.fxTimeS;
    this.frameDt = ctx.fxDtS;
    this.reduced = ctx.reducedMotion;
    this.updateRise(ctx);
    const w = this.deps.world;
    if (w.canvas !== this.layoutCanvas || w.gridSize !== this.layoutGrid) this.relayout();
    if (this.deps.render.brickVersion !== this.version) this.sync();
    if (this.count > 0) {
      this.stepFades();
      this.stepSprings();
    }
    this.flush();
  }

  flashBrick(cell: number, strength: number): void {
    const k = cell >= 0 && cell < CELLS ? this.instOf[cell] : -1;
    if (k < 0) return;
    this.fx[k * 4] = this.time;
    this.fx[k * 4 + 3] = strength;
    this.dirty(k);
  }

  brickRise(mode: 'wave' | 'instant' | 'lower', seconds: number): void {
    const t = this.time;
    if (mode === 'instant') this.setRise(RISE.full, t, 1, 0);
    else if (mode === 'wave') {
      if (this.reduced) this.setRise(RISE.rising, t, REDUCED_RISE_S, 0);
      else this.setRise(RISE.rising, t, Math.max(0.05, seconds * 0.5), seconds * 0.5);
    } else if (this.reduced || seconds <= 0) this.setRise(RISE.tiles, t, 1, 0);
    else this.setRise(RISE.lowering, t, seconds, 0);
  }

  /** Empties the mesh (a new room or a disposed stage). */
  reset(): void {
    this.count = 0;
    this.mesh.count = 0;
    this.instOf.fill(-1);
    this.life.fill(0);
    this.level.fill(0);
    this.moving.fill(0);
    this.fadeEnd.fill(-1);
    this.version = -1;
    this.full = true;
    this.epochPending = false;
    this.riseInit = false;
    this.lastMode = '';
  }

  /** A new epoch on the same stage (D33): the instances, heights and fades stay; hit flashes end. The next sync
   *  compares the kept instances with the display arrays, so the first grid's silent removals fade (5.11), and it
   *  takes the crack weight from the new epoch's brickLevel. */
  newEpoch(): void {
    for (let k = 0; k < this.count; k++) {
      this.fx[k * 4] = NO_HIT;
      this.fx[k * 4 + 3] = 0;
    }
    this.version = -1;
    this.epochPending = true;
    this.full = true;
    this.riseInit = false;
    this.lastMode = '';
  }

  markNeedsUpdate(): void {
    this.full = true;
  }

  dispose(): void {
    this.deps.board.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
    this.mesh.dispose();
  }

  // ---- rise ----

  private setRise(mode: RiseMode, t0: number, dur: number, spread: number): void {
    this.uniforms.uRise.value.set(t0, dur, mode, TILE_H);
    this.uniforms.uRiseSpread.value = spread;
    this.riseMode = mode;
  }

  /** Lobby tiles until brickRise('wave') (E40, E41). Entering the lobby flattens risen bricks at once, unless a
   *  lowering is already running (E42). When play starts with the bricks still flat, they rise on their own. */
  private updateRise(ctx: FrameCtx): void {
    if (!this.riseInit) {
      this.riseInit = true;
      this.setRise(ctx.mode === 'lobby' ? RISE.tiles : RISE.full, this.time, 1, 0);
    } else if (ctx.mode === 'lobby' && this.lastMode !== 'lobby' && (this.riseMode === RISE.full || this.riseMode === RISE.rising)) {
      this.setRise(RISE.tiles, this.time, 1, 0);
    }
    const flat = this.riseMode === RISE.tiles || this.riseMode === RISE.lowering;
    if (flat && ctx.mode !== 'lobby' && (ctx.session === 'playing' || ctx.session === 'finished')) this.brickRise('wave', WAVE_S);
    this.lastMode = ctx.mode;
  }

  // ---- cells ----

  private relayout(): void {
    const w = this.deps.world;
    this.layoutCanvas = w.canvas;
    this.layoutGrid = w.gridSize;
    const cs = w.cellSize;
    this.uniforms.uRiseReach.value = Math.SQRT2 * Math.max(1, w.canvas / 2 - cs / 2);
    for (let k = 0; k < this.count; k++) this.writeMatrix(k, this.cellOf[k]);
    if (this.count > 0) this.full = true;
  }

  private sync(): void {
    const r = this.deps.render;
    const side = this.deps.world.gridSize;
    const n = Math.min(side * side, CELLS);
    const epoch = this.epochPending;
    this.epochPending = false;
    const levels = this.deps.world.brickLevel;
    for (let i = 0; i < CELLS; i++) {
      const alive = i < n && r.brickType[i] === CellType.Brick && r.brickLife[i] > 0;
      const k = this.instOf[i];
      if (alive) {
        const life = r.brickLife[i];
        if (k < 0) {
          this.add(i, life);
          continue;
        }
        if (this.fadeEnd[i] >= 0) {
          this.fadeEnd[i] = -1;
          this.fx[k * 4 + 2] = -1;
          this.dirty(k);
        }
        if (epoch) this.level[i] = life > levels[i] ? life : levels[i];
        if (life !== this.life[i]) this.setLife(i, k, life);
        else if (epoch) {
          this.fx[k * 4 + 1] = this.crack(i);
          this.dirty(k);
        }
      } else if (k >= 0 && this.fadeEnd[i] < 0) {
        if (r.brickFade[i] === 1) {
          this.fadeEnd[i] = this.time + FADE_S;
          this.fx[k * 4 + 2] = this.time;
          this.dirty(k);
        } else {
          this.remove(i);   // the FX shatter covers it (E27)
        }
      }
    }
    this.version = r.brickVersion;
  }

  private add(i: number, life: number): void {
    const k = this.count++;
    this.instOf[i] = k;
    this.cellOf[k] = i;
    this.life[i] = life;
    this.level[i] = Math.max(life, this.deps.world.brickLevel[i]);
    this.height[i] = life * LIFE_H;
    this.velocity[i] = 0;
    this.moving[i] = 0;
    this.fadeEnd[i] = -1;
    const f = k * 4;
    this.fx[f] = NO_HIT;
    this.fx[f + 1] = this.crack(i);
    this.fx[f + 2] = -1;
    this.fx[f + 3] = 0;
    this.writeColor(k, life);
    this.writeMatrix(k, i);
    this.mesh.count = this.count;
    this.dirty(k);
  }

  private setLife(i: number, k: number, life: number): void {
    this.life[i] = life;
    if (life > this.level[i]) this.level[i] = life;
    this.moving[i] = 1;
    this.fx[k * 4 + 1] = this.crack(i);
    this.writeColor(k, life);
    this.dirty(k);
  }

  private remove(i: number): void {
    const k = this.instOf[i];
    const last = this.count - 1;
    if (k !== last) {
      const m = this.matrix;
      for (let e = 0; e < 16; e++) m[k * 16 + e] = m[last * 16 + e];
      const c = this.colors;
      c[k * 3] = c[last * 3];
      c[k * 3 + 1] = c[last * 3 + 1];
      c[k * 3 + 2] = c[last * 3 + 2];
      const f = this.fx;
      f[k * 4] = f[last * 4];
      f[k * 4 + 1] = f[last * 4 + 1];
      f[k * 4 + 2] = f[last * 4 + 2];
      f[k * 4 + 3] = f[last * 4 + 3];
      const moved = this.cellOf[last];
      this.cellOf[k] = moved;
      this.instOf[moved] = k;
      this.dirty(k);
    }
    this.instOf[i] = -1;
    this.fadeEnd[i] = -1;
    this.moving[i] = 0;
    this.life[i] = 0;
    this.count = last;
    this.mesh.count = last;
  }

  private stepFades(): void {
    for (let k = this.count - 1; k >= 0; k--) {
      const i = this.cellOf[k];
      if (this.fadeEnd[i] >= 0 && this.time >= this.fadeEnd[i]) this.remove(i);
    }
  }

  /** Advances every moving spring by this frame's presentation dt (read from a field: no double crosses the call). */
  private stepSprings(): void {
    const dtS = this.frameDt;
    if (dtS <= 0) return;   // hit-stop holds the springs
    const h = dtS > 1 / 30 ? 1 / 30 : dtS;
    const steps = h > 1 / 120 ? 2 : 1;
    const sdt = h / steps;
    const zeta = this.reduced ? 1 : SPRING_Z;
    const damping = 2 * zeta * SPRING_W;
    const stiffness = SPRING_W * SPRING_W;
    for (let k = 0; k < this.count; k++) {
      const i = this.cellOf[k];
      if (this.moving[i] === 0) continue;
      const target = this.life[i] * LIFE_H;
      let x = this.height[i];
      let v = this.velocity[i];
      for (let s = 0; s < steps; s++) {
        v += (-damping * v - stiffness * (x - target)) * sdt;
        x += v * sdt;
      }
      if (Math.abs(x - target) < 0.02 && Math.abs(v) < 0.05) {
        x = target;
        v = 0;
        this.moving[i] = 0;
      }
      this.height[i] = x;
      this.velocity[i] = v;
      this.writeMatrix(k, i);
      this.dirty(k);
    }
  }

  private crack(i: number): number {
    const level = this.level[i];
    return level > 0 ? Math.min(1, Math.max(0, 1 - this.life[i] / level)) : 0;
  }

  private writeColor(k: number, life: number): void {
    const l = life > BRICK_MAX_LIFE ? BRICK_MAX_LIFE : life < 1 ? 1 : life;
    this.colors[k * 3] = LIFE_RGB[l * 3];
    this.colors[k * 3 + 1] = LIFE_RGB[l * 3 + 1];
    this.colors[k * 3 + 2] = LIFE_RGB[l * 3 + 2];
  }

  private writeMatrix(k: number, i: number): void {
    const w = this.deps.world;
    const side = w.gridSize;
    const cs = w.cellSize;
    const half = w.canvas / 2;
    const bs = (BRICK_SIZE * cs) / CELL;
    const h = this.height[i];
    TRS[0] = bs;
    TRS[1] = bs;
    TRS[2] = h > 0.01 ? h : 0.01;
    TRS[3] = (i % side) * cs + cs / 2 - half;
    TRS[4] = half - (((i / side) | 0) * cs + cs / 2);
    TRS[5] = 0;
    TRS[6] = 0;
    writeTRS(this.matrix, k * 16);
  }

  private dirty(k: number): void {
    if (k < this.dirtyLo) this.dirtyLo = k;
    if (k > this.dirtyHi) this.dirtyHi = k;
  }

  private flush(): void {
    if (this.full) {
      markAll(this.mesh.instanceMatrix);
      markAll(this.colorAttr);
      markAll(this.fxAttr);
      this.full = false;
    } else if (this.dirtyHi >= this.dirtyLo) {
      const lo = this.dirtyLo;
      const n = this.dirtyHi - lo + 1;
      markRange(this.mesh.instanceMatrix, this.rm, lo * 16, n * 16);
      markRange(this.colorAttr, this.rc, lo * 3, n * 3);
      markRange(this.fxAttr, this.rf, lo * 4, n * 4);
    }
    this.dirtyLo = CELLS;
    this.dirtyHi = -1;
  }
}
