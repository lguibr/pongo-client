// Shard pool (6.2): 512 / 256 / 128 boxes (BoxGeometry(1, 1, 0.35)) on an opaque, depth-writing MeshStandardMaterial
// patched through patchStandard, so shards are lit like the bricks they came from. Brick slabs and chips (E26),
// shatters (E27) and the game-over confetti (E45) all come from here.

import * as THREE from 'three';
import type { Rand } from '../../lib/random';
import { patchStandard } from '../../render/materials/patch';
import { InstancedPool } from './gpuPool';
import type { FxUniforms } from './gpuPool';
import { SHARD_FRAGMENT_COLOR, SHARD_FRAGMENT_PARS, SHARD_VERTEX_BEGIN, SHARD_VERTEX_PARS } from '../shaders/shard';

export const SHARD_STRIDE = 20;   // aStart 4, aVel 4, aAxisSpin 4, aColorLife 4, aSize 4

/** One burst's parameters. The caller reuses one object between bursts; the pool reads it only during burst(). */
export interface ShardBurst {
  x: number; y: number; z: number;          // origin, board-local
  dx: number; dy: number;                   // horizontal bias direction; both zero means all around
  spread: number;                           // horizontal half-angle (rad) around (dx, dy)
  speedMin: number; speedMax: number;       // horizontal speed, units per second
  vzMin: number; vzMax: number;             // vertical speed, units per second
  gravity: number; drag: number;
  spinMin: number; spinMax: number;         // rad per second, either sign
  lifeMin: number; lifeMax: number;         // seconds
  sizeMin: number; sizeMax: number;         // box edge along x; y is 60-100 % of it
  thick: number;                            // z scale of the 0.35-thick box
  sx: number; sy: number; sz: number;       // all > 0: this exact scale for every shard (a brick's top slab)
  spanX: number; spanY: number;             // start positions spread along origin -/+ span
  jitter: number;                           // and over a disc of this radius
  r: number; g: number; b: number;          // linear colour
  t0: number;                               // spawn time (s)
}

export function shardBurst(): ShardBurst {
  return resetShardBurst({
    x: 0.5, y: 0.5, z: 0.5, dx: 0.5, dy: 0.5, spread: 0.5, speedMin: 0.5, speedMax: 0.5, vzMin: 0.5, vzMax: 0.5,
    gravity: 0.5, drag: 0.5, spinMin: 0.5, spinMax: 0.5, lifeMin: 0.5, lifeMax: 0.5, sizeMin: 0.5, sizeMax: 0.5,
    thick: 0.5, sx: 0.5, sy: 0.5, sz: 0.5, spanX: 0.5, spanY: 0.5, jitter: 0.5, r: 0.5, g: 0.5, b: 0.5, t0: 0.5,
  }, 0);
}

/** Restores the defaults in place: grey chips bursting all around and up, falling under gravity for about 0.9 s. */
export function resetShardBurst(b: ShardBurst, t0: number): ShardBurst {
  b.x = 0;
  b.y = 0;
  b.z = 10;
  b.dx = 0;
  b.dy = 0;
  b.spread = Math.PI;
  b.speedMin = 60;
  b.speedMax = 200;
  b.vzMin = 140;
  b.vzMax = 300;
  b.gravity = 700;
  b.drag = 1.2;
  b.spinMin = 4;
  b.spinMax = 14;
  b.lifeMin = 0.8;
  b.lifeMax = 0.9;
  b.sizeMin = 5;
  b.sizeMax = 10;
  b.thick = 1;
  b.sx = 0;
  b.sy = 0;
  b.sz = 0;
  b.spanX = 0;
  b.spanY = 0;
  b.jitter = 0;
  b.r = 0.6;
  b.g = 0.6;
  b.b = 0.6;
  b.t0 = t0;
  return b;
}

export class ShardPool {
  readonly pool: InstancedPool;
  private readonly rand: Rand;
  private cur: ShardBurst = shardBurst();

  constructor(u: FxUniforms, maxCapacity: number, capacity: number, rand: Rand) {
    this.rand = rand;
    const material = patchStandard(new THREE.MeshStandardMaterial({ name: 'fxShards', color: 0xffffff, roughness: 0.55, metalness: 0.05 }), {
      name: 'fxShard',
      uniforms: { uFxTime: u.uFxTime },
      vertexPars: SHARD_VERTEX_PARS,
      vertexBegin: SHARD_VERTEX_BEGIN,
      fragmentPars: SHARD_FRAGMENT_PARS,
      fragmentColor: SHARD_FRAGMENT_COLOR,
    });
    this.pool = new InstancedPool({
      name: 'fxShards', geometry: new THREE.BoxGeometry(1, 1, 0.35), material, stride: SHARD_STRIDE,
      attributes: [
        { name: 'aStart', size: 4, offset: 0 }, { name: 'aVel', size: 4, offset: 4 },
        { name: 'aAxisSpin', size: 4, offset: 8 }, { name: 'aColorLife', size: 4, offset: 12 },
        { name: 'aSize', size: 4, offset: 16 },
      ],
      t0: 3, life: 15, maxCapacity, capacity, uniforms: u, renderOrder: 0,
    });
  }

  /** Spawns `n` shards (already granted by the budget) from `b`; returns how many were written. */
  burst(n: number, b: ShardBurst): number {
    if (!(n >= 1)) return 0;
    this.cur = b;
    return this.pool.spawn(n, this.write);
  }

  private readonly write = (_i: number, a: Float32Array, o: number): void => {
    const b = this.cur;
    const rand = this.rand;
    const all = b.dx === 0 && b.dy === 0;
    const heading = all ? 2 * Math.PI * rand() : Math.atan2(b.dy, b.dx) + (2 * rand() - 1) * b.spread;
    const hs = b.speedMin + (b.speedMax - b.speedMin) * rand();
    const along = 2 * rand() - 1;
    let sx = b.x + b.spanX * along;
    let sy = b.y + b.spanY * along;
    if (b.jitter > 0) {
      const jr = b.jitter * Math.sqrt(rand());
      const ja = 2 * Math.PI * rand();
      sx += jr * Math.cos(ja);
      sy += jr * Math.sin(ja);
    }
    // a uniform random axis
    const az = 1 - 2 * rand();
    const as = Math.sqrt(1 - az * az);
    const ap = 2 * Math.PI * rand();
    const spin = (b.spinMin + (b.spinMax - b.spinMin) * rand()) * (rand() < 0.5 ? -1 : 1);
    a[o] = sx;
    a[o + 1] = sy;
    a[o + 2] = b.z;
    a[o + 3] = b.t0;
    a[o + 4] = Math.cos(heading) * hs;
    a[o + 5] = Math.sin(heading) * hs;
    a[o + 6] = b.vzMin + (b.vzMax - b.vzMin) * rand();
    a[o + 7] = b.gravity;
    a[o + 8] = as * Math.cos(ap);
    a[o + 9] = as * Math.sin(ap);
    a[o + 10] = az;
    a[o + 11] = spin;
    a[o + 12] = b.r;
    a[o + 13] = b.g;
    a[o + 14] = b.b;
    a[o + 15] = b.lifeMin + (b.lifeMax - b.lifeMin) * rand();
    if (b.sx > 0 && b.sy > 0 && b.sz > 0) {
      a[o + 16] = b.sx;
      a[o + 17] = b.sy;
      a[o + 18] = b.sz;
    } else {
      const s = b.sizeMin + (b.sizeMax - b.sizeMin) * rand();
      a[o + 16] = s;
      a[o + 17] = s * (0.6 + 0.4 * rand());
      a[o + 18] = s * b.thick;
    }
    a[o + 19] = b.drag;
  };
}
