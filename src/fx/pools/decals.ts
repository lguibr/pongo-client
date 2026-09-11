// Decal pool (6.2): 64 / 48 / 32 floor quads with premultiplied blending, so one material both darkens (scorch, E27)
// and glows (the reduced-motion winner glow, E45). Offset toward the camera so it never fights the floor.

import * as THREE from 'three';
import { InstancedPool } from './gpuPool';
import type { FxUniforms } from './gpuPool';
import { DECAL_FRAGMENT, DECAL_VERTEX } from '../shaders/decal';

export const DECAL_STRIDE = 12;   // aCenter 4, aParams 4, aColor 4
export const DecalKind = { Scorch: 0, Glow: 1 } as const;

/** One decal. The caller reuses one object; the pool reads it only during decal(). */
export interface DecalSpec {
  x: number; y: number; z: number;   // centre, board-local
  rot: number;                       // radians about +z
  size: number;                      // half extent
  dur: number;                       // seconds to fade out
  kind: number;                      // DecalKind
  r: number; g: number; b: number; strength: number;   // linear ember or glow colour
  t0: number;                        // spawn time (s)
}

export function decalSpec(): DecalSpec {
  return resetDecalSpec({ x: 0.5, y: 0.5, z: 0.5, rot: 0.5, size: 0.5, dur: 0.5, kind: 0.5, r: 0.5, g: 0.5, b: 0.5, strength: 0.5, t0: 0.5 }, 0);
}

/** Restores the defaults in place: a 2 s scorch with an orange ember rim. */
export function resetDecalSpec(s: DecalSpec, t0: number): DecalSpec {
  s.x = 0;
  s.y = 0;
  s.z = 0.3;
  s.rot = 0;
  s.size = 24;
  s.dur = 2;
  s.kind = DecalKind.Scorch;
  s.r = 1;
  s.g = 0.45;
  s.b = 0.15;
  s.strength = 0.8;
  s.t0 = t0;
  return s;
}

export class DecalPool {
  readonly pool: InstancedPool;
  private cur: DecalSpec = decalSpec();

  constructor(u: FxUniforms, maxCapacity: number, capacity: number) {
    const material = new THREE.ShaderMaterial({
      name: 'fxDecals',
      uniforms: { uFxTime: u.uFxTime, uHdr: u.uHdr },
      vertexShader: DECAL_VERTEX,
      fragmentShader: DECAL_FRAGMENT,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -4,
    });
    this.pool = new InstancedPool({
      name: 'fxDecals', geometry: new THREE.PlaneGeometry(1, 1), material, stride: DECAL_STRIDE,
      attributes: [{ name: 'aCenter', size: 4, offset: 0 }, { name: 'aParams', size: 4, offset: 4 }, { name: 'aColor', size: 4, offset: 8 }],
      t0: 5, life: 6, maxCapacity, capacity, uniforms: u, renderOrder: 1,
    });
  }

  /** Spawns one decal from `s`; returns 1, or 0 when `n` (the budget's grant) is 0. */
  decal(s: DecalSpec, n = 1): number {
    if (!(n >= 1)) return 0;
    this.cur = s;
    return this.pool.spawn(1, this.write);
  }

  private readonly write = (_i: number, a: Float32Array, o: number): void => {
    const s = this.cur;
    a[o] = s.x;
    a[o + 1] = s.y;
    a[o + 2] = s.z;
    a[o + 3] = s.rot;
    a[o + 4] = s.size;
    a[o + 5] = s.t0;
    a[o + 6] = s.dur;
    a[o + 7] = s.kind;
    a[o + 8] = s.r;
    a[o + 9] = s.g;
    a[o + 10] = s.b;
    a[o + 11] = s.strength;
  };
}
