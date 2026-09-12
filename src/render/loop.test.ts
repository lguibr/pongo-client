import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RootState } from '@react-three/fiber';
import type * as THREE from 'three';
import { createFrameRunner } from './loop';
import type { QualitySampler } from './loop';
import { QualityController } from './quality';
import type { FrameCtx, FrameSystem, FxDirector, StageMode, Tier } from './contracts';
import type { CameraRig } from './camera';
import type { PostPipeline } from './post/composer';
import { createFakeApp, fakeGame } from '../test/fakes/fakeApp';
import type { GameEvent } from '../game/events';
import type { GameRuntime } from '../game/types';
import type { SessionStateName } from '../session/types';
import { stats } from '../state/stats';
import { TUNING } from '../config/tuning';

const SYSTEMS = ['floor', 'walls', 'bricks', 'paddles', 'balls', 'halos'];
const SCORE: GameEvent = { k: 'score', seat: 0, from: 0, to: 1, delta: 1, cause: 'brick', tick: 1, seq: 1, x: 0, y: 0, conf: 1, stale: false };

interface Info {
  autoReset: boolean;
  render: { calls: number; triangles: number };
  programs: unknown[] | null;
  reset(): void;
}

interface Harness {
  run(deltaS?: number): void;
  log: string[];
  ctxs: FrameCtx[];
  frameDt: number[];
  modes: string[];
  introEnds: number[];
  quality: number[];
  refresh: number[];
  setReady(v: boolean): void;
  setLost(v: boolean): void;
  setHitStop(v: boolean): void;
  setMode(m: StageMode): void;
  setSession(s: SessionStateName): void;
  setSize(w: number, h: number): void;
  setBuffer(w: number, h: number): void;
  /** Stands in for three's context restore, which replaces renderer.info with a new WebGLInfo (autoReset on). */
  replaceInfo(): Info;
  app: ReturnType<typeof createFakeApp>;
  renderer: { info: Info };
}

function harness(opts: { post?: boolean; fire?: GameEvent | null; sampler?: QualitySampler } = {}): Harness {
  const log: string[] = [];
  const ctxs: FrameCtx[] = [];
  const frameDt: number[] = [];
  const modes: string[] = [];
  const introEnds: number[] = [];
  const quality: number[] = [];
  const refresh: number[] = [];
  const game = fakeGame() as { -readonly [K in keyof GameRuntime]: GameRuntime[K] };
  const render = game.render as { ready: boolean };
  render.ready = true;
  let hitStop = false;
  Object.defineProperty(game, 'hitStopActive', { get: () => hitStop });
  const fire = opts.fire === undefined ? SCORE : opts.fire;
  game.frame = (dtMs, _nowMs, f) => {
    log.push('game.frame');
    frameDt.push(dtMs);
    if (fire !== null) f(fire);
  };
  const app = createFakeApp({ game });
  const makeInfo = (): Info => {
    const info: Info = {
      autoReset: true,
      render: { calls: 0, triangles: 0 },
      programs: [1, 2, 3],
      reset(): void {
        log.push('info.reset');
        info.render.calls = 0;
        info.render.triangles = 0;
      },
    };
    return info;
  };
  let lost = false;
  const renderer = {
    info: makeInfo(),
    domElement: { width: 800, height: 600 },
    getContext: () => ({ isContextLost: () => lost }),
    render: (): void => {
      log.push('gl.render');
      renderer.info.render.calls += 7;
      renderer.info.render.triangles += 700;
    },
  };
  const systems: FrameSystem[] = SYSTEMS.map((name) => ({
    name,
    update: (c: FrameCtx) => {
      log.push(name);
      ctxs.push({ ...c });
    },
    reset: () => {},
    dispose: () => {},
  }));
  const fx: FxDirector = {
    consume: (e) => log.push(`fx.consume:${e.k}`),
    update: () => log.push('fx.update'),
    lateUpdate: () => log.push('fx.lateUpdate'),
    reset: () => {},
    setTier: () => {},
    dispose: () => {},
    stats: { sparks: 0, shards: 0, rings: 0, decals: 0, trails: 0, droppedP2: 0, staleSkipped: 0 },
  };
  const camera = {
    camera: {},
    setMode: (m: string) => modes.push(m),
    setIntroEnd: (ms: number) => introEnds.push(ms),
    update: (_c: FrameCtx, w: number, h: number) => log.push(`camera ${w}x${h}`),
    refit: (w: number, h: number) => log.push(`camera.refit ${w}x${h}`),
  };
  const post = {
    enabled: opts.post ?? true,
    sceneCalls: 0,
    sceneTriangles: 0,
    setSize: () => log.push('post.setSize'),
    render(): void {
      const info = renderer.info;
      log.push('post.render');
      info.render.calls += 5;           // the RenderPass
      info.render.triangles += 500;
      this.sceneCalls = info.render.calls;
      this.sceneTriangles = info.render.triangles;
      info.render.calls += 3;           // bloom mips and the EffectPass
    },
  };
  const sampler: QualitySampler = opts.sampler ?? {
    sample: (dt, refreshMs) => {
      quality.push(dt);
      refresh.push(refreshMs);
    },
  };
  let mode: StageMode = 'live';
  const runner = createFrameRunner({
    app, systems, fx, camera: camera as unknown as CameraRig, post: post as unknown as PostPipeline,
    renderer: renderer as unknown as THREE.WebGLRenderer, scene: {} as THREE.Scene, quality: sampler,
  }, () => mode);
  const state = { size: { width: 800, height: 600 }, viewport: { dpr: 1 } };
  return {
    run: (deltaS = 1 / 60) => runner(state as unknown as RootState, deltaS),
    log, ctxs, frameDt, modes, introEnds, quality, refresh,
    setReady: (v) => { render.ready = v; },
    setLost: (v) => { lost = v; },
    setHitStop: (v) => { hitStop = v; },
    setMode: (m) => { mode = m; },
    setSession: (s) => app.store.patch({ session: { ...app.store.get().session, s } }),
    setSize: (w, h) => {
      state.size = { width: w, height: h };
      renderer.domElement.width = w;
      renderer.domElement.height = h;
    },
    setBuffer: (w, h) => {
      renderer.domElement.width = w;
      renderer.domElement.height = h;
    },
    replaceInfo: () => {
      renderer.info = makeInfo();
      return renderer.info;
    },
    app,
    renderer,
  };
}

describe('createFrameRunner (2.5)', () => {
  let clockMs = 0;
  beforeEach(() => {
    clockMs = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => clockMs);
    stats.render.calls = -1;
    stats.render.postCalls = -1;
  });
  afterEach(() => vi.restoreAllMocks());

  it('runs the frame in order: clock and release, systems, FX, camera, late FX, one render', () => {
    const h = harness();
    h.run();
    expect(h.renderer.info.autoReset).toBe(false);
    expect(h.log).toEqual([
      'info.reset', 'game.frame', 'fx.consume:score', 'post.setSize', ...SYSTEMS, 'fx.update', 'camera 800x600',
      'fx.lateUpdate', 'post.render',
    ]);
  });

  it('turns gl.info.autoReset off again after three replaced renderer.info on a context restore', () => {
    const h = harness();
    h.run();
    const restored = h.replaceInfo();
    expect(restored.autoReset).toBe(true);
    h.log.length = 0;
    h.run();
    expect(restored.autoReset).toBe(false);
    expect(h.log[0]).toBe('info.reset');
    // Counts accumulate over the frame's passes on the new info object: 5 scene draws plus 3 post draws.
    clockMs += 600;
    h.run();
    expect(stats.render.calls).toBe(5);
    expect(stats.render.postCalls).toBe(3);
  });

  it('renders exactly once per frame, through the composer or directly on the low tier', () => {
    const high = harness();
    for (let i = 0; i < 3; i++) high.run();
    expect(high.log.filter((l) => l === 'post.render')).toHaveLength(3);
    expect(high.log.filter((l) => l === 'gl.render')).toHaveLength(0);
    const low = harness({ post: false });
    for (let i = 0; i < 3; i++) low.run();
    expect(low.log.filter((l) => l === 'gl.render')).toHaveLength(3);
    expect(low.log.filter((l) => l === 'post.render')).toHaveLength(0);
  });

  it('skips the render while the context is lost, but still releases events', () => {
    const h = harness();
    h.setLost(true);
    h.run();
    expect(h.log).toContain('fx.consume:score');
    expect(h.log).not.toContain('post.render');
    expect(h.log).not.toContain('gl.render');
    h.setLost(false);
    h.log.length = 0;
    h.run();
    expect(h.log.filter((l) => l === 'post.render')).toHaveLength(1);
  });

  it('stops after the clock and release while render.ready is false, so the canvas keeps its last frame (D33)', () => {
    const h = harness();
    h.setReady(false);
    h.run();
    expect(h.log).toEqual(['info.reset', 'game.frame', 'fx.consume:score']);
    h.setReady(true);
    h.run();
    expect(h.log.filter((l) => l === 'post.render')).toHaveLength(1);
    h.setReady(false);
    h.log.length = 0;
    h.run();
    h.run();
    expect(h.log).toEqual(['info.reset', 'game.frame', 'fx.consume:score', 'info.reset', 'game.frame', 'fx.consume:score']);
  });

  it('redraws the last board at the new size when the canvas is resized while render.ready is false', () => {
    const h = harness();
    h.run();
    h.setReady(false);
    h.setSize(400, 900);
    h.log.length = 0;
    h.run();
    // Fiber's resize cleared the drawing buffer: the frozen board is drawn again, with no system, FX or camera
    // time step in between.
    expect(h.log).toEqual(['info.reset', 'game.frame', 'fx.consume:score', 'post.setSize', 'camera.refit 400x900', 'post.render']);
    h.log.length = 0;
    h.run();
    expect(h.log).toEqual(['info.reset', 'game.frame', 'fx.consume:score']);
  });

  it('draws nothing on a resize before the canvas has shown any frame', () => {
    const h = harness();
    h.setReady(false);
    h.run();
    h.setSize(400, 900);
    h.run();
    expect(h.log).not.toContain('post.render');
    expect(h.log).not.toContain('camera.refit 400x900');
  });

  it('clamps dt at dtClampMs, and presentation time stands still during hit-stop', () => {
    const h = harness({ fire: null });
    h.run(0.2);
    expect(h.frameDt[0]).toBe(TUNING.playout.dtClampMs);
    expect(h.ctxs[0].dtMs).toBe(TUNING.playout.dtClampMs);
    h.run(1 / 60);
    const before = h.ctxs[h.ctxs.length - 1].fxTimeS;
    h.setHitStop(true);
    h.run(1 / 60);
    const during = h.ctxs[h.ctxs.length - 1];
    expect(during.hitStopActive).toBe(true);
    expect(during.fxDtS).toBe(0);
    expect(during.fxTimeS).toBe(before);
    expect(during.dtS).toBeCloseTo(1 / 60, 12);
    h.setHitStop(false);
    h.run(1 / 60);
    expect(h.ctxs[h.ctxs.length - 1].fxTimeS).toBeGreaterThan(before);
  });

  it('stats.render.calls counts scene draws only; postCalls is the rest (every 500 ms)', () => {
    const h = harness();
    h.run();
    expect(stats.render.calls).toBe(-1);
    clockMs += 250;
    h.run();
    expect(stats.render.calls).toBe(-1);
    clockMs += 300;
    h.run();
    expect(stats.render.calls).toBe(5);
    expect(stats.render.postCalls).toBe(3);
    expect(stats.render.triangles).toBe(500);
    expect(stats.render.programs).toBe(3);
    expect(stats.render.fps).toBeGreaterThan(0);
    expect(stats.render.tier).toBe('high');

    const low = harness({ post: false });
    low.run();
    clockMs += 600;
    low.run();
    expect(stats.render.calls).toBe(7);
    expect(stats.render.postCalls).toBe(0);
  });

  it('feeds the quality controller the raw interval, in live mode only', () => {
    const h = harness({ fire: null });
    h.run(0.03);
    h.run(0.2);
    h.setMode('lobby');
    h.run(0.05);
    expect(h.quality).toEqual([30, 200]);
  });

  it('learns the display period from continuous frames only: on-demand lobby frames never raise it', () => {
    const h = harness({ fire: null });
    h.setMode('lobby');
    for (let i = 0; i < 80; i++) h.run(0.05);   // 4 s at lobbyFps
    h.setMode('live');
    for (let i = 0; i < 80; i++) h.run(0.028);
    expect(h.refresh.length).toBe(80);
    for (const r of h.refresh) expect(r).toBeCloseTo(1000 / 60, 9);
  });

  it('with a real controller, a device slow all the time steps down after three 2 s windows, lobby first', () => {
    const changes: Tier[] = [];
    const controller = new QualityController(TUNING.quality, 'high', (t) => changes.push(t));
    const h = harness({ fire: null, sampler: controller });
    h.setMode('lobby');
    for (let i = 0; i < 60; i++) h.run(0.05);   // 3 s of the lobby at 20 fps
    h.setMode('live');
    // A steady 28 ms frame (about 36 fps) on a 60 Hz display: 72 frames close each 2 s window.
    for (let i = 0; i < 215; i++) h.run(0.028);
    expect(controller.tier).toBe('high');
    h.run(0.028);
    expect(controller.tier).toBe('medium');
    expect(changes).toEqual(['medium']);
  });

  it('sets the camera mode from the stage mode and session, and keeps it while frozen', () => {
    const h = harness({ fire: null });
    h.setSession('playing');
    h.run();
    h.setSession('countdown');
    h.run();
    h.setMode('frozen');
    h.setSession('reconnecting');
    h.run();
    h.setMode('live');
    h.setSession('countdown');
    h.run();
    h.setMode('lobby');
    h.run();
    h.setMode('ended');
    h.run();
    expect(h.modes).toEqual(['play', 'intro', 'intro', 'lobby', 'gameOver']);
  });

  it('times the camera intro from the countdown slice', () => {
    const h = harness({ fire: null });
    h.run();
    h.app.store.patch({ countdown: { seconds: 2, endsAt: 4321 } });
    h.run();
    h.app.store.patch({ countdown: null });
    h.run();
    expect(h.introEnds).toEqual([-1, 4321, -1]);
  });

  it('resizes the post pipeline once per size change, and when only the drawing buffer moves', () => {
    const h = harness({ fire: null });
    h.run();
    h.run();
    h.setSize(400, 900);
    h.run();
    expect(h.log.filter((l) => l === 'post.setSize')).toHaveLength(2);
    expect(h.log[h.log.length - 3]).toBe('camera 400x900');
    // A fractional CSS change can move the drawing buffer by a pixel while the rounded size stays.
    h.setBuffer(401, 900);
    h.run();
    h.run();
    expect(h.log.filter((l) => l === 'post.setSize')).toHaveLength(3);
  });
});
