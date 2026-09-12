// E01 floor system. It runs first in the frame (2.5 step 2), so it also advances the shared uniforms every stage
// material reads: presentation time, reduced motion and the dim envelope (EntityFx.setDim). The occupancy texture
// is rebuilt from render.brickType when render.brickVersion changes (D32), never from World.brick*.

import * as THREE from 'three';
import type { FrameCtx, FrameSystem } from '../contracts';
import type { Owner } from '../../game/events';
import { BALL_STRIDE, BO, BallVis, PADDLE_STRIDE, PO } from '../../game/types';
import { GRID, MAX_BALLS, WALL_T } from '../../config/constants';
import { PLAYER_COLORS } from '../../config/palette';
import { createFloorMaterial, FLOOR_RIPPLES } from '../materials/floor';
import type { FloorUniforms } from '../materials/floor';
import type { SystemDeps } from '../materials/patch';
import { createOccupancyTexture, writeOccupancy } from '../textures';
import type { Occupancy } from '../textures';

const BLOB_STRENGTH = 0.55;
const SEAT_COLORS = PLAYER_COLORS.map((c) => new THREE.Color(c));
const WHITE = new THREE.Color(1, 1, 1);

export class FloorSystem implements FrameSystem {
  readonly name = 'floor';
  readonly mesh: THREE.Mesh;
  readonly uniforms: FloorUniforms;
  private readonly deps: SystemDeps;
  private readonly geometry: THREE.PlaneGeometry;
  private readonly material: THREE.ShaderMaterial;
  private occ: Occupancy;
  private version = -1;
  private extent = -1;
  private rippleNext = 0;
  private time = 0;
  // Dim envelope, advanced in real time so a hit-stop never holds a ramp.
  private dimFrom = 1;
  private dimTo = 1;
  private dimT = 0;
  private dimDur = 0;

  constructor(deps: SystemDeps) {
    this.deps = deps;
    this.occ = createOccupancyTexture(Math.min(GRID, deps.world.gridSize));
    const { material, uniforms } = createFloorMaterial(deps.shared, this.occ.texture, deps.world.canvas, deps.world.gridSize);
    this.material = material;
    this.uniforms = uniforms;
    this.geometry = new THREE.PlaneGeometry(1, 1);
    this.mesh = new THREE.Mesh(this.geometry, material);
    this.mesh.name = 'floor';
    this.mesh.frustumCulled = false;
    this.layout();
    deps.board.add(this.mesh);
  }

  /** The occupancy texture, for tests and the debug overlay. */
  get occupancy(): Occupancy {
    return this.occ;
  }

  update(ctx: FrameCtx): void {
    const shared = this.deps.shared;
    this.time = ctx.fxTimeS;
    shared.uTime.value = ctx.fxTimeS;
    shared.uReduced.value = ctx.reducedMotion ? 1 : 0;
    if (this.dimT < this.dimDur) {
      this.dimT += ctx.dtS;
      const t = this.dimT >= this.dimDur ? 1 : this.dimT / this.dimDur;
      const u = 1 - t;
      shared.uDim.value = this.dimFrom + (this.dimTo - this.dimFrom) * (1 - u * u * u);
    } else {
      shared.uDim.value = this.dimTo;
    }

    const w = this.deps.world;
    const r = this.deps.render;
    if (w.canvas !== this.extent) this.layout();
    if (r.brickVersion !== this.version) {
      const grid = Math.min(GRID, w.gridSize);
      if (grid !== this.occ.grid) {
        this.occ.texture.dispose();
        this.occ = createOccupancyTexture(grid);
        this.uniforms.uOcc.value = this.occ.texture;
        this.uniforms.uGrid.value = w.gridSize;
      }
      writeOccupancy(this.occ, r.brickType);
      this.version = r.brickVersion;
    }

    const blobs = this.uniforms.uBlobs.value;
    const b = r.ball;
    const high = r.ballHigh;
    for (let slot = 0; slot < MAX_BALLS; slot++) {
      const q = slot * 4;
      const o = slot * BALL_STRIDE;
      const vis = slot < high ? b[o + BO.VIS] : BallVis.Hidden;
      if (vis === BallVis.Hidden) {
        blobs[q] = 0;
        blobs[q + 1] = 0;
        blobs[q + 2] = 0;
        blobs[q + 3] = 0;
        continue;
      }
      blobs[q] = b[o + BO.X];
      blobs[q + 1] = b[o + BO.Y];
      blobs[q + 2] = b[o + BO.R];
      blobs[q + 3] = vis === BallVis.Live ? BLOB_STRENGTH : BLOB_STRENGTH * 0.5;
    }
    const p = r.paddle;
    for (let seat = 0; seat < 4; seat++) {
      const q = (MAX_BALLS + seat) * 4;
      const o = seat * PADDLE_STRIDE;
      if (p[o + PO.PRESENT] > 0.5) {
        blobs[q] = p[o + PO.CX];
        blobs[q + 1] = p[o + PO.CY];
        blobs[q + 2] = -p[o + PO.W] / 2;
        blobs[q + 3] = p[o + PO.H] / 2;
      } else {
        blobs[q] = 0;
        blobs[q + 1] = 0;
        blobs[q + 2] = 0;
        blobs[q + 3] = 0;
      }
    }

    const me = ctx.myIndex;
    if (me === null) {
      this.uniforms.uMyWall.value = -1;
    } else {
      this.uniforms.uMyWall.value = me;
      this.uniforms.uMyColor.value.copy(SEAT_COLORS[me]);
    }
  }

  /** Canvas px; floor shader, 8 slots, the oldest overwritten. */
  ripple(x: number, y: number, strength: number): void {
    const half = this.deps.world.canvas / 2;
    const q = this.rippleNext * 4;
    const rip = this.uniforms.uRipples.value;
    rip[q] = x - half;
    rip[q + 1] = half - y;
    rip[q + 2] = this.time;
    rip[q + 3] = strength;
    this.rippleNext = (this.rippleNext + 1) % FLOOR_RIPPLES;
  }

  /** A radial sweep in the winner's colour from the winner's wall (from the centre, in white, for a tie). */
  winnerSweep(winner: Owner, seconds: number): void {
    const half = this.deps.world.canvas / 2;
    const ox = winner === 0 ? half : winner === 2 ? -half : 0;
    const oy = winner === 1 ? half : winner === 3 ? -half : 0;
    this.uniforms.uSweep.value.set(ox, oy, this.time, Math.max(0.05, seconds));
    this.uniforms.uSweepColor.value.copy(winner >= 0 ? SEAT_COLORS[winner] : WHITE);
  }

  /** Ramps the shared dim to `target` over `seconds` (0 = at once). */
  setDim(target: number, seconds: number): void {
    this.dimFrom = this.deps.shared.uDim.value;
    this.dimTo = target;
    this.dimT = 0;
    this.dimDur = seconds > 0 ? seconds : 0;
    if (this.dimDur === 0) this.deps.shared.uDim.value = target;
  }

  get dimTarget(): number {
    return this.dimTo;
  }

  reset(): void {
    this.version = -1;
    this.uniforms.uRipples.value.fill(0);
    this.uniforms.uSweep.value.z = -1;
  }

  markNeedsUpdate(): void {
    this.version = -1;
    this.occ.texture.needsUpdate = true;
  }

  dispose(): void {
    this.deps.board.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
    this.occ.texture.dispose();
  }

  private layout(): void {
    const w = this.deps.world;
    const e = w.canvas + 2 * WALL_T;
    this.mesh.scale.set(e, e, 1);
    this.mesh.updateMatrix();
    this.uniforms.uCanvas.value = w.canvas;
    this.uniforms.uGrid.value = w.gridSize;
    this.extent = w.canvas;
  }
}
