// World, RenderState and GameRuntime types (4.6). Implemented by P2 (src/game/*).

import type { Seat, Owner, SeatConn, GameEvent, EventQueue, IngestListener } from './events';
import type { GameSink } from '../session/types';
import type { AppStore } from '../state/appStore';
import type { Visual } from '../input/types';
import type { TimerHost } from '../lib/timers';
import type { Now } from '../lib/clock';
import type { Tuning } from '../config/tuning';

export interface SeatRow {
  conn: SeatConn; score: number; scoreKnown: boolean; ready: boolean;
  graceEndsAt: number;             // performance.now ms; NaN when unknown (late joiner)
  everSeen: boolean;               // present at any time during this epoch (results rows, C58)
  leftCount: number;               // playerLeft messages seen since the last join (1 = grace, 2 = gone)
  missingPaddleTicks: number;
}
export interface PaddleRow { present: boolean; x: number; y: number; w: number; h: number; vx: number; vy: number; collided: boolean }
export interface BallSlot {
  live: boolean; id: number; owner: Owner; permanent: boolean; phasing: boolean;
  x: number; y: number; vx: number; vy: number; collided: boolean;
  r0: number;                      // exact radius at spawn or snapshot
  radiusSet: number;               // bitmask over r0 + 4k, k = 0..30 (5.4.6)
  radius: number;                  // displayed radius = rMin(radiusSet)
  spawnTick: number; spawnedAtMs: number; phaseStartTick: number;
  lastDestroyTick: number; lastBrickContactTick: number; brickContactX: number; brickContactY: number;
  removedTick: number;             // -1 while alive
  lastGoalTick: number; lastGoalWall: number;
}
export interface World {
  epoch: number; myIndex: Seat | null;
  tick: number;                    // tick frames closed this epoch; the initial state is tick 0
  ready: boolean;                  // initial state and first grid applied
  frozen: boolean;
  canvas: number; gridSize: number; cellSize: number;   // derived from the first grid: cellSize x sqrt(bricks.length)
  seats: [SeatRow, SeatRow, SeatRow, SeatRow];
  paddles: [PaddleRow, PaddleRow, PaddleRow, PaddleRow];
  balls: BallSlot[];               // length MAX_BALLS; slot index === instance index
  slotById: Map<number, number>;
  brickLife: Uint8Array; brickType: Uint8Array; brickLevel: Uint8Array; brickDirty: Uint8Array;
  brickVersion: number; bricksAlive: number; bricksAtStart: number; gridKnown: boolean;
}

export const PO = { PRESENT: 0, CX: 1, CY: 2, W: 3, H: 4, VX: 5, VY: 6, CONN: 7 } as const;
export const PADDLE_STRIDE = 8;
export const BO = { X: 0, Y: 1, VX: 2, VY: 3, R: 4, OWNER: 5, PHASING: 6, PERMANENT: 7, AGE_S: 8, VIS: 9 } as const;
export const BALL_STRIDE = 10;
export const BallVis = { Hidden: 0, Live: 1, Dying: 2 } as const;
/** Written in place every frame; board space, un-rotated; velocities in board units per tick (vy negated). */
export interface RenderState {
  displayMs: number; displayTick: number;
  paddle: Float32Array;            // 4 x PADDLE_STRIDE (centre, size, velocity, conn)
  paddleLead: Float32Array;        // 4; px along the paddle axis; non-zero only for my seat when ownLead is on
  ball: Float32Array;              // MAX_BALLS x BALL_STRIDE
  ballId: Int32Array;              // MAX_BALLS; -1 when the slot is free
  ballHigh: number;                // 1 + highest slot index in use
  // Display-time brick state (D32). Changed only when brick events are released, and at once for the
  // first grid of an epoch. The bricks system and the floor occupancy texture read these, never World.brick*.
  brickLife: Uint8Array;           // CELLS
  brickType: Uint8Array;           // CELLS; initialised to CellType.Empty
  brickFade: Uint8Array;           // CELLS; 1 when the cell's last change was released stale or had no event (fade, never shatter)
  brickVersion: number;            // bumps whenever the three arrays change
  extrapolating: boolean;
  frozen: boolean;                 // from freeze(true) until the first grid of the next epoch (kept through reset)
  ready: boolean;                  // the current epoch's first grid has been applied; false after reset
}
export interface PlayoutStats { delayMs: number; jitterMs: number; snaps: number; idle: boolean; extrapolating: boolean; lastTicksPerBatch: number }

export interface GameRuntime extends GameSink {
  readonly world: Readonly<World>;
  readonly render: Readonly<RenderState>;
  readonly queue: EventQueue;
  readonly playoutStats: Readonly<PlayoutStats>;
  readonly hitStopActive: boolean;
  /** Advances playout and hit-stop debt. Releases due events in (tick, seq) order. For each one the runtime
   *  first applies its own bookkeeping (pending score delta, display brick arrays, cold-bridge dirty mark for
   *  score and seat events) and then calls `fire`, which the frame loop uses only for fx.consume (D34).
   *  Samples into `render`. No allocation. */
  frame(dtMs: number, nowMs: number, fire: (e: GameEvent) => void): void;
  displayMs(nowMs: number): number;   // estimated display time at nowMs (audio scheduling)
  hitStop(ms: number, reason: 'goalConceded' | 'lastBrick'): void;
  setIntentSource(src: (() => Visual) | null): void;   // own-paddle lead input (D08)
  setOwnLead(enabled: boolean): void;                  // initialised from T.ownLead.enabled; DebugOverlay toggles it (8.4)
  setUnstable(unstable: boolean): void;                // mirrors appStore.net.unstable (5.6)
  onIngestEvents(fn: IngestListener): () => void;
  slotOf(ballId: number): number;     // -1 when unknown
}
export interface GameRuntimeDeps { store: AppStore; now?: Now; timers?: TimerHost; tuning?: Tuning }
