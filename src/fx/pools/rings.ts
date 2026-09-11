// Ring pool (6.2): 64 / 48 / 32 flat additive SDF rings: shockwaves, ownership rings, implosions (r1 < r0).

import * as THREE from 'three';
import { HDR } from '../../config/palette';
import { InstancedPool } from './gpuPool';
import type { FxUniforms } from './gpuPool';
import { RING_FRAGMENT, RING_VERTEX } from '../shaders/ring';

export const RING_STRIDE = 12;   // aCenter 4, aParams 4, aColor 4

/** One ring. The caller reuses one object; the pool reads it only during ring(). */
export interface RingSpec {
  x: number; y: number; z: number;   // centre, board-local
  r0: number; r1: number;            // start and end radius
  dur: number; width: number;        // seconds; band half-width
  r: number; g: number; b: number; hdr: number;
  t0: number;                        // spawn time (s); later than now delays the ring
}

export function ringSpec(): RingSpec {
  return resetRingSpec({ x: 0.5, y: 0.5, z: 0.5, r0: 0.5, r1: 0.5, dur: 0.5, width: 0.5, r: 0.5, g: 0.5, b: 0.5, hdr: 0.5, t0: 0.5 }, 0);
}

/** Restores the defaults in place: a white shockwave on the floor, 0 -> 40 units over 0.25 s. */
export function resetRingSpec(s: RingSpec, t0: number): RingSpec {
  s.x = 0;
  s.y = 0;
  s.z = 0.6;
  s.r0 = 0;
  s.r1 = 40;
  s.dur = 0.25;
  s.width = 3;
  s.r = 1;
  s.g = 1;
  s.b = 1;
  s.hdr = HDR.ring;
  s.t0 = t0;
  return s;
}

export class RingPool {
  readonly pool: InstancedPool;
  private cur: RingSpec = ringSpec();

  constructor(u: FxUniforms, maxCapacity: number, capacity: number) {
    const material = new THREE.ShaderMaterial({
      name: 'fxRings',
      uniforms: { uFxTime: u.uFxTime, uHdr: u.uHdr },
      vertexShader: RING_VERTEX,
      fragmentShader: RING_FRAGMENT,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
    });
    this.pool = new InstancedPool({
      name: 'fxRings', geometry: new THREE.PlaneGeometry(1, 1), material, stride: RING_STRIDE,
      attributes: [{ name: 'aCenter', size: 4, offset: 0 }, { name: 'aParams', size: 4, offset: 4 }, { name: 'aColor', size: 4, offset: 8 }],
      t0: 3, life: 6, maxCapacity, capacity, uniforms: u, renderOrder: 2,
    });
  }

  /** Spawns one ring from `s`; returns 1, or 0 when `n` (the budget's grant) is 0. */
  ring(s: RingSpec, n = 1): number {
    if (!(n >= 1)) return 0;
    this.cur = s;
    return this.pool.spawn(1, this.write);
  }

  private readonly write = (_i: number, a: Float32Array, o: number): void => {
    const s = this.cur;
    a[o] = s.x;
    a[o + 1] = s.y;
    a[o + 2] = s.z;
    a[o + 3] = s.t0;
    a[o + 4] = s.r0;
    a[o + 5] = s.r1;
    a[o + 6] = s.dur;
    a[o + 7] = s.width;
    a[o + 8] = s.r;
    a[o + 9] = s.g;
    a[o + 10] = s.b;
    a[o + 11] = s.hdr;
  };
}
