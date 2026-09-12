// Seat lifecycle and ghost paddles (5.4.7, C06, C56). The server sends playerLeft at the disconnect and again
// at grace expiry, and removes the paddle only at the second (game_actor_disconnect.go:44,85-86), so a Grace
// seat keeps its paddle, which the server still collides with.

import type { Seat, SeatConn as SeatConnT } from './events';
import { SeatConn } from './events';
import type { PaddleRow, World } from './types';
import type { ReducerCtx } from './reducer';
import type { InitialState, LobbyState, PaddlePositionUpdate, PlayerJoined, PlayerLeft, WirePaddle } from '../protocol/messages';
import { GRACE_MS } from '../config/constants';

/** The paddle centre when present, else the middle of the seat's wall (canvas px). */
export function seatPoint(w: Readonly<World>, seat: Seat, out: { x: number; y: number }): void {
  const p = w.paddles[seat];
  if (p.present) {
    out.x = p.x;
    out.y = p.y;
    return;
  }
  const c = w.canvas;
  switch (seat) {
    case 0:
      out.x = c;
      out.y = c / 2;
      return;
    case 1:
      out.x = c / 2;
      out.y = 0;
      return;
    case 2:
      out.x = 0;
      out.y = c / 2;
      return;
    default:
      out.x = c / 2;
      out.y = c;
  }
}

/** Wire paddle (top-left corner) to a World row (centre). */
export function setPaddleFromWire(row: PaddleRow, m: Pick<WirePaddle, 'x' | 'y' | 'width' | 'height' | 'vx' | 'vy' | 'collided'>): void {
  row.present = true;
  row.w = m.width;
  row.h = m.height;
  row.x = m.x + m.width / 2;
  row.y = m.y + m.height / 2;
  row.vx = m.vx;
  row.vy = m.vy;
  row.collided = m.collided;
}

/** Removes the paddle but keeps its size, so rows still in the ring can be drawn until display time passes. */
function removePaddle(row: PaddleRow): void {
  row.present = false;
  row.vx = 0;
  row.vy = 0;
  row.collided = false;
}

const pt = { x: 0, y: 0 };

function pushSeat(ctx: ReducerCtx, seat: Seat, from: SeatConnT, to: SeatConnT, tick: number): void {
  const w = ctx.world;
  seatPoint(w, seat, pt);
  ctx.queue.push({
    k: 'seat', seat, from, to, graceEndsAt: w.seats[seat].graceEndsAt,
    tick, seq: ctx.queue.nextSeq(), x: pt.x, y: pt.y, conf: 1, stale: false,
  });
}

function becomeConnected(ctx: ReducerCtx, seat: Seat, tick: number): void {
  const s = ctx.world.seats[seat];
  const from = s.conn;
  s.conn = SeatConn.Connected;
  s.leftCount = 0;
  s.graceEndsAt = NaN;
  s.everSeen = true;
  s.missingPaddleTicks = 0;
  if (from !== SeatConn.Connected) pushSeat(ctx, seat, from, SeatConn.Connected, tick);
}

function becomeGrace(ctx: ReducerCtx, seat: Seat, tick: number, graceEndsAt: number): void {
  const s = ctx.world.seats[seat];
  const from = s.conn;
  s.conn = SeatConn.Grace;
  s.ready = false;
  s.graceEndsAt = graceEndsAt;
  s.everSeen = true;
  if (from !== SeatConn.Grace) pushSeat(ctx, seat, from, SeatConn.Grace, tick);
}

function becomeEmpty(ctx: ReducerCtx, seat: Seat, tick: number): void {
  const s = ctx.world.seats[seat];
  const from = s.conn;
  s.conn = SeatConn.Empty;
  s.ready = false;
  s.graceEndsAt = NaN;
  s.missingPaddleTicks = 0;
  removePaddle(ctx.world.paddles[seat]);
  if (from !== SeatConn.Empty) pushSeat(ctx, seat, from, SeatConn.Empty, tick);
}

/** Listed players are Connected with their score; a paddle with no player is a Grace seat whose deadline and
 *  score are unknown (a late joiner). No events. */
export function seatsFromInitial(ctx: ReducerCtx, msg: InitialState): void {
  const w = ctx.world;
  for (const p of msg.paddles) setPaddleFromWire(w.paddles[p.index as Seat], p);
  for (const pl of msg.players) {
    const s = w.seats[pl.index as Seat];
    s.conn = SeatConn.Connected;
    s.score = pl.score;
    s.scoreKnown = true;
    s.graceEndsAt = NaN;
    s.everSeen = true;
    s.leftCount = 0;
    s.missingPaddleTicks = 0;
  }
  for (const p of msg.paddles) {
    const s = w.seats[p.index as Seat];
    if (s.conn === SeatConn.Connected) continue;
    s.conn = SeatConn.Grace;
    s.scoreKnown = false;
    s.graceEndsAt = NaN;
    s.everSeen = true;
    s.leftCount = 1;
  }
}

export function seatOnJoined(ctx: ReducerCtx, m: PlayerJoined, tick: number): void {
  const w = ctx.world;
  const seat = m.player.index as Seat;
  const s = w.seats[seat];
  setPaddleFromWire(w.paddles[seat], m.paddle);
  // A returning (Grace) or refreshed (Connected) player keeps a known score; a new player starts unknown.
  const fromScore = s.conn !== SeatConn.Empty && s.scoreKnown ? s.score : null;
  if (s.conn === SeatConn.Empty) s.ready = false;
  becomeConnected(ctx, seat, tick);
  const to = m.player.score;
  s.score = to;
  s.scoreKnown = true;
  if (fromScore !== to) {
    seatPoint(w, seat, pt);
    ctx.queue.push({
      k: 'score', seat, from: fromScore, to, delta: fromScore === null ? 0 : to - fromScore, cause: 'join',
      tick, seq: ctx.queue.nextSeq(), x: pt.x, y: pt.y, conf: 1, stale: false,
    });
  }
}

export function seatOnLeft(ctx: ReducerCtx, m: PlayerLeft, tick: number): void {
  const seat = m.index as Seat;
  const s = ctx.world.seats[seat];
  s.leftCount++;
  if (s.conn === SeatConn.Connected) {
    becomeGrace(ctx, seat, tick, ctx.nowMs + GRACE_MS);
  } else if (s.conn === SeatConn.Grace) {
    becomeEmpty(ctx, seat, tick);
    const sc = ctx.scratch;
    sc.goneMask |= 1 << seat;
    // Where the grace expiry sits in the items, so R7 can tell the removals it causes (listed after it) apart.
    sc.goneTick[seat] = tick;
    sc.goneOrd[seat] = sc.ord;
  }
}

export function seatOnLobby(ctx: ReducerCtx, m: LobbyState, tick: number): void {
  const w = ctx.world;
  let listed = 0;
  for (const p of m.players) {
    const seat = p.index as Seat;
    listed |= 1 << seat;
    becomeConnected(ctx, seat, tick);
    w.seats[seat].ready = p.isReady;
  }
  for (let i = 0; i < 4; i++) {
    const seat = i as Seat;
    if ((listed & (1 << i)) === 0 && w.seats[seat].conn === SeatConn.Connected) {
      becomeGrace(ctx, seat, tick, ctx.nowMs + GRACE_MS);
    }
  }
}

/** Writes the paddle row. An update for an Empty seat heals a missed join into Grace. */
export function seatOnPaddle(ctx: ReducerCtx, m: PaddlePositionUpdate, tick: number): void {
  const w = ctx.world;
  const seat = m.index as Seat;
  setPaddleFromWire(w.paddles[seat], m);
  const s = w.seats[seat];
  s.missingPaddleTicks = 0;
  if (s.conn === SeatConn.Empty) becomeGrace(ctx, seat, tick, NaN);
}

/** A Grace seat whose paddle got no update for missingPaddleTicks consecutive ticks is gone. */
export function seatTickSafety(ctx: ReducerCtx, seenMask: number, tick: number): void {
  const w = ctx.world;
  const limit = ctx.tuning.derive.missingPaddleTicks;
  for (let i = 0; i < 4; i++) {
    if ((seenMask & (1 << i)) !== 0) continue;
    const seat = i as Seat;
    if (!w.paddles[seat].present) continue;
    const s = w.seats[seat];
    s.missingPaddleTicks++;
    if (s.conn === SeatConn.Grace && s.missingPaddleTicks >= limit) becomeEmpty(ctx, seat, tick);
  }
}
