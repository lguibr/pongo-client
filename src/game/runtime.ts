// The game runtime (4.6, 4.7): owns the World, the ring, the playout clock, the event queue and the cold
// bridge. ingest() runs per server batch; frame() runs per display frame and allocates nothing.

import type { EventQueue, GameEvent, IngestEventCtx, IngestListener, Owner } from './events';
import { IMMEDIATE } from './events';
import type { GameRuntime, GameRuntimeDeps, PlayoutStats } from './types';
import { PADDLE_STRIDE, PO } from './types';
import type { GameOver, GameUpdates, InitialState } from '../protocol/messages';
import type { IngestResult, WorldSummary } from '../session/types';
import type { ResultsView } from '../state/appStore';
import type { Visual } from '../input/types';
import type { MutableIngestResult, ReducerCtx } from './reducer';
import { applyBatch, applyInitial } from './reducer';
import { createWorld, graceSeats, resetWorld } from './world';
import { SnapshotRing } from './ring';
import { Playout } from './playout';
import { createEventQueue } from './queue';
import { DeriveScratch } from './derive';
import { createBatchPlan } from './segment';
import { SAMPLE_AT, createRenderState, sampleIntoAt } from './interpolate';
import { ColdBridge } from './coldBridge';
import { derivedResults, resultsFromGameOver } from './results';
import { toWire } from './orientation';
import { T } from '../config/tuning';
import { CELLS, CellType, TICK_MS } from '../config/constants';
import { now as clockNow } from '../lib/clock';
import { browserTimers } from '../lib/timers';
import { stats } from '../state/stats';

const QUEUE_CAPACITY = 1024;
const noopFire = (): void => {};
const NO_CONTROLS: IngestResult['controls'] = Object.freeze([]);

function hasSeatChange(events: readonly GameEvent[]): boolean {
  for (let i = 0; i < events.length; i++) if (events[i].k === 'seat' || events[i].k === 'score') return true;
  return false;
}

/** ingest() ends with: if !headless and nowMs - lastFrameCallMs > T.playout.staleMs, release the whole
 *  queue stale through the same bookkeeping as frame() (D34). */
export function createGameRuntime(deps: GameRuntimeDeps): GameRuntime {
  const tuning = deps.tuning ?? T;
  const now = deps.now ?? clockNow;
  const timers = deps.timers ?? browserTimers;
  const world = createWorld();
  const ring = new SnapshotRing();
  const playout = new Playout(tuning.playout, tuning.hitStop);
  const render = createRenderState();
  const scratch = new DeriveScratch();
  const plan = createBatchPlan();
  const listeners = new Set<IngestListener>();
  const batchEvents: GameEvent[] = [];
  const queue = createEventQueue(QUEUE_CAPACITY, (e) => bookkeep(e));
  const bridge = new ColdBridge(deps.store, queue, timers, now, world);
  const staleTicks = tuning.playout.staleMs / TICK_MS;
  const playoutStats: PlayoutStats = { delayMs: 0, jitterMs: 0, snaps: 0, idle: true, extrapolating: false, lastTicksPerBatch: 0 };

  // Everything the reducer pushes is also collected for the ingest listeners.
  const recorder: EventQueue = {
    get size(): number {
      return queue.size;
    },
    pendingScoreDelta: queue.pendingScoreDelta,
    push(e: GameEvent): void {
      batchEvents.push(e);
      queue.push(e);
    },
    drain: (displayTick, idle, stale, fire) => queue.drain(displayTick, idle, stale, fire),
    releaseAllStale: (fire) => queue.releaseAllStale(fire),
    clear: () => queue.clear(),
    nextSeq: () => queue.nextSeq(),
  };
  const ctx: ReducerCtx = { world, ring, playout, queue: recorder, scratch, nowMs: 0, tuning };
  const out: MutableIngestResult = { controls: [], ticks: 0, boardReady: false };

  let headless = false;
  let ownLead = tuning.ownLead.enabled;
  let intent: (() => Visual) | null = null;
  let unstable = false;
  let fireTarget: (e: GameEvent) => void = noopFire;
  // Per-frame doubles live on an object, whose number fields are updated in place (a captured `let` would box a
  // new number on every write).
  const fs = { lastFrameCallMs: -Infinity, lead: 0.5, dtMs: 0.5 };
  fs.lead = 0;
  fs.dtMs = 0;

  /** Release bookkeeping, before any presentation (D34): pending score deltas are settled by the queue; the
   *  display brick arrays follow brick events (D32); score and seat events mark the cold bridge. */
  function bookkeep(e: GameEvent): void {
    stats.events.released++;
    if (e.stale) stats.events.stale++;
    switch (e.k) {
      case 'brickDamaged':
        render.brickLife[e.cell] = e.to;
        render.brickType[e.cell] = CellType.Brick;
        render.brickFade[e.cell] = e.stale ? 1 : 0;
        render.brickVersion++;
        break;
      case 'brickDestroyed':
        render.brickLife[e.cell] = 0;
        render.brickType[e.cell] = CellType.Empty;
        render.brickFade[e.cell] = e.stale ? 1 : 0;
        render.brickVersion++;
        break;
      case 'score':
      case 'seat':
        bridge.markDirty();
        break;
      default:
        break;
    }
  }
  const releaseToFire = (e: GameEvent): void => {
    bookkeep(e);
    fireTarget(e);
  };

  /** The first grid of an epoch replaces the display arrays at once; a cell that was alive and is now empty
   *  fades (5.4.3). */
  function showFirstGrid(): void {
    for (let i = 0; i < CELLS; i++) {
      const wasAlive = render.brickType[i] === CellType.Brick;
      const type = world.brickType[i];
      render.brickLife[i] = world.brickLife[i];
      render.brickType[i] = type;
      render.brickFade[i] = wasAlive && type !== CellType.Brick ? 1 : 0;
    }
    render.brickVersion++;
    render.frozen = false;
    render.ready = true;
    playout.snap();
  }

  /** Grid changes that no rule has an event for are shown at once and fade. */
  function showSilentCells(): void {
    for (let j = 0; j < scratch.silentN; j++) {
      const i = scratch.silentCells[j];
      render.brickLife[i] = world.brickLife[i];
      render.brickType[i] = world.brickType[i];
      render.brickFade[i] = 1;
    }
    render.brickVersion++;
  }

  /** Display time at nowMs, projected from the last frame: it stands still for what is left of a hit-stop and
   *  never passes the cap frame() applies (the newest sample while unstable, plus maxExtrapMs otherwise). */
  function estimateDisplayMs(nowMs: number): number {
    if (!playout.started) return world.tick * TICK_MS;
    const sinceFrame = nowMs - fs.lastFrameCallMs;
    if (sinceFrame >= 0 && sinceFrame <= tuning.playout.staleMs) {
      const run = playout.hitStopActive ? Math.max(0, sinceFrame - playout.hitStopRemainingMs) : sinceFrame;
      const cap = playout.latestMs + (unstable ? 0 : tuning.playout.maxExtrapMs);
      return Math.min(playout.displayMs + run, cap);
    }
    const since = Math.max(0, Math.min(TICK_MS, nowMs - playout.lastArrivalMs));
    return playout.latestMs + since - playout.delayMs;
  }

  function notify(events: readonly GameEvent[], nowMs: number): void {
    if (listeners.size === 0 || events.length === 0) return;
    const ectx: IngestEventCtx = { nowMs, displayMs: estimateDisplayMs(nowMs), myIndex: world.myIndex, headless };
    for (const fn of Array.from(listeners)) fn(events, ectx);
  }

  function releaseIfNoFrames(nowMs: number): void {
    if (headless || nowMs - fs.lastFrameCallMs > tuning.playout.staleMs) queue.releaseAllStale(bookkeep);
  }

  function clearLead(): void {
    fs.lead = 0;
    render.paddleLead.fill(0);
  }

  /** Own-paddle lead (5.3, D08): visual only, never changes what is sent. render.paddleLead[seat] is in board
   *  units along the paddle's axis, in RenderState board space: consumers add it to PO.CX for seats 1 and 3 and
   *  to PO.CY for seats 0 and 2 (the canvas-y lead is negated here, so no consumer applies a canvas sign).
   *  fs.lead itself is kept in canvas px along the axis. Reads fs.dtMs. */
  function updateLead(): void {
    const me = world.myIndex;
    const pl = render.paddleLead;
    if (!ownLead || me === null || intent === null || !world.paddles[me].present) {
      if (fs.lead !== 0 || pl[0] !== 0 || pl[1] !== 0 || pl[2] !== 0 || pl[3] !== 0) clearLead();
      return;
    }
    const p = world.paddles[me];
    const vertical = me === 0 || me === 2;
    const v = vertical ? p.vy : p.vx;
    const serverDir = v > 0 ? 1 : v < 0 ? -1 : 0;
    const wire = toWire(me, intent());
    const want = wire === 'ArrowLeft' ? -1 : wire === 'ArrowRight' ? 1 : 0;
    const dtS = fs.dtMs / 1000;
    const L = tuning.ownLead;
    let lead = fs.lead;
    if (want !== serverDir) lead += want * L.speedPxPerS * dtS;
    else lead *= Math.exp(-dtS / L.bleedTauS);
    if (lead < -L.maxPx) lead = -L.maxPx;
    else if (lead > L.maxPx) lead = L.maxPx;
    // Keep the displayed paddle on its rail.
    const canvas = world.canvas;
    const half = canvas / 2;
    const o = me * PADDLE_STRIDE;
    const len = vertical ? p.h : p.w;
    const centre = vertical ? half - render.paddle[o + PO.CY] : render.paddle[o + PO.CX] + half;
    const lo = len / 2 - centre;
    const hi = canvas - len / 2 - centre;
    if (lo <= hi) {
      if (lead < lo) lead = lo;
      else if (lead > hi) lead = hi;
    }
    fs.lead = lead;
    pl[0] = 0;
    pl[1] = 0;
    pl[2] = 0;
    pl[3] = 0;
    pl[me] = vertical ? -lead : lead;
  }

  const runtime: GameRuntime = {
    world,
    render,
    queue,
    playoutStats,
    get hitStopActive(): boolean {
      return playout.hitStopActive;
    },

    reset(epoch, myIndex): void {
      resetWorld(world, epoch, myIndex);
      ring.clear();
      queue.clear();
      playout.reset();
      playout.setUnstable(unstable);
      scratch.reset();
      render.ready = false;   // render.frozen and the display brick arrays stay until the first grid (D33)
      clearLead();
      bridge.markDirty();
    },

    freeze(frozen): void {
      // No snap on freeze(false): the session never sends it, and every rejoin runs reset(), which snaps (5.2).
      world.frozen = frozen;
      render.frozen = frozen;
    },

    ingest(msg: InitialState | GameUpdates, arrivalMs: number): IngestResult {
      ctx.nowMs = arrivalMs;
      batchEvents.length = 0;
      if (msg.messageType === 'initialPlayersAndBallsState') {
        applyInitial(ctx, msg);
        out.controls.length = 0;
        out.ticks = 0;
        out.boardReady = false;
      } else {
        applyBatch(ctx, msg, plan, out);
        if (scratch.silentN > 0) showSilentCells();
      }
      if (out.boardReady) showFirstGrid();
      stats.events.pushed += batchEvents.length;
      stats.playout.ticksPerBatch[Math.min(out.ticks, 3)]++;
      playoutStats.lastTicksPerBatch = out.ticks;
      if (batchEvents.length > 0) notify(batchEvents.slice(), arrivalMs);
      // 2.4 step 6: the bridge is marked at ingest only when seats may have changed. Ready flags change without
      // an event, so a lobby item marks it too; score deltas are marked again when their events are released.
      if (msg.messageType === 'initialPlayersAndBallsState' || plan.lobby !== null || hasSeatChange(batchEvents)) bridge.markDirty();
      releaseIfNoFrames(arrivalMs);
      return {
        controls: out.controls.length > 0 ? out.controls.slice() : NO_CONTROLS,
        ticks: out.ticks,
        boardReady: out.boardReady,
      };
    },

    summary(): WorldSummary {
      return {
        ready: world.ready,
        bricksAlive: world.gridKnown ? world.bricksAlive : null,
        bricksAtStart: world.gridKnown ? world.bricksAtStart : null,
        tick: world.tick,
        graceSeats: graceSeats(world),
      };
    },

    results(msg: GameOver | null, reason: string): ResultsView {
      return msg !== null ? resultsFromGameOver(msg, world) : derivedResults(world, reason);
    },

    ended(winner: Owner, derived: boolean): void {
      const e: GameEvent = {
        k: 'gameOver', winner, derived, tick: IMMEDIATE, seq: queue.nextSeq(),
        x: world.canvas / 2, y: world.canvas / 2, conf: 1, stale: false,
      };
      queue.push(e);
      stats.events.pushed++;
      const t = now();
      notify([e], t);
      releaseIfNoFrames(t);
    },

    snap(): void {
      playout.snap();
    },

    setHeadless(h: boolean): void {
      headless = h;
      if (h) queue.releaseAllStale(bookkeep);
      else playout.snap();
    },

    frame(dtMs: number, nowMs: number, fire: (e: GameEvent) => void): void {
      fs.lastFrameCallMs = nowMs;
      const dt = dtMs < 0 ? 0 : dtMs > tuning.playout.dtClampMs ? tuning.playout.dtClampMs : dtMs;
      playout.advance(dt, nowMs);
      const displayTick = playout.started ? playout.displayMs / TICK_MS : world.tick;
      fireTarget = fire;
      if (headless) queue.releaseAllStale(releaseToFire);
      else queue.drain(displayTick, playout.idle, staleTicks, releaseToFire);
      fireTarget = noopFire;
      if (render.ready) {
        // The fractional tick goes through SAMPLE_AT: a double passed to a call that is not inlined is boxed.
        SAMPLE_AT[0] = displayTick;
        SAMPLE_AT[1] = playout.started && !unstable ? tuning.playout.maxExtrapMs / TICK_MS : 0;
        sampleIntoAt(world, ring, render);
        render.displayMs = playout.started ? playout.displayMs : world.tick * TICK_MS;
        fs.dtMs = dt;
        updateLead();
      }
      playoutStats.delayMs = playout.delayMs;
      playoutStats.jitterMs = playout.jitterMs;
      playoutStats.snaps = playout.snaps;
      playoutStats.idle = playout.idle;
      playoutStats.extrapolating = render.extrapolating;
      stats.playout.delayMs = playout.delayMs;
      stats.playout.jitterMs = playout.jitterMs;
      stats.playout.snaps = playout.snaps;
      stats.playout.extrapolating = render.extrapolating;
    },

    displayMs(nowMs: number): number {
      return estimateDisplayMs(nowMs);
    },

    hitStop(ms: number): void {
      playout.hitStop(ms, now());
    },

    setIntentSource(src: (() => Visual) | null): void {
      intent = src;
      if (src === null) clearLead();
    },

    setOwnLead(enabled: boolean): void {
      ownLead = enabled;
      if (!enabled) clearLead();
    },

    setUnstable(u: boolean): void {
      unstable = u;
      playout.setUnstable(u);
    },

    onIngestEvents(fn: IngestListener): () => void {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },

    slotOf(ballId: number): number {
      return world.slotById.get(ballId) ?? -1;
    },
  };
  return runtime;
}
