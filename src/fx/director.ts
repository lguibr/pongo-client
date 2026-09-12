// The effects director (4.12, 6): createFxDirector implements FxFactory. The frame loop hands it every released event
// through consume (D20, D34): a stale event changes state only (STALE), any other runs its preset (PRESETS, 6.1),
// which calls the host (EntityFx, CameraFx, PostFx, hitStop), spawns into the GPU pools under the budget, and shows
// pops. update() advances pool time, samples the trails, places the phasing shells and runs the scheduled pulses;
// lateUpdate() projects the pops after the camera. Every material and geometry is created once per stage and disposed
// with it (C69, C70); pools outlive the entities that triggered them (C04, C72). update() allocates nothing.

import * as THREE from 'three';
import type { FrameCtx, FxDirector, FxFactory, FxHost, FxStats, Tier } from '../render/contracts';
import type { GameEvent, GameEventKind } from '../game/events';
import type { Tuning } from '../config/tuning';
import { T } from '../config/tuning';
import { HDR } from '../config/palette';
import { seeded } from '../lib/random';
import type { Rand } from '../lib/random';
import { stats } from '../state/stats';
import { FxBudget } from './budget';
import type { Priority } from './budget';
import { createFxUniforms } from './pools/gpuPool';
import type { FxUniforms, InstancedPool } from './pools/gpuPool';
import { SparkPool, sparkBurst } from './pools/sparks';
import type { SparkBurst } from './pools/sparks';
import { ShardPool, shardBurst } from './pools/shards';
import type { ShardBurst } from './pools/shards';
import { RingPool, ringSpec } from './pools/rings';
import type { RingSpec } from './pools/rings';
import { DecalPool, decalSpec } from './pools/decals';
import type { DecalSpec } from './pools/decals';
import { TrailSystem } from './trails';
import { ShellSystem } from './shells';
import { PopLayer } from './pops';
import { PRESETS, STALE, createRuntimeState, runSchedules } from './presets';
import type { FxKit, FxRuntimeState, Preset } from './presets';

type AnyPreset = Preset<GameEventKind>;

function maxOf(pools: Tuning['fx']['pools'], key: 'sparks' | 'shards' | 'rings' | 'decals' | 'trailPoints'): number {
  return Math.max(pools.high[key], pools.medium[key], pools.low[key]);
}

function touchDevice(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function'
    && typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
}

export class EffectsDirector implements FxDirector, FxKit {
  readonly stats: FxStats = { sparks: 0, shards: 0, rings: 0, decals: 0, trails: 0, droppedP2: 0, staleSkipped: 0 };
  readonly host: FxHost;
  readonly budget: FxBudget;
  readonly sparks: SparkPool;
  readonly shards: ShardPool;
  readonly rings: RingPool;
  readonly decals: DecalPool;
  readonly trails: TrailSystem;
  readonly shells: ShellSystem;
  readonly pops: PopLayer;
  readonly spark: SparkBurst = sparkBurst();
  readonly shard: ShardBurst = shardBurst();
  readonly ring: RingSpec = ringSpec();
  readonly decal: DecalSpec = decalSpec();
  readonly v = new THREE.Vector3();
  readonly c = new THREE.Color();
  readonly fx: FxRuntimeState = createRuntimeState();
  private readonly tuning: Tuning;
  private readonly uniforms: FxUniforms;
  private readonly canVibrate: boolean;
  private tierV: Tier = 'high';
  private hdrScale = 1.5;
  private disposed = false;

  constructor(host: FxHost, tuning: Tuning = T, rand: Rand = seeded(0x5eed)) {
    this.host = host;
    this.tuning = tuning;
    this.canVibrate = touchDevice();
    const fx = tuning.fx;
    const start = fx.pools.high;
    this.budget = new FxBudget(fx);
    this.uniforms = createFxUniforms();
    this.sparks = new SparkPool(this.uniforms, maxOf(fx.pools, 'sparks'), start.sparks, rand);
    this.shards = new ShardPool(this.uniforms, maxOf(fx.pools, 'shards'), start.shards, rand);
    this.rings = new RingPool(this.uniforms, maxOf(fx.pools, 'rings'), start.rings);
    this.decals = new DecalPool(this.uniforms, maxOf(fx.pools, 'decals'), start.decals);
    this.trails = new TrailSystem(host.render, this.uniforms, maxOf(fx.pools, 'trailPoints'), start.trailPoints);
    this.shells = new ShellSystem(host.render, host.world, this.uniforms, this.trails);
    this.pops = new PopLayer(host);
    host.board.add(
      this.decals.pool.object, this.rings.pool.object, this.trails.object, this.shells.object,
      this.sparks.pool.object, this.shards.pool.object,
    );
  }

  get tier(): Tier {
    return this.tierV;
  }

  consume(e: GameEvent, ctx: FrameCtx): void {
    if (this.disposed) return;
    this.pops.setTime(ctx.fxTimeS);
    if (e.stale) {
      this.stats.staleSkipped++;
      const s = STALE[e.k] as AnyPreset | undefined;
      if (s !== undefined) s(this, e, ctx);
      return;
    }
    (PRESETS[e.k] as AnyPreset)(this, e, ctx);
  }

  update(ctx: FrameCtx): void {
    if (this.disposed) return;
    const t = ctx.fxTimeS;
    const hdr = this.host.post.enabled && this.host.post.lowBit ? HDR.lowBitScale : 1;
    if (hdr !== this.hdrScale) {
      this.hdrScale = hdr;
      this.uniforms.uHdr.value = hdr;
    }
    this.sparks.pool.setTime(t);
    this.shards.pool.setTime(t);
    this.rings.pool.setTime(t);
    this.decals.pool.setTime(t);
    this.trails.update(ctx);
    this.shells.update(ctx);
    runSchedules(this, ctx);
    const st = this.stats;
    st.sparks = this.sparks.pool.live;
    st.shards = this.shards.pool.live;
    st.rings = this.rings.pool.live;
    st.decals = this.decals.pool.live;
    st.trails = this.trails.active;
    const g = stats.fx;
    g.sparks = st.sparks;
    g.shards = st.shards;
    g.rings = st.rings;
    g.decals = st.decals;
    g.droppedP2 = st.droppedP2;
  }

  lateUpdate(ctx: FrameCtx): void {
    if (this.disposed) return;
    this.pops.lateUpdate(ctx);
  }

  /** Epoch change, visible again, stage remount: every live effect ends. */
  reset(): void {
    if (this.disposed) return;
    this.sparks.pool.clear();
    this.shards.pool.clear();
    this.rings.pool.clear();
    this.decals.pool.clear();
    this.trails.reset();
    this.shells.reset();
    this.pops.clear();
    const fresh = createRuntimeState();
    Object.assign(this.fx, fresh);
  }

  /** Tier budgets (6.2): pool capacities, trail points and spawnScale. Never a program change. */
  setTier(t: Tier): void {
    if (this.disposed) return;
    this.tierV = t;
    this.budget.setTier(t);
    const p = this.tuning.fx.pools[t];
    this.sparks.pool.setCapacity(p.sparks);
    this.shards.pool.setCapacity(p.shards);
    this.rings.pool.setCapacity(p.rings);
    this.decals.pool.setCapacity(p.decals);
    this.trails.setPoints(p.trailPoints);
  }

  /** After a WebGL context restore: every buffer uploads whole. */
  markNeedsUpdate(): void {
    this.sparks.pool.markNeedsUpdate();
    this.shards.pool.markNeedsUpdate();
    this.rings.pool.markNeedsUpdate();
    this.decals.pool.markNeedsUpdate();
    this.trails.markNeedsUpdate();
    this.shells.markNeedsUpdate();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.sparks.pool.dispose();
    this.shards.pool.dispose();
    this.rings.pool.dispose();
    this.decals.pool.dispose();
    this.trails.dispose();
    this.shells.dispose();
    this.pops.dispose();
  }

  grant(requested: number, p: Priority, pool: InstancedPool): number {
    const n = this.budget.grant(requested, p, pool.free, pool.capacity);
    if (p === 2 && n === 0 && requested >= 1) this.stats.droppedP2++;
    return n;
  }

  vibrate(ms: number): void {
    if (!this.canVibrate) return;
    try {
      navigator.vibrate(ms);
    } catch {
      // a blocked vibration is not an error
    }
  }
}

export const createFxDirector: FxFactory = (host) => new EffectsDirector(host);
