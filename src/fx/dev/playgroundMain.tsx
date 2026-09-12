// Dev-only FX playground (fx.html, 3.10). Both modes draw with the real GameStage and the effects director.
//  - Arena (default): the server oracle (ServerSim from src/game/testing, AI paddles, bricks on) feeds a real
//    createGameRuntime inside createFakeApp one physics tick every 25 ms, so trails, shells and derived events run
//    live. The panel fires every E-id on demand: synthetic released events straight into the director for the event
//    effects, and real server flows (join, drop, phasing, a temporary ball, countdown, GO, game over, freeze) through
//    the oracle and the runtime for the rest.
//  - Replay (?fixture=<name>[&client=A|B|C][&speed=n]): a recorded fixture played at its recorded timing through
//    decode and the same runtime and stage (P5's replayMain.tsx is not edited). The panel counts every E-id fired.
// Both modes toggle the quality tier and reduced motion.
//
// This is an entry module: it renders on load and exports nothing, so fast refresh does not apply to it.
/* eslint-disable react-refresh/only-export-components */

import { StrictMode, useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';
import { GameStage } from '../../render/GameStage';
import { StageBoundary } from '../../render/StageBoundary';
import type { FrameCtx, FxFactory, StageMode } from '../../render/contracts';
import { EffectsDirector } from '../director';
import { FIXTURES, FIXTURE_GAPS, loadFixture } from '../../test/fixtures/load';
import type { FixtureGap } from '../../test/fixtures/load';
import { createFakeApp, fakeInput } from '../../test/fakes/fakeApp';
import { createStore } from '../../lib/store';
import { useStore } from '../../lib/useStore';
import { initialAppState } from '../../state/appStore';
import type { AppState, SessionView } from '../../state/appStore';
import { createGameRuntime } from '../../game/runtime';
import { BALL_STRIDE, BO } from '../../game/types';
import { IMMEDIATE, SeatConn } from '../../game/events';
import type { EventBase, EventOf, GameEvent, GameEventKind, Seat } from '../../game/events';
import { decode } from '../../net/decode';
import type { BatchItem, GameOver, ServerMessage } from '../../protocol/messages';
import type { RoomCode } from '../../session/types';
import type { App } from '../../app/types';
import type { InputController, Visual } from '../../input/types';
import type { QualityPref } from '../../lib/settings';
import { ServerSim } from '../../game/testing/oracle';
import { batch, cancelledItem, countdownItem, startedItem } from '../../game/testing/synth';
import { CellType, TICK_MS } from '../../config/constants';
import { stats } from '../../state/stats';

const ME: Seat = 3;
const QUALITIES: readonly QualityPref[] = ['auto', 'high', 'medium', 'low'];
const POWER_KINDS = ['split', 'phase', 'boost', 'mass'] as const;

// ---- the director, observed ----

interface Probe { director: EffectsDirector | null; ctx: FrameCtx | null; readonly fired: Map<string, number> }
const probe: Probe = { director: null, ctx: null, fired: new Map() };

function bump(id: string): void {
  probe.fired.set(id, (probe.fired.get(id) ?? 0) + 1);
}

/** The catalogue ids (6.1) a released, non-stale event triggers. */
function effectIds(e: GameEvent): readonly string[] {
  switch (e.k) {
    case 'paddleHit': return ['E20'];
    case 'ownerChanged': return ['E21'];
    case 'wallBounce': return ['E22'];
    case 'goal': return ['E23'];
    case 'absorbed': return ['E24'];
    case 'brickBounce': return ['E25'];
    case 'brickDamaged': return ['E26'];
    case 'brickDestroyed': return e.chain >= 3 && e.last ? ['E27', 'E28', 'E29'] : e.chain >= 3 ? ['E27', 'E28'] : e.last ? ['E27', 'E29'] : ['E27'];
    case 'ballSpawned': return e.cause === 'snapshot' ? [] : ['E30'];
    case 'powerUp': return e.conf >= 0.7 ? ['E31'] : [];
    case 'ballRemoved': return e.cause === 'absorbed' ? [] : ['E33'];
    case 'phaseStart':
    case 'phaseEnd': return ['E34'];
    case 'ballResized': return ['E35'];
    case 'seat':
      if (e.from === SeatConn.Empty && e.to === SeatConn.Connected) return ['E37'];
      if (e.to === SeatConn.Grace) return ['E38'];
      return e.from === SeatConn.Grace || e.to === SeatConn.Empty ? ['E39'] : [];
    case 'countdown': return ['E41'];
    case 'countdownCancelled': return ['E42'];
    case 'go': return ['E43'];
    case 'gameOver': return ['E45'];
    default: return [];
  }
}

/** Stable for the page's life: Scene rebuilds the stage when its fxFactory changes. */
const fxFactory: FxFactory = (host) => {
  const d = new EffectsDirector(host);
  probe.director = d;
  return {
    consume(e, ctx) {
      probe.ctx = ctx;
      if (!e.stale) for (const id of effectIds(e)) bump(id);
      d.consume(e, ctx);
    },
    update(ctx) {
      probe.ctx = ctx;
      d.update(ctx);
    },
    lateUpdate(ctx) {
      d.lateUpdate(ctx);
    },
    reset() {
      d.reset();
    },
    setTier(t) {
      d.setTier(t);
    },
    dispose() {
      d.dispose();
      if (probe.director === d) {
        probe.director = null;
        probe.ctx = null;
      }
    },
    get stats() {
      return d.stats;
    },
  };
};

type Fields<K extends GameEventKind> = Omit<EventOf<K>, keyof EventBase | 'k'> & Partial<EventBase>;

function event<K extends GameEventKind>(k: K, f: Fields<K>): EventOf<K> {
  return { k, tick: IMMEDIATE, seq: 0, x: 450, y: 450, conf: 1, stale: false, ...f } as unknown as EventOf<K>;
}

/** A synthetic released event, straight into the director with the frame loop's context. */
function fire(e: GameEvent): void {
  const d = probe.director;
  const ctx = probe.ctx;
  if (d === null || ctx === null) return;
  for (const id of effectIds(e)) bump(id);
  d.consume(e, ctx);
}

/** Effects read from continuous state: a trail drawn (E36), a temporary ball in its expiry warning (E32). */
function observeContinuous(app: App): void {
  const d = probe.director;
  if (d !== null && d.stats.trails > 0 && !probe.fired.has('E36')) probe.fired.set('E36', 1);
  const r = app.game.render;
  for (let s = 0; s < r.ballHigh; s++) {
    const o = s * BALL_STRIDE;
    if (r.ballId[s] >= 0 && r.ball[o + BO.PERMANENT] < 0.5 && r.ball[o + BO.AGE_S] >= 9.5 && !probe.fired.has('E32')) probe.fired.set('E32', 1);
  }
}

// ---- session plumbing (the harness stands in for the session writers of this page's fake app) ----

function patchSession(app: App, p: Partial<SessionView>): void {
  app.store.patch({ session: { ...app.store.get().session, ...p } });
}

function stageModeOf(s: SessionView): StageMode | 'none' {
  if (s.s === 'lobby' || s.s === 'countdown' || s.s === 'playing') {
    if (!s.worldReady) return s.stageRetained ? 'frozen' : 'none';
    return s.s === 'lobby' ? 'lobby' : 'live';
  }
  if (s.s === 'finished') return s.worldReady ? 'ended' : 'none';
  return 'none';
}

function applyControls(app: App, controls: readonly { k: string; seconds?: number }[], at: number): void {
  for (const c of controls) {
    if (c.k === 'countdown') {
      const seconds = c.seconds ?? 3;
      patchSession(app, { s: 'countdown', phase: 'countingDown' });
      app.store.patch({ countdown: { seconds, endsAt: at + seconds * 1000 } });
    } else if (c.k === 'started') {
      patchSession(app, { s: 'playing', phase: 'playing' });
      app.store.patch({ countdown: null });
    } else {
      patchSession(app, { s: 'lobby', phase: 'lobby' });
      app.store.patch({ countdown: null });
    }
  }
}

// ---- arena ----

interface BallRef { id: number; x: number; y: number; r: number }
interface Point { x: number; y: number }

class Arena {
  readonly sim = new ServerSim({ seed: 11, seats: [0, 1, 2, 3], bricks: true }, { ai: true });
  readonly app: App;
  private readonly steer: { desired: Visual };
  private stepping = true;
  private frozen = false;
  private goTimer = -1;
  private readonly countTimers = [-1, -1];   // the "2" and the "1" of the countdown
  private steerTimer = -1;
  private power = 0;

  constructor(app: App, steer: { desired: Visual }) {
    this.app = app;
    this.steer = steer;
  }

  start(): void {
    const game = this.app.game;
    game.reset(1, ME);
    patchSession(this.app, {
      s: 'playing', phase: 'playing', myIndex: ME, epoch: 1, worldReady: false, roomKnown: true, code: 'F0CA11' as RoomCode,
    });
    game.ingest(this.sim.initialState(), performance.now());
    this.sim.gridDirty = false;
    this.ingest([this.sim.grid()]);
    window.setInterval(this.tick, TICK_MS);
  }

  /** The first rendered ball, canvas px. */
  ball(): BallRef | null {
    const r = this.app.game.render;
    const half = this.app.game.world.canvas / 2;
    for (let s = 0; s < r.ballHigh; s++) {
      if (r.ballId[s] < 0) continue;
      const o = s * BALL_STRIDE;
      return { id: r.ballId[s], x: r.ball[o + BO.X] + half, y: half - r.ball[o + BO.Y], r: r.ball[o + BO.R] };
    }
    return null;
  }

  /** A random brick still standing on screen, or -1. */
  cell(): number {
    const r = this.app.game.render;
    const alive: number[] = [];
    for (let i = 0; i < r.brickType.length; i++) if (r.brickType[i] === CellType.Brick && r.brickLife[i] > 0) alive.push(i);
    return alive.length > 0 ? alive[Math.floor(Math.random() * alive.length)] : -1;
  }

  centre(cell: number): Point | null {
    if (cell < 0) return null;
    const w = this.app.game.world;
    return { x: (cell % w.gridSize) * w.cellSize + w.cellSize / 2, y: Math.floor(cell / w.gridSize) * w.cellSize + w.cellSize / 2 };
  }

  /** A synthetic shatter of a standing brick (the display arrays keep it: effects only). */
  shatter(chain: number, last: boolean, cell = this.cell()): Point | null {
    const c = this.centre(cell);
    if (c === null) return null;
    fire(event('brickDestroyed', { cell, from: 5, level: 1, ball: -1, scorer: ME, points: 2, chain, last, x: c.x, y: c.y - 40 }));
    return c;
  }

  nextPower(): (typeof POWER_KINDS)[number] {
    this.power = (this.power + 1) % POWER_KINDS.length;
    return POWER_KINDS[this.power];
  }

  steerDemo(): void {
    window.clearTimeout(this.steerTimer);
    this.steer.desired = -1;
    this.steerTimer = window.setTimeout(() => {
      this.steer.desired = 1;
      this.steerTimer = window.setTimeout(() => {
        this.steer.desired = 0;
      }, 1500);
    }, 1500);
  }

  lobby(): void {
    this.stopCountdown();
    this.stepping = false;
    patchSession(this.app, { s: 'lobby', phase: 'lobby' });
    this.app.store.patch({ countdown: null });
    this.ingest([this.sim.lobbyState()]);
  }

  /** As the server does: "3", "2" and "1" a second apart, then gameStarted. */
  countdown(): void {
    if (this.app.store.get().session.s !== 'lobby') this.lobby();
    this.stopCountdown();
    this.ingest([countdownItem(3)]);
    this.countTimers[0] = window.setTimeout(() => this.ingest([countdownItem(2)]), 1000);
    this.countTimers[1] = window.setTimeout(() => this.ingest([countdownItem(1)]), 2000);
    this.goTimer = window.setTimeout(() => this.go(), 3000);
  }

  cancel(): void {
    this.stopCountdown();
    this.ingest([cancelledItem()]);
  }

  go(): void {
    this.stopCountdown();
    this.stepping = true;
    this.ingest([startedItem()]);
  }

  private stopCountdown(): void {
    window.clearTimeout(this.goTimer);
    window.clearTimeout(this.countTimers[0]);
    window.clearTimeout(this.countTimers[1]);
  }

  /** E44: the connection "drops" (nothing arrives, the stage freezes) until toggled back. */
  freeze(): void {
    this.frozen = !this.frozen;
    this.app.game.freeze(this.frozen);
    patchSession(this.app, { worldReady: !this.frozen, stageRetained: true });
    if (!this.frozen) this.app.game.snap();
  }

  gameOver(): void {
    this.stepping = false;
    this.stopCountdown();
    const scores = [0, 1, 2, 3].map((i) => this.sim.players[i]?.score ?? 0);
    const best = Math.max(...scores);
    const winnerIndex = scores.filter((s) => s === best).length === 1 ? scores.indexOf(best) : -1;
    const msg: GameOver = {
      messageType: 'gameOver', winnerIndex, finalScores: [scores[0], scores[1], scores[2], scores[3]], reason: 'FX playground', roomPID: 'fx',
    };
    const results = this.app.game.results(msg, msg.reason);
    this.app.store.patch({ results });
    this.app.game.ended(results.winner, false);
    patchSession(this.app, { s: 'finished' });
  }

  join(seat: Seat): void {
    this.sim.join(seat);
  }

  drop(seat: Seat): void {
    this.sim.disconnect(seat);
  }

  expire(seat: Seat): void {
    this.sim.expireGrace(seat);
  }

  /** A real power-up phase on the first ball: the server sets phasing, the runtime derives phaseStart/phaseEnd. */
  phase(): void {
    for (const b of this.sim.balls.values()) {
      this.sim.startPhasing(b.id);
      return;
    }
  }

  /** A temporary ball living 10-14 s: its expiry warning (E32) starts at 9.5 s, then it dissolves (E33). */
  tempBall(): void {
    this.sim.spawnBall(ME, 0, 0, 12000, false);
  }

  private readonly tick = (): void => {
    if (this.frozen) return;
    const items: BatchItem[] = [];
    if (this.stepping) for (const it of this.sim.step().items) items.push(it);
    if (this.sim.gridDirty) {
      items.push(this.sim.grid());
      this.sim.gridDirty = false;
    }
    this.ingest(items);
  };

  private ingest(items: BatchItem[]): void {
    const at = performance.now();
    const res = this.app.game.ingest(batch(...items), at);
    if (res.boardReady) patchSession(this.app, { worldReady: true, stageRetained: true });
    applyControls(this.app, res.controls, at);
  }
}

function arenaActions(a: Arena): Readonly<Record<string, () => void>> {
  const w = a.app.game.world;
  const half = (): number => w.canvas / 2;
  return {
    E05: () => a.steerDemo(),
    E20: () => {
      const p = w.paddles[ME];
      fire(event('paddleHit', { ball: a.ball()?.id ?? -1, seat: ME, speed: 12, prevOwner: 1, u: 0.5, x: p.x, y: p.y - 20 }));
    },
    E21: () => {
      const b = a.ball();
      if (b !== null) fire(event('ownerChanged', { ball: b.id, from: 1, to: ME, cause: 'paddle', x: b.x, y: b.y }));
    },
    E22: () => fire(event('wallBounce', { ball: a.ball()?.id ?? -1, wall: 0, phasing: false, u: 0.5, x: w.canvas - 8, y: half() })),
    E23: () => {
      const g = event('goal', { ball: -1, wall: ME, scorer: 1, repeat: 0, u: 0.4, x: w.canvas * 0.4, y: w.canvas - 5 });
      fire(g);
      window.setTimeout(() => fire({ ...g, repeat: 1 }), 350);
      window.setTimeout(() => fire({ ...g, repeat: 2 }), 700);
    },
    E24: () => fire(event('absorbed', { ball: -1, wall: 2, u: 0.5, x: 0, y: half(), conf: 0.95 })),
    E25: () => {
      const c = a.centre(a.cell());
      if (c !== null) fire(event('brickBounce', { ball: a.ball()?.id ?? -1, x: c.x, y: c.y - 30 }));
    },
    E26: () => {
      const cell = a.cell();
      const c = a.centre(cell);
      if (c !== null) fire(event('brickDamaged', { cell, from: 5, to: 4, level: 1, ball: -1, x: c.x, y: c.y - 40 }));
    },
    E27: () => {
      a.shatter(1, false);
    },
    E28: () => {
      a.shatter(4, false);
    },
    E29: () => {
      a.shatter(1, true);
    },
    E30: () => {
      // As the runtime releases them: the power-up spawn (same tick, lower seq) before the shatter that caused it.
      const cell = a.cell();
      const c = a.centre(cell);
      const b = a.ball();
      if (c !== null && b !== null) fire(event('ballSpawned', { ball: b.id, owner: ME, permanent: false, cause: 'powerUp', x: c.x + 12, y: c.y + 12 }));
      a.shatter(1, false, cell);
      window.setTimeout(() => fire(event('ballSpawned', { ball: -1, owner: 1, permanent: true, cause: 'join', x: half(), y: half() })), 500);
    },
    E31: () => {
      const b = a.ball();
      fire(event('powerUp', { ball: b?.id ?? -1, kind: a.nextPower(), x: b?.x ?? half(), y: b?.y ?? half() }));
    },
    E32: () => a.tempBall(),
    E33: () => {
      const b = a.ball();
      fire(event('ballRemoved', { ball: -1, owner: 2, cause: 'expired', x: b !== null ? b.x + 60 : half(), y: b?.y ?? half() }));
    },
    E34: () => a.phase(),
    E35: () => {
      const b = a.ball();
      if (b !== null) fire(event('ballResized', { ball: b.id, from: b.r, to: b.r + 4, x: b.x, y: b.y }));
    },
    E37: () => a.join(1),
    E38: () => a.drop(1),
    E39: () => a.expire(1),
    E40: () => a.lobby(),
    E41: () => a.countdown(),
    E42: () => a.cancel(),
    E43: () => a.go(),
    E44: () => a.freeze(),
    E45: () => a.gameOver(),
  };
}

// ---- replay ----

interface Inbound { t: number; msg: ServerMessage }

/** Plays inbound frames at their recorded times, scaled by speed. A declared cut (FIXTURE_GAPS) is jumped over. */
class FixturePlayer {
  readonly frames: Inbound[];
  private readonly app: App;
  private readonly gaps: readonly FixtureGap[];
  private i = 0;
  private base = 0;
  private offset = 0;
  private speedV: number;
  private timer = -1;
  private paused = false;
  private epoch = 0;
  private retained = false;

  constructor(app: App, frames: Inbound[], gaps: readonly FixtureGap[], speed: number) {
    this.app = app;
    this.frames = frames;
    this.gaps = gaps;
    this.speedV = speed;
  }

  get position(): number {
    return this.timeline(performance.now());
  }

  get total(): number {
    return this.frames.length > 0 ? this.frames[this.frames.length - 1].t : 0;
  }

  get speed(): number {
    return this.speedV;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  start(): void {
    this.base = performance.now();
    this.offset = this.frames.length > 0 ? this.frames[0].t : 0;
    this.schedule();
  }

  setSpeed(s: number): void {
    const t = this.timeline(performance.now());
    this.speedV = s;
    this.base = performance.now();
    this.offset = t;
    window.clearTimeout(this.timer);
    this.schedule();
  }

  togglePause(): void {
    if (this.paused) {
      this.paused = false;
      this.base = performance.now();
      this.schedule();
    } else {
      this.offset = this.timeline(performance.now());
      this.paused = true;
      window.clearTimeout(this.timer);
    }
  }

  private timeline(nowMs: number): number {
    return this.paused ? this.offset : (nowMs - this.base) * this.speedV + this.offset;
  }

  private schedule(): void {
    if (this.paused || this.i >= this.frames.length) return;
    const wait = (this.frames[this.i].t - this.timeline(performance.now())) / this.speedV;
    this.timer = window.setTimeout(this.pump, Math.max(0, wait));
  }

  private readonly pump = (): void => {
    const nowMs = performance.now();
    while (this.i < this.frames.length && this.frames[this.i].t <= this.timeline(nowMs)) {
      const prev = this.frames[this.i];
      this.deliver(prev.msg, nowMs);
      this.i++;
      if (this.i < this.frames.length) {
        const next = this.frames[this.i].t;
        const cut = this.gaps.find((g) => prev.t <= g.from + 1 && next >= g.to - 1);
        if (cut !== undefined) this.offset += next - 25 - this.timeline(nowMs);
      }
    }
    this.schedule();
  };

  private deliver(msg: ServerMessage, at: number): void {
    const app = this.app;
    const game = app.game;
    switch (msg.messageType) {
      case 'roomCreated':
        patchSession(app, { code: msg.code as RoomCode, roomKnown: true });
        return;
      case 'roomJoined':
        if (msg.success) patchSession(app, { code: msg.code as RoomCode, roomKnown: true, phase: msg.phase === '' ? null : msg.phase });
        return;
      case 'playerAssignment': {
        this.epoch++;
        const me = msg.playerIndex as Seat;
        game.reset(this.epoch, me);
        patchSession(app, {
          s: msg.phase === 'lobby' ? 'lobby' : msg.phase === 'countingDown' ? 'countdown' : 'playing',
          myIndex: me, phase: msg.phase, epoch: this.epoch, worldReady: false, stageRetained: this.retained,
        });
        return;
      }
      case 'initialPlayersAndBallsState':
      case 'gameUpdates': {
        const res = game.ingest(msg, at);
        if (res.boardReady) {
          this.retained = true;
          patchSession(app, { worldReady: true, stageRetained: true });
        }
        applyControls(app, res.controls, at);
        return;
      }
      case 'gameOver': {
        const results = game.results(msg, msg.reason);
        app.store.patch({ results });
        game.ended(results.winner, false);
        patchSession(app, { s: 'finished' });
        return;
      }
    }
  }
}

// ---- catalogue (6.1) ----

interface Row { id: string; name: string; owner: 'P5' | 'P6' | 'P7'; how: string }
const ROWS: readonly Row[] = [
  { id: 'E01', name: 'Floor', owner: 'P5', how: 'always' },
  { id: 'E02', name: 'Walls', owner: 'P5', how: 'always' },
  { id: 'E03', name: 'Bricks', owner: 'P5', how: 'always' },
  { id: 'E04', name: 'Paddles', owner: 'P5', how: 'always; ghost with E38' },
  { id: 'E05', name: 'Intent chevrons', owner: 'P5', how: 'steers left, then right' },
  { id: 'E06', name: 'Balls', owner: 'P5', how: 'always' },
  { id: 'E07', name: 'Halos and light pools', owner: 'P5', how: 'always' },
  { id: 'E20', name: 'Paddle hit', owner: 'P7', how: 'event' },
  { id: 'E21', name: 'Ownership sweep', owner: 'P7', how: 'event' },
  { id: 'E22', name: 'Wall bounce', owner: 'P7', how: 'event' },
  { id: 'E23', name: 'Goal (then two repeats)', owner: 'P7', how: 'event' },
  { id: 'E24', name: 'Absorb', owner: 'P7', how: 'event' },
  { id: 'E25', name: 'Brick bounce', owner: 'P7', how: 'event' },
  { id: 'E26', name: 'Brick damage', owner: 'P7', how: 'event' },
  { id: 'E27', name: 'Brick shatter', owner: 'P7', how: 'event' },
  { id: 'E28', name: 'Chain combo', owner: 'P7', how: 'event' },
  { id: 'E29', name: 'Last brick', owner: 'P7', how: 'event' },
  { id: 'E30', name: 'Spawn (power-up, then join)', owner: 'P7', how: 'event' },
  { id: 'E31', name: 'Power-up callout', owner: 'P7', how: 'event' },
  { id: 'E32', name: 'Expiry warning', owner: 'P5', how: 'a temporary ball; blinks from 9.5 s' },
  { id: 'E33', name: 'Dissolve', owner: 'P7', how: 'event' },
  { id: 'E34', name: 'Phasing', owner: 'P7', how: 'a real phase on a ball' },
  { id: 'E35', name: 'Mass growth', owner: 'P7', how: 'event' },
  { id: 'E36', name: 'Ball trail', owner: 'P7', how: 'always' },
  { id: 'E37', name: 'Seat join', owner: 'P7', how: 'seat 1 joins (after E39)' },
  { id: 'E38', name: 'Seat drop', owner: 'P7', how: 'seat 1 drops' },
  { id: 'E39', name: 'Seat removal', owner: 'P7', how: 'seat 1 grace expires (after E38)' },
  { id: 'E40', name: 'Lobby arena', owner: 'P5', how: 'lobby' },
  { id: 'E41', name: 'Countdown', owner: 'P7', how: 'countdown, GO after 3 s' },
  { id: 'E42', name: 'Countdown cancelled', owner: 'P7', how: 'cancel a countdown' },
  { id: 'E43', name: 'GO', owner: 'P7', how: 'start play' },
  { id: 'E44', name: 'Reconnecting freeze', owner: 'P5', how: 'toggle' },
  { id: 'E45', name: 'Game over', owner: 'P7', how: 'end the game' },
  { id: 'E46', name: 'Unstable link', owner: 'P6', how: 'ui.html' },
  { id: 'E50', name: 'Score bump', owner: 'P6', how: 'ui.html' },
  { id: 'E51', name: 'Grace ring', owner: 'P6', how: 'ui.html' },
  { id: 'E52', name: 'Rules carousel', owner: 'P6', how: 'ui.html' },
];

// ---- page ----

type Lab =
  | { kind: 'arena'; actions: Readonly<Record<string, () => void>> }
  | { kind: 'replay'; player: FixturePlayer; name: string; client: string };

const selectSession = (s: AppState): SessionView => s.session;
const selectGfx = (s: AppState): AppState['gfx'] => s.gfx;

function Stage({ app }: { app: App }): JSX.Element {
  const session = useStore(app.store, selectSession);
  const gfx = useStore(app.store, selectGfx);
  const mode = stageModeOf(session);
  useEffect(() => {
    if (mode === 'lobby') bump('E40');
    if (mode === 'frozen') bump('E44');
  }, [mode]);
  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      {mode !== 'none' && (
        <StageBoundary resetKey={gfx.stageKey} fallback={<div style={{ padding: 24 }}>Graphics stopped responding</div>}>
          <GameStage app={app} fxFactory={fxFactory} mode={mode} />
        </StageBoundary>
      )}
    </div>
  );
}

const PANEL: CSSProperties = {
  position: 'fixed', top: 8, left: 8, width: 380, maxHeight: 'calc(100% - 16px)', overflow: 'auto', padding: 10,
  background: 'rgba(9, 9, 11, 0.84)', border: '1px solid #3f3f46', borderRadius: 6,
  font: '12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace', color: '#e4e4e7',
};
const ROW: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 4, margin: '6px 0' };
const MUTED: CSSProperties = { color: '#a1a1aa' };
const CELL_STYLE: CSSProperties = { padding: '1px 4px', verticalAlign: 'top' };

function Panel({ app, lab }: { app: App; lab: Lab }): JSX.Element {
  const [, setTick] = useState(0);
  useEffect(() => {
    const handle = setInterval(() => {
      observeContinuous(app);
      setTick((t) => t + 1);
    }, 250);
    return () => clearInterval(handle);
  }, [app]);
  const s = app.store.get();
  const fs = probe.director?.stats;
  const r = stats.render;
  const quality = app.settings.get().quality;
  const names = Object.keys(FIXTURES).sort();
  return (
    <div style={PANEL}>
      <div>
        <strong>FX playground</strong>{' '}
        {lab.kind === 'arena' ? 'arena (oracle, live)' : `replay ${lab.name}, client ${lab.client}`}
      </div>
      <div style={ROW}>
        <a href="?" style={{ color: '#93c5fd' }}>arena</a>
        {names.map((n) => <a key={n} href={`?fixture=${encodeURIComponent(n)}`} style={{ color: '#93c5fd' }}>{n}</a>)}
      </div>
      <div>session {s.session.s}, mode {stageModeOf(s.session)}, seat {s.session.myIndex ?? '-'}, gfx {s.gfx.health}</div>
      <div>
        sparks {fs?.sparks ?? 0}, shards {fs?.shards ?? 0}, rings {fs?.rings ?? 0}, decals {fs?.decals ?? 0}, trails {fs?.trails ?? 0},
        {' '}P2 dropped {fs?.droppedP2 ?? 0}, stale {fs?.staleSkipped ?? 0}
      </div>
      <div>scene draws {r.calls}, post draws {r.postCalls}, programs {r.programs}, fps {r.fps.toFixed(0)}, tier {s.gfx.tier}</div>
      <div style={ROW}>
        {QUALITIES.map((q) => (
          <button key={q} type="button" aria-pressed={quality === q} onClick={() => app.settings.update({ quality: q })}>{q}</button>
        ))}
        <label>
          <input type="checkbox" checked={s.motion.reduced} onChange={(e) => app.store.patch({ motion: { reduced: e.target.checked } })} /> reduced motion
        </label>
      </div>
      {lab.kind === 'replay' && (
        <div style={ROW}>
          <span>t {(lab.player.position / 1000).toFixed(1)} / {(lab.player.total / 1000).toFixed(1)} s, x{lab.player.speed}</span>
          <button type="button" onClick={() => lab.player.togglePause()}>{lab.player.isPaused ? 'Play' : 'Pause'}</button>
          {[0.5, 1, 2, 4].map((v) => <button key={v} type="button" onClick={() => lab.player.setSpeed(v)}>x{v}</button>)}
          <button type="button" onClick={() => location.reload()}>Restart</button>
        </div>
      )}
      {lab.kind === 'arena' && (
        <div style={ROW}>
          <button type="button" onClick={() => location.reload()}>Restart arena</button>
        </div>
      )}
      <table style={{ borderCollapse: 'collapse', width: '100%' }}>
        <tbody>
          {ROWS.map((row) => {
            const act = lab.kind === 'arena' ? lab.actions[row.id] : undefined;
            const n = probe.fired.get(row.id) ?? 0;
            return (
              <tr key={row.id}>
                <td style={CELL_STYLE}>{row.id}</td>
                <td style={CELL_STYLE}>{row.name}</td>
                <td style={{ ...CELL_STYLE, ...MUTED }}>{row.owner}</td>
                <td style={CELL_STYLE}>
                  {act !== undefined
                    ? <button type="button" onClick={act} title={row.how}>fire</button>
                    : <span style={MUTED}>{lab.kind === 'arena' || row.owner === 'P6' ? row.how : ''}</span>}
                </td>
                <td style={{ ...CELL_STYLE, textAlign: 'right' }}>{n > 0 ? n : ''}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Page({ app, lab }: { app: App; lab: Lab }): JSX.Element {
  return (
    <>
      <Stage app={app} />
      <StrictMode>
        <Panel app={app} lab={lab} />
      </StrictMode>
    </>
  );
}

function main(): void {
  const params = new URLSearchParams(location.search);
  const store = createStore(initialAppState());
  const game = createGameRuntime({ store });
  const steer: { desired: Visual } = { desired: 0 };
  const input: InputController = {
    ...fakeInput(),
    get desired(): Visual {
      return steer.desired;
    },
  };
  const app = createFakeApp({ store, game, input });
  document.addEventListener('visibilitychange', () => {
    const visible = document.visibilityState === 'visible';
    store.patch({ page: { ...store.get().page, visible } });
    game.setHeadless(!visible);
  });
  const root = document.getElementById('root');
  if (root === null) throw new Error('fx.html has no #root');

  const name = params.get('fixture');
  if (name !== null && FIXTURES[name] !== undefined) {
    const frames = loadFixture(FIXTURES[name]);
    const clients = [...new Set(frames.filter((f) => f.dir === 'in').map((f) => f.c))].sort();
    const wanted = params.get('client');
    const client = clients.find((c) => c === wanted) ?? clients[0] ?? 'A';
    const inbound: Inbound[] = [];
    for (const f of frames) {
      if (f.c !== client || f.dir !== 'in') continue;
      const d = decode(f.d);
      if (d.ok) inbound.push({ t: f.t, msg: d.msg });
    }
    const speed = Number(params.get('speed')) > 0 ? Number(params.get('speed')) : 1;
    const player = new FixturePlayer(app, inbound, FIXTURE_GAPS[name] ?? [], speed);
    createRoot(root).render(<Page app={app} lab={{ kind: 'replay', player, name, client }} />);
    player.start();
    return;
  }
  const arena = new Arena(app, steer);
  createRoot(root).render(<Page app={app} lab={{ kind: 'arena', actions: arenaActions(arena) }} />);
  arena.start();
}

main();
