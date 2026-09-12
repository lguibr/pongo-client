// E06 balls system: InstancedMesh(64) of an icosphere (detail 2); slot index === instance index. Colour
// cross-fades to a new owner over 0.15 s (E21), velocity stretch up to +12 % along v and -6 % across it (off
// under reduced motion), the spawn pop (0 -> 1.25 -> 1 over 0.28 s), pulses, the resize overshoot, the dissolve
// of a Dying slot over 250 ms, and dissolveBall's fade with a shrink to 35 % of the radius (E24, E33).

import * as THREE from 'three';
import type { FrameCtx, FrameSystem } from '../contracts';
import { BALL_STRIDE, BO, BallVis } from '../../game/types';
import { MAX_BALLS } from '../../config/constants';
import { COLORS, HDR, PLAYER_COLORS } from '../../config/palette';
import { createBallMaterial } from '../materials/ball';
import { TRS, instanceAttribute, instanceColors, linearRGB, markAll, writeHidden, writeTRS } from '../materials/patch';
import type { SystemDeps } from '../materials/patch';

const STRETCH_MAX = 0.12;     // E06
const STRETCH_SPEED = 12;     // board units per tick at full stretch
const DYING_S = 0.25;
const SPAWN_S = 0.28;         // E30
const POP_S = 0.15;
const RESIZE_S = 0.2;         // E35
const RESIZE_MEMORY_S = 0.5;  // a resize event this soon after the radius changed animates from the old radius
const FADE_S = 0.15;          // E21: the colour cross-fades over 0.15 s
const DISSOLVE_MIN = 0.35;    // E33: the radius shrinks to 35 % as the dissolve ends
const NONE = -100;

const OWNER_RGB = new Float32Array(15);   // seats 0..3, then unowned
for (let i = 0; i < 4; i++) linearRGB(PLAYER_COLORS[i], OWNER_RGB, i * 3);
linearRGB(COLORS.unownedBall, OWNER_RGB, 12);

export class BallsSystem implements FrameSystem {
  readonly name = 'balls';
  readonly mesh: THREE.InstancedMesh;
  /** Current colour per slot (linear rgb), displayed radius and alpha; the halos read them. */
  readonly colors: Float32Array;
  readonly radius = new Float32Array(MAX_BALLS);
  readonly alpha = new Float32Array(MAX_BALLS);
  private readonly deps: SystemDeps;
  private readonly geometry: THREE.IcosahedronGeometry;
  private readonly material: THREE.MeshStandardMaterial;
  private readonly matrix: Float32Array;
  private readonly colorAttr: THREE.InstancedBufferAttribute;
  private readonly ballAttr: THREE.InstancedBufferAttribute;
  private readonly ball: Float32Array;
  private readonly ids = new Int32Array(MAX_BALLS).fill(-1);
  private readonly fxFor = new Int32Array(MAX_BALLS).fill(-1);   // the ball id the slot's timers were set for
  private readonly prevVis = new Uint8Array(MAX_BALLS);
  private readonly dyingT0 = new Float32Array(MAX_BALLS);
  private readonly spawnT0 = new Float32Array(MAX_BALLS).fill(NONE);
  private readonly popT0 = new Float32Array(MAX_BALLS).fill(NONE);
  private readonly popAmp = new Float32Array(MAX_BALLS);
  private readonly resizeT0 = new Float32Array(MAX_BALLS).fill(NONE);
  private readonly resizeFrom = new Float32Array(MAX_BALLS);
  private readonly resizeTo = new Float32Array(MAX_BALLS);
  private readonly dissolveT0 = new Float32Array(MAX_BALLS).fill(NONE);
  private readonly dissolveDur = new Float32Array(MAX_BALLS).fill(1);
  private readonly baseR = new Float32Array(MAX_BALLS);       // RenderState radius last frame
  private readonly prevR = new Float32Array(MAX_BALLS);       // radius before the last change
  private readonly changedAt = new Float32Array(MAX_BALLS).fill(NONE);
  private readonly fadeFrom = new Float32Array(MAX_BALLS * 3);
  private readonly fadeT0 = new Float32Array(MAX_BALLS).fill(NONE);
  private readonly fadeOwner = new Int8Array(MAX_BALLS);   // the owner the colour is heading to
  private time = 0;
  private reduced = false;
  private full = true;

  constructor(deps: SystemDeps) {
    this.deps = deps;
    this.material = createBallMaterial(deps.shared);
    this.geometry = new THREE.IcosahedronGeometry(1, 2);
    this.ballAttr = instanceAttribute(this.geometry, 'aBall', MAX_BALLS, 4);
    this.ball = this.ballAttr.array as Float32Array;
    this.mesh = new THREE.InstancedMesh(this.geometry, this.material, MAX_BALLS);
    this.mesh.name = 'balls';
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.matrix = this.mesh.instanceMatrix.array as Float32Array;
    this.colorAttr = instanceColors(this.mesh, MAX_BALLS);
    this.colors = this.colorAttr.array as Float32Array;
    for (let s = 0; s < MAX_BALLS; s++) writeHidden(this.matrix, s * 16);
    this.mesh.count = 0;
    deps.board.add(this.mesh);
  }

  update(ctx: FrameCtx): void {
    this.time = ctx.fxTimeS;
    this.reduced = ctx.reducedMotion;
    const r = this.deps.render;
    const b = r.ball;
    const n = r.ballHigh;
    for (let slot = 0; slot < n; slot++) {
      const o = slot * BALL_STRIDE;
      const m = slot * 16;
      const id = r.ballId[slot];
      const vis = id < 0 ? BallVis.Hidden : b[o + BO.VIS] | 0;
      const owner = b[o + BO.OWNER] | 0;   // an int from here on, so it indexes without a conversion
      const src = owner >= 0 && owner <= 3 ? owner * 3 : 12;
      const c = slot * 3;
      if (id !== this.ids[slot]) {
        this.ids[slot] = id;
        this.prevVis[slot] = BallVis.Hidden;
        this.baseR[slot] = b[o + BO.R];
        this.changedAt[slot] = NONE;
        if (this.fxFor[slot] !== id) {
          this.spawnT0[slot] = NONE;
          this.popT0[slot] = NONE;
          this.resizeT0[slot] = NONE;
          this.dissolveT0[slot] = NONE;
        }
        this.fadeOwner[slot] = owner;
        this.fadeT0[slot] = NONE;
      } else if (owner !== this.fadeOwner[slot]) {
        this.fadeOwner[slot] = owner;
        this.fadeFrom[c] = this.colors[c];
        this.fadeFrom[c + 1] = this.colors[c + 1];
        this.fadeFrom[c + 2] = this.colors[c + 2];
        this.fadeT0[slot] = this.time;
      }
      const x = this.fadeT0[slot] > NONE ? (this.time - this.fadeT0[slot]) / FADE_S : 1;
      if (x >= 1) {
        this.fadeT0[slot] = NONE;
        this.colors[c] = OWNER_RGB[src];
        this.colors[c + 1] = OWNER_RGB[src + 1];
        this.colors[c + 2] = OWNER_RGB[src + 2];
      } else {
        const e = x <= 0 ? 0 : x * x * (3 - 2 * x);
        this.colors[c] = this.fadeFrom[c] + (OWNER_RGB[src] - this.fadeFrom[c]) * e;
        this.colors[c + 1] = this.fadeFrom[c + 1] + (OWNER_RGB[src + 1] - this.fadeFrom[c + 1]) * e;
        this.colors[c + 2] = this.fadeFrom[c + 2] + (OWNER_RGB[src + 2] - this.fadeFrom[c + 2]) * e;
      }
      if (vis === BallVis.Hidden) {
        writeHidden(this.matrix, m);
        this.alpha[slot] = 0;
        this.radius[slot] = 0;
        this.prevVis[slot] = vis;
        continue;
      }
      if (vis === BallVis.Dying && this.prevVis[slot] !== BallVis.Dying) this.dyingT0[slot] = this.time;
      this.prevVis[slot] = vis;
      let a = vis === BallVis.Dying ? 1 - (this.time - this.dyingT0[slot]) / DYING_S : 1;
      let shrink = 1;
      if (this.dissolveT0[slot] > NONE) {
        // E33 shrinks the ball while the noise dissolve eats it; E24 flattens it into the wall the same way.
        let d = 1 - (this.time - this.dissolveT0[slot]) / this.dissolveDur[slot];
        d = d < 0 ? 0 : d > 1 ? 1 : d;
        if (d < a) a = d;
        shrink = DISSOLVE_MIN + (1 - DISSOLVE_MIN) * d;
      }
      a = a < 0 ? 0 : a > 1 ? 1 : a;

      const rNow = b[o + BO.R];
      if (rNow !== this.baseR[slot]) {
        this.prevR[slot] = this.baseR[slot];
        this.baseR[slot] = rNow;
        this.changedAt[slot] = this.time;
      }
      let rad = rNow;
      let f = 1;
      let t = (this.time - this.resizeT0[slot]) / RESIZE_S;
      if (t >= 0 && t < 1) {
        const from = this.resizeFrom[slot];
        const to = this.resizeTo[slot];
        const u = t - 1;
        // ease-out-back gives the 0.2 s overshoot; ease-out-cubic under reduced motion
        const e = this.reduced ? 1 + u * u * u : 1 + 2.70158 * u * u * u + 1.70158 * u * u;
        rad = from + (to - from) * e;
      }
      t = (this.time - this.spawnT0[slot]) / SPAWN_S;
      if (t >= 0 && t < 1) {
        if (t < 0.55) {
          const u = 1 - t / 0.55;
          f *= 1.25 * (1 - u * u * u);
        } else {
          const u = 1 - (t - 0.55) / 0.45;
          f *= 1.25 - 0.25 * (1 - u * u * u);
        }
      }
      t = (this.time - this.popT0[slot]) / POP_S;
      if (t >= 0 && t < 1) f *= 1 + this.popAmp[slot] * (this.reduced ? 0.125 : 0.25) * Math.sin(Math.PI * t);

      const vx = b[o + BO.VX];
      const vy = b[o + BO.VY];
      const speed = Math.sqrt(vx * vx + vy * vy);
      const s = this.reduced ? 0 : STRETCH_MAX * (speed >= STRETCH_SPEED ? 1 : speed / STRETCH_SPEED);
      const rr = rad * f * shrink;
      TRS[0] = rr * (1 + s);
      TRS[1] = rr * (1 - s / 2);
      TRS[2] = rr;
      TRS[3] = b[o + BO.X];
      TRS[4] = b[o + BO.Y];
      TRS[5] = rr;
      TRS[6] = speed > 1e-4 ? Math.atan2(vy, vx) : 0;
      writeTRS(this.matrix, m);
      this.radius[slot] = rr;
      this.alpha[slot] = a;

      const q = slot * 4;
      this.ball[q] = owner >= 0 ? HDR.ballCore : HDR.ballCoreUnowned;
      this.ball[q + 1] = a;
      this.ball[q + 2] = b[o + BO.PHASING];
      this.ball[q + 3] = b[o + BO.PERMANENT] > 0.5 ? -1 : b[o + BO.AGE_S];
    }
    this.mesh.count = n;
    // Positions change every frame: whole uploads (about 6 KB) allocate nothing, unlike three's range path.
    if (this.full || n > 0) {
      markAll(this.mesh.instanceMatrix);
      markAll(this.colorAttr);
      markAll(this.ballAttr);
      this.full = false;
    }
  }

  pulseBall(ballId: number, strength: number): void {
    const slot = this.slot(ballId);
    if (slot < 0) return;
    this.popT0[slot] = this.time;
    this.popAmp[slot] = strength;
  }

  spawnBall(ballId: number): void {
    const slot = this.slot(ballId);
    if (slot >= 0) this.spawnT0[slot] = this.time;
  }

  dissolveBall(ballId: number, seconds: number): void {
    const slot = this.slot(ballId);
    if (slot < 0) return;
    this.dissolveT0[slot] = this.time;
    this.dissolveDur[slot] = seconds > 0.01 ? seconds : 0.01;
  }

  /** The radius springs to `radius`: from the radius before its last change when that change is recent (the
   *  World changes it at ingest, before the event is released), else from what is shown now. */
  resizeBall(ballId: number, radius: number): void {
    const slot = this.slot(ballId);
    if (slot < 0) return;
    const recent = this.time - this.changedAt[slot] < RESIZE_MEMORY_S;
    this.resizeFrom[slot] = recent ? this.prevR[slot] : this.baseR[slot];
    this.resizeTo[slot] = radius;
    this.resizeT0[slot] = this.time;
  }

  reset(): void {
    this.ids.fill(-1);
    this.fxFor.fill(-1);
    this.prevVis.fill(BallVis.Hidden);
    this.spawnT0.fill(NONE);
    this.popT0.fill(NONE);
    this.resizeT0.fill(NONE);
    this.dissolveT0.fill(NONE);
    this.alpha.fill(0);
    this.radius.fill(0);
    for (let s = 0; s < MAX_BALLS; s++) writeHidden(this.matrix, s * 16);
    this.mesh.count = 0;
    this.full = true;
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

  private slot(ballId: number): number {
    const slot = this.deps.world.slotById.get(ballId);
    if (slot === undefined || slot < 0 || slot >= MAX_BALLS) return -1;
    this.fxFor[slot] = ballId;
    return slot;
  }
}
