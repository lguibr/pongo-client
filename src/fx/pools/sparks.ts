// Spark pool (6.2): 2048 / 1024 / 384 velocity-stretched quads, additive, depth-tested without depth writes. A
// burst samples directions in a cone (or a sphere), speeds and lifetimes from the director's seeded random source.
// `converge` makes sparks start out on a shell and meet at the origin when they die (E24 absorb, E30 join); a
// converging sphere burst uses the upper hemisphere of that shell.

import * as THREE from 'three';
import type { Rand } from '../../lib/random';
import { HDR } from '../../config/palette';
import { InstancedPool } from './gpuPool';
import type { FxUniforms } from './gpuPool';
import { SPARK_FRAGMENT, SPARK_VERTEX } from '../shaders/spark';

export const SPARK_STRIDE = 16;   // aStart 4, aVel 4, aColor 4, aParams 4

/** One burst's parameters. The caller reuses one object between bursts; the pool reads it only during burst(). */
export interface SparkBurst {
  x: number; y: number; z: number;          // origin, board-local
  dx: number; dy: number; dz: number;       // main direction (any length); all zero means every direction
  spread: number;                           // cone half-angle (rad); Math.PI is a sphere
  speedMin: number; speedMax: number;       // units per second
  lifeMin: number; lifeMax: number;         // seconds
  size: number; drag: number; gravity: number; stretch: number;
  r: number; g: number; b: number; hdr: number;   // linear colour and HDR multiplier
  converge: number;                         // > 0: start this far out and reach the origin at the end of life
  jitter: number;                           // start positions spread over a disc of this radius
  t0: number;                               // spawn time (s)
}

export function sparkBurst(): SparkBurst {
  return resetSparkBurst({
    x: 0.5, y: 0.5, z: 0.5, dx: 0.5, dy: 0.5, dz: 0.5, spread: 0.5, speedMin: 0.5, speedMax: 0.5, lifeMin: 0.5,
    lifeMax: 0.5, size: 0.5, drag: 0.5, gravity: 0.5, stretch: 0.5, r: 0.5, g: 0.5, b: 0.5, hdr: 0.5, converge: 0.5,
    jitter: 0.5, t0: 0.5,
  }, 0);
}

/** Restores the defaults in place: a white HDR sphere burst at the origin, 80-200 units/s, 0.3-0.5 s. */
export function resetSparkBurst(b: SparkBurst, t0: number): SparkBurst {
  b.x = 0;
  b.y = 0;
  b.z = 6;
  b.dx = 0;
  b.dy = 0;
  b.dz = 0;
  b.spread = Math.PI;
  b.speedMin = 80;
  b.speedMax = 200;
  b.lifeMin = 0.3;
  b.lifeMax = 0.5;
  b.size = 2.5;
  b.drag = 4;
  b.gravity = 250;
  b.stretch = 0.025;
  b.r = 1;
  b.g = 1;
  b.b = 1;
  b.hdr = HDR.spark;
  b.converge = 0;
  b.jitter = 0;
  b.t0 = t0;
  return b;
}

export class SparkPool {
  readonly pool: InstancedPool;
  private readonly rand: Rand;
  private cur: SparkBurst = sparkBurst();
  // The current burst's cone basis (u, v across, w along) and the cosine of its half-angle.
  private ux = 0.5; private uy = 0.5; private uz = 0.5;
  private vx = 0.5; private vy = 0.5; private vz = 0.5;
  private wx = 0.5; private wy = 0.5; private wz = 0.5;
  private cosMin = 0.5;
  private sphere = false;

  constructor(u: FxUniforms, maxCapacity: number, capacity: number, rand: Rand) {
    this.rand = rand;
    const material = new THREE.ShaderMaterial({
      name: 'fxSparks',
      uniforms: { uFxTime: u.uFxTime, uHdr: u.uHdr },
      vertexShader: SPARK_VERTEX,
      fragmentShader: SPARK_FRAGMENT,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
    });
    this.pool = new InstancedPool({
      name: 'fxSparks', geometry: new THREE.PlaneGeometry(1, 1), material, stride: SPARK_STRIDE,
      attributes: [
        { name: 'aStart', size: 4, offset: 0 }, { name: 'aVel', size: 4, offset: 4 },
        { name: 'aColor', size: 4, offset: 8 }, { name: 'aParams', size: 4, offset: 12 },
      ],
      t0: 3, life: 7, maxCapacity, capacity, uniforms: u, renderOrder: 5,
    });
  }

  /** Spawns `n` sparks (already granted by the budget) from `b`; returns how many were written. */
  burst(n: number, b: SparkBurst): number {
    if (!(n >= 1)) return 0;
    this.cur = b;
    const len = Math.sqrt(b.dx * b.dx + b.dy * b.dy + b.dz * b.dz);
    this.sphere = !(len > 1e-9) || b.spread >= Math.PI - 1e-6;
    if (!this.sphere) {
      this.wx = b.dx / len;
      this.wy = b.dy / len;
      this.wz = b.dz / len;
      // u = normalize(helper x w), v = w x u
      const hz = Math.abs(this.wz) < 0.9 ? 1 : 0;
      const hx = 1 - hz;
      let ux = -hz * this.wy;
      let uy = hz * this.wx - hx * this.wz;
      let uz = hx * this.wy;
      const ul = Math.sqrt(ux * ux + uy * uy + uz * uz);
      ux /= ul;
      uy /= ul;
      uz /= ul;
      this.ux = ux;
      this.uy = uy;
      this.uz = uz;
      this.vx = this.wy * uz - this.wz * uy;
      this.vy = this.wz * ux - this.wx * uz;
      this.vz = this.wx * uy - this.wy * ux;
      this.cosMin = Math.cos(b.spread);
    }
    return this.pool.spawn(n, this.write);
  }

  private readonly write = (_i: number, a: Float32Array, o: number): void => {
    const b = this.cur;
    const rand = this.rand;
    let dx: number;
    let dy: number;
    let dz: number;
    const phi = 2 * Math.PI * rand();
    if (this.sphere) {
      dz = 1 - 2 * rand();
      // A converging burst starts on the upper hemisphere only, so no spark starts below the origin (under the floor).
      if (b.converge > 0 && dz < 0) dz = -dz;
      const s = Math.sqrt(1 - dz * dz);
      dx = s * Math.cos(phi);
      dy = s * Math.sin(phi);
    } else {
      const c = 1 - rand() * (1 - this.cosMin);
      const s = Math.sqrt(1 - c * c);
      const cp = s * Math.cos(phi);
      const sp = s * Math.sin(phi);
      dx = this.ux * cp + this.vx * sp + this.wx * c;
      dy = this.uy * cp + this.vy * sp + this.wy * c;
      dz = this.uz * cp + this.vz * sp + this.wz * c;
    }
    const life = b.lifeMin + (b.lifeMax - b.lifeMin) * rand();
    let sx = b.x;
    let sy = b.y;
    let sz = b.z;
    if (b.jitter > 0) {
      const jr = b.jitter * Math.sqrt(rand());
      const ja = 2 * Math.PI * rand();
      sx += jr * Math.cos(ja);
      sy += jr * Math.sin(ja);
    }
    let drag = b.drag;
    let gravity = b.gravity;
    let speed: number;
    if (b.converge > 0) {
      sx += dx * b.converge;
      sy += dy * b.converge;
      sz += dz * b.converge;
      dx = -dx;
      dy = -dy;
      dz = -dz;
      speed = b.converge / life;
      drag = 0;
      gravity = 0;
    } else {
      speed = b.speedMin + (b.speedMax - b.speedMin) * rand();
    }
    a[o] = sx;
    a[o + 1] = sy;
    a[o + 2] = sz;
    a[o + 3] = b.t0;
    a[o + 4] = dx * speed;
    a[o + 5] = dy * speed;
    a[o + 6] = dz * speed;
    a[o + 7] = life;
    a[o + 8] = b.r;
    a[o + 9] = b.g;
    a[o + 10] = b.b;
    a[o + 11] = b.hdr;
    a[o + 12] = b.size * (0.7 + 0.6 * rand());
    a[o + 13] = drag;
    a[o + 14] = gravity;
    a[o + 15] = b.stretch;
  };
}
