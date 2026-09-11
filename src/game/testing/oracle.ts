// The server oracle (14.2, 4.7). Test-only: never imported by app code. A seeded port of the server's tick:
// Ball.Move, Paddle.Move, the wall tests and handleWallCollision, BallInterceptPaddles, the brick collision,
// damageBrick and the power-ups (pongo/game/ball.go, paddle.go, game_actor.go:188-205,370-423,
// game_actor_physics.go:17-430, game_actor_entities.go). It emits each tick's items in the server's order:
// between-tick items, then detectCollisions' messages, then paddles 0..3, then balls in (shuffled) map order,
// together with the ground truth of what happened.

import type {
  BatchItem, BrickCell, FullGridUpdate, InitialState, WireBall, WireCellType, WirePaddle, WirePlayer,
} from '../../protocol/messages';
import type { Seat, Wall } from '../events';
import type { Rand } from '../../lib/random';
import { seeded } from '../../lib/random';
import {
  BALL_R0, BALL_V_MAX, BALL_V_MIN, CANVAS, CELL, CellType, GRID, PADDLE_LEN, PADDLE_STEP, PADDLE_THICK, PHASE_MS, TICK_MS,
} from '../../config/constants';

// Server values that have no client mirror (pongo/utils/config.go:59-104).
const SPEED_FACTOR = 0.3;      // BallHitPaddleSpeedFactor
const ANGLE_FACTOR = 2.8;      // BallHitPaddleAngleFactor
const FILL_DENSITY = 0.55;
const CLEAR_CENTER = 1;
const CLEAR_WALL = 3;
const MIN_LIFE = 1;
const MAX_LIFE = 7;
const POWER_UP_CHANCE = 0.4;
const SPAWN_EXPIRY_MS = 12000;
const MASS_ADD = 2;
const MASS_SIZE = 2;
const VEL_RATIO = 1.09;
const BALL_MASS = 1;
const MAX_PLAYERS = 4;

export interface OracleConfig { seed: number; seats: readonly Seat[]; bricks?: boolean; tickJitterMs?: number }
export interface OracleTruth {
  tick: number; ball: number;
  kind: 'paddle' | 'wallBounce' | 'goal' | 'absorbed' | 'brick';
  seat?: Seat; wall?: Wall; phasing?: boolean;
}
export interface Oracle {
  /** Advances one server tick. Returns the items that tick appends in server order: pre items, paddles 0..3, balls. */
  step(): { items: BatchItem[]; truth: OracleTruth[] };
  initialState(): InitialState;
  grid(): FullGridUpdate;
  readonly tick: number;
}

export interface SimBall {
  x: number; y: number; vx: number; vy: number; radius: number; id: number;
  ownerIndex: number; phasing: boolean; mass: number; isPermanent: boolean; collided: boolean;
}
export type SimDirection = '' | 'left' | 'right';
export interface SimPaddle {
  x: number; y: number; width: number; height: number; index: Seat;
  direction: SimDirection; vx: number; vy: number; isMoving: boolean; collided: boolean;
}
export interface SimPlayer { connected: boolean; score: number; ready: boolean }
export interface SimOptions {
  /** Steer connected paddles toward approaching balls (with some laziness), as createOracle does. */
  ai?: boolean;
  /** Give every configured seat its permanent ball, as announcePlayer does. Default true. */
  spawnBalls?: boolean;
}

const copysign1 = (v: number): number => (v < 0 || Object.is(v, -0) ? -1 : 1);
const r3f = (x: number, y: number): { r3fX: number; r3fY: number } => ({ r3fX: x - CANVAS / 2, r3fY: CANVAS / 2 - y });
const PLAYER_COLORS: readonly [number, number, number][] = [[59, 130, 246], [34, 197, 94], [234, 179, 8], [239, 68, 68]];

export function newPaddle(index: Seat): SimPaddle {
  const p: SimPaddle = { x: 0, y: 0, width: 0, height: 0, index, direction: '', vx: 0, vy: 0, isMoving: false, collided: false };
  if (index === 0 || index === 2) {
    p.width = PADDLE_THICK;
    p.height = PADDLE_LEN;
    p.x = index === 0 ? CANVAS - p.width : 0;
    p.y = Math.trunc((CANVAS - p.height) / 2);
  } else {
    p.width = PADDLE_LEN;
    p.height = PADDLE_THICK;
    p.x = Math.trunc((CANVAS - p.width) / 2);
    p.y = index === 1 ? 0 : CANVAS - p.height;
  }
  return p;
}

export class ServerSim implements Oracle {
  readonly rand: Rand;
  readonly players: (SimPlayer | null)[] = [null, null, null, null];
  readonly paddles: (SimPaddle | null)[] = [null, null, null, null];
  readonly balls = new Map<number, SimBall>();
  readonly life = new Int32Array(GRID * GRID);
  readonly type = new Uint8Array(GRID * GRID).fill(CellType.Empty);
  readonly level = new Int32Array(GRID * GRID);
  gridDirty = false;
  over = false;
  private readonly ai: boolean;
  private readonly aiOffset = new Float64Array(4);
  private readonly aiRetarget = new Int32Array(4);
  private readonly aiLazy = new Uint8Array(4);
  private readonly paddleKeys = new Set<number>();
  private readonly brickKeys = new Map<number, Set<number>>();
  private readonly phaseEnd = new Map<number, number>();
  private readonly expireAt = new Map<number, number>();
  private pending: BatchItem[] = [];
  private items: BatchItem[] = [];
  private truth: OracleTruth[] = [];
  private inStep = false;
  private tickNo = 0;
  private nextBallId = 0;

  constructor(cfg: OracleConfig, opts: SimOptions = {}) {
    this.rand = seeded(cfg.seed);
    this.ai = opts.ai ?? false;
    for (const seat of cfg.seats) {
      this.players[seat] = { connected: true, score: 0, ready: true };
      this.paddles[seat] = newPaddle(seat);
    }
    if (cfg.bricks) this.fillSymmetrical();
    if (opts.spawnBalls ?? true) for (const seat of cfg.seats) this.spawnBall(seat, 0, 0, 0, true);
    this.pending.length = 0;   // the permanent balls are part of the initial state
  }

  get tick(): number {
    return this.tickNo;
  }

  // ------------------------------------------------------------------------------------------ wire views

  wireBall(b: SimBall): WireBall {
    return {
      x: b.x, y: b.y, vx: b.vx, vy: b.vy, radius: b.radius, id: b.id, ownerIndex: b.ownerIndex,
      phasing: b.phasing, mass: b.mass, isPermanent: b.isPermanent, collided: b.collided,
    };
  }

  wirePaddle(p: SimPaddle): WirePaddle {
    return { x: p.x, y: p.y, width: p.width, height: p.height, index: p.index, vx: p.vx, vy: p.vy, isMoving: p.isMoving, collided: p.collided };
  }

  wirePlayer(i: Seat): WirePlayer {
    const pl = this.players[i] as SimPlayer;
    return { index: i, id: `player${i}`, color: PLAYER_COLORS[i], score: pl.score };
  }

  initialState(): InitialState {
    const players: WirePlayer[] = [];
    const paddles: InitialState['paddles'] = [];
    for (let i = 0; i < MAX_PLAYERS; i++) {
      const pl = this.players[i];
      if (pl !== null && pl.connected) players.push(this.wirePlayer(i as Seat));
      const p = this.paddles[i];
      if (p !== null) paddles.push({ ...this.wirePaddle(p), ...r3f(p.x + Math.trunc(p.width / 2), p.y + Math.trunc(p.height / 2)) });
    }
    const balls: InitialState['balls'] = [];
    for (const b of this.balls.values()) balls.push({ ...this.wireBall(b), ...r3f(b.x, b.y) });
    return { messageType: 'initialPlayersAndBallsState', players, paddles, balls };
  }

  grid(): FullGridUpdate {
    const bricks: BrickCell[] = [];
    for (let r = 0; r < GRID; r++) {
      for (let c = 0; c < GRID; c++) {
        const i = r * GRID + c;
        const { r3fX, r3fY } = r3f(c * CELL + CELL / 2, r * CELL + CELL / 2);
        bricks.push({ x: r3fX, y: r3fY, life: this.life[i], type: this.type[i] as WireCellType });
      }
    }
    return { messageType: 'fullGridUpdate', cellSize: CELL, bricks };
  }

  // ------------------------------------------------------------------------------------------ test hooks

  /** Adds a ball without any message, as if it were already in the room. */
  addBall(b: Partial<SimBall> & { x: number; y: number; vx: number; vy: number }): SimBall {
    const id = b.id ?? ++this.nextBallId;
    if (id > this.nextBallId) this.nextBallId = id;
    const ball: SimBall = {
      radius: BALL_R0, ownerIndex: -1, phasing: false, mass: BALL_MASS, isPermanent: true, collided: false, ...b, id,
    };
    this.balls.set(id, ball);
    return ball;
  }

  setBrick(row: number, col: number, life: number): void {
    const i = row * GRID + col;
    this.life[i] = life;
    this.level[i] = life;
    this.type[i] = life > 0 ? CellType.Brick : CellType.Empty;
  }

  setDirection(seat: Seat, dir: SimDirection): void {
    const p = this.paddles[seat];
    if (p !== null) p.direction = dir;
  }

  /** Starts phasing as the power-up does (the timer runs PHASE_MS). */
  startPhasing(ballId: number): void {
    const b = this.balls.get(ballId);
    if (b === undefined) return;
    b.phasing = true;
    this.phaseEnd.set(ballId, this.tickNo + Math.round(PHASE_MS / TICK_MS));
  }

  /** Ends phasing between ticks, as the phasing timer does. */
  stopPhasing(ballId: number): void {
    const b = this.balls.get(ballId);
    if (b !== undefined) b.phasing = false;
    this.phaseEnd.delete(ballId);
  }

  /** The disconnect handler (game_actor_disconnect.go:21-60): playerLeft, then lobbyState, between ticks. */
  disconnect(seat: Seat): void {
    const pl = this.players[seat];
    if (pl === null || !pl.connected) return;
    pl.connected = false;
    pl.ready = false;
    const p = this.paddles[seat];
    if (p !== null) p.direction = '';
    this.emit({ messageType: 'playerLeft', index: seat });
    this.emit(this.lobbyState());
  }

  /** The grace expiry (game_actor_disconnect.go:79-119): playerLeft, paddle removed, the leaver's permanent
   *  balls released, its temporary balls destroyed, then lobbyState. */
  expireGrace(seat: Seat): void {
    const pl = this.players[seat];
    if (pl === null || pl.connected) return;
    this.emit({ messageType: 'playerLeft', index: seat });
    this.paddles[seat] = null;
    for (const [id, b] of Array.from(this.balls)) {
      if (b.ownerIndex !== seat) continue;
      if (b.isPermanent) {
        b.ownerIndex = -1;
        this.emit({ messageType: 'ballOwnerChanged', id, newOwnerIndex: -1 });
      } else {
        this.destroyBall(id);
      }
    }
    this.players[seat] = null;
    this.emit(this.lobbyState());
  }

  /** Admission of a (new or returning) player: playerJoined, a permanent ball if it has none, lobbyState. */
  join(seat: Seat, score = 0): void {
    const existing = this.players[seat];
    if (existing !== null) existing.connected = true;
    else this.players[seat] = { connected: true, score, ready: false };
    if (this.paddles[seat] === null) this.paddles[seat] = newPaddle(seat);
    const p = this.paddles[seat] as SimPaddle;
    this.emit({ messageType: 'playerJoined', player: this.wirePlayer(seat), paddle: this.wirePaddle(p), ...r3f(p.x, p.y) });
    let hasBall = false;
    for (const b of this.balls.values()) if (b.isPermanent && b.ownerIndex === seat) hasBall = true;
    if (!hasBall) this.spawnBall(seat, 0, 0, 0, true);
    this.emit(this.lobbyState());
  }

  lobbyState(): BatchItem {
    const players: { index: number; isReady: boolean }[] = [];
    for (let i = 0; i < MAX_PLAYERS; i++) {
      const pl = this.players[i];
      if (pl !== null && pl.connected) players.push({ index: i, isReady: pl.ready });
    }
    return { messageType: 'lobbyState', players };
  }

  // ------------------------------------------------------------------------------------------ the tick

  step(): { items: BatchItem[]; truth: OracleTruth[] } {
    this.tickNo++;
    const t = this.tickNo;
    this.items = this.pending;
    this.pending = [];
    this.truth = [];
    this.inStep = true;
    // Between ticks: timers (the phasing clear is silent, expiry emits ballRemoved) and direction messages.
    for (const [id, end] of Array.from(this.phaseEnd)) {
      if (end > t) continue;
      this.phaseEnd.delete(id);
      const b = this.balls.get(id);
      if (b !== undefined) b.phasing = false;
    }
    for (const [id, at] of Array.from(this.expireAt)) if (at <= t) this.destroyBall(id);
    if (this.ai) this.steer();
    // GameTick (game_actor.go:188-205).
    this.moveEntities();
    this.detectCollisions();
    this.generatePositionUpdates();
    for (const p of this.paddles) if (p !== null) p.collided = false;
    for (const b of this.balls.values()) b.collided = false;
    this.checkGameOver();
    this.inStep = false;
    return { items: this.items, truth: this.truth };
  }

  private emit(item: BatchItem): void {
    (this.inStep ? this.items : this.pending).push(item);
  }

  /** Go map iteration order is random: each range loop gets its own shuffled order. */
  private order(): SimBall[] {
    const arr = Array.from(this.balls.values());
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.rand() * (i + 1));
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    return arr;
  }

  private intn(n: number): number {
    return Math.floor(this.rand() * n);
  }

  private moveEntities(): void {
    for (const p of this.paddles) if (p !== null) movePaddle(p);
    for (const b of this.balls.values()) {
      b.x += b.vx;
      b.y += b.vy;
    }
  }

  private detectCollisions(): void {
    const phasingAtStart = new Map<number, boolean>();
    for (const [id, b] of this.balls) phasingAtStart.set(id, b.phasing);
    // Ball-wall. A ball removed at one wall is still tested against the next ones (as the server does).
    for (const b of this.order()) {
      const ph = phasingAtStart.get(b.id) ?? false;
      if (b.x + b.radius >= CANVAS) this.wallCollision(b, 0, ph);
      if (b.y - b.radius <= 0) this.wallCollision(b, 1, ph);
      if (b.x - b.radius <= 0) this.wallCollision(b, 2, ph);
      if (b.y + b.radius >= CANVAS) this.wallCollision(b, 3, ph);
    }
    // Ball-paddle.
    for (const b of this.order()) {
      for (let i = 0; i < MAX_PLAYERS; i++) {
        const p = this.paddles[i];
        if (p === null) continue;
        const key = b.id * 1000 + i;
        if (interceptsPaddle(b, p)) {
          const isNew = !this.paddleKeys.has(key);
          this.paddleKeys.add(key);
          b.collided = true;
          p.collided = true;
          if (isNew) this.paddleCollision(b, p, i as Seat);
        } else {
          this.paddleKeys.delete(key);
        }
      }
    }
    // Ball-brick.
    for (const b of this.order()) {
      const ph = phasingAtStart.get(b.id) ?? false;
      let active = this.brickKeys.get(b.id);
      if (active === undefined) {
        active = new Set();
        this.brickKeys.set(b.id, active);
      }
      const hit = new Set<number>();
      const clampG = (v: number): number => Math.max(0, Math.min(GRID - 1, v));
      const minCol = clampG(Math.trunc((b.x - b.radius) / CELL));
      const maxCol = clampG(Math.trunc((b.x + b.radius) / CELL));
      const minRow = clampG(Math.trunc((b.y - b.radius) / CELL));
      const maxRow = clampG(Math.trunc((b.y + b.radius) / CELL));
      for (let r = minRow; r <= maxRow; r++) {
        for (let c = minCol; c <= maxCol; c++) {
          const i = r * GRID + c;
          if (this.type[i] !== CellType.Brick) continue;
          const brickId = MAX_PLAYERS + i;
          if (interceptsCell(b, c, r)) {
            hit.add(brickId);
            const isNew = !active.has(brickId);
            active.add(brickId);
            if (ph) {
              if (isNew) this.damageBrick(b, r, c);
            } else {
              b.collided = true;
              if (isNew) this.brickCollision(b, r, c);
            }
          } else if (active.has(brickId)) {
            active.delete(brickId);
          }
        }
      }
      for (const k of Array.from(active)) if (!hit.has(k)) active.delete(k);
    }
  }

  private wallCollision(b: SimBall, wall: Wall, isPhasing: boolean): void {
    let reflected = false;
    if (wall === 0 && b.vx > 0) reflected = reflect(b, 'X');
    else if (wall === 1 && b.vy < 0) reflected = reflect(b, 'Y');
    else if (wall === 2 && b.vx < 0) reflected = reflect(b, 'X');
    else if (wall === 3 && b.vy > 0) reflected = reflect(b, 'Y');
    b.collided = true;
    if (isPhasing) {
      if (reflected) this.truth.push({ tick: this.tickNo, ball: b.id, kind: 'wallBounce', wall, phasing: true });
      return;
    }
    const conceder = this.players[wall];
    if (conceder !== null && conceder.connected) {
      conceder.score--;
      this.emit({ messageType: 'scoreUpdate', index: wall, score: conceder.score });
      const scorerIndex = b.ownerIndex;
      const scorer = scorerIndex >= 0 && scorerIndex < MAX_PLAYERS ? this.players[scorerIndex] : null;
      if (scorer !== null && scorer.connected && scorerIndex !== wall) {
        scorer.score++;
        this.emit({ messageType: 'scoreUpdate', index: scorerIndex, score: scorer.score });
      }
      if (b.ownerIndex === wall) {
        b.ownerIndex = -1;
        this.emit({ messageType: 'ballOwnerChanged', id: b.id, newOwnerIndex: -1 });
      }
      this.truth.push({ tick: this.tickNo, ball: b.id, kind: 'goal', wall });
      return;
    }
    if (!b.isPermanent) {
      if (this.balls.has(b.id)) {
        this.truth.push({ tick: this.tickNo, ball: b.id, kind: 'absorbed', wall });
        this.destroyBall(b.id);
      }
      return;
    }
    if (reflected) this.truth.push({ tick: this.tickNo, ball: b.id, kind: 'wallBounce', wall, phasing: false });
  }

  private paddleCollision(b: SimBall, p: SimPaddle, seat: Seat): void {
    const horizontal = p.width > p.height;
    const centre = horizontal ? p.x + Math.trunc(p.width / 2) : p.y + Math.trunc(p.height / 2);
    const rel = (horizontal ? b.x : b.y) - centre;
    const span = horizontal ? p.width : p.height;
    let norm = (rel / (span / 2)) * 1.1;
    norm = Math.max(-1, Math.min(1, norm));
    let angle = norm * (Math.PI / ANGLE_FACTOR);
    if (seat === 0 || seat === 1) angle = -angle;
    const base = seat === 0 ? [-1, 0] : seat === 1 ? [0, 1] : seat === 2 ? [1, 0] : [0, -1];
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const nvx = base[0] * cos - base[1] * sin;
    const nvy = base[0] * sin + base[1] * cos;
    const current = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
    const pv = horizontal ? p.vx * nvx : p.vy * nvy;
    let speed = current + pv * SPEED_FACTOR;
    speed = Math.max(BALL_V_MIN, Math.min(BALL_V_MAX * 1.2, speed));
    let fvx = Math.trunc(nvx * speed);
    let fvy = Math.trunc(nvy * speed);
    if (speed > 0) {
      if (fvx === 0) fvx = copysign1(nvx);
      if (fvy === 0) fvy = copysign1(nvy);
    }
    b.vx = fvx;
    b.vy = fvy;
    b.ownerIndex = seat;
    this.emit({ messageType: 'ballOwnerChanged', id: b.id, newOwnerIndex: seat });
    this.truth.push({ tick: this.tickNo, ball: b.id, kind: 'paddle', seat });
  }

  private brickCollision(b: SimBall, r: number, c: number): void {
    if (b.phasing) return;
    const dx = b.x - (c * CELL + CELL / 2);
    const dy = b.y - (r * CELL + CELL / 2);
    const ox = b.radius + CELL / 2 - Math.abs(dx);
    const oy = b.radius + CELL / 2 - Math.abs(dy);
    if (ox > 0 && oy > 0) {
      if (ox < oy) {
        if ((b.vx > 0 && dx < 0) || (b.vx < 0 && dx > 0)) reflect(b, 'X');
      } else if ((b.vy > 0 && dy < 0) || (b.vy < 0 && dy > 0)) {
        reflect(b, 'Y');
      }
    }
    this.damageBrick(b, r, c);
  }

  private damageBrick(b: SimBall, r: number, c: number): void {
    const i = r * GRID + c;
    if (this.life[i] <= 0) return;
    this.gridDirty = true;
    this.life[i]--;
    this.truth.push({ tick: this.tickNo, ball: b.id, kind: 'brick' });
    if (this.life[i] > 0) return;
    const lvl = this.level[i];
    this.type[i] = CellType.Empty;
    this.level[i] = 0;
    const s = b.ownerIndex;
    const scorer = s >= 0 && s < MAX_PLAYERS ? this.players[s] : null;
    if (scorer !== null && scorer.connected) {
      scorer.score += lvl;
      this.emit({ messageType: 'scoreUpdate', index: s, score: scorer.score });
    }
    if (this.rand() < POWER_UP_CHANCE) this.powerUp(b, r, c);
  }

  private powerUp(b: SimBall, r: number, c: number): void {
    switch (this.intn(4)) {
      case 0: {
        const x = c * CELL + CELL / 2 + this.intn(CELL / 2) - Math.trunc(CELL / 4);
        const y = r * CELL + CELL / 2 + this.intn(CELL / 2) - Math.trunc(CELL / 4);
        this.spawnBall(b.ownerIndex, x, y, SPAWN_EXPIRY_MS, false);
        break;
      }
      case 1:
        b.mass += MASS_ADD;
        b.radius += MASS_ADD * MASS_SIZE;
        break;
      case 2: {
        const nvx = Math.floor(b.vx * VEL_RATIO);
        const nvy = Math.floor(b.vy * VEL_RATIO);
        b.vx = b.vx !== 0 && nvx === 0 ? copysign1(b.vx) : nvx;
        b.vy = b.vy !== 0 && nvy === 0 ? copysign1(b.vy) : nvy;
        break;
      }
      default:
        b.phasing = true;
        this.phaseEnd.set(b.id, this.tickNo + Math.round(PHASE_MS / TICK_MS));
    }
  }

  /** spawnBall (game_actor_entities.go:32-66). x = y = 0 places it by owner, as NewBall does. */
  spawnBall(owner: number, x: number, y: number, expireMs: number, permanent: boolean): SimBall | null {
    if (owner < -1 || owner >= MAX_PLAYERS) return null;
    if (owner >= 0) {
      const pl = this.players[owner];
      if (pl === null || !pl.connected) return null;
    }
    let id = ++this.nextBallId;
    while (this.balls.has(id)) id = ++this.nextBallId;
    const b = this.newBall(owner, x, y, id, permanent);
    this.balls.set(id, b);
    this.emit({ messageType: 'ballSpawned', ball: this.wireBall(b), ...r3f(b.x, b.y) });
    if (!permanent && expireMs > 0) {
      let duration = expireMs + this.intn(4000) - 2000;
      if (duration <= 0) duration = 500;
      this.expireAt.set(id, this.tickNo + Math.ceil(duration / TICK_MS));
    }
    return b;
  }

  /** NewBall (ball.go:34-117). */
  private newBall(owner: number, x: number, y: number, id: number, permanent: boolean): SimBall {
    if (x === 0 && y === 0) {
      const offset = PADDLE_THICK * 2;
      switch (owner) {
        case 0:
          x = CANVAS - offset - BALL_R0;
          y = CANVAS / 2;
          break;
        case 1:
          x = CANVAS / 2;
          y = offset + BALL_R0;
          break;
        case 2:
          x = offset + BALL_R0;
          y = CANVAS / 2;
          break;
        case 3:
          x = CANVAS / 2;
          y = CANVAS - offset - BALL_R0;
          break;
        default:
          x = CANVAS / 2;
          y = CANVAS / 2;
      }
    }
    const offsetA = Math.PI / 12;
    let angle = offsetA + this.rand() * (Math.PI / 2 - 2 * offsetA);
    switch (owner) {
      case 0:
        angle += Math.PI / 2;
        if (this.intn(2) === 0) angle += Math.PI;
        break;
      case 1:
        angle += Math.PI;
        if (this.intn(2) === 0) angle += Math.PI / 2;
        break;
      case 2:
        if (this.intn(2) === 0) angle += (3 * Math.PI) / 2;
        break;
      case 3:
        angle += (3 * Math.PI) / 2;
        if (this.intn(2) === 0) angle += Math.PI / 2;
        break;
      default:
        angle = this.rand() * 2 * Math.PI;
    }
    const speed = BALL_V_MIN + this.intn(BALL_V_MAX - BALL_V_MIN + 1);
    const fx = speed * Math.cos(angle);
    const fy = speed * Math.sin(angle);
    let vx = Math.trunc(fx);
    let vy = Math.trunc(fy);
    if (vx === 0) vx = copysign1(fx);
    if (vy === 0) vy = copysign1(fy);
    return { x, y, vx, vy, radius: BALL_R0, id, ownerIndex: owner, phasing: false, mass: BALL_MASS, isPermanent: permanent, collided: false };
  }

  /** handleDestroyExpiredBall (game_actor_entities.go:68-88): temporary balls only. */
  destroyBall(id: number): void {
    const b = this.balls.get(id);
    if (b === undefined || b.isPermanent) return;
    this.balls.delete(id);
    this.expireAt.delete(id);
    this.phaseEnd.delete(id);
    this.brickKeys.delete(id);
    for (let i = 0; i < MAX_PLAYERS; i++) this.paddleKeys.delete(id * 1000 + i);
    this.emit({ messageType: 'ballRemoved', id });
  }

  private generatePositionUpdates(): void {
    for (let i = 0; i < MAX_PLAYERS; i++) {
      const p = this.paddles[i];
      if (p === null) continue;
      this.emit({
        messageType: 'paddlePositionUpdate', index: i, x: p.x, y: p.y,
        ...r3f(p.x + Math.trunc(p.width / 2), p.y + Math.trunc(p.height / 2)),
        width: p.width, height: p.height, vx: p.vx, vy: p.vy, isMoving: p.isMoving, collided: p.collided,
      });
    }
    for (const b of this.order()) {
      this.emit({
        messageType: 'ballPositionUpdate', id: b.id, x: b.x, y: b.y, ...r3f(b.x, b.y),
        vx: b.vx, vy: b.vy, collided: b.collided, phasing: b.phasing,
      });
    }
  }

  private checkGameOver(): void {
    if (this.over) return;
    for (let i = 0; i < this.type.length; i++) if (this.type[i] === CellType.Brick) return;
    this.over = true;
  }

  /** FillSymmetrical (grid.go:30-90) with the default config. */
  private fillSymmetrical(): void {
    const center = GRID / 2;
    const lifeRange = MAX_LIFE - MIN_LIFE + 1;
    for (let r = CLEAR_WALL; r <= center - 1; r++) {
      for (let c = CLEAR_WALL; c <= center - 1; c++) {
        const dx = c + 0.5 - GRID / 2;
        const dy = r + 0.5 - GRID / 2;
        if (dx * dx + dy * dy < CLEAR_CENTER * CLEAR_CENTER) continue;
        if (this.rand() < FILL_DENSITY) {
          const life = MIN_LIFE + (lifeRange > 1 ? this.intn(lifeRange) : 0);
          const positions = [[r, c], [c, GRID - 1 - r], [GRID - 1 - r, GRID - 1 - c], [GRID - 1 - c, r]];
          for (const [row, col] of positions) {
            const i = row * GRID + col;
            if (this.type[i] === CellType.Empty) this.setBrick(row, col, life);
          }
        }
      }
    }
    this.gridDirty = true;
  }

  /** Connected paddles steer toward the ball that reaches their wall first, off by a wandering offset, and
   *  sometimes idle, so the play has both hits and goals. */
  private steer(): void {
    for (let i = 0; i < MAX_PLAYERS; i++) {
      const p = this.paddles[i];
      const pl = this.players[i];
      if (p === null || pl === null || !pl.connected) continue;
      if (this.tickNo >= this.aiRetarget[i]) {
        this.aiOffset[i] = (this.rand() * 2 - 1) * 60;
        this.aiRetarget[i] = this.tickNo + 20 + this.intn(60);
        this.aiLazy[i] = this.rand() < 0.15 ? 1 : 0;
      }
      const vertical = i === 0 || i === 2;
      let best: SimBall | null = null;
      let bestT = Infinity;
      for (const b of this.balls.values()) {
        const v = i === 0 ? b.vx : i === 1 ? -b.vy : i === 2 ? -b.vx : b.vy;
        if (v <= 0) continue;
        const dist = i === 0 ? CANVAS - b.x : i === 1 ? b.y : i === 2 ? b.x : CANVAS - b.y;
        const tt = dist / v;
        if (tt < bestT) {
          bestT = tt;
          best = b;
        }
      }
      if (best === null || this.aiLazy[i] === 1) {
        p.direction = '';
        continue;
      }
      const target = (vertical ? best.y : best.x) + this.aiOffset[i];
      const centre = vertical ? p.y + p.height / 2 : p.x + p.width / 2;
      const diff = target - centre;
      p.direction = Math.abs(diff) < PADDLE_STEP * 0.7 ? '' : diff < 0 ? 'left' : 'right';
    }
  }
}

/** Paddle.Move (paddle.go:83-123). */
export function movePaddle(p: SimPaddle): void {
  p.vx = 0;
  p.vy = 0;
  p.isMoving = false;
  if (p.direction === '') return;
  const up = p.direction === 'left';
  if (p.index === 0 || p.index === 2) {
    p.vy = up ? -PADDLE_STEP : PADDLE_STEP;
    p.y = up ? Math.max(0, p.y - PADDLE_STEP) : Math.min(CANVAS - p.height, p.y + PADDLE_STEP);
  } else {
    p.vx = up ? -PADDLE_STEP : PADDLE_STEP;
    p.x = up ? Math.max(0, p.x - PADDLE_STEP) : Math.min(CANVAS - p.width, p.x + PADDLE_STEP);
  }
  p.isMoving = true;
}

/** ReflectVelocity (ball.go:150-166). Always true: the caller only reflects when moving toward the wall. */
function reflect(b: SimBall, axis: 'X' | 'Y'): boolean {
  if (axis === 'X') {
    const o = b.vx;
    b.vx = -b.vx;
    if (b.vx === 0 && o !== 0) b.vx = copysign1(-o);
  } else {
    const o = b.vy;
    b.vy = -b.vy;
    if (b.vy === 0 && o !== 0) b.vy = copysign1(-o);
  }
  return true;
}

/** BallInterceptPaddles (ball.go:207-220). */
export function interceptsPaddle(b: SimBall, p: SimPaddle): boolean {
  const cx = Math.max(p.x, Math.min(b.x, p.x + p.width));
  const cy = Math.max(p.y, Math.min(b.y, p.y + p.height));
  const dx = b.x - cx;
  const dy = b.y - cy;
  return dx * dx + dy * dy < b.radius * b.radius;
}

/** InterceptsIndex (ball.go:223-239). */
function interceptsCell(b: SimBall, col: number, row: number): boolean {
  const left = col * CELL;
  const top = row * CELL;
  const cx = Math.max(left, Math.min(b.x, left + CELL));
  const cy = Math.max(top, Math.min(b.y, top + CELL));
  const dx = b.x - cx;
  const dy = b.y - cy;
  return dx * dx + dy * dy < b.radius * b.radius;
}

/** A playing server with steering paddles. */
export function createOracle(cfg: OracleConfig): Oracle {
  return new ServerSim(cfg, { ai: true });
}
