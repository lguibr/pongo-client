// E04 paddles system: InstancedMesh(4) of the unit box, placed from RenderState centres plus the own-paddle lead
// (added to PO.CX for seats 1 and 3 and to PO.CY for seats 0 and 2, as the game runtime documents). A Grace seat
// shows the ghost; a paddle that left keeps its last place while its dissolve runs.

import * as THREE from 'three';
import type { FrameCtx, FrameSystem } from '../contracts';
import type { Seat } from '../../game/events';
import { SeatConn } from '../../game/events';
import { PADDLE_STRIDE, PO } from '../../game/types';
import { PLAYER_COLORS } from '../../config/palette';
import { createPaddleMaterial, MATERIALISE } from '../materials/paddle';
import { TRS, instanceAttribute, instanceColors, linearRGB, markAll, unitBox, writeHidden, writeTRS } from '../materials/patch';
import type { SystemDeps } from '../materials/patch';

const PADDLE_Z = 18;          // board units of paddle height (visual; walls are WALL_H = 16)
const SQUASH_MIN = 0.85;      // E20: squash 0.85 -> 1.05 on a short spring
const SQUASH_W = 37;          // first overshoot after about 0.09 s
const SQUASH_Z = 0.35;        // overshoot to about 1.05
const OUT_S = 0.4;            // the dissolve after a seat empties
const NO_HIT = -100;

export class PaddlesSystem implements FrameSystem {
  readonly name = 'paddles';
  readonly mesh: THREE.InstancedMesh;
  private readonly deps: SystemDeps;
  private readonly geometry: THREE.BoxGeometry;
  private readonly material: THREE.MeshStandardMaterial;
  private readonly matrix: Float32Array;
  private readonly fx: THREE.InstancedBufferAttribute;
  private readonly state: THREE.InstancedBufferAttribute;
  private readonly last = new Float32Array(16);   // cx, cy, w, h of each seat's last present paddle
  private readonly seen = new Uint8Array(4);
  private readonly squash = new Float32Array(4).fill(1);
  private readonly squashV = new Float32Array(4);
  private time = 0;
  private attrDirty = true;

  constructor(deps: SystemDeps) {
    this.deps = deps;
    this.material = createPaddleMaterial(deps.shared);
    this.geometry = unitBox();
    this.fx = instanceAttribute(this.geometry, 'aFx', 4, 4);
    this.state = instanceAttribute(this.geometry, 'aState', 4, 4);
    this.mesh = new THREE.InstancedMesh(this.geometry, this.material, 4);
    this.mesh.name = 'paddles';
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.matrix = this.mesh.instanceMatrix.array as Float32Array;
    const colors = instanceColors(this.mesh, 4);
    for (let i = 0; i < 4; i++) {
      linearRGB(PLAYER_COLORS[i], colors.array as Float32Array, i * 3);
      this.fx.array[i * 4] = NO_HIT;
      this.fx.array[i * 4 + 3] = NO_HIT;
      this.state.array[i * 4 + 3] = i;
      writeHidden(this.matrix, i * 16);
    }
    deps.board.add(this.mesh);
  }

  update(ctx: FrameCtx): void {
    this.time = ctx.fxTimeS;
    const r = this.deps.render;
    const p = r.paddle;
    const fx = this.fx.array as Float32Array;
    const st = this.state.array as Float32Array;
    const dt = ctx.fxDtS > 1 / 30 ? 1 / 30 : ctx.fxDtS;
    for (let seat = 0; seat < 4; seat++) {
      const o = seat * PADDLE_STRIDE;
      const q = seat * 4;
      const ghost = p[o + PO.CONN] === SeatConn.Grace ? 1 : 0;
      if (fx[q + 2] !== ghost) {
        fx[q + 2] = ghost;
        this.attrDirty = true;
      }
      const mine = ctx.myIndex === seat ? 1 : 0;
      if (st[q + 2] !== mine) {
        st[q + 2] = mine;
        this.attrDirty = true;
      }
      const vertical = seat === 0 || seat === 2;
      const present = p[o + PO.PRESENT] > 0.5;
      const l = seat * 4;
      if (present) {
        this.last[l] = p[o + PO.CX] + (vertical ? 0 : r.paddleLead[seat]);
        this.last[l + 1] = p[o + PO.CY] + (vertical ? r.paddleLead[seat] : 0);
        this.last[l + 2] = p[o + PO.W];
        this.last[l + 3] = p[o + PO.H];
        this.seen[seat] = 1;
      }
      const leaving = !present && this.seen[seat] === 1 && st[q + 1] === MATERIALISE.out && this.time - fx[q + 3] < OUT_S;
      if (!present && !leaving) {
        writeHidden(this.matrix, seat * 16);
      } else {
        // The squash shows its current value first, so the frame of the hit shows the full 0.85.
        const s = this.squash[seat];
        const along = 1 + (1 - s) * 0.3;
        TRS[0] = this.last[l + 2] * (vertical ? s : along);
        TRS[1] = this.last[l + 3] * (vertical ? along : s);
        TRS[2] = PADDLE_Z;
        TRS[3] = this.last[l];
        TRS[4] = this.last[l + 1];
        TRS[5] = 0;
        TRS[6] = 0;
        writeTRS(this.matrix, seat * 16);
      }
      if (dt > 0 && (this.squash[seat] !== 1 || this.squashV[seat] !== 0)) {
        let x = this.squash[seat];
        let v = this.squashV[seat];
        v += (-2 * SQUASH_Z * SQUASH_W * v - SQUASH_W * SQUASH_W * (x - 1)) * dt;
        x += v * dt;
        if (Math.abs(x - 1) < 0.002 && Math.abs(v) < 0.02) {
          x = 1;
          v = 0;
        }
        this.squash[seat] = x;
        this.squashV[seat] = v;
      }
    }
    markAll(this.mesh.instanceMatrix);
    if (this.attrDirty) {
      markAll(this.fx);
      markAll(this.state);
      this.attrDirty = false;
    }
  }

  /** u = 0..1 along the paddle (canvas top-left to bottom-right, as derive's paddleU). */
  flashPaddle(seat: Seat, u: number, strength: number): void {
    const q = seat * 4;
    (this.fx.array as Float32Array)[q] = this.time;
    (this.fx.array as Float32Array)[q + 1] = u;
    (this.state.array as Float32Array)[q] = strength;
    this.attrDirty = true;
  }

  /** amount 1 gives the full 0.85 squash, springing back through about 1.05. */
  squashPaddle(seat: Seat, amount: number): void {
    const a = amount < 0 ? 0 : amount > 1 ? 1 : amount;
    this.squash[seat] = 1 - (1 - SQUASH_MIN) * a;
    this.squashV[seat] = 0;
  }

  materialisePaddle(seat: Seat, mode: 'in' | 'out' | 'solidify'): void {
    const q = seat * 4;
    (this.state.array as Float32Array)[q + 1] = MATERIALISE[mode];
    (this.fx.array as Float32Array)[q + 3] = this.time;
    this.attrDirty = true;
  }

  reset(): void {
    this.seen.fill(0);
    this.squash.fill(1);
    this.squashV.fill(0);
    const st = this.state.array as Float32Array;
    for (let i = 0; i < 4; i++) {
      st[i * 4] = 0;
      st[i * 4 + 1] = MATERIALISE.none;
      writeHidden(this.matrix, i * 16);
    }
    this.attrDirty = true;
  }

  markNeedsUpdate(): void {
    markAll(this.mesh.instanceMatrix);
    if (this.mesh.instanceColor !== null) markAll(this.mesh.instanceColor);
    this.attrDirty = true;
  }

  dispose(): void {
    this.deps.board.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
    this.mesh.dispose();
  }
}
