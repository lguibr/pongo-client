// Builders for synthetic batches and sessions that follow the server's emission order (5.1). Test-only; later
// stages may import it. Coordinates are canvas px; paddles take the wire's top-left corner.

import type {
  BallOwnerChanged, BallPositionUpdate, BallRemoved, BallSpawned, BatchItem, BrickCell, FullGridUpdate, GameStartCancelled,
  GameStartCountdown, GameStarted, GameUpdates, InitialState, LobbyState, PaddlePositionUpdate, PlayerJoined, PlayerLeft,
  ScoreUpdate, WireBall, WireCellType, WirePaddle,
} from '../../protocol/messages';
import type { Seat } from '../events';
import type { FixtureFrame } from '../../test/fixtures/load';
import type { Oracle, OracleConfig, OracleTruth } from './oracle';
import { newPaddle, ServerSim } from './oracle';
import { seeded } from '../../lib/random';
import { BALL_R0, CANVAS, CELL, CellType, GRID, TICK_MS } from '../../config/constants';

const r3f = (x: number, y: number): { r3fX: number; r3fY: number } => ({ r3fX: x - CANVAS / 2, r3fY: CANVAS / 2 - y });

export function batch(...items: BatchItem[]): GameUpdates {
  return { messageType: 'gameUpdates', updates: items };
}

/** Concatenated output of `ticks` oracle steps. */
export function frames(oracle: Oracle, ticks: number): BatchItem[] {
  const out: BatchItem[] = [];
  for (let i = 0; i < ticks; i++) out.push(...oracle.step().items);
  return out;
}

// -------------------------------------------------------------------------------------------- item builders

/** The seat's paddle at its start position (paddle.go:37-80), top-left corner as on the wire. */
export function wirePaddle(seat: Seat, over: Partial<WirePaddle> = {}): WirePaddle {
  const p = newPaddle(seat);
  return {
    x: p.x, y: p.y, width: p.width, height: p.height, index: seat, vx: 0, vy: 0, isMoving: false, collided: false, ...over,
  };
}

export function paddleItem(seat: Seat, over: Partial<WirePaddle> = {}): PaddlePositionUpdate {
  const p = wirePaddle(seat, over);
  return { messageType: 'paddlePositionUpdate', ...p, ...r3f(p.x + p.width / 2, p.y + p.height / 2) };
}

export function wireBall(id: number, x: number, y: number, vx: number, vy: number, over: Partial<WireBall> = {}): WireBall {
  return {
    x, y, vx, vy, radius: BALL_R0, id, ownerIndex: -1, phasing: false, mass: 1, isPermanent: true, collided: false, ...over,
  };
}

export function ballItem(
  id: number, x: number, y: number, vx: number, vy: number, over: { collided?: boolean; phasing?: boolean } = {},
): BallPositionUpdate {
  return {
    messageType: 'ballPositionUpdate', id, x, y, ...r3f(x, y), vx, vy,
    collided: over.collided ?? false, phasing: over.phasing ?? false,
  };
}

export function spawnedItem(ball: WireBall): BallSpawned {
  return { messageType: 'ballSpawned', ball, ...r3f(ball.x, ball.y) };
}

export function removedItem(id: number): BallRemoved {
  return { messageType: 'ballRemoved', id };
}

export function ownerItem(id: number, newOwnerIndex: number): BallOwnerChanged {
  return { messageType: 'ballOwnerChanged', id, newOwnerIndex };
}

export function scoreItem(index: Seat, score: number): ScoreUpdate {
  return { messageType: 'scoreUpdate', index, score };
}

export function joinedItem(seat: Seat, score = 0, over: Partial<WirePaddle> = {}): PlayerJoined {
  const paddle = wirePaddle(seat, over);
  return {
    messageType: 'playerJoined', player: { index: seat, id: `player${seat}`, color: [1, 2, 3], score }, paddle,
    ...r3f(paddle.x + paddle.width / 2, paddle.y + paddle.height / 2),
  };
}

export function leftItem(seat: Seat): PlayerLeft {
  return { messageType: 'playerLeft', index: seat };
}

export function lobbyItem(players: readonly (Seat | [Seat, boolean])[]): LobbyState {
  return {
    messageType: 'lobbyState',
    players: players.map((p) => (Array.isArray(p) ? { index: p[0], isReady: p[1] } : { index: p, isReady: false })),
  };
}

export function countdownItem(seconds: number): GameStartCountdown {
  return { messageType: 'gameStartCountdown', seconds };
}

export function startedItem(): GameStarted {
  return { messageType: 'gameStarted' };
}

export function cancelledItem(reason = 'Lobby membership or readiness changed'): GameStartCancelled {
  return { messageType: 'gameStartCancelled', reason };
}

/** A full 18x18 grid; `life(row, col)` > 0 places a brick with that life. */
export function gridItem(life: (row: number, col: number) => number = () => 0): FullGridUpdate {
  const bricks: BrickCell[] = [];
  for (let r = 0; r < GRID; r++) {
    for (let c = 0; c < GRID; c++) {
      const l = life(r, c);
      bricks.push({ ...xy(c * CELL + CELL / 2, r * CELL + CELL / 2), life: l > 0 ? l : 0, type: (l > 0 ? CellType.Brick : CellType.Empty) as WireCellType });
    }
  }
  return { messageType: 'fullGridUpdate', cellSize: CELL, bricks };
}

function xy(x: number, y: number): { x: number; y: number } {
  return { x: x - CANVAS / 2, y: CANVAS / 2 - y };
}

/** An initial state: `players` are Connected with their scores; `paddles` lists every seat with a paddle. */
export function initialItem(opts: { players?: readonly [Seat, number][]; paddles?: readonly Seat[]; balls?: readonly WireBall[] }): InitialState {
  const players = (opts.players ?? []).map(([index, score]) => ({ index, id: `player${index}`, color: [1, 2, 3] as [number, number, number], score }));
  const paddleSeats = opts.paddles ?? (opts.players ?? []).map(([s]) => s);
  return {
    messageType: 'initialPlayersAndBallsState',
    players,
    paddles: paddleSeats.map((s) => {
      const p = wirePaddle(s);
      return { ...p, ...r3f(p.x + p.width / 2, p.y + p.height / 2) };
    }),
    balls: (opts.balls ?? []).map((b) => ({ ...b, ...r3f(b.x, b.y) })),
  };
}

/** Paddle updates for the given seats at their start positions (one tick's paddle block). */
export function paddleBlock(seats: readonly Seat[]): PaddlePositionUpdate[] {
  return [...seats].sort((a, b) => a - b).map((s) => paddleItem(s));
}

// -------------------------------------------------------------------------------------------- sessions

function gaussian(rand: () => number): number {
  const u = Math.max(1e-12, rand());
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** A session of recorded-format frames: admission messages, then batches that coalesce 0-3 ticks, with arrival
 *  times. The physics and broadcast tickers run at 25 ms with independent scheduling noise, as they do on the
 *  server (game_actor_lifecycle.go:31-59), and the grid rides at the end of the batch that dirtied it. */
export function synthSession(cfg: OracleConfig & { seconds: number }): { frames: FixtureFrame[]; truth: OracleTruth[] } {
  const sim = new ServerSim(cfg, { ai: true });
  const rand = seeded((cfg.seed ^ 0x5bd1e995) >>> 0);
  const jitter = cfg.tickJitterMs ?? 3;
  const out: FixtureFrame[] = [];
  const truth: OracleTruth[] = [];
  const me = cfg.seats[0] ?? 0;
  const code = 'ABC123';
  let t = 10;
  const inbound = (d: unknown): void => {
    out.push({ t: Math.round(t * 10) / 10, c: 'A', dir: 'in', d: JSON.stringify(d) });
  };
  out.push({ t, c: 'A', dir: 'out', d: JSON.stringify({ messageType: 'quickPlay', sessionId: 'synthetic' }) });
  t += 1;
  inbound({ messageType: 'roomJoined', success: true, roomPID: 'actor-1', code, phase: 'playing', reason: '' });
  inbound({ messageType: 'playerAssignment', playerIndex: me, phase: 'playing' });
  inbound(sim.initialState());
  t += 0.2;
  sim.gridDirty = false;
  inbound(batch(sim.grid()));

  const start = t + 5;
  const ticks = Math.round((cfg.seconds * 1000) / TICK_MS);
  const phase = 4;                         // broadcast ticker offset from the physics ticker (ms)
  let nextTick = 1;
  let tickDoneAt = start + TICK_MS + gaussian(rand) * 1.5;
  let lastArrival = t;
  let pending: BatchItem[] = [];
  for (let j = 1; nextTick <= ticks; j++) {
    const broadcastAt = start + j * TICK_MS + phase + gaussian(rand) * 1.5;
    while (nextTick <= ticks && tickDoneAt <= broadcastAt) {
      const s = sim.step();
      pending.push(...s.items);
      truth.push(...s.truth);
      nextTick++;
      tickDoneAt = start + nextTick * TICK_MS + gaussian(rand) * 1.5;
    }
    if (sim.gridDirty) {
      pending.push(sim.grid());
      sim.gridDirty = false;
    }
    if (pending.length === 0) continue;
    const arrival = Math.max(lastArrival, broadcastAt + 15 + Math.abs(gaussian(rand)) * jitter);
    lastArrival = arrival;
    t = arrival;
    inbound(batch(...pending));
    pending = [];
  }
  return { frames: out, truth };
}
