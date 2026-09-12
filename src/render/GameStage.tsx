// The <Canvas> host (3.8). It is never rendered under StrictMode (D22). It owns the frameloop policy per stage mode
// (9.3), the DPR cap per tier, the pop layer and the stage key, and it is the only writer of the gfx slice: health
// from attachContextLoss's onHealth and from renderer creation, the tier from QualityController. With health
// 'failed' or 'unsupported' it throws GraphicsFailedError during render, so StageBoundary shows its fallback.

import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { Canvas } from '@react-three/fiber';
import * as THREE from 'three';
import type { App } from '../app/types';
import type { FxFactory, StageMode } from './contracts';
import type { AppState, AppStore, GfxHealth } from '../state/appStore';
import type { QualityPref, Settings } from '../lib/settings';
import { GraphicsFailedError } from './StageBoundary';
import { Scene } from './Scene';
import { QualityController, initialTier } from './quality';
import { noteCreationError, noteStageCreated } from './contextLoss';
import { T } from '../config/tuning';
import { useStore } from '../lib/useStore';
import { now } from '../lib/clock';

export interface GameStageProps { app: App; fxFactory: FxFactory; mode: StageMode }

const selectGfx = (s: AppState): AppState['gfx'] => s.gfx;
const selectVisible = (s: AppState): boolean => s.page.visible;
const selectQuality = (s: Settings): Settings['quality'] => s.quality;

const STAGE_STYLE: CSSProperties = { position: 'relative', width: '100%', height: '100%', overflow: 'hidden' };
const POP_STYLE: CSSProperties = { position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden' };
const CAMERA = { fov: T.camera.fovDeg, near: 1, far: 20000, position: [0, -2000, 3000] as [number, number, number], manual: true };
const RESIZE = { scroll: false, debounce: { scroll: 50, resize: 0 } };

/** The gfx slice's only write path: a patch only when something changed. */
function writeGfx(store: AppStore, p: Partial<AppState['gfx']>): void {
  const cur = store.get().gfx;
  const next = { ...cur, ...p };
  if (next.health === cur.health && next.tier === cur.tier && next.stageKey === cur.stageKey) return;
  store.patch({ gfx: next });
}

function deviceInfo(): { deviceMemory?: number; hardwareConcurrency?: number } {
  if (typeof navigator === 'undefined') return {};
  return { deviceMemory: (navigator as Navigator & { deviceMemory?: number }).deviceMemory, hardwareConcurrency: navigator.hardwareConcurrency };
}

function coarsePointer(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
}

/** Creates the renderer. A creation error before any success is 'unsupported'; after one it is a failed remount,
 *  retried with a new stage key until the escalation budget is spent (5.8). The error still propagates, so the
 *  boundary shows its fallback until the key changes. */
function createRenderer(canvas: HTMLCanvasElement | OffscreenCanvas, store: AppStore): THREE.WebGLRenderer {
  try {
    const renderer = new THREE.WebGLRenderer({
      canvas, antialias: false, alpha: false, stencil: false, depth: true, powerPreference: 'high-performance',
    });
    noteStageCreated();
    return renderer;
  } catch (err) {
    const outcome = noteCreationError(now());
    if (outcome === 'remount') writeGfx(store, { health: 'lost', stageKey: store.get().gfx.stageKey + 1 });
    else writeGfx(store, { health: outcome });
    throw err;
  }
}

/** One tier controller per page (per app store), so its verdict outlives a GameStage mount: a new room or a
 *  StageBoundary remount neither forgets a step-down nor earns a second step-up (5.13, at most once per session).
 *  `pref` is the setting the initial tier was last derived from; null before the first mount. */
interface PageQuality { readonly controller: QualityController; pref: QualityPref | null }
const pageQuality = new WeakMap<AppStore, PageQuality>();

function qualityFor(store: AppStore): PageQuality {
  let q = pageQuality.get(store);
  if (q === undefined) {
    q = { controller: new QualityController(T.quality, store.get().gfx.tier, (tier) => writeGfx(store, { tier })), pref: null };
    pageQuality.set(store, q);
  }
  return q;
}

/** True for endEffectsMs after the mode became 'ended'. */
function useEndEffects(mode: StageMode): boolean {
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (mode !== 'ended') return;
    const handle = setTimeout(() => setSettled(true), T.render.endEffectsMs);
    return () => {
      clearTimeout(handle);
      setSettled(false);
    };
  }, [mode]);
  return mode === 'ended' && !settled;
}

export function GameStage({ app, fxFactory, mode }: GameStageProps): JSX.Element {
  const store = app.store;
  const gfx = useStore(store, selectGfx);
  const visible = useStore(store, selectVisible);
  const pref = useStore(app.settings, selectQuality);
  const endEffects = useEndEffects(mode);
  const [popLayer, setPopLayer] = useState<HTMLDivElement | null>(null);

  const page = useMemo(() => qualityFor(store), [store]);
  const quality = page.controller;
  // The initial tier is derived when the setting changes, not on every mount, so a remount keeps the tier the
  // controller chose.
  useLayoutEffect(() => {
    if (page.pref === pref) return;
    page.pref = pref;
    const tier = initialTier(pref, deviceInfo(), coarsePointer());
    quality.setTier(tier);
    writeGfx(store, { tier });
  }, [pref, page, quality, store]);

  const onHealth = useCallback((health: GfxHealth) => writeGfx(store, { health }), [store]);
  const remount = useCallback(() => writeGfx(store, { stageKey: store.get().gfx.stageKey + 1 }), [store]);
  const glFactory = useCallback((canvas: HTMLCanvasElement | OffscreenCanvas) => createRenderer(canvas, store), [store]);

  if (gfx.health === 'failed' || gfx.health === 'unsupported') throw new GraphicsFailedError();

  const frameloop = !visible ? 'never' : mode === 'live' || endEffects ? 'always' : 'demand';
  return (
    <div style={STAGE_STYLE}>
      <Canvas
        key={gfx.stageKey}
        gl={glFactory}
        flat
        dpr={[1, T.quality.dpr[gfx.tier]]}
        frameloop={frameloop}
        camera={CAMERA}
        resize={RESIZE}
      >
        {popLayer !== null && (
          <Scene
            app={app}
            fxFactory={fxFactory}
            mode={mode}
            popLayer={popLayer}
            quality={pref === 'auto' ? quality : null}
            onHealth={onHealth}
            remount={remount}
          />
        )}
      </Canvas>
      <div ref={setPopLayer} aria-hidden="true" style={POP_STYLE} />
    </div>
  );
}
