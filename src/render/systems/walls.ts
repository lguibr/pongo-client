// E02 walls system: InstancedMesh(4). Vertical walls (seats 0 and 2) span the corners; horizontal ones stop at
// them, so no two top faces overlap. Colour follows the seat's connection state from RenderState; the lobby's
// ready glow reads World.seats[i].ready.

import * as THREE from 'three';
import type { FrameCtx, FrameSystem } from '../contracts';
import type { Owner, Wall } from '../../game/events';
import { SeatConn } from '../../game/events';
import { PADDLE_STRIDE, PO } from '../../game/types';
import { WALL_H, WALL_T } from '../../config/constants';
import { COLORS, PLAYER_COLORS } from '../../config/palette';
import { createWallMaterial, WALL_KIND } from '../materials/wall';
import type { WallUniforms } from '../materials/wall';
import { TRS, instanceAttribute, instanceColors, linearRGB, markAll, unitBox, writeTRS } from '../materials/patch';
import type { SystemDeps } from '../materials/patch';

const SEAT_RGB = new Float32Array(12);
for (let i = 0; i < 4; i++) linearRGB(PLAYER_COLORS[i], SEAT_RGB, i * 3);
const GRAPHITE_RGB = new Float32Array(3);
linearRGB(COLORS.wallEmpty, GRAPHITE_RGB, 0);
const SEAT_COLORS = PLAYER_COLORS.map((c) => new THREE.Color(c));

export class WallsSystem implements FrameSystem {
  readonly name = 'walls';
  readonly mesh: THREE.InstancedMesh;
  readonly uniforms: WallUniforms;
  private readonly deps: SystemDeps;
  private readonly geometry: THREE.BoxGeometry;
  private readonly material: THREE.MeshStandardMaterial;
  private readonly fx: THREE.InstancedBufferAttribute;
  private readonly seat: THREE.InstancedBufferAttribute;
  private readonly color: THREE.InstancedBufferAttribute;
  private readonly conn = new Int8Array(4).fill(-1);
  private extent = -1;
  private time = 0;
  private fxDirty = false;

  constructor(deps: SystemDeps) {
    this.deps = deps;
    const { material, uniforms } = createWallMaterial(deps.shared, deps.world.canvas);
    this.material = material;
    this.uniforms = uniforms;
    this.geometry = unitBox();
    this.fx = instanceAttribute(this.geometry, 'aFx', 4, 4);
    this.seat = instanceAttribute(this.geometry, 'aSeat', 4, 4);
    this.mesh = new THREE.InstancedMesh(this.geometry, material, 4);
    this.mesh.name = 'walls';
    this.mesh.frustumCulled = false;
    this.color = instanceColors(this.mesh, 4);
    for (let i = 0; i < 4; i++) {
      this.fx.array[i * 4] = -100;
      this.seat.array[i * 4 + 3] = i;
    }
    this.layout();
    deps.board.add(this.mesh);
  }

  update(ctx: FrameCtx): void {
    this.time = ctx.fxTimeS;
    const w = this.deps.world;
    if (w.canvas !== this.extent) this.layout();
    const p = this.deps.render.paddle;
    const seatArr = this.seat.array as Float32Array;
    const colorArr = this.color.array as Float32Array;
    let seatDirty = false;
    let colorDirty = false;
    for (let i = 0; i < 4; i++) {
      const conn = p[i * PADDLE_STRIDE + PO.CONN];
      if (conn !== this.conn[i]) {
        this.conn[i] = conn;
        const src = conn === SeatConn.Empty ? GRAPHITE_RGB : SEAT_RGB;
        const so = conn === SeatConn.Empty ? 0 : i * 3;
        colorArr[i * 3] = src[so];
        colorArr[i * 3 + 1] = src[so + 1];
        colorArr[i * 3 + 2] = src[so + 2];
        colorDirty = true;
      }
      const grace = conn === SeatConn.Grace ? 1 : 0;
      const ready = ctx.mode === 'lobby' && conn === SeatConn.Connected && w.seats[i].ready ? 1 : 0;
      const mine = ctx.myIndex === i ? 1 : 0;
      const o = i * 4;
      if (seatArr[o] !== grace || seatArr[o + 1] !== ready || seatArr[o + 2] !== mine) {
        seatArr[o] = grace;
        seatArr[o + 1] = ready;
        seatArr[o + 2] = mine;
        seatDirty = true;
      }
    }
    if (colorDirty) markAll(this.color);
    if (seatDirty) markAll(this.seat);
    if (this.fxDirty) {
      markAll(this.fx);
      this.fxDirty = false;
    }
  }

  flashWall(wall: Wall, u: number, strength: number, kind: 'bounce' | 'goal' | 'absorb' | 'phase'): void {
    const a = this.fx.array as Float32Array;
    const o = wall * 4;
    a[o] = this.time;
    a[o + 1] = u;
    a[o + 2] = strength;
    a[o + 3] = WALL_KIND[kind];
    this.fxDirty = true;
  }

  wallBreathe(seconds: number): void {
    this.uniforms.uBreathe.value.set(this.time, Math.max(0.05, seconds));
  }

  winnerSweep(winner: Owner, seconds: number): void {
    const v = this.uniforms.uWinner.value;
    if (winner < 0) {
      v.set(1, 1, 1, this.time);
    } else {
      const c = SEAT_COLORS[winner];
      v.set(c.r, c.g, c.b, this.time);
    }
    this.uniforms.uWinnerDur.value = Math.max(0.05, seconds);
  }

  /** The base colour of a wall, linear rgb (tests). */
  colorOf(wall: Wall, out: THREE.Color): THREE.Color {
    const a = this.color.array as Float32Array;
    return out.setRGB(a[wall * 3], a[wall * 3 + 1], a[wall * 3 + 2]);
  }

  reset(): void {
    this.conn.fill(-1);
    const a = this.fx.array as Float32Array;
    for (let i = 0; i < 4; i++) a[i * 4 + 2] = 0;
    this.fxDirty = true;
    this.uniforms.uWinner.value.w = -1;
    this.uniforms.uBreathe.value.set(-10, 1);
  }

  markNeedsUpdate(): void {
    markAll(this.mesh.instanceMatrix);
    markAll(this.color);
    markAll(this.seat);
    markAll(this.fx);
  }

  dispose(): void {
    this.deps.board.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
    this.mesh.dispose();
  }

  private layout(): void {
    const canvas = this.deps.world.canvas;
    const half = canvas / 2;
    const m = this.mesh.instanceMatrix.array as Float32Array;
    const span = canvas + 2 * WALL_T;
    const off = half + WALL_T / 2;
    for (let i = 0; i < 4; i++) {
      const vertical = i === 0 || i === 2;
      TRS[0] = vertical ? WALL_T : canvas;
      TRS[1] = vertical ? span : WALL_T;
      TRS[2] = WALL_H;
      TRS[3] = i === 0 ? off : i === 2 ? -off : 0;
      TRS[4] = i === 1 ? off : i === 3 ? -off : 0;
      TRS[5] = 0;
      TRS[6] = 0;
      writeTRS(m, i * 16);
    }
    markAll(this.mesh.instanceMatrix);
    this.uniforms.uCanvas.value = canvas;
    this.extent = canvas;
  }
}
