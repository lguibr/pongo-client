// Camera rig (5.10, 6.5; C05, C24, C75). The fit uses the 8 corners of the board box and never the bricks; near
// and far are recomputed from the corner depths every frame, so a 24-bit depth step stays about 0.1 unit. The rig
// refits in the same frame as a size change. It also eases the board rotation to rotationRad(myIndex).

import * as THREE from 'three';
import type { CameraFx, FrameCtx } from './contracts';
import type { Tuning } from '../config/tuning';
import type { World } from '../game/types';
import { CANVAS, WALL_T } from '../config/constants';
import { rotationRad } from '../game/orientation';
import { valueNoise1 } from '../lib/math';

export type CameraMode = 'lobby' | 'intro' | 'play' | 'gameOver';

const NEAR_K = 0.9;
const FAR_K = 1.1 * 1.02;          // 1.02: shake headroom (5.10)
const SHAKE_DECAY = 1.6;           // trauma per second (6.5)
const SHAKE_ANGLE_TAN = Math.tan((0.35 * Math.PI) / 180);
const SHAKE_HZ = 18;
const ROLL_MAX = (0.4 * Math.PI) / 180;
const IMPULSE_K = 180;             // 6.5: critically damped screen-space spring (k 180, zeta 0.7)
const IMPULSE_ZETA = 0.7;
const IMPULSE_GAIN = 3;            // strength 1 pushes the image by about 11 % of the half view height
const KICK_S = 0.3;
const KICK_MAX = 0.05;
const INTRO_S = 3;                 // the server's countdown; the intro pose reaches play at `go`
const GAME_OVER_S = 1.5;
const GAME_OVER_ORBIT = (6 * Math.PI) / 180;
const LOBBY_ORBIT_PERIOD_S = 16;
const BLEND_S = 0.35;              // pose blend when a mode is entered before the last one finished

/** fitCore and depthRange results: [d, near, far]. */
const FIT = new Float64Array(3);

function extentOf(canvas: number): number {
  return canvas / 2 + WALL_T;
}

/** Near and far bounding the 8 corners of [-e, e]^2 x [0, headroom] seen from distance D along the pose. */
function depthRange(D: number, tilt: number, yaw: number, headroom: number, e: number): void {
  const ct = Math.sqrt(1 - tilt * tilt);
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const bx = -tilt * sy;
  const by = tilt * cy;
  let lo = Infinity;
  let hi = -Infinity;
  for (let c = 0; c < 8; c++) {
    const px = c & 1 ? e : -e;
    const py = c & 2 ? e : -e;
    const pz = c & 4 ? headroom : 0;
    const depth = D - (px * bx + py * by + pz * ct);
    if (depth < lo) lo = depth;
    if (depth > hi) hi = depth;
  }
  FIT[1] = NEAR_K * lo;
  FIT[2] = FAR_K * hi;
}

/** d = margin * max over the corners of (p.b + max(|p.r| / tanH, |p.u| / tanV)) for the pose (tilt, yaw). */
function fitCore(aspect: number, fovDeg: number, tilt: number, yaw: number, margin: number, headroom: number, e: number): void {
  const tanV = Math.tan((fovDeg * Math.PI) / 360);
  const tanH = tanV * aspect;
  const ct = Math.sqrt(1 - tilt * tilt);
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const bx = -tilt * sy;
  const by = tilt * cy;
  const ux = -ct * sy;
  const uy = ct * cy;
  let need = -Infinity;
  for (let c = 0; c < 8; c++) {
    const px = c & 1 ? e : -e;
    const py = c & 2 ? e : -e;
    const pz = c & 4 ? headroom : 0;
    const pb = px * bx + py * by + pz * ct;
    const pr = px * cy + py * sy;
    const pu = px * ux + py * uy - pz * tilt;
    const h = Math.abs(pr) / tanH;
    const v = Math.abs(pu) / tanV;
    const k = pb + (h > v ? h : v);
    if (k > need) need = k;
  }
  FIT[0] = margin * need;
  depthRange(FIT[0], tilt, yaw, headroom, e);
}

/** Pure (tested): the play-pose distance for this aspect, and near and far bounding every corner there. */
export function fitDistance(aspect: number, t: Tuning['camera']): { d: number; near: number; far: number } {
  fitCore(aspect, t.fovDeg, t.tilt, 0, t.margin, t.headroom, extentOf(CANVAS));
  return { d: FIT[0], near: FIT[1], far: FIT[2] };
}

/** The rig writes the camera's matrices itself (matrixAutoUpdate off): the per-frame path passes no doubles to
 *  calls that may not be inlined, so it allocates nothing. `position`, `quaternion` and `rotation` are kept in step
 *  with the matrix, so code that orients objects toward the camera may read them. */
export class CameraRig implements CameraFx {
  readonly camera: THREE.PerspectiveCamera;
  private readonly t: Tuning['camera'];
  private board: THREE.Group | null = null;
  private world: Readonly<World> | null = null;
  private w = 0;
  private h = 0;
  private aspect = 1;
  private extent = -1;
  private d0 = 1;
  private mode: CameraMode = 'play';
  private reducedMode = false;
  private reduced = false;
  private modeT = 0;
  private hasPose = false;
  // Every numeric field starts as a number (-0.5 stands in for the tilt until the constructor sets it): a field
  // declared without an initializer is defined as undefined first, and its per-frame writes would then be boxed.
  private fromScale = 1;
  private fromTilt = -0.5;
  private fromYaw = 0;
  private scale = 1;
  private tilt = -0.5;
  private yaw = 0;
  private tScale = 1;
  private tTilt = -0.5;
  private tYaw = 0;
  private trauma = 0;
  private shakeT = 0;
  private ix = 0;
  private iy = 0;
  private ivx = 0;
  private ivy = 0;
  private kickAmt = 0;
  private kickT = KICK_S;
  private nearV = 1;
  private farV = 2;
  private dist = 1;
  private offX = 0;       // shake and impulse offset along r and u, and the roll, for writePose
  private offY = 0;
  private rollA = 0;
  private poseE = 1;      // the board extent writePose bounds near and far with
  private nowMs = 0;
  private introEnd = -1;  // performance.now ms of `go`; negative when no countdown is known
  private frameDt = 0;
  private rotSeat = -2;   // the seat nextTarget was computed for (-1 = none, -2 = not yet)
  private nextTarget = 0.5;
  private rotTarget = NaN;
  private rotFrom = 0;
  private rotDelta = 0;
  private rotP = 1;
  private rotAngle = 0;

  constructor(camera: THREE.PerspectiveCamera, t: Tuning['camera']) {
    this.camera = camera;
    this.t = t;
    this.fromTilt = t.tilt;
    this.tilt = t.tilt;
    this.tTilt = t.tilt;
    camera.fov = t.fovDeg;
    camera.up.set(0, 1, 0);
    camera.matrixAutoUpdate = false;
  }

  get near(): number {
    return this.nearV;
  }

  get far(): number {
    return this.farV;
  }

  /** Current distance from the board centre, kick included. */
  get distance(): number {
    return this.dist;
  }

  /** The CSS size of the last update (FxHost.project). */
  get width(): number {
    return this.w;
  }

  get height(): number {
    return this.h;
  }

  get currentMode(): CameraMode {
    return this.mode;
  }

  /** The board group this rig rotates to the local seat, and the World whose canvas sets the fitted extent. */
  setBoard(board: THREE.Group, world: Readonly<World>): void {
    this.board = board;
    this.world = world;
  }

  setMode(m: 'lobby' | 'intro' | 'play' | 'gameOver', reducedMotion: boolean): void {
    this.reducedMode = reducedMotion;
    if (m === this.mode && this.hasPose) return;
    this.fromScale = this.scale;
    this.fromTilt = this.tilt;
    this.fromYaw = this.yaw;
    this.mode = m;
    this.modeT = 0;
  }

  /** When the countdown ends (the store's countdown.endsAt, performance.now ms), or a negative value when none is
   *  known. The intro pose is timed from it, so it finishes at `go` even when the player joins mid-countdown. */
  setIntroEnd(endsAtMs: number): void {
    this.introEnd = endsAtMs;
  }

  /** A resize while the board is not ready (D33): refits and redraws the current pose at the new size, without
   *  advancing time, shake or the board rotation. */
  refit(width: number, height: number): void {
    if (!(width > 0 && height > 0)) return;
    const t = this.t;
    if (this.extent < 0) this.extent = extentOf(this.world !== null ? this.world.canvas : CANVAS);
    if (width !== this.w || height !== this.h) {
      this.w = width;
      this.h = height;
      this.aspect = width / height;
      fitCore(this.aspect, t.fovDeg, t.tilt, 0, t.margin, t.headroom, this.extent);
      this.d0 = FIT[0];
    }
    this.dist = this.d0 * this.scale;
    this.offX = 0;
    this.offY = 0;
    this.rollA = 0;
    this.poseE = this.extent;
    this.writePose();
  }

  /** Refits in the same frame on any size change, then applies the mode pose, kick, shake and impulse. */
  update(ctx: FrameCtx, width: number, height: number): void {
    const t = this.t;
    const dt = ctx.dtS;
    this.frameDt = dt;
    this.nowMs = ctx.nowMs;
    const reduced = ctx.reducedMotion || this.reducedMode;
    this.reduced = reduced;
    const e = extentOf(this.world !== null ? this.world.canvas : CANVAS);
    if (width > 0 && height > 0 && (width !== this.w || height !== this.h || e !== this.extent)) {
      this.w = width;
      this.h = height;
      this.aspect = width / height;
      this.extent = e;
      fitCore(this.aspect, t.fovDeg, t.tilt, 0, t.margin, t.headroom, e);
      this.d0 = FIT[0];
    }

    // Mode pose.
    this.modeT += dt;
    this.poseTarget();
    if (!this.hasPose) {
      // The first pose is cut, not blended from the constructor's defaults.
      this.fromScale = this.tScale;
      this.fromTilt = this.tTilt;
      this.fromYaw = this.tYaw;
    }
    if (reduced) {
      this.scale = 1;
      this.tilt = t.tilt;
      this.yaw = 0;
    } else if (this.hasPose && this.modeT < BLEND_S) {
      const u = 1 - this.modeT / BLEND_S;
      const k = 1 - u * u * u;
      this.scale = this.fromScale + (this.tScale - this.fromScale) * k;
      this.tilt = this.fromTilt + (this.tTilt - this.fromTilt) * k;
      this.yaw = this.fromYaw + (this.tYaw - this.fromYaw) * k;
    } else {
      this.scale = this.tScale;
      this.tilt = this.tTilt;
      this.yaw = this.tYaw;
    }
    this.hasPose = true;

    // Kick: an instant dolly in that eases back over KICK_S.
    this.kickT += dt;
    let kick = 0;
    if (!reduced && this.kickT < KICK_S) {
      const u = 1 - this.kickT / KICK_S;
      kick = this.kickAmt * u * u * u;
    }
    const D = this.d0 * this.scale * (1 - kick);
    this.dist = D;

    // Shake (trauma squared) and the impulse spring translate the camera along its right and up vectors and keep
    // its orientation, which is the screen-space push of 6.5. 5.10's pseudocode re-aims at the origin after the
    // offset (lookAt), which would turn the push into a small rotation about the board centre.
    const tanV = Math.tan((this.camera.fov * Math.PI) / 360);
    let ox = 0;
    let oy = 0;
    let roll = 0;
    if (reduced) {
      this.trauma = 0;
      this.ix = 0;
      this.iy = 0;
      this.ivx = 0;
      this.ivy = 0;
    } else {
      this.trauma = this.trauma > SHAKE_DECAY * dt ? this.trauma - SHAKE_DECAY * dt : 0;
      if (this.trauma > 0) {
        this.shakeT += dt;
        const shake = this.trauma * this.trauma;
        const n = this.shakeT * SHAKE_HZ;
        ox = shake * D * SHAKE_ANGLE_TAN * valueNoise1(n, 11);
        oy = shake * D * SHAKE_ANGLE_TAN * valueNoise1(n, 23);
        roll = shake * ROLL_MAX * valueNoise1(n, 37);
      }
      if (this.ix !== 0 || this.iy !== 0 || this.ivx !== 0 || this.ivy !== 0) this.stepImpulse();
      ox -= this.ix * D * tanV;
      oy -= this.iy * D * tanV;
    }
    this.offX = ox;
    this.offY = oy;
    this.rollA = roll;
    this.poseE = e;
    this.writePose();
    this.updateBoard(ctx);
  }

  /** Writes the camera matrices, near, far and the projection for the current pose: distance dist, offsets offX and
   *  offY, roll rollA, bounding the board box of extent poseE. Reads fields only, so no double crosses the call. */
  private writePose(): void {
    const t = this.t;
    const D = this.dist;
    const ox = this.offX;
    const oy = this.offY;
    const roll = this.rollA;
    const e = this.poseE;
    // The camera basis for the pose: right r, up u, back b (camera up is +y at yaw 0).
    const tilt = this.tilt;
    const ct = Math.sqrt(1 - tilt * tilt);
    const cyw = Math.cos(this.yaw);
    const syw = Math.sin(this.yaw);
    const bx = -tilt * syw;
    const by = tilt * cyw;
    const bz = ct;
    let rx = cyw;
    let ry = syw;
    let rz = 0;
    let ux = -ct * syw;
    let uy = ct * cyw;
    let uz = -tilt;
    const px = bx * D + rx * ox + ux * oy;
    const py = by * D + ry * ox + uy * oy;
    const pz = bz * D + rz * ox + uz * oy;
    if (roll !== 0) {
      const c = Math.cos(roll);
      const s = Math.sin(roll);
      const nrx = rx * c + ux * s;
      const nry = ry * c + uy * s;
      const nrz = rz * c + uz * s;
      ux = ux * c - rx * s;
      uy = uy * c - ry * s;
      uz = uz * c - rz * s;
      rx = nrx;
      ry = nry;
      rz = nrz;
    }
    const cam = this.camera;
    const m = cam.matrix.elements;
    m[0] = rx;
    m[1] = ry;
    m[2] = rz;
    m[3] = 0;
    m[4] = ux;
    m[5] = uy;
    m[6] = uz;
    m[7] = 0;
    m[8] = bx;
    m[9] = by;
    m[10] = bz;
    m[11] = 0;
    m[12] = px;
    m[13] = py;
    m[14] = pz;
    m[15] = 1;
    cam.position.x = px;
    cam.position.y = py;
    cam.position.z = pz;
    cam.quaternion.setFromRotationMatrix(cam.matrix);   // rotation follows through its onChange callback
    cam.matrixWorldNeedsUpdate = true;

    // Near and far bound the 8 corners at this distance and pose (C24).
    let lo = Infinity;
    let hi = -Infinity;
    for (let c = 0; c < 8; c++) {
      const qx = c & 1 ? e : -e;
      const qy = c & 2 ? e : -e;
      const qz = c & 4 ? t.headroom : 0;
      const depth = D - (qx * bx + qy * by + qz * bz);
      if (depth < lo) lo = depth;
      if (depth > hi) hi = depth;
    }
    const near = NEAR_K * lo;
    const far = FAR_K * hi;
    this.nearV = near;
    this.farV = far;
    cam.near = near;
    cam.far = far;
    cam.aspect = this.aspect;
    cam.fov = t.fovDeg;
    // The symmetric perspective matrix three's makePerspective builds (WebGL clip space, zoom 1, no view offset).
    const f = 1 / Math.tan((t.fovDeg * Math.PI) / 360);
    const pm = cam.projectionMatrix.elements;
    pm[0] = f / this.aspect;
    pm[1] = 0;
    pm[2] = 0;
    pm[3] = 0;
    pm[4] = 0;
    pm[5] = f;
    pm[6] = 0;
    pm[7] = 0;
    pm[8] = 0;
    pm[9] = 0;
    pm[10] = -(far + near) / (far - near);
    pm[11] = -1;
    pm[12] = 0;
    pm[13] = 0;
    pm[14] = (-2 * far * near) / (far - near);
    pm[15] = 0;
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
    cam.updateMatrixWorld(true);
  }

  addTrauma(amount: number): void {
    if (this.reduced || !(amount > 0)) return;
    this.trauma = this.trauma + amount > 1 ? 1 : this.trauma + amount;
  }

  /** Pushes the image toward screen direction (dirX right, dirY up); a damped spring brings it back. */
  impulse(dirX: number, dirY: number, strength: number): void {
    if (this.reduced) return;
    const len = Math.sqrt(dirX * dirX + dirY * dirY);
    if (!(len > 0) || !(strength > 0)) return;
    this.ivx += (dirX / len) * strength * IMPULSE_GAIN;
    this.ivy += (dirY / len) * strength * IMPULSE_GAIN;
  }

  /** A short dolly in by amount x distance (0..0.05), eased back over 0.3 s. */
  kick(amount: number): void {
    if (this.reduced || !(amount > 0)) return;
    this.kickAmt = amount > KICK_MAX ? KICK_MAX : amount;
    this.kickT = 0;
  }

  /** The pose of the current mode at the current mode time, into tScale, tTilt and tYaw. */
  private poseTarget(): void {
    const t = this.t;
    const mode = this.mode;
    const tau = this.modeT;
    this.tScale = 1;
    this.tTilt = t.tilt;
    this.tYaw = 0;
    if (mode === 'lobby') {
      this.tYaw = ((t.lobbyOrbitDeg * Math.PI) / 180) * Math.sin((2 * Math.PI * tau) / LOBBY_ORBIT_PERIOD_S);
    } else if (mode === 'intro') {
      // Timed from the server countdown when it is known, so the dolly finishes at `go` (5.10) however late the
      // intro began; from the mode's own clock otherwise.
      let x: number;
      if (this.introEnd >= 0) {
        const left = (this.introEnd - this.nowMs) / 1000;
        x = left <= 0 ? 1 : left >= INTRO_S ? 0 : 1 - left / INTRO_S;
      } else {
        x = tau >= INTRO_S ? 1 : tau / INTRO_S;
      }
      const p = x * x * (3 - 2 * x);
      this.tScale = t.introScale + (1 - t.introScale) * p;
      this.tTilt = t.introTilt + (t.tilt - t.introTilt) * p;
    } else if (mode === 'gameOver') {
      const x = tau >= GAME_OVER_S ? 1 : tau / GAME_OVER_S;
      const u = 1 - x;
      const p = 1 - u * u * u;
      this.tScale = 1 + (t.gameOverScale - 1) * p;
      this.tYaw = GAME_OVER_ORBIT * p;
    }
  }

  /** Advances the impulse spring by this frame's dt (read from a field: no double crosses the call). */
  private stepImpulse(): void {
    const dt = this.frameDt;
    const steps = dt > 1 / 120 ? Math.ceil(dt * 120) : 1;
    const h = dt / steps;
    const c = 2 * IMPULSE_ZETA * Math.sqrt(IMPULSE_K);
    for (let i = 0; i < steps; i++) {
      this.ivx += (-IMPULSE_K * this.ix - c * this.ivx) * h;
      this.ivy += (-IMPULSE_K * this.iy - c * this.ivy) * h;
      this.ix += this.ivx * h;
      this.iy += this.ivy * h;
    }
    if (Math.abs(this.ix) + Math.abs(this.iy) < 1e-5 && Math.abs(this.ivx) + Math.abs(this.ivy) < 1e-4) {
      this.ix = 0;
      this.iy = 0;
      this.ivx = 0;
      this.ivy = 0;
    }
  }

  /** The board eases to rotationRad(myIndex) over rotationEaseMs with ease-out-cubic, along the shorter way round;
   *  cut on the first frame and under reduced motion. */
  private updateBoard(ctx: FrameCtx): void {
    const dt = this.frameDt;
    const reduced = this.reduced;
    const seat = ctx.myIndex === null ? -1 : ctx.myIndex;
    if (seat !== this.rotSeat) {
      this.rotSeat = seat;
      this.nextTarget = rotationRad(ctx.myIndex);
    }
    const target = this.nextTarget;
    if (target !== this.rotTarget) {
      if (Number.isNaN(this.rotTarget) || reduced) {
        this.rotAngle = target;
        this.rotP = 1;
      } else {
        let delta = (target - this.rotAngle) % (2 * Math.PI);
        if (delta > Math.PI) delta -= 2 * Math.PI;
        else if (delta < -Math.PI) delta += 2 * Math.PI;
        this.rotFrom = this.rotAngle;
        this.rotDelta = delta;
        this.rotP = 0;
      }
      this.rotTarget = target;
    }
    if (this.rotP < 1) {
      if (reduced) {
        this.rotP = 1;
      } else {
        this.rotP += (dt * 1000) / this.t.rotationEaseMs;
        if (this.rotP > 1) this.rotP = 1;
      }
      const u = 1 - this.rotP;
      this.rotAngle = this.rotP >= 1 ? target : this.rotFrom + this.rotDelta * (1 - u * u * u);
    }
    if (this.board !== null && this.board.rotation.z !== this.rotAngle) {
      this.board.rotation.z = this.rotAngle;
      this.board.updateMatrixWorld(true);
    }
  }
}
