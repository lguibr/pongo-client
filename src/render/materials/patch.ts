// Shared stage plumbing (6.6): `patchStandard`, the uniforms every stage material shares, the dependencies every
// entity system takes, and the allocation-free instance writers the systems use on the per-frame path.

import * as THREE from 'three';
import type { RenderState, World } from '../../game/types';
import { log } from '../../lib/log';

/** A numeric uniform with a shape of its own. Plain `{ value }` literals share one hidden class with texture and
 *  colour uniforms, whose `value` is an object, so a number written there is boxed on every write; here it stays a
 *  double field, written in place (the per-frame path allocates nothing). The field starts as a double: a class
 *  field without an initializer is defined as undefined first, which would make it a tagged field for good. */
export class NumberUniform implements THREE.IUniform<number> {
  value = 0.5;

  constructor(value: number) {
    this.value = value;
  }
}

/** Uniform objects shared by every stage material, so one write reaches every program. */
export interface SharedUniforms {
  readonly uTime: NumberUniform;     // presentation time in seconds (FrameCtx.fxTimeS); stands still in hit-stop
  readonly uDim: NumberUniform;      // 0.35 lobby, 1 play, 0.4 frozen (EntityFx.setDim)
  readonly uReduced: NumberUniform;  // 1 under reduced motion (6.3)
  readonly uHdr: NumberUniform;      // 1, or HDR.lowBitScale when the composer runs on 8-bit buffers (6.4)
}

export function createSharedUniforms(): SharedUniforms {
  return { uTime: new NumberUniform(0), uDim: new NumberUniform(1), uReduced: new NumberUniform(0), uHdr: new NumberUniform(1) };
}

/** What every entity system is built from. The systems read `render` (display time) and `world` (geometry and
 *  brick levels); they write only their own GPU buffers (2.1 principle 1). */
export interface SystemDeps {
  readonly board: THREE.Group;
  readonly render: Readonly<RenderState>;
  readonly world: Readonly<World>;
  readonly shared: SharedUniforms;
}

/** The chunks patchStandard injects around, as they appear in three r176's standard material. */
export const ANCHORS = {
  common: '#include <common>',
  begin: '#include <begin_vertex>',
  color: '#include <color_fragment>',
  alphaHash: '#include <alphahash_fragment>',
  emissive: '#include <emissivemap_fragment>',
} as const;

export interface StandardPatch {
  /** Program cache key suffix; one per material factory, so the program set stays fixed (C59). */
  name: string;
  uniforms: Record<string, THREE.IUniform>;
  vertexPars?: string;        // after #include <common> (vertex)
  vertexBegin?: string;       // after #include <begin_vertex>; `transformed` and `position` are in scope
  fragmentPars?: string;      // after #include <common> (fragment)
  fragmentColor?: string;     // after #include <color_fragment>; `diffuseColor` is in scope
  fragmentAlpha?: string;     // before #include <alphahash_fragment>
  fragmentEmissive?: string;  // after #include <emissivemap_fragment>; `totalEmissiveRadiance` is in scope
}

/** Anchors of `patch` missing from the given sources (empty when the patch applies cleanly). */
export function missingAnchors(vertexShader: string, fragmentShader: string, patch: StandardPatch): string[] {
  const missing: string[] = [];
  const need = (src: string, anchor: string, used: string | undefined, where: string): void => {
    if (used !== undefined && !src.includes(anchor)) missing.push(`${where} ${anchor}`);
  };
  need(vertexShader, ANCHORS.common, patch.vertexPars, 'vertex');
  need(vertexShader, ANCHORS.begin, patch.vertexBegin, 'vertex');
  need(fragmentShader, ANCHORS.common, patch.fragmentPars, 'fragment');
  need(fragmentShader, ANCHORS.color, patch.fragmentColor, 'fragment');
  need(fragmentShader, ANCHORS.alphaHash, patch.fragmentAlpha, 'fragment');
  need(fragmentShader, ANCHORS.emissive, patch.fragmentEmissive, 'fragment');
  return missing;
}

function after(src: string, anchor: string, code: string | undefined): string {
  return code === undefined ? src : src.replace(anchor, () => `${anchor}\n${code}`);
}

function before(src: string, anchor: string, code: string | undefined): string {
  return code === undefined ? src : src.replace(anchor, () => `${code}\n${anchor}`);
}

/** Patches a MeshStandardMaterial through onBeforeCompile. It asserts that every anchor it uses exists (three is
 *  pinned at 0.176.0, risk 4) and warns in DEV when one is missing; that part of the patch is then skipped. */
export function patchStandard<M extends THREE.MeshStandardMaterial>(material: M, patch: StandardPatch): M {
  material.onBeforeCompile = (shader) => {
    const missing = missingAnchors(shader.vertexShader, shader.fragmentShader, patch);
    if (missing.length > 0 && import.meta.env.DEV) log.warn(`patchStandard(${patch.name}): missing ${missing.join(', ')}`);
    Object.assign(shader.uniforms, patch.uniforms);
    let vs = shader.vertexShader;
    vs = after(vs, ANCHORS.common, patch.vertexPars);
    vs = after(vs, ANCHORS.begin, patch.vertexBegin);
    let fs = shader.fragmentShader;
    fs = after(fs, ANCHORS.common, patch.fragmentPars);
    fs = after(fs, ANCHORS.color, patch.fragmentColor);
    fs = before(fs, ANCHORS.alphaHash, patch.fragmentAlpha);
    fs = after(fs, ANCHORS.emissive, patch.fragmentEmissive);
    shader.vertexShader = vs;
    shader.fragmentShader = fs;
  };
  material.customProgramCacheKey = () => `pongo:${patch.name}`;
  return material;
}

// ---- instance writers (per-frame path; nothing here allocates) ----

/** Inputs of writeTRS, written in place by the caller: sx, sy, sz, tx, ty, tz, angle (radians about +z). Passing
 *  the doubles through a typed array keeps them unboxed across the call. */
export const TRS = new Float64Array(7);

/** Writes the column-major matrix T(tx, ty, tz) * Rz(angle) * S(sx, sy, sz) from TRS at out[o .. o + 16). */
export function writeTRS(out: Float32Array, o: number): void {
  const a = TRS[6];
  const c = a === 0 ? 1 : Math.cos(a);
  const s = a === 0 ? 0 : Math.sin(a);
  const sx = TRS[0];
  const sy = TRS[1];
  out[o] = c * sx;
  out[o + 1] = s * sx;
  out[o + 2] = 0;
  out[o + 3] = 0;
  out[o + 4] = -s * sy;
  out[o + 5] = c * sy;
  out[o + 6] = 0;
  out[o + 7] = 0;
  out[o + 8] = 0;
  out[o + 9] = 0;
  out[o + 10] = TRS[2];
  out[o + 11] = 0;
  out[o + 12] = TRS[3];
  out[o + 13] = TRS[4];
  out[o + 14] = TRS[5];
  out[o + 15] = 1;
}

/** A degenerate (zero-scale) matrix: the instance draws nothing and costs no CPU. */
export function writeHidden(out: Float32Array, o: number): void {
  for (let i = 0; i < 15; i++) out[o + i] = 0;
  out[o + 15] = 1;
}

export interface UploadRange { start: number; count: number }

/** Marks array elements [start, start + count) of `attr` for upload, reusing `range`; until three uploads it, the
 *  pending range only grows. A range upload is not free in three r176: the upload sorts with a new closure and
 *  empties updateRanges (length = 0 drops its backing store). So ranges are for sparse, event-driven changes (brick
 *  releases); attributes that change every frame upload whole through markAll, which allocates nothing. */
export function markRange(attr: THREE.BufferAttribute, range: UploadRange, start: number, count: number): void {
  const ranges = attr.updateRanges;
  if (ranges.length === 0) {
    range.start = start;
    range.count = count;
    ranges.push(range);
  } else if (ranges.length === 1 && ranges[0] === range) {
    const end = Math.max(range.start + range.count, start + count);
    range.start = Math.min(range.start, start);
    range.count = end - range.start;
  } else {
    attr.clearUpdateRanges();   // a foreign range: upload the whole attribute
  }
  attr.needsUpdate = true;
}

/** Marks the whole attribute for upload (context restore, full rebuilds). */
export function markAll(attr: THREE.BufferAttribute): void {
  attr.clearUpdateRanges();
  attr.needsUpdate = true;
}

/** A per-instance float attribute with dynamic usage. */
export function instanceAttribute(geometry: THREE.BufferGeometry, name: string, count: number, itemSize: number): THREE.InstancedBufferAttribute {
  const attr = new THREE.InstancedBufferAttribute(new Float32Array(count * itemSize), itemSize);
  attr.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute(name, attr);
  return attr;
}

/** A dynamic instanceColor buffer, created before the first render so USE_INSTANCING_COLOR is in the program key
 *  from the start (a fixed program set, C59). */
export function instanceColors(mesh: THREE.InstancedMesh, count: number): THREE.InstancedBufferAttribute {
  const attr = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
  attr.setUsage(THREE.DynamicDrawUsage);
  mesh.instanceColor = attr;
  return attr;
}

/** Linear working-space RGB of an sRGB hex colour, written at out[o .. o + 3). Setup only (parses the string). */
export function linearRGB(hex: string, out: Float32Array, o: number): void {
  const c = new THREE.Color(hex);
  out[o] = c.r;
  out[o + 1] = c.g;
  out[o + 2] = c.b;
}

/** A unit box translated to z in [0, 1], so a scale of h makes it h tall standing on the floor (D11). */
export function unitBox(): THREE.BoxGeometry {
  const g = new THREE.BoxGeometry(1, 1, 1);
  g.translate(0, 0, 0.5);
  return g;
}
