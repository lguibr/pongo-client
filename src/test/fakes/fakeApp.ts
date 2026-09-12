// createFakeApp: every port stubbed, a real appStore. Used by jsdom tests and by the dev harnesses
// (ui.html gallery, fx.html playground), so it must not import vitest. Stubs are inert: queries return
// empty values and commands do nothing. Pass real implementations through `overrides` where needed.

import { createStore } from '../../lib/store';
import { createSafeStorage } from '../../lib/storage';
import { createSettingsStore } from '../../lib/settings';
import type { SettingsStore } from '../../lib/settings';
import { initialAppState } from '../../state/appStore';
import type { AppState, AppStore, ResultsView } from '../../state/appStore';
import type { App, PwaApi } from '../../app/types';
import type { SessionApi, Model, GameSink, IngestResult, WorldSummary } from '../../session/types';
import type { GameRuntime, World, RenderState, SeatRow, PaddleRow, BallSlot, PlayoutStats } from '../../game/types';
import { PADDLE_STRIDE, BALL_STRIDE } from '../../game/types';
import { SeatConn } from '../../game/events';
import type { EventQueue } from '../../game/events';
import type { InputController, JoystickModel } from '../../input/types';
import type { AudioEngine } from '../../audio/types';
import { CANVAS, CELL, CELLS, GRID, MAX_BALLS, CellType } from '../../config/constants';

export interface FakeAppOverrides {
  store?: AppStore;
  settings?: SettingsStore;
  session?: SessionApi;
  game?: GameRuntime;
  input?: InputController;
  audio?: AudioEngine;
  pwa?: PwaApi;
  /** Patched into the store after it is created. */
  state?: Partial<AppState>;
}

const noop = (): void => {};
const unsubscribe = (): (() => void) => noop;

export function createFakeApp(overrides: FakeAppOverrides = {}): App {
  const store = overrides.store ?? createStore(initialAppState());
  if (overrides.state) store.patch(overrides.state);
  return {
    store,
    settings: overrides.settings ?? createSettingsStore(createSafeStorage(() => null)),
    session: overrides.session ?? fakeSession(),
    game: overrides.game ?? fakeGame(),
    input: overrides.input ?? fakeInput(),
    audio: overrides.audio ?? fakeAudio(),
    pwa: overrides.pwa ?? fakePwa(),
    dispose: noop,
  };
}

export function fakeModel(): Model {
  return {
    state: { s: 'idle' }, lastGen: 0, epoch: 0, online: true, visible: true, resumeGraceUntil: 0,
    unstable: false, badCount: 0, badWindowStart: 0, lastLeft: null,
    budgetUsedMs: 0, budgetAt: 0, droppedAt: null, roomCloseFloorAt: null,
  };
}

export function fakeSession(): SessionApi {
  const model = fakeModel();
  return {
    start: noop, leave: noop, retry: noop, joinAsNew: noop, rejoinPrevious: noop,
    setReady: () => false, sendDirection: () => false,
    bindRoute: unsubscribe, notifyEnv: noop, dismissNotice: noop,
    getModel: () => model, subscribe: unsubscribe, dispose: noop,
  };
}

function seatRow(): SeatRow {
  return { conn: SeatConn.Empty, score: 0, scoreKnown: false, ready: false, graceEndsAt: NaN, everSeen: false, leftCount: 0, missingPaddleTicks: 0 };
}

function paddleRow(): PaddleRow {
  return { present: false, x: 0, y: 0, w: 0, h: 0, vx: 0, vy: 0, collided: false };
}

function ballSlot(): BallSlot {
  return {
    live: false, id: -1, owner: -1, permanent: false, phasing: false,
    x: 0, y: 0, vx: 0, vy: 0, collided: false, r0: 0, radiusSet: 0, radius: 0,
    spawnTick: 0, spawnedAtMs: 0, phaseStartTick: -1,
    lastDestroyTick: -1, lastBrickContactTick: -1, brickContactX: 0, brickContactY: 0,
    removedTick: -1, lastGoalTick: -1, lastGoalWall: -1,
  };
}

/** An empty World with the expected geometry. */
export function fakeWorld(): World {
  return {
    epoch: 0, myIndex: null, tick: 0, ready: false, frozen: false,
    canvas: CANVAS, gridSize: GRID, cellSize: CELL,
    seats: [seatRow(), seatRow(), seatRow(), seatRow()],
    paddles: [paddleRow(), paddleRow(), paddleRow(), paddleRow()],
    balls: Array.from({ length: MAX_BALLS }, ballSlot),
    slotById: new Map(),
    brickLife: new Uint8Array(CELLS), brickType: new Uint8Array(CELLS).fill(CellType.Empty),
    brickLevel: new Uint8Array(CELLS), brickDirty: new Uint8Array(CELLS),
    brickVersion: 0, bricksAlive: 0, bricksAtStart: 0, gridKnown: false,
  };
}

/** An empty RenderState: no paddles, every ball slot free, every cell empty. */
export function fakeRenderState(): RenderState {
  return {
    displayMs: 0, displayTick: 0,
    paddle: new Float32Array(4 * PADDLE_STRIDE), paddleLead: new Float32Array(4),
    ball: new Float32Array(MAX_BALLS * BALL_STRIDE), ballId: new Int32Array(MAX_BALLS).fill(-1), ballHigh: 0,
    brickLife: new Uint8Array(CELLS), brickType: new Uint8Array(CELLS).fill(CellType.Empty),
    brickFade: new Uint8Array(CELLS), brickVersion: 0,
    extrapolating: false, frozen: false, ready: false,
  };
}

function fakeQueue(): EventQueue {
  return {
    size: 0, pendingScoreDelta: new Int32Array(4),
    push: noop, drain: noop, releaseAllStale: noop, clear: noop, nextSeq: () => 0,
  };
}

export function fakeGame(): GameRuntime {
  const world = fakeWorld();
  const playoutStats: PlayoutStats = { delayMs: 0, jitterMs: 0, snaps: 0, idle: true, extrapolating: false, lastTicksPerBatch: 0 };
  const ingestResult: IngestResult = { controls: [], ticks: 0, boardReady: false };
  const sink: GameSink = {
    reset: noop, freeze: noop,
    ingest: () => ingestResult,
    summary: (): WorldSummary => ({ ready: false, bricksAlive: null, bricksAtStart: null, tick: 0, graceSeats: 0 }),
    results: (msg, reason): ResultsView => ({ winner: -1, rows: [], reason, derived: msg === null }),
    ended: noop, snap: noop, setHeadless: noop,
  };
  return {
    ...sink,
    world, render: fakeRenderState(), queue: fakeQueue(), playoutStats, hitStopActive: false,
    frame: noop, displayMs: (nowMs) => nowMs, hitStop: noop,
    setIntentSource: noop, setOwnLead: noop, setUnstable: noop,
    onIngestEvents: unsubscribe, slotOf: () => -1,
  };
}

function fakeJoystick(): JoystickModel {
  return { down: () => false, move: noop, up: noop, cancelAll: noop, axis: null, knob: new Float32Array(4) };
}

export function fakeInput(): InputController {
  return {
    resync: noop, halt: noop, attach: unsubscribe, setSink: noop, onSession: noop,
    joystick: fakeJoystick(), desired: 0, lastSent: null, stats: { sent: 0, coalesced: 0, refused: 0 },
  };
}

export function fakeAudio(): AudioEngine {
  return {
    setScene: noop, setHidden: noop, init: unsubscribe,
    state: 'uninitialized', context: null, onEvents: noop,
    playUi: noop, setIntensity: noop, setMix: noop, setSuppressed: noop, dispose: () => Promise.resolve(),
  };
}

export function fakePwa(): PwaApi {
  return { supported: false, applyUpdate: noop, start: noop, dispose: noop, notifyRoute: noop };
}
