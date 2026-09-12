import { describe, expect, it } from 'vitest';
import { derivedResults, resultsFromGameOver } from './results';
import { createWorld } from './world';
import { SeatConn } from './events';
import type { GameOver } from '../protocol/messages';
import type { World } from './types';

function world(conns: [number, number][], myIndex: 0 | 1 | 2 | 3 | null = null): World {
  const w = createWorld();
  w.myIndex = myIndex;
  conns.forEach(([conn, score], i) => {
    w.seats[i].conn = conn as World['seats'][0]['conn'];
    w.seats[i].score = score;
  });
  return w;
}

const gameOver = (winnerIndex: number, finalScores: [number, number, number, number]): GameOver => ({
  messageType: 'gameOver', winnerIndex, finalScores, reason: 'All bricks destroyed', roomPID: 'actor-1',
});

describe('results (5.12)', () => {
  it('lists seated players only, sorted by score, with Grace seats marked left', () => {
    const w = world([[SeatConn.Connected, 0], [SeatConn.Empty, 0], [SeatConn.Grace, 0], [SeatConn.Connected, 0]], 3);
    const r = resultsFromGameOver(gameOver(3, [4, 9, 2, 11]), w);
    expect(r.rows.map((x) => [x.index, x.score, x.left, x.isMe, x.winner])).toEqual([
      [3, 11, false, true, true], [0, 4, false, false, false], [2, 2, true, false, false],
    ]);
    expect(r.winner).toBe(3);
    expect(r.derived).toBe(false);
    expect(r.reason).toBe('All bricks destroyed');
  });

  it('derives the winner among Connected seats only, as the server does', () => {
    const w = world([[SeatConn.Connected, 5], [SeatConn.Grace, 20], [SeatConn.Connected, 7], [SeatConn.Empty, 30]]);
    const r = derivedResults(w, 'All bricks destroyed');
    expect(r.winner).toBe(2);
    expect(r.derived).toBe(true);
    expect(r.rows.map((x) => x.index)).toEqual([1, 2, 0]);
  });

  it('gives -1 for a derived tie', () => {
    const w = world([[SeatConn.Connected, 6], [SeatConn.Connected, 6], [SeatConn.Connected, 2], [SeatConn.Empty, 0]]);
    const r = derivedResults(w, 'x');
    expect(r.winner).toBe(-1);
    expect(r.rows.some((x) => x.winner)).toBe(false);
  });
});
