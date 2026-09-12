// warmup's readiness poll against a stub renderer, and the warm scheduler's latch across restarts (render-3).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createWarmScheduler, warmup } from './warmup';
import { log } from '../lib/log';

interface Props { currentProgram?: { isReady(): boolean } }

interface Stub {
  gl: THREE.WebGLRenderer;
  props: Map<object, Props>;
  ready: Set<THREE.Material>;
  /** The target bound at each render and at each compile. */
  renders: (THREE.WebGLRenderTarget | null)[];
  compiledInto: (THREE.WebGLRenderTarget | null)[];
  setLost(v: boolean): void;
  bound(): THREE.WebGLRenderTarget | null;
}

function stub(toneMapping: THREE.ToneMapping = THREE.ACESFilmicToneMapping): Stub {
  let lost = false;
  let target: THREE.WebGLRenderTarget | null = null;
  const props = new Map<object, Props>();
  const ready = new Set<THREE.Material>();
  const renders: (THREE.WebGLRenderTarget | null)[] = [];
  const compiledInto: (THREE.WebGLRenderTarget | null)[] = [];
  const gl = {
    toneMapping,
    info: { autoReset: false },
    extensions: { has: () => true },
    getContext: () => ({ isContextLost: () => lost }),
    getRenderTarget: () => target,
    setRenderTarget: (t: THREE.WebGLRenderTarget | null) => {
      target = t;
    },
    // As three's compile: every mesh material gets properties with a program, and the set is returned.
    compile: (scene: THREE.Object3D) => {
      compiledInto.push(target);
      const set = new Set<THREE.Material>();
      scene.traverse((o) => {
        const m = (o as { material?: THREE.Material }).material;
        if (m === undefined) return;
        set.add(m);
        props.set(m, { currentProgram: { isReady: () => ready.has(m) } });
      });
      return set;
    },
    // As WebGLProperties: get() creates an entry.
    properties: {
      has: (o: object) => props.has(o),
      get: (o: object) => {
        let p = props.get(o);
        if (p === undefined) {
          p = {};
          props.set(o, p);
        }
        return p;
      },
    },
    render: () => {
      renders.push(target);
    },
  };
  return {
    gl: gl as unknown as THREE.WebGLRenderer, props, ready, renders, compiledInto,
    setLost: (v) => {
      lost = v;
    },
    bound: () => target,
  };
}

function stage(): { scene: THREE.Scene; camera: THREE.PerspectiveCamera; a: THREE.Material; b: THREE.Material; inst: THREE.InstancedMesh } {
  const scene = new THREE.Scene();
  const geo = new THREE.BoxGeometry();
  const a = new THREE.MeshStandardMaterial();
  const b = new THREE.MeshBasicMaterial();
  const inst = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial(), 4);
  inst.count = 0;
  scene.add(new THREE.Mesh(geo, a), new THREE.Mesh(geo, b), inst);
  return { scene, camera: new THREE.PerspectiveCamera(), a, b, inst };
}

const never = (): boolean => false;

describe('warmup', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('drops a material whose properties are removed mid-poll, and finishes without throwing', async () => {
    const s = stub();
    const { scene, camera, a, b } = stage();
    s.ready.add(a);
    for (const m of s.gl.compile(scene, camera)) if (m !== a && m !== b) s.ready.add(m);
    let done = false;
    const p = warmup(s.gl, scene, camera, never).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(30);
    expect(done).toBe(false);
    s.props.delete(b);   // b.dispose() mid-compile: three removes its properties
    await vi.advanceTimersByTimeAsync(10);
    await p;
    expect(done).toBe(true);
    expect(s.props.has(b)).toBe(false);   // the poll never re-created the disposed material's entry
    expect(s.renders).toHaveLength(1);
  });

  it('drops a material whose properties a restore replaced (no current program)', async () => {
    const s = stub();
    const { scene, camera, a, b } = stage();
    const others = s.gl.compile(scene, camera);
    for (const m of others) if (m !== b) s.ready.add(m);
    s.ready.add(a);
    const p = warmup(s.gl, scene, camera, never);
    await vi.advanceTimersByTimeAsync(20);
    s.props.set(b, {});
    await vi.advanceTimersByTimeAsync(10);
    await expect(p).resolves.toBeUndefined();
  });

  it('stops when the context is lost mid-poll, without a hidden frame', async () => {
    const s = stub();
    const { scene, camera } = stage();
    let done = false;
    const p = warmup(s.gl, scene, camera, never).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(50);
    expect(done).toBe(false);
    s.setLost(true);
    await vi.advanceTimersByTimeAsync(10);
    await p;
    expect(done).toBe(true);
    expect(s.renders).toHaveLength(0);
  });

  it('stops when aborted mid-poll, without a hidden frame', async () => {
    const s = stub();
    const { scene, camera } = stage();
    let abort = false;
    const p = warmup(s.gl, scene, camera, () => abort);
    await vi.advanceTimersByTimeAsync(20);
    abort = true;
    await vi.advanceTimersByTimeAsync(10);
    await p;
    expect(s.renders).toHaveLength(0);
  });

  it('stops, logging, when the renderer throws inside the poll', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const s = stub();
    const { scene, camera, b } = stage();
    const p = warmup(s.gl, scene, camera, never);
    await vi.advanceTimersByTimeAsync(20);
    s.props.set(b, { currentProgram: { isReady: () => { throw new Error('boom'); } } });
    await vi.advanceTimersByTimeAsync(10);
    await p;
    expect(warn).toHaveBeenCalledOnce();
  });

  it('renders one hidden frame on the screen once every program is ready (low: ACES)', async () => {
    const s = stub(THREE.ACESFilmicToneMapping);
    const { scene, camera, inst } = stage();
    for (const m of s.gl.compile(scene, camera)) s.ready.add(m);
    s.compiledInto.length = 0;
    await warmup(s.gl, scene, camera, never);
    expect(s.compiledInto).toEqual([null]);
    expect(s.renders).toEqual([null]);
    expect(inst.count).toBe(0);   // the degenerate instance lasted one render
  });

  it('compiles and renders into a 16x16 target on the composer tiers and restores the bound target', async () => {
    const s = stub(THREE.NoToneMapping);
    const { scene, camera } = stage();
    for (const m of s.gl.compile(scene, camera)) s.ready.add(m);
    s.compiledInto.length = 0;
    const previous = new THREE.WebGLRenderTarget(4, 4);
    s.gl.setRenderTarget(previous);
    await warmup(s.gl, scene, camera, never);
    const target = s.compiledInto[0];
    expect(target).not.toBeNull();
    expect(target).not.toBe(previous);
    expect(target?.width).toBe(16);
    expect(s.renders).toEqual([target]);
    expect(s.bound()).toBe(previous);
  });
});

interface Deferred { aborted: () => boolean; resolve: () => void; reject: (e: unknown) => void }

function recorder(): { runs: Deferred[]; run: (aborted: () => boolean) => Promise<void> } {
  const runs: Deferred[] = [];
  return {
    runs,
    run: (aborted) => new Promise<void>((resolve, reject) => {
      runs.push({ aborted, resolve, reject });
    }),
  };
}

describe('createWarmScheduler', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('restart starts a new run that resolves while the first never settles; a later warm starts fresh', async () => {
    const { runs, run } = recorder();
    const s = createWarmScheduler(run, never);
    let firstDone = false;
    void s.warm().then(() => {
      firstDone = true;
    });
    expect(runs).toHaveLength(1);
    const second = s.restart();
    expect(runs).toHaveLength(2);
    expect(runs[0].aborted()).toBe(true);
    expect(runs[1].aborted()).toBe(false);
    runs[1].resolve();
    await second;
    expect(firstDone).toBe(false);
    void s.warm();
    expect(runs).toHaveLength(3);
  });

  it('a stale run that settles later neither clears the new latch nor runs again', async () => {
    const { runs, run } = recorder();
    const s = createWarmScheduler(run, never);
    const first = s.warm();
    const second = s.restart();
    runs[0].resolve();
    await first;
    expect(runs).toHaveLength(2);
    expect(s.warm()).toBe(second);   // still latched on the second run; asks it for one more round
    expect(runs).toHaveLength(2);
    runs[1].resolve();
    await vi.waitFor(() => expect(runs).toHaveLength(3));
    runs[2].resolve();
    await second;
    void s.warm();
    expect(runs).toHaveLength(4);
  });

  it('coalesces warms during a run into one more round', async () => {
    const { runs, run } = recorder();
    const s = createWarmScheduler(run, never);
    const p = s.warm();
    expect(s.warm()).toBe(p);
    expect(s.warm()).toBe(p);
    runs[0].resolve();
    await vi.waitFor(() => expect(runs).toHaveLength(2));
    runs[1].resolve();
    await p;
    expect(runs).toHaveLength(2);
  });

  it('logs a failed run and clears the latch', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const { runs, run } = recorder();
    const s = createWarmScheduler(run, never);
    const p = s.warm();
    runs[0].reject(new Error('boom'));
    await p;
    expect(warn).toHaveBeenCalledOnce();
    void s.warm();
    expect(runs).toHaveLength(2);
  });

  it('keeps the latch clear when a run throws synchronously', async () => {
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    let calls = 0;
    const s = createWarmScheduler(() => {
      calls++;
      throw new Error('sync');
    }, never);
    await s.warm();
    await s.warm();
    expect(calls).toBe(2);
  });

  it('does nothing once disposed', async () => {
    const { runs, run } = recorder();
    let disposed = false;
    const s = createWarmScheduler(run, () => disposed);
    void s.warm();
    disposed = true;
    expect(runs[0].aborted()).toBe(true);
    await s.warm();
    await s.restart();
    expect(runs).toHaveLength(1);
  });
});
