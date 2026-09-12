// Results (5.12, C46, C58): seated players only (Connected or Grace at the end), Grace rows marked `left`,
// sorted by score, descending.

import type { Owner, Seat } from './events';
import { SeatConn } from './events';
import type { World } from './types';
import type { ResultRow, ResultsView } from '../state/appStore';
import type { GameOver } from '../protocol/messages';

function seated(w: Readonly<World>): Seat[] {
  const seats: Seat[] = [];
  for (let i = 0; i < 4; i++) {
    const c = w.seats[i].conn;
    if (c === SeatConn.Connected || c === SeatConn.Grace) seats.push(i as Seat);
  }
  return seats;
}

function sortRows(rows: ResultRow[]): ResultRow[] {
  return rows.sort((a, b) => b.score - a.score || a.index - b.index);
}

export function resultsFromGameOver(msg: GameOver, w: Readonly<World>): ResultsView {
  const winner = msg.winnerIndex as Owner;
  let seats = seated(w);
  if (seats.length === 0) {
    // The world lost its seats (a reset raced the message): fall back to the seats the message names.
    seats = ([0, 1, 2, 3] as Seat[]).filter((i) => msg.finalScores[i] !== 0 || i === winner || i === w.myIndex);
  }
  const rows = seats.map((i): ResultRow => ({
    index: i, score: msg.finalScores[i], left: w.seats[i].conn === SeatConn.Grace,
    isMe: w.myIndex === i, winner: winner === i,
  }));
  return { winner, rows: sortRows(rows), reason: msg.reason, derived: false };
}

/** The winner is the highest score among Connected seats, and a tie gives -1, exactly as the server computes
 *  it (game_actor_lifecycle.go:176-193). */
export function derivedResults(w: Readonly<World>, reason: string): ResultsView {
  let winner: Owner = -1;
  let best = -Infinity;
  let tie = false;
  for (let i = 0; i < 4; i++) {
    const s = w.seats[i];
    if (s.conn !== SeatConn.Connected) continue;
    if (s.score > best) {
      best = s.score;
      winner = i as Seat;
      tie = false;
    } else if (s.score === best) {
      tie = true;
    }
  }
  if (tie) winner = -1;
  const rows = seated(w).map((i): ResultRow => ({
    index: i, score: w.seats[i].score, left: w.seats[i].conn === SeatConn.Grace,
    isMe: w.myIndex === i, winner: winner === i,
  }));
  return { winner, rows: sortRows(rows), reason, derived: true };
}
