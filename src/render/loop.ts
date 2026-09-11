// The one ordered display frame (2.5), run from the single useFrame at priority 1, so R3F's own render is off and
// step 6 is the only render:
//   1 game.frame (clock, release, sample); while render.ready is false the loop stops here (D33), unless the canvas
//     was resized after a frame was drawn: fiber's resize cleared the drawing buffer, so the last board is drawn
//     again at the new size (post resize, camera refit and step 6 only; the systems are not touched)
//   2 entity systems in order   3 fx.update   4 camera   5 fx.lateUpdate   6 render (skipped while the context is
//   lost)   7 stats every 500 ms
// gl.info.autoReset is off and reset at frame start, so the counts accumulate over the frame's passes. It is set
// off on every frame, because three replaces renderer.info with a new WebGLInfo (autoReset on) when the context is
// restored.
//
// The display period is learnt only from a continuous frameloop (live, and ended while its effects run): the
// lobby's on-demand frames at lobbyFps would read as a 30 Hz display. The quality controller is fed in live mode.

import type * as THREE from 'three';
import type { RootState } from '@react-three/fiber';
import type { FrameCtx, FrameSystem, FxDirector, StageMode } from './contracts';
import type { App } from '../app/types';
import type { GameEvent } from '../game/events';
import type { CameraRig } from './camera';
import type { PostPipeline } from './post/composer';
import { RefreshEstimator, selectQuantile } from './quality';
import { T } from '../config/tuning';
import { stats } from '../state/stats';

export interface QualitySampler { sample(dtMs: number, refreshMs: number): void }

export interface FrameParts {
  app: App; systems: readonly FrameSystem[]; fx: FxDirector; camera: CameraRig; post: PostPipeline;
  renderer: THREE.WebGLRenderer; scene: THREE.Scene;
  /** Fed the raw frame interval in live mode; absent when the tier is set by hand. */
  quality?: QualitySampler;
}

const STATS_MS = 500;
const WORK_RING = 64;

function cameraModeOf(mode: StageMode, session: FrameCtx['session']): 'lobby' | 'intro' | 'play' | 'gameOver' {
  if (mode === 'lobby') return 'lobby';
  if (mode === 'ended') return 'gameOver';
  return session === 'countdown' ? 'intro' : 'play';
}

export function createFrameRunner(parts: FrameParts, getMode: () => StageMode): (state: RootState, deltaS: number) => void {
  const { app, systems, fx, camera, post, renderer, scene } = parts;
  const store = app.store;
  const game = app.game;
  const canvas = renderer.domElement;
  const clampMs = T.playout.dtClampMs;
  const ctx: FrameCtx = {
    nowMs: 0, dtMs: 0, dtS: 0, fxTimeS: 0, fxDtS: 0, displayMs: 0,
    reducedMotion: false, tier: 'high', myIndex: null, hitStopActive: false, session: 'idle', mode: 'live',
  };
  const fire = (e: GameEvent): void => fx.consume(e, ctx);
  const refresh = new RefreshEstimator();
  const work = new Float32Array(WORK_RING);
  const scratch = new Float32Array(WORK_RING);
  // Per-frame doubles live on an object, updated in place. bw and bh: the drawing buffer the post buffers were
  // sized for; drawn: 1 once this canvas has shown a frame.
  const st = {
    lastStats: -1, frames: 0, workN: 0, workI: 0, sceneCalls: 0, total: 0, triangles: 0, w: -1, h: -1, dpr: -1,
    bw: -1, bh: -1, drawn: 0,
  };

  return (state: RootState, deltaS: number): void => {
    const now = performance.now();
    const info = renderer.info;
    info.autoReset = false;
    info.reset();
    const raw = deltaS * 1000;
    const dtMs = raw > 0 ? (raw > clampMs ? clampMs : raw) : 0;
    const s = store.get();
    ctx.nowMs = now;
    ctx.dtMs = dtMs;
    ctx.dtS = dtMs / 1000;
    ctx.reducedMotion = s.motion.reduced;
    ctx.tier = s.gfx.tier;
    ctx.session = s.session.s;
    ctx.mode = getMode();
    ctx.myIndex = game.world.myIndex;
    ctx.hitStopActive = game.hitStopActive;
    ctx.fxDtS = ctx.hitStopActive ? 0 : ctx.dtS;
    ctx.fxTimeS += ctx.fxDtS;

    // 1. Clock, release and sample.
    game.frame(dtMs, now, fire);
    ctx.displayMs = game.render.displayMs;
    ctx.hitStopActive = game.hitStopActive;
    if (ctx.mode === 'live' || ctx.mode === 'ended') refresh.push(raw);
    if (ctx.mode === 'live' && parts.quality !== undefined) parts.quality.sample(raw, refresh.periodMs);

    // Whole CSS pixels: an int crosses a call without being boxed. The drawing buffer is compared as well, because
    // a fractional CSS change can move it by a pixel while the rounded size stays.
    const w = Math.round(state.size.width);
    const h = Math.round(state.size.height);
    const dpr = state.viewport.dpr;
    const resized = w !== st.w || h !== st.h || dpr !== st.dpr || canvas.width !== st.bw || canvas.height !== st.bh;
    const ready = game.render.ready;
    if (!ready && !(resized && st.drawn === 1)) return;   // the canvas keeps its last frame (D33)
    if (resized) {
      st.w = w;
      st.h = h;
      st.dpr = dpr;
      st.bw = canvas.width;
      st.bh = canvas.height;
      post.setSize();
    }

    if (ready) {
      // 2-5. Systems, FX, camera, late FX.
      for (let i = 0; i < systems.length; i++) systems[i].update(ctx);
      fx.update(ctx);
      // A frozen stage keeps its camera mode, so an intro resumes where it was after a reconnect.
      if (ctx.mode !== 'frozen') camera.setMode(cameraModeOf(ctx.mode, ctx.session), ctx.reducedMotion);
      const countdown = s.countdown;
      camera.setIntroEnd(countdown !== null ? countdown.endsAt : -1);
      camera.update(ctx, w, h);
      fx.lateUpdate(ctx);
      work[st.workI] = performance.now() - now;
      st.workI = (st.workI + 1) % WORK_RING;
      if (st.workN < WORK_RING) st.workN++;
    } else {
      camera.refit(w, h);   // the last board at the new size (D33)
    }

    // 6. The one render of the frame.
    if (renderer.getContext().isContextLost()) return;
    if (post.enabled) {
      post.render(ctx.dtS);
      st.sceneCalls = post.sceneCalls;
      st.triangles = post.sceneTriangles;
    } else {
      renderer.render(scene, camera.camera);
      st.sceneCalls = info.render.calls;
      st.triangles = info.render.triangles;
    }
    st.total = info.render.calls;
    st.frames++;
    st.drawn = 1;

    // 7. Stats.
    if (st.lastStats < 0) st.lastStats = now;
    const elapsed = now - st.lastStats;
    if (elapsed >= STATS_MS) {
      const r = stats.render;
      r.calls = st.sceneCalls;
      r.postCalls = st.total - st.sceneCalls;
      r.triangles = st.triangles;
      r.programs = info.programs !== null ? info.programs.length : 0;
      r.fps = (st.frames * 1000) / elapsed;
      for (let i = 0; i < st.workN; i++) scratch[i] = work[i];
      r.frameMsP95 = selectQuantile(scratch, st.workN, 0.95);
      r.tier = ctx.tier;
      st.frames = 0;
      st.lastStats = now;
    }
  };
}
