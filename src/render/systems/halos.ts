// E07 halos and light pools, and E05 intent chevrons: one instanced additive draw of 64 ball halos, 4 paddle light
// pools and 2 chevrons. The chevrons sit beside my paddle on the side I steer toward: local truth about input,
// while the paddle itself stays server truth (D08).

import * as THREE from 'three';
import type { FrameCtx, FrameSystem } from '../contracts';
import type { Visual } from '../../input/types';
import { BALL_STRIDE, BO, PADDLE_STRIDE, PO } from '../../game/types';
import { SeatConn } from '../../game/events';
import { rotationRad } from '../../game/orientation';
import { MAX_BALLS } from '../../config/constants';
import { HDR, PLAYER_COLORS } from '../../config/palette';
import { createHaloMaterial, HALO_KIND } from '../materials/halo';
import { instanceAttribute, linearRGB, markAll } from '../materials/patch';
import type { SystemDeps } from '../materials/patch';
import type { BallsSystem } from './balls';

export const HALO_COUNT = MAX_BALLS + 4 + 2;
const POOL = MAX_BALLS;
const CHEVRON = MAX_BALLS + 4;
const CHEVRON_SIZE = 18;
const CHEVRON_GAP = 18;
const CHEVRON_STEP = 16;

const SEAT_RGB = new Float32Array(12);
for (let i = 0; i < 4; i++) linearRGB(PLAYER_COLORS[i], SEAT_RGB, i * 3);

export class HalosSystem implements FrameSystem {
  readonly name = 'halos';
  readonly mesh: THREE.InstancedMesh;
  private readonly deps: SystemDeps;
  private readonly balls: BallsSystem;
  private readonly intent: () => Visual;
  private readonly geometry: THREE.PlaneGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly haloAttr: THREE.InstancedBufferAttribute;
  private readonly colorAttr: THREE.InstancedBufferAttribute;
  private readonly kindAttr: THREE.InstancedBufferAttribute;
  private readonly halo: Float32Array;
  private readonly color: Float32Array;
  private readonly kind: Float32Array;

  constructor(deps: SystemDeps, balls: BallsSystem, intent: () => Visual, glow: THREE.Texture) {
    this.deps = deps;
    this.balls = balls;
    this.intent = intent;
    this.material = createHaloMaterial(deps.shared, glow);
    this.geometry = new THREE.PlaneGeometry(1, 1);
    this.haloAttr = instanceAttribute(this.geometry, 'aHalo', HALO_COUNT, 4);
    this.colorAttr = instanceAttribute(this.geometry, 'aHaloColor', HALO_COUNT, 4);
    this.kindAttr = instanceAttribute(this.geometry, 'aHaloKind', HALO_COUNT, 2);
    this.halo = this.haloAttr.array as Float32Array;
    this.color = this.colorAttr.array as Float32Array;
    this.kind = this.kindAttr.array as Float32Array;
    for (let i = 0; i < HALO_COUNT; i++) this.kind[i * 2] = i < POOL ? HALO_KIND.disc : i < CHEVRON ? HALO_KIND.pool : HALO_KIND.chevron;
    this.mesh = new THREE.InstancedMesh(this.geometry, this.material, HALO_COUNT);
    this.mesh.name = 'halos';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    deps.board.add(this.mesh);
  }

  update(ctx: FrameCtx): void {
    const r = this.deps.render;
    const b = r.ball;
    const n = r.ballHigh;
    const halo = this.halo;
    const color = this.color;
    for (let slot = 0; slot < MAX_BALLS; slot++) {
      const h = slot * 4;
      const a = slot < n ? this.balls.alpha[slot] : 0;
      if (a <= 0) {
        halo[h + 2] = 0;
        halo[h + 3] = 0;
        color[h + 3] = 0;
        continue;
      }
      const o = slot * BALL_STRIDE;
      const vx = b[o + BO.VX];
      const vy = b[o + BO.VY];
      const size = this.balls.radius[slot] * (3.2 + 0.18 * Math.sqrt(vx * vx + vy * vy));
      halo[h] = b[o + BO.X];
      halo[h + 1] = b[o + BO.Y];
      halo[h + 2] = size;
      halo[h + 3] = size;
      const c = slot * 3;
      color[h] = this.balls.colors[c];
      color[h + 1] = this.balls.colors[c + 1];
      color[h + 2] = this.balls.colors[c + 2];
      color[h + 3] = (b[o + BO.OWNER] >= 0 ? 0.55 : 0.25) * HDR.halo * a;
    }

    const p = r.paddle;
    for (let seat = 0; seat < 4; seat++) {
      const h = (POOL + seat) * 4;
      const o = seat * PADDLE_STRIDE;
      if (p[o + PO.PRESENT] < 0.5) {
        halo[h + 2] = 0;
        halo[h + 3] = 0;
        color[h + 3] = 0;
        continue;
      }
      halo[h] = p[o + PO.CX];
      halo[h + 1] = p[o + PO.CY];
      halo[h + 2] = p[o + PO.W] + 44;
      halo[h + 3] = p[o + PO.H] + 44;
      color[h] = SEAT_RGB[seat * 3];
      color[h + 1] = SEAT_RGB[seat * 3 + 1];
      color[h + 2] = SEAT_RGB[seat * 3 + 2];
      color[h + 3] = p[o + PO.CONN] === SeatConn.Grace ? 0.15 : ctx.myIndex === seat ? 0.5 : 0.35;
    }

    const me = ctx.myIndex;
    const d = this.intent();
    const po = me === null ? 0 : me * PADDLE_STRIDE;
    const show = me !== null && d !== 0 && ctx.session === 'playing' && p[po + PO.PRESENT] > 0.5;
    for (let j = 0; j < 2; j++) {
      const h = (CHEVRON + j) * 4;
      if (!show || me === null) {
        halo[h + 2] = 0;
        halo[h + 3] = 0;
        color[h + 3] = 0;
        continue;
      }
      // Screen left/right in the view, taken back into board space by the inverse board rotation.
      const rot = rotationRad(me);
      const dx = Math.round(Math.cos(rot)) * d;
      const dy = -Math.round(Math.sin(rot)) * d;
      const vertical = me === 0 || me === 2;
      const lead = r.paddleLead[me];
      const cx = p[po + PO.CX] + (vertical ? 0 : lead);
      const cy = p[po + PO.CY] + (vertical ? lead : 0);
      const len = vertical ? p[po + PO.H] : p[po + PO.W];
      const dist = len / 2 + CHEVRON_GAP + j * CHEVRON_STEP;
      halo[h] = cx + dx * dist;
      halo[h + 1] = cy + dy * dist;
      halo[h + 2] = CHEVRON_SIZE;
      halo[h + 3] = CHEVRON_SIZE;
      this.kind[(CHEVRON + j) * 2 + 1] = Math.atan2(dy, dx);
      color[h] = SEAT_RGB[me * 3];
      color[h + 1] = SEAT_RGB[me * 3 + 1];
      color[h + 2] = SEAT_RGB[me * 3 + 2];
      color[h + 3] = HDR.halo * (j === 0 ? 1 : 0.6);
    }
    markAll(this.haloAttr);
    markAll(this.colorAttr);
    markAll(this.kindAttr);
  }

  reset(): void {
    this.halo.fill(0);
    this.color.fill(0);
    markAll(this.haloAttr);
    markAll(this.colorAttr);
  }

  markNeedsUpdate(): void {
    markAll(this.haloAttr);
    markAll(this.colorAttr);
    markAll(this.kindAttr);
  }

  dispose(): void {
    this.deps.board.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
    this.mesh.dispose();
  }
}
