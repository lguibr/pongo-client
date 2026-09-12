// Warmup (6.6, C65): compile every program of the stage before it is needed, then render one hidden frame so
// buffers, textures and uniforms are uploaded. It runs when the board is ready, after a context restore and after
// a tier change. InstancedMeshes with count 0 draw one degenerate instance for that frame only; the counts are
// changed and restored synchronously around the hidden render, never across an await, so a system writing its
// instances meanwhile is never overwritten.
//
// three r176 keys a program on the render target bound when it is built: into a target it builds linear,
// untone-mapped variants; on the screen, sRGB variants with the renderer's tone mapping (WebGLPrograms
// getParameters). The composer tiers (renderer NoToneMapping under the flat Canvas) draw the scene into the
// composer's target, and the low tier (ACES) draws it straight to the screen. So the compile and the hidden frame
// use a 16x16 target of the composer's buffer type on the composer tiers, and the screen on low. compile() is
// synchronous, so the target only needs to be bound around that call. On low the hidden frame is a real frame of
// the current scene, and the next frame overwrites it. The 6.6 recipe (always render into a 16x16 target) would
// build every scene program twice on one tier or the other.
//
// Readiness is polled here rather than through compileAsync. compileAsync reads
// properties.get(m).currentProgram.isReady() unguarded: a material disposed mid-compile (a tier change across low,
// programs.ts) or a context restore that replaces the properties makes it throw inside its timer, and on a lost
// context isReady never turns true. Either way its promise never settles, and the warm latch would hold forever.
// This poll drops such materials, stops on loss or abort, and never throws.

import * as THREE from 'three';
import { log } from '../lib/log';

const TARGET_SIZE = 16;
const POLL_MS = 10;

/** The part of three's material properties the poll reads. */
interface CompiledProperties { currentProgram?: { isReady(): boolean } | null }

/** The same probe as the composer's frame buffer type (6.4). */
function halfFloatRenderable(gl: THREE.WebGLRenderer): boolean {
  return gl.extensions.has('EXT_color_buffer_half_float') || gl.extensions.has('EXT_color_buffer_float');
}

/** Drops every material that is ready or can no longer become ready; true when none is left. */
function drain(gl: THREE.WebGLRenderer, pending: Set<THREE.Material>): boolean {
  for (const m of pending) {
    // has() first: get() would create an entry for a material that was disposed or whose properties a restore
    // replaced.
    if (!gl.properties.has(m)) {
      pending.delete(m);
      continue;
    }
    const program = (gl.properties.get(m) as CompiledProperties).currentProgram;
    if (program === undefined || program === null || program.isReady()) pending.delete(m);
  }
  return pending.size === 0;
}

/** Resolves when every pending program is ready, or when waiting stops making sense. Never rejects. */
function programsSettled(gl: THREE.WebGLRenderer, pending: Set<THREE.Material>, aborted: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const check = (): void => {
      let done: boolean;
      try {
        done = aborted() || gl.getContext().isContextLost() || drain(gl, pending);
      } catch (e) {
        // An unexpected renderer state: stop waiting rather than hold the warm latch.
        log.warn('warmup: readiness poll stopped', e);
        done = true;
      }
      if (done) resolve();
      else setTimeout(check, POLL_MS);
    };
    check();
  });
}

function hiddenFrame(gl: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, target: THREE.WebGLRenderTarget | null): void {
  const meshes: THREE.InstancedMesh[] = [];
  const saved: number[] = [];
  const first: Float32Array[] = [];
  scene.traverse((o) => {
    const mesh = o as THREE.InstancedMesh;
    if (mesh.isInstancedMesh === true && mesh.count === 0) {
      meshes.push(mesh);
      saved.push(mesh.count);
      const m = mesh.instanceMatrix.array as Float32Array;
      first.push(m.slice(0, 16));
      m.fill(0, 0, 15);   // a zero-scale instance draws nothing
      m[15] = 1;
      mesh.count = 1;
      mesh.instanceMatrix.clearUpdateRanges();
      mesh.instanceMatrix.needsUpdate = true;
    }
  });
  const previous = gl.getRenderTarget();
  try {
    gl.setRenderTarget(target);
    gl.render(scene, camera);
  } finally {
    gl.setRenderTarget(previous);
    for (let i = 0; i < meshes.length; i++) {
      const mesh = meshes[i];
      mesh.count = saved[i];
      (mesh.instanceMatrix.array as Float32Array).set(first[i], 0);
      mesh.instanceMatrix.clearUpdateRanges();
      mesh.instanceMatrix.needsUpdate = true;
    }
  }
}

/** `aborted` turns true when the stage is disposed or a newer warm replaced this one; the poll then stops and no
 *  hidden frame is drawn. */
export async function warmup(gl: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, aborted: () => boolean): Promise<void> {
  if (aborted() || gl.getContext().isContextLost()) return;
  const throughTarget = gl.toneMapping === THREE.NoToneMapping;
  const target = throughTarget
    ? new THREE.WebGLRenderTarget(TARGET_SIZE, TARGET_SIZE, { type: halfFloatRenderable(gl) ? THREE.HalfFloatType : THREE.UnsignedByteType })
    : null;
  try {
    const previous = gl.getRenderTarget();
    gl.setRenderTarget(target);
    let pending: Set<THREE.Material>;
    try {
      pending = gl.compile(scene, camera);
    } finally {
      gl.setRenderTarget(previous);
    }
    await programsSettled(gl, pending, aborted);
    // A tier change while compiling changes the variants the stage needs; the caller runs warmup again for it.
    if (aborted() || gl.getContext().isContextLost() || (gl.toneMapping === THREE.NoToneMapping) !== throughTarget) return;
    // Counts are touched only inside this synchronous block.
    const autoReset = gl.info.autoReset;
    hiddenFrame(gl, scene, camera, target);
    gl.info.autoReset = autoReset;
  } finally {
    target?.dispose();
  }
}

export interface WarmScheduler {
  /** Starts a warm, or asks the running one to go round once more; resolves when that warm's loop ends. */
  warm(): Promise<void>;
  /** Abandons the running warm (its `aborted` turns true) and starts a new one. */
  restart(): Promise<void>;
}

/** The stage's warm latch. warm() while a warm runs coalesces into one more round of the same loop. restart()
 *  bumps the generation, so a warm cut off by a context loss can never hold the latch: a stale loop stops at its
 *  next check and never clears the latch of a newer one. */
export function createWarmScheduler(run: (aborted: () => boolean) => Promise<void>, disposed: () => boolean): WarmScheduler {
  let warming: Promise<void> | null = null;
  let again = false;
  let generation = 0;

  const start = (): Promise<void> => {
    const gen = ++generation;
    const stale = (): boolean => disposed() || gen !== generation;
    let ended = false;
    const loop = async (): Promise<void> => {
      try {
        do {
          again = false;
          await run(stale);
        } while (again && !stale());
      } catch (e) {
        log.warn('warmup failed', e);
      } finally {
        ended = true;
        // Cleared in the same microtask as the last `again` check, so any later warm() starts a new loop.
        if (gen === generation) warming = null;
      }
    };
    const p = loop();
    // A run that threw synchronously has already ended, and the latch must stay clear.
    if (!ended) warming = p;
    return p;
  };

  return {
    warm() {
      if (disposed()) return Promise.resolve();
      if (warming !== null) {
        again = true;
        return warming;
      }
      return start();
    },
    restart() {
      if (disposed()) return Promise.resolve();
      warming = null;
      again = false;
      return start();
    },
  };
}
