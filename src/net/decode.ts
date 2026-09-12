// The single JSON.parse per frame and its shape guards (C52, C57). The parsed object is validated and
// normalised in place (booleans coerced, null arrays replaced, bad batch items removed), so no copy is made.

import type { ServerMessage } from '../protocol/messages';

export type Decoded = { ok: true; msg: ServerMessage; dropped: number } | { ok: false; detail: string };

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isSeat = (v: unknown): boolean => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 3;
const isOwner = (v: unknown): boolean => Number.isInteger(v) && (v as number) >= -1 && (v as number) <= 3;
const isPhase = (v: unknown): boolean => v === 'lobby' || v === 'countingDown' || v === 'playing';
const isCellType = (v: unknown): boolean => v === 0 || v === 1 || v === 2;

const PADDLE_NUMS = ['x', 'y', 'width', 'height', 'vx', 'vy'] as const;
const PADDLE_BOOLS = ['isMoving', 'collided'] as const;
const BALL_NUMS = ['x', 'y', 'vx', 'vy', 'radius', 'id', 'mass'] as const;
const BALL_BOOLS = ['phasing', 'isPermanent', 'collided'] as const;
const BALL_POS_NUMS = ['id', 'x', 'y', 'vx', 'vy'] as const;
const BALL_POS_BOOLS = ['collided', 'phasing'] as const;

function allFinite(o: Obj, keys: readonly string[]): boolean {
  for (let i = 0; i < keys.length; i++) if (!fin(o[keys[i]])) return false;
  return true;
}

function coerce(o: Obj, keys: readonly string[]): void {
  for (let i = 0; i < keys.length; i++) o[keys[i]] = !!o[keys[i]];
}

/** The array stored at o[key]: null becomes a new [] (stored back); anything else that is not an array gives null. */
function arrayAt(o: Obj, key: string): unknown[] | null {
  const v = o[key];
  if (v === null) {
    const empty: unknown[] = [];
    o[key] = empty;
    return empty;
  }
  return Array.isArray(v) ? v : null;
}

/** Keeps the entries for which keep() is true, in place. Returns how many were removed. */
function filterInPlace(arr: unknown[], keep: (v: unknown) => boolean): number {
  let w = 0;
  for (let r = 0; r < arr.length; r++) {
    const v = arr[r];
    if (keep(v)) arr[w++] = v;
  }
  const removed = arr.length - w;
  arr.length = w;
  return removed;
}

const notNull = (v: unknown): boolean => v !== null;

function checkPaddle(p: unknown): boolean {
  if (!isObj(p) || !isSeat(p.index) || !allFinite(p, PADDLE_NUMS)) return false;
  coerce(p, PADDLE_BOOLS);
  return true;
}

function checkBall(b: unknown): boolean {
  if (!isObj(b) || !isOwner(b.ownerIndex) || !allFinite(b, BALL_NUMS)) return false;
  coerce(b, BALL_BOOLS);
  return true;
}

function checkPlayer(p: unknown): boolean {
  if (!isObj(p) || !isSeat(p.index) || !isStr(p.id) || !fin(p.score)) return false;
  const c = p.color;
  return Array.isArray(c) && c.length === 3 && fin(c[0]) && fin(c[1]) && fin(c[2]);
}

function checkCell(c: unknown): boolean {
  return isObj(c) && fin(c.x) && fin(c.y) && fin(c.life) && isCellType(c.type);
}

function checkGrid(g: Obj): boolean {
  if (!fin(g.cellSize) || g.cellSize <= 0) return false;
  const bricks = arrayAt(g, 'bricks');
  if (bricks === null) return false;
  // The grid is square and row-major (gridSize = sqrt(bricks.length), 4.6), so any other length misplaces
  // cells. The side is not pinned to GRID: the World derives it from the first grid (risk 11).
  const side = Math.round(Math.sqrt(bricks.length));
  // A missing or bad cell would shift the row-major index of every later cell, so it drops the whole grid.
  return side * side === bricks.length && bricks.every(checkCell);
}

/** Null entries removed inside kept batch items (lobbyState.players); reset by each gameUpdates decode. */
let nestedDropped = 0;

function checkLobby(l: Obj): boolean {
  const players = arrayAt(l, 'players');
  if (players === null) return false;
  const removed = filterInPlace(players, notNull);
  for (const p of players) {
    if (!isObj(p) || !isSeat(p.index)) return false;
    p.isReady = !!p.isReady;
  }
  nestedDropped += removed;   // only for a kept item: a dropped item counts once, whatever it held
  return true;
}

function checkItem(it: unknown): boolean {
  if (!isObj(it)) return false;
  switch (it.messageType) {
    case 'ballPositionUpdate':
      if (!allFinite(it, BALL_POS_NUMS)) return false;
      coerce(it, BALL_POS_BOOLS);
      return true;
    case 'paddlePositionUpdate':
      return checkPaddle(it);
    case 'playerJoined':
      return checkPlayer(it.player) && checkPaddle(it.paddle);
    case 'playerLeft':
      return isSeat(it.index);
    case 'ballSpawned':
      return checkBall(it.ball);
    case 'ballRemoved':
      return fin(it.id);
    case 'fullGridUpdate':
      return checkGrid(it);
    case 'scoreUpdate':
      return isSeat(it.index) && fin(it.score);
    case 'ballOwnerChanged':
      return fin(it.id) && isOwner(it.newOwnerIndex);
    case 'lobbyState':
      return checkLobby(it);
    case 'gameStartCountdown':
      return fin(it.seconds);
    case 'gameStarted':
      return true;
    case 'gameStartCancelled':
      return isStr(it.reason);
    default:
      return false;
  }
}

const fail = (detail: string): Decoded => ({ ok: false, detail });
const pass = (msg: Obj, dropped: number): Decoded => ({ ok: true, msg: msg as unknown as ServerMessage, dropped });

/** Validates a top-level array: null entries are dropped and counted; any other bad entry fails. */
function strictArray(o: Obj, key: string, check: (v: unknown) => boolean): number {
  const arr = arrayAt(o, key);
  if (arr === null) return -1;
  const removed = filterInPlace(arr, notNull);
  return arr.every(check) ? removed : -1;
}

/** One JSON.parse. An unknown messageType or a bad top-level shape gives ok:false. Inside gameUpdates,
 *  each bad item is dropped on its own (counted in `dropped`), and so is a null item. Numbers the client
 *  reads must be finite. Booleans are coerced with !!. null arrays become [].
 *  Range rules (anything outside them drops the item, or gives ok:false for a top-level message):
 *   - seat fields, 0..3: playerAssignment.playerIndex; player.index (initial players, playerJoined.player);
 *     paddle.index (initial paddles, playerJoined.paddle, paddlePositionUpdate); playerLeft.index;
 *     scoreUpdate.index; lobbyState.players[].index;
 *   - owner fields, -1..3: ball.ownerIndex (initial balls, ballSpawned.ball); ballOwnerChanged.newOwnerIndex;
 *     gameOver.winnerIndex. -1 is legitimate: an own goal and a grace expiry release a ball
 *     (game_actor_physics.go:209-212, game_actor_disconnect.go:88-93), and a tie has no winner;
 *   - gameOver.finalScores: exactly 4 finite numbers. */
export function decode(text: string): Decoded {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail('malformed JSON');
  }
  if (!isObj(raw)) return fail('top level is not an object');

  switch (raw.messageType) {
    case 'gameUpdates': {
      const updates = arrayAt(raw, 'updates');
      if (updates === null) return fail('gameUpdates.updates is not an array');
      nestedDropped = 0;
      const removed = filterInPlace(updates, checkItem);
      return pass(raw, removed + nestedDropped);
    }
    case 'initialPlayersAndBallsState': {
      const players = strictArray(raw, 'players', checkPlayer);
      if (players < 0) return fail('bad initialPlayersAndBallsState.players');
      const paddles = strictArray(raw, 'paddles', checkPaddle);
      if (paddles < 0) return fail('bad initialPlayersAndBallsState.paddles');
      const balls = strictArray(raw, 'balls', checkBall);
      if (balls < 0) return fail('bad initialPlayersAndBallsState.balls');
      return pass(raw, players + paddles + balls);
    }
    case 'roomCreated':
      return isStr(raw.code) && isStr(raw.roomPID) ? pass(raw, 0) : fail('bad roomCreated');
    case 'roomJoined':
      if (!isStr(raw.roomPID) || !isStr(raw.code) || !isStr(raw.reason) || !(raw.phase === '' || isPhase(raw.phase))) {
        return fail('bad roomJoined');
      }
      raw.success = !!raw.success;
      return pass(raw, 0);
    case 'playerAssignment':
      return isSeat(raw.playerIndex) && isPhase(raw.phase) ? pass(raw, 0) : fail('bad playerAssignment');
    case 'gameOver': {
      const s = raw.finalScores;
      const scoresOk = Array.isArray(s) && s.length === 4 && fin(s[0]) && fin(s[1]) && fin(s[2]) && fin(s[3]);
      return isOwner(raw.winnerIndex) && scoresOk && isStr(raw.reason) && isStr(raw.roomPID) ? pass(raw, 0) : fail('bad gameOver');
    }
    default:
      return fail(`unknown messageType ${JSON.stringify(raw.messageType) ?? 'undefined'}`);
  }
}
