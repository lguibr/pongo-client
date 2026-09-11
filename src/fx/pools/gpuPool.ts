// Generic instanced GPU pool (6.2, D12). One Mesh over an InstancedBufferGeometry whose per-instance attributes live
// in one interleaved Float32Array. Motion is analytic in the vertex shader, from the spawn attributes and uFxTime, so
// after a spawn the CPU does nothing per frame. A spawn writes at a ring-buffer index: when the pool is full the
// oldest instance is overwritten (oldest-first stealing), and the instance count stays at capacity. A dead instance
// (t outside [0, life)) outputs a degenerate position, which costs no CPU. The buffers are sized for the largest tier,
// so a tier change only moves the capacity and never reallocates or changes a program (2.1 principle 4). Live
// instances below the new capacity survive a tier change; every slot at or above the capacity is always dead.

import * as THREE from 'three';
import { NumberUniform } from '../../render/materials/patch';

export interface GpuPool {
  readonly capacity: number;
  readonly live: number;
  readonly object: THREE.Object3D;
  spawn(n: number, init: (i: number, a: Float32Array, o: number) => void): number;
  setTime(t: number): void;
  clear(): void;
  dispose(): void;
}

/** Uniforms every FX material shares, so one write per frame reaches every program. */
export interface FxUniforms {
  readonly uFxTime: NumberUniform;   // presentation time in seconds (FrameCtx.fxTimeS); stands still in hit-stop
  readonly uHdr: NumberUniform;      // 1, or HDR.lowBitScale when the composer runs on 8-bit buffers (6.4)
}

export function createFxUniforms(): FxUniforms {
  return { uFxTime: new NumberUniform(0), uHdr: new NumberUniform(1) };
}

export interface PoolAttribute { readonly name: string; readonly size: number; readonly offset: number }

export interface PoolSpec {
  readonly name: string;
  /** The per-instance shape. Its attributes are shared with the pool's geometry; it is disposed with the pool. */
  readonly geometry: THREE.BufferGeometry;
  readonly material: THREE.Material;
  readonly stride: number;                       // floats per instance
  readonly attributes: readonly PoolAttribute[]; // views into the interleaved instance buffer
  readonly t0: number;                           // offset of the spawn time (s) inside an instance
  readonly life: number;                         // offset of the lifetime (s) inside an instance
  readonly maxCapacity: number;
  readonly capacity: number;
  readonly uniforms: FxUniforms;
  readonly renderOrder: number;
}

/** A spawn time far in the past: an instance written with it is dead. */
export const DEAD_T0 = -1e6;
/** Every pool's bounds are the board (6.2), with room for sparks thrown above it. */
const BOUNDS_R = 1200;

export class InstancedPool implements GpuPool {
  readonly object: THREE.Mesh;
  /** The interleaved instance data: `stride` floats per instance, `maxCapacity` instances. */
  readonly array: Float32Array;
  readonly maxCapacity: number;
  readonly stride: number;
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly base: THREE.BufferGeometry;
  private readonly material: THREE.Material;
  private readonly buffer: THREE.InstancedInterleavedBuffer;
  private readonly uniforms: FxUniforms;
  private readonly t0Off: number;
  private readonly lifeOff: number;
  private readonly endAt: Float64Array;   // spawn time + life per instance; -Infinity when dead
  private readonly range = { start: 0, count: 0 };
  private cap = 1;
  private head = 0;
  private now = 0.5;
  private liveN = 0;
  private liveAt = -1.5;
  private liveDirty = true;
  /** A whole upload is pending (after clear), so spawns must not narrow it to a range. */
  private wholePending = true;

  private readonly uploaded = (): void => {
    this.wholePending = false;
  };

  constructor(spec: PoolSpec) {
    this.maxCapacity = spec.maxCapacity;
    this.stride = spec.stride;
    this.t0Off = spec.t0;
    this.lifeOff = spec.life;
    this.uniforms = spec.uniforms;
    this.material = spec.material;
    this.base = spec.geometry;
    this.array = new Float32Array(spec.maxCapacity * spec.stride);
    this.endAt = new Float64Array(spec.maxCapacity).fill(-Infinity);
    this.buffer = new THREE.InstancedInterleavedBuffer(this.array, spec.stride, 1);
    this.buffer.setUsage(THREE.DynamicDrawUsage);
    this.buffer.onUpload(this.uploaded);

    const g = new THREE.InstancedBufferGeometry();
    g.setIndex(this.base.getIndex());
    for (const name of Object.keys(this.base.attributes)) g.setAttribute(name, this.base.getAttribute(name));
    for (const a of spec.attributes) g.setAttribute(a.name, new THREE.InterleavedBufferAttribute(this.buffer, a.size, a.offset));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), BOUNDS_R);
    g.boundingBox = new THREE.Box3(new THREE.Vector3(-BOUNDS_R, -BOUNDS_R, -BOUNDS_R), new THREE.Vector3(BOUNDS_R, BOUNDS_R, BOUNDS_R));
    this.geometry = g;

    this.object = new THREE.Mesh(g, spec.material);
    this.object.name = spec.name;
    this.object.frustumCulled = false;
    this.object.matrixAutoUpdate = false;
    this.object.renderOrder = spec.renderOrder;
    this.now = 0;
    this.setCapacity(spec.capacity);
    this.clear();
  }

  get capacity(): number {
    return this.cap;
  }

  /** Instances whose spawn time plus life lies after the last setTime (a delayed spawn counts from its spawn). */
  get live(): number {
    if (this.liveDirty || this.liveAt !== this.now) {
      const e = this.endAt;
      const now = this.now;
      let n = 0;
      for (let i = 0; i < this.cap; i++) if (e[i] > now) n++;
      this.liveN = n;
      this.liveAt = now;
      this.liveDirty = false;
    }
    return this.liveN;
  }

  /** Free slots at the last setTime. */
  get free(): number {
    return this.cap - this.live;
  }

  /** The instance count the geometry draws (always the capacity). */
  get drawCount(): number {
    return this.geometry.instanceCount;
  }

  /** Writes `n` instances (at most the capacity) at the ring head through `init(i, array, offset)`. */
  spawn(n: number, init: (i: number, a: Float32Array, o: number) => void): number {
    let k = n > 0 ? Math.floor(n) : 0;
    if (k === 0) return 0;
    if (k > this.cap) k = this.cap;
    const a = this.array;
    const s = this.stride;
    const first = this.head;
    for (let i = 0; i < k; i++) {
      const slot = this.head;
      const o = slot * s;
      init(i, a, o);
      this.endAt[slot] = a[o + this.t0Off] + a[o + this.lifeOff];
      this.head = slot + 1 === this.cap ? 0 : slot + 1;
    }
    this.mark(first, k);
    this.liveDirty = true;
    return k;
  }

  setTime(t: number): void {
    this.now = t;
    this.uniforms.uFxTime.value = t;
  }

  /** Kills every instance and uploads the whole buffer. */
  clear(): void {
    const a = this.array;
    const s = this.stride;
    for (let i = 0; i < this.maxCapacity; i++) {
      a[i * s + this.t0Off] = DEAD_T0;
      a[i * s + this.lifeOff] = 0;
    }
    this.endAt.fill(-Infinity);
    this.head = 0;
    this.liveDirty = true;
    this.buffer.clearUpdateRanges();
    this.wholePending = true;
    this.buffer.needsUpdate = true;
  }

  /** The tier's capacity (1..maxCapacity). Instances below it keep running. A growth adds free slots, which are dead
   *  already (clear() at construction and every shrink killed them) and needs no upload. A shrink kills the slots
   *  from the new capacity up, moves the ring head below it and uploads the whole buffer. */
  setCapacity(n: number): void {
    const c = Math.floor(n);
    const next = c >= 1 ? (c > this.maxCapacity ? this.maxCapacity : c) : 1;
    const prev = this.cap;
    this.cap = next;
    this.geometry.instanceCount = next;
    if (next < prev) {
      const a = this.array;
      const s = this.stride;
      for (let i = next; i < prev; i++) {
        a[i * s + this.t0Off] = DEAD_T0;
        a[i * s + this.lifeOff] = 0;
        this.endAt[i] = -Infinity;
      }
      if (this.head >= next) this.head = 0;
      this.buffer.clearUpdateRanges();
      this.wholePending = true;
      this.buffer.needsUpdate = true;
    }
    this.liveDirty = true;
  }

  /** Marks the context's buffer for a whole upload (context restore). */
  markNeedsUpdate(): void {
    this.buffer.clearUpdateRanges();
    this.wholePending = true;
    this.buffer.needsUpdate = true;
  }

  dispose(): void {
    this.object.removeFromParent();
    this.geometry.dispose();
    this.base.dispose();
    this.material.dispose();
  }

  /** One reused range per upload: spawns in the same frame merge into it. A wrap uploads the pool's whole span. */
  private mark(first: number, k: number): void {
    const s = this.stride;
    const lo = first + k <= this.cap ? first * s : 0;
    const hi = first + k <= this.cap ? (first + k) * s : this.cap * s;
    this.buffer.needsUpdate = true;
    if (this.wholePending) return;
    const ranges = this.buffer.updateRanges;
    const r = this.range;
    if (ranges.length === 0) {
      r.start = lo;
      r.count = hi - lo;
      ranges.push(r);
    } else if (ranges.length === 1 && ranges[0] === r) {
      const end = r.start + r.count > hi ? r.start + r.count : hi;
      r.start = r.start < lo ? r.start : lo;
      r.count = end - r.start;
    } else {
      this.buffer.clearUpdateRanges();
      this.wholePending = true;
    }
  }
}

/** Marks a whole interleaved buffer for upload without a range (per-frame writers: trails and shells). */
export function markWhole(buffer: THREE.InterleavedBuffer | THREE.BufferAttribute): void {
  buffer.clearUpdateRanges();
  buffer.needsUpdate = true;
}
