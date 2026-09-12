// The stage inside the Canvas. It builds the lights, the rotated board group, the six entity systems, the camera
// rig, the post pipeline and the FX director once per canvas, mounts the single ordered frame loop at priority 1,
// and wires context loss, warmup, tier changes, epoch resets and the stage-mode defaults (E40 dim, E44 freeze).
// Every resource it creates is disposed when the canvas unmounts (C70).
//
// The stage is built in a layout effect, never during render: fiber renders into a concurrent root, where a render
// that is discarded or restarted would leave a board and lights in the scene that nothing disposes.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import type { RootState } from '@react-three/fiber';
import * as THREE from 'three';
import type { App } from '../app/types';
import type { EntityFx, FrameCtx, FxDirector, FxFactory, FxHost, StageMode, Tier } from './contracts';
import type { AppState, GfxHealth } from '../state/appStore';
import { createFrameRunner } from './loop';
import type { QualitySampler } from './loop';
import { CameraRig } from './camera';
import { PostPipeline } from './post/composer';
import { attachContextLoss } from './contextLoss';
import { createWarmScheduler, warmup } from './warmup';
import { releaseMaterialPrograms, tierChangeReleasesPrograms } from './programs';
import { createSharedUniforms } from './materials/patch';
import { createGlowTexture } from './textures';
import { FloorSystem } from './systems/floor';
import { WallsSystem } from './systems/walls';
import { BricksSystem } from './systems/bricks';
import { PaddlesSystem } from './systems/paddles';
import { BallsSystem } from './systems/balls';
import { HalosSystem } from './systems/halos';
import { T } from '../config/tuning';
import { BRICK_MAX_LIFE } from '../config/constants';
import { COLORS, HDR, lifeColor } from '../config/palette';
import { canvasToBoard } from '../game/orientation';
import { browserTimers } from '../lib/timers';
import { now } from '../lib/clock';
import { useStore } from '../lib/useStore';

export interface SceneProps {
  app: App;
  fxFactory: FxFactory;
  mode: StageMode;
  popLayer: HTMLElement;
  /** The tier controller while the quality setting is 'auto'; null when the tier is set by hand. */
  quality: QualitySampler | null;
  onHealth: (h: GfxHealth) => void;
  remount: () => void;
}

interface StageSystem { readonly name: string; update(ctx: FrameCtx): void; reset(): void; dispose(): void; markNeedsUpdate(): void }

interface Stage {
  readonly runner: (state: RootState, deltaS: number) => void;
  readonly post: PostPipeline;
  readonly fx: FxDirector;
  readonly entities: EntityFx;
  setTier(t: Tier): void;
  /** Warms the stage, or asks the running warm to go round once more (a tier change while compiling). */
  warm(): Promise<void>;
  /** Abandons the running warm and starts a new one: after a context restore, whose loss may have cut it off. */
  restartWarm(): Promise<void>;
  /** An epoch change: the systems and FX reset on the first frame whose board is ready. */
  newEpoch(): void;
  markNeedsUpdate(): void;
  dispose(): void;
}

const LIGHT_DISTANCE = 2000;
const BRICK_COLORS: readonly THREE.Color[] = Array.from({ length: BRICK_MAX_LIFE + 1 }, (_, l) => new THREE.Color(lifeColor(Math.max(1, l))));

const selectVisible = (s: AppState): boolean => s.page.visible;

function buildStage(
  app: App, gl: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera,
  fxFactory: FxFactory, popLayer: HTMLElement, getMode: () => StageMode, quality: QualitySampler,
): Stage {
  const game = app.game;
  const shared = createSharedUniforms();
  const board = new THREE.Group();
  board.name = 'board';
  scene.add(board);
  const hemi = new THREE.HemisphereLight('#cbd5ff', '#0b0b10', 0.6);
  const sun = new THREE.DirectionalLight('#ffffff', 1.4);
  sun.position.set(-0.35, -0.6, 1).normalize().multiplyScalar(LIGHT_DISTANCE);
  sun.castShadow = false;
  scene.add(hemi, sun, sun.target);
  scene.background = null;
  gl.setClearColor(COLORS.background, 1);

  const deps = { board, render: game.render, world: game.world, shared };
  const glow = createGlowTexture();
  const floor = new FloorSystem(deps);
  const walls = new WallsSystem(deps);
  const bricks = new BricksSystem(deps);
  const paddles = new PaddlesSystem(deps);
  const balls = new BallsSystem(deps);
  const halos = new HalosSystem(deps, balls, () => app.input.desired, glow);
  const systems: readonly StageSystem[] = [floor, walls, bricks, paddles, balls, halos];

  const rig = new CameraRig(camera, T.camera);
  rig.setBoard(board, game.world);
  const tier = app.store.get().gfx.tier;
  const post = new PostPipeline(gl, scene, camera, tier);
  const syncHdr = (): void => {
    shared.uHdr.value = post.enabled && post.lowBit ? HDR.lowBitScale : 1;
  };
  syncHdr();

  const entities: EntityFx = {
    flashPaddle: (seat, u, strength) => paddles.flashPaddle(seat, u, strength),
    squashPaddle: (seat, amount) => paddles.squashPaddle(seat, amount),
    materialisePaddle: (seat, mode) => paddles.materialisePaddle(seat, mode),
    flashWall: (wall, u, strength, kind) => walls.flashWall(wall, u, strength, kind),
    pulseBall: (id, strength) => balls.pulseBall(id, strength),
    spawnBall: (id) => balls.spawnBall(id),
    dissolveBall: (id, seconds) => balls.dissolveBall(id, seconds),
    resizeBall: (id, radius) => balls.resizeBall(id, radius),
    flashBrick: (cell, strength) => bricks.flashBrick(cell, strength),
    brickRise: (mode, seconds) => bricks.brickRise(mode, seconds),
    ripple: (x, y, strength) => floor.ripple(x, y, strength),
    winnerSweep: (winner, seconds) => {
      floor.winnerSweep(winner, seconds);
      walls.winnerSweep(winner, seconds);
    },
    setDim: (target, seconds) => floor.setDim(target, seconds),
    wallBreathe: (seconds) => walls.wallBreathe(seconds),
  };

  const pt = { x: 0, y: 0 };
  const v = new THREE.Vector3();
  const host: FxHost = {
    scene, board, camera: rig, post, entities, render: game.render, world: game.world, popLayer,
    toBoard(x, y, z, out) {
      canvasToBoard(x, y, game.world.canvas, pt);
      return out.set(pt.x, pt.y, z);
    },
    project(boardLocal, out) {
      v.copy(boardLocal).applyMatrix4(board.matrixWorld).project(camera);
      out.sx = (v.x + 1) * 0.5 * rig.width;
      out.sy = (1 - v.y) * 0.5 * rig.height;
      out.visible = v.z > -1 && v.z < 1 && v.x >= -1.1 && v.x <= 1.1 && v.y >= -1.1 && v.y <= 1.1;
    },
    hitStop: (ms, reason) => game.hitStop(ms, reason),
    slotOf: (id) => game.slotOf(id),
    brickColor: (life, out) => out.copy(BRICK_COLORS[life < 1 ? 1 : life > BRICK_MAX_LIFE ? BRICK_MAX_LIFE : Math.round(life)]),
  };
  const fx = fxFactory(host);
  fx.setTier(tier);

  let disposed = false;
  let resetPending = false;
  const run = createFrameRunner({ app, systems, fx, camera: rig, post, renderer: gl, scene, quality }, getMode);
  // The reset waits for the new epoch's first grid (render.ready), so until then a resize can redraw the frozen
  // board as it was (D33), and the bricks diff the kept instances against that grid, fading the cells the rejoin
  // removed (5.11). It runs before game.frame, so the new epoch's first released events reach a clean director.
  const runner = (state: RootState, deltaS: number): void => {
    if (disposed) return;
    if (resetPending && game.render.ready) {
      resetPending = false;
      for (const s of systems) {
        if (s === bricks) bricks.newEpoch();
        else s.reset();
      }
      fx.reset();
    }
    run(state, deltaS);
  };

  const warmer = createWarmScheduler((aborted) => warmup(gl, scene, camera, aborted), () => disposed);

  return {
    runner, post, fx, entities,
    setTier(t) {
      if (disposed) return;
      const from = post.tier;
      post.setTier(t);
      fx.setTier(t);
      syncHdr();
      // Across the low boundary every scene program's key changes (target or screen output, tone mapping), and
      // three keeps the variants of the tier being left until the material is disposed (programs.ts). The store
      // subscriber warms right after this, compiling the new set.
      if (tierChangeReleasesPrograms(from, t)) releaseMaterialPrograms(scene);
    },
    warm: () => warmer.warm(),
    restartWarm: () => warmer.restart(),
    newEpoch() {
      resetPending = true;
    },
    markNeedsUpdate() {
      if (disposed) return;
      for (const s of systems) s.markNeedsUpdate();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      fx.dispose();
      for (const s of systems) s.dispose();
      post.dispose();
      glow.dispose();
      scene.remove(board, hemi, sun, sun.target);
      hemi.dispose();
      sun.dispose();
    },
  };
}

export function Scene({ app, fxFactory, mode, popLayer, quality, onHealth, remount }: SceneProps): null {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const invalidate = useThree((s) => s.invalidate);
  const width = useThree((s) => s.size.width);
  const height = useThree((s) => s.size.height);
  const dpr = useThree((s) => s.viewport.dpr);
  const visible = useStore(app.store, selectVisible);

  const modeRef = useRef<StageMode>(mode);
  const qualityRef = useRef<QualitySampler | null>(quality);
  useLayoutEffect(() => {
    modeRef.current = mode;
    qualityRef.current = quality;
  }, [mode, quality]);

  const stageRef = useRef<Stage | null>(null);
  const [stage, setStage] = useState<Stage | null>(null);
  useLayoutEffect(() => {
    const sampler: QualitySampler = { sample: (dtMs, refreshMs) => qualityRef.current?.sample(dtMs, refreshMs) };
    const built = buildStage(app, gl, scene, camera, fxFactory, popLayer, () => modeRef.current, sampler);
    stageRef.current = built;
    setStage(built);
    return () => {
      if (stageRef.current === built) stageRef.current = null;
      built.dispose();
    };
  }, [app, gl, scene, camera, fxFactory, popLayer]);

  useFrame((state, deltaS) => stageRef.current?.runner(state, deltaS), 1);

  // Fiber's resize reallocates and clears the drawing buffer without asking for a frame; in 'demand' (frozen, or
  // ended after its effects) nothing else would, and the stage would stay blank.
  useEffect(() => {
    invalidate();
  }, [width, height, dpr, invalidate]);

  const warmAndShow = useCallback(() => {
    if (stage === null) return;
    void stage.warm().then(() => {
      if (!gl.getContext().isContextLost()) invalidate();
    });
  }, [stage, gl, invalidate]);

  // Context loss (5.8): attached per canvas, detached in the unmount cleanup. A restore restarts the warm rather
  // than joining one the loss cut off, so every restore ends in health 'ok' and a frame.
  useEffect(() => {
    if (stage === null) return;
    onHealth('ok');
    return attachContextLoss(gl.domElement, gl, {
      onHealth, timers: browserTimers, now, remount,
      restored: () => {
        stage.markNeedsUpdate();
        void stage.restartWarm().then(() => {
          if (gl.getContext().isContextLost()) return;
          onHealth('ok');
          invalidate();
        });
      },
    });
  }, [gl, stage, onHealth, remount, invalidate]);

  // Warmup when the board is ready, tier changes, epoch resets and FX reset on visible (D21).
  useEffect(() => {
    if (stage === null) return;
    const store = app.store;
    let prev = store.get();
    stage.setTier(prev.gfx.tier);
    if (prev.session.worldReady) warmAndShow();
    return store.subscribe(() => {
      const s = store.get();
      if (s.gfx.tier !== prev.gfx.tier) {
        stage.setTier(s.gfx.tier);
        warmAndShow();
      }
      if (s.session.epoch !== prev.session.epoch) stage.newEpoch();
      if (s.session.worldReady && !prev.session.worldReady) warmAndShow();
      if (s.page.visible && !prev.page.visible) stage.fx.reset();
      prev = s;
    });
  }, [app, stage, warmAndShow]);

  // Stage-mode defaults: 35 % dim behind the lobby (E40), frozen at 25 % saturation and 40 % dim (E44), restored
  // with a 0.3 s ramp; the FX director may ramp further on events.
  const prevMode = useRef<StageMode | null>(null);
  useEffect(() => {
    if (stage === null) return;
    const reduced = app.store.get().motion.reduced;
    const from = prevMode.current;
    prevMode.current = mode;
    const ramp = (s: number): number => (reduced || from === null ? 0 : s);
    if (mode === 'lobby') {
      stage.entities.setDim(0.35, ramp(0.4));
      stage.post.saturation(1, ramp(0.3));
    } else if (mode === 'frozen') {
      stage.entities.setDim(0.4, 0);
      stage.post.saturation(0.25, 0);
    } else {
      stage.entities.setDim(1, ramp(from === 'lobby' ? 3 : 0.3));
      stage.post.saturation(1, ramp(0.3));
    }
    invalidate();
  }, [mode, stage, app, invalidate]);

  // The lobby runs on demand at lobbyFps (D30).
  useEffect(() => {
    if (mode !== 'lobby' || !visible) return;
    const handle = setInterval(() => invalidate(), 1000 / T.render.lobbyFps);
    return () => clearInterval(handle);
  }, [mode, visible, invalidate]);

  return null;
}
