import { afterEach, describe, expect, it, vi } from 'vitest';
import { decode } from './decode';
import type { Decoded } from './decode';
import type { BatchItem, ServerMessage } from '../protocol/messages';
import { FIXTURES, loadFixture } from '../test/fixtures/load';

const ballPos = (id: number, over: Record<string, unknown> = {}) => ({
  messageType: 'ballPositionUpdate', id, x: 100, y: 200, r3fX: -350, r3fY: 250, vx: 5, vy: -5, collided: false, phasing: false, ...over,
});
const wireBall = (id: number, ownerIndex: number) => ({
  x: 450, y: 450, vx: 5, vy: 5, radius: 8, id, ownerIndex, phasing: false, mass: 1, isPermanent: true, collided: false,
});
const wirePaddle = (index: number) => ({ x: 875, y: 375, width: 25, height: 150, index, vx: 0, vy: 0, isMoving: false, collided: false });
const wirePlayer = (index: number) => ({ index, id: `p${index}`, color: [1, 2, 3], score: 0 });
const batch = (updates: unknown): string => JSON.stringify({ messageType: 'gameUpdates', updates });

function ok(d: Decoded): { msg: ServerMessage; dropped: number } {
  if (!d.ok) throw new Error(`expected ok, got: ${d.detail}`);
  return d;
}

function updatesOf(d: Decoded): { items: BatchItem[]; dropped: number } {
  const r = ok(d);
  if (r.msg.messageType !== 'gameUpdates') throw new Error(`expected gameUpdates, got ${r.msg.messageType}`);
  return { items: r.msg.updates, dropped: r.dropped };
}

describe('decode', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('decodes every recorded fixture frame, dropping nothing', () => {
    const names = Object.keys(FIXTURES);
    for (const required of ['quick-solo', 'lobby-2p', 'grace', 'late-join', 'rejections', 'game-over']) {
      expect(names, `fixture ${required}`).toContain(required);
    }
    for (const [name, raw] of Object.entries(FIXTURES)) {
      let decoded = 0;
      let dropped = 0;
      for (const frame of loadFixture(raw)) {
        if (frame.dir !== 'in') continue;
        const d = decode(frame.d);
        expect(d.ok, `${name} at t=${frame.t}: ${d.ok ? '' : d.detail}`).toBe(true);
        if (d.ok) {
          decoded++;
          dropped += d.dropped;
        }
      }
      expect(decoded, `${name}: inbound frames`).toBeGreaterThan(0);
      // The server never sends null entries or malformed items, so a recorded frame loses nothing.
      expect(dropped, `${name}: dropped`).toBe(0);
    }
  });

  it('rejects malformed JSON and non-object top levels', () => {
    for (const text of ['{"messageType":', '', 'NaN', '[]', 'null', '"gameUpdates"', '42']) {
      expect(decode(text).ok, text).toBe(false);
    }
  });

  it('rejects an unknown or missing messageType', () => {
    expect(decode('{"messageType":"hello"}')).toMatchObject({ ok: false });
    expect(decode('{"code":"ABC123"}')).toMatchObject({ ok: false });
  });

  it('drops a non-finite coordinate item and keeps the rest', () => {
    const text = batch([ballPos(1), ballPos(2, { x: 'NaN' }), ballPos(3, { y: null }), ballPos(4, { vx: '__INF__' }), ballPos(5)])
      .replace('"__INF__"', '1e999');
    const { items, dropped } = updatesOf(decode(text));
    expect(items.map((i) => (i.messageType === 'ballPositionUpdate' ? i.id : -1))).toEqual([1, 5]);
    expect(dropped).toBe(3);
  });

  it('turns "updates": null into [] and drops a null item', () => {
    expect(updatesOf(decode(batch(null)))).toEqual({ items: [], dropped: 0 });
    const { items, dropped } = updatesOf(decode(batch([null, ballPos(7), null])));
    expect(items).toHaveLength(1);
    expect(dropped).toBe(2);
  });

  it('keeps the owner value -1 in newOwnerIndex, ownerIndex and winnerIndex', () => {
    const { items } = updatesOf(decode(batch([
      { messageType: 'ballOwnerChanged', id: 3, newOwnerIndex: -1 },
      { messageType: 'ballSpawned', ball: wireBall(9, -1), r3fX: 0, r3fY: 0 },
    ])));
    expect(items).toHaveLength(2);

    const over = ok(decode(JSON.stringify({ messageType: 'gameOver', winnerIndex: -1, finalScores: [1, 1, 0, 0], reason: 'tie', roomPID: 'pid' })));
    expect(over.msg).toMatchObject({ messageType: 'gameOver', winnerIndex: -1 });

    const init = ok(decode(JSON.stringify({ messageType: 'initialPlayersAndBallsState', players: [], paddles: [], balls: [wireBall(1, -1)] })));
    expect(init.msg).toMatchObject({ balls: [{ ownerIndex: -1 }] });
  });

  it('drops out-of-range seat and owner fields', () => {
    const { items, dropped } = updatesOf(decode(batch([
      { messageType: 'scoreUpdate', index: 4, score: 1 },
      { messageType: 'scoreUpdate', index: -1, score: 1 },
      { messageType: 'scoreUpdate', index: 2, score: 1 },
      { messageType: 'ballOwnerChanged', id: 3, newOwnerIndex: 4 },
      { messageType: 'ballOwnerChanged', id: 3, newOwnerIndex: -2 },
      { messageType: 'playerLeft', index: 1.5 },
      { messageType: 'paddlePositionUpdate', ...wirePaddle(5), r3fX: 0, r3fY: 0 },
    ])));
    expect(items).toEqual([{ messageType: 'scoreUpdate', index: 2, score: 1 }]);
    expect(dropped).toBe(6);
  });

  it('calls JSON.parse exactly once', () => {
    const text = batch([ballPos(1), { messageType: 'scoreUpdate', index: 0, score: 3 }, { messageType: 'lobbyState', players: [{ index: 0, isReady: true }] }]);
    const spy = vi.spyOn(JSON, 'parse');
    expect(decode(text).ok).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('coerces booleans and normalises nested null arrays', () => {
    const { items } = updatesOf(decode(batch([
      ballPos(1, { collided: 1, phasing: 0 }),
      { messageType: 'lobbyState', players: null },
      { messageType: 'lobbyState', players: [null, { index: 1, isReady: 'yes' }] },
      { messageType: 'fullGridUpdate', cellSize: 50, bricks: null },
    ])));
    expect(items[0]).toMatchObject({ collided: true, phasing: false });
    expect(items[1]).toEqual({ messageType: 'lobbyState', players: [] });
    expect(items[2]).toEqual({ messageType: 'lobbyState', players: [{ index: 1, isReady: true }] });
    expect(items[3]).toEqual({ messageType: 'fullGridUpdate', cellSize: 50, bricks: [] });
  });

  it('drops a grid with a bad cell, an unknown item type and a lobby entry out of range', () => {
    const cell = { x: 0, y: 0, life: 1, type: 0 };
    const { items, dropped } = updatesOf(decode(batch([
      { messageType: 'fullGridUpdate', cellSize: 50, bricks: [cell, cell, cell, { ...cell, type: 3 }] },
      { messageType: 'fullGridUpdate', cellSize: 50, bricks: [cell, cell, cell, null] },
      { messageType: 'teleport', id: 1 },
      { messageType: 'lobbyState', players: [{ index: 7, isReady: true }] },
      { messageType: 'gameStarted' },
    ])));
    expect(items).toEqual([{ messageType: 'gameStarted' }]);
    expect(dropped).toBe(4);
  });

  it('drops a grid whose cell count is not a square, and does not pin the side to 18', () => {
    const grid = (n: number) => ({
      messageType: 'fullGridUpdate', cellSize: 50, bricks: Array.from({ length: n }, (_, i) => ({ x: i, y: 0, life: 1, type: 1 })),
    });
    const { items, dropped } = updatesOf(decode(batch([grid(3), grid(4), grid(323), grid(324), grid(325), grid(400)])));
    expect(items.map((i) => (i.messageType === 'fullGridUpdate' ? i.bricks.length : -1))).toEqual([4, 324, 400]);
    expect(dropped).toBe(3);
  });

  it('counts null lobby entries as dropped, and a dropped lobby item only once', () => {
    const { items, dropped } = updatesOf(decode(batch([
      { messageType: 'lobbyState', players: [null, { index: 0, isReady: true }, null] },
      { messageType: 'lobbyState', players: [null, { index: 9, isReady: true }] },
    ])));
    expect(items).toEqual([{ messageType: 'lobbyState', players: [{ index: 0, isReady: true }] }]);
    expect(dropped).toBe(3);
    // The count belongs to one frame: the next clean frame starts again from zero.
    expect(updatesOf(decode(batch([{ messageType: 'lobbyState', players: [{ index: 1, isReady: false }] }]))).dropped).toBe(0);
  });

  it('validates admission messages', () => {
    const failed = ok(decode(JSON.stringify({ messageType: 'roomJoined', success: false, roomPID: '', code: '', phase: '', reason: 'Room not found' })));
    expect(failed.msg).toMatchObject({ success: false, phase: '' });
    expect(decode(JSON.stringify({ messageType: 'roomJoined', success: 1, roomPID: 'p', code: 'ABC123', phase: 'lobby', reason: '' }))).toMatchObject({ ok: true, msg: { success: true } });
    expect(decode(JSON.stringify({ messageType: 'roomJoined', success: true, roomPID: 'p', code: 'ABC123', phase: 'waiting', reason: '' })).ok).toBe(false);
    expect(decode(JSON.stringify({ messageType: 'playerAssignment', playerIndex: 3, phase: 'playing' })).ok).toBe(true);
    expect(decode(JSON.stringify({ messageType: 'playerAssignment', playerIndex: 4, phase: 'playing' })).ok).toBe(false);
    expect(decode(JSON.stringify({ messageType: 'roomCreated', code: 'ABC123', roomPID: 'p' })).ok).toBe(true);
    expect(decode(JSON.stringify({ messageType: 'roomCreated', code: 7, roomPID: 'p' })).ok).toBe(false);
  });

  it('requires exactly 4 finite final scores and an owner-range winner', () => {
    const over = (o: Record<string, unknown>) => JSON.stringify({ messageType: 'gameOver', winnerIndex: 0, finalScores: [3, 1, 0, 0], reason: 'done', roomPID: 'p', ...o });
    expect(decode(over({})).ok).toBe(true);
    expect(decode(over({ finalScores: [3, 1, 0] })).ok).toBe(false);
    expect(decode(over({ finalScores: [3, 1, 0, 0, 0] })).ok).toBe(false);
    expect(decode(over({ finalScores: [3, 1, 0, null] })).ok).toBe(false);
    expect(decode(over({ winnerIndex: 4 })).ok).toBe(false);
    expect(decode(over({ winnerIndex: -2 })).ok).toBe(false);
  });

  it('fails an initial state with a bad entry, and drops null entries', () => {
    const init = (o: Record<string, unknown>) => JSON.stringify({ messageType: 'initialPlayersAndBallsState', players: [wirePlayer(0)], paddles: [wirePaddle(0)], balls: [wireBall(1, 0)], ...o });
    expect(ok(decode(init({}))).dropped).toBe(0);
    expect(ok(decode(init({ players: null, paddles: [null, wirePaddle(2)], balls: null })))).toMatchObject({ dropped: 1, msg: { players: [], balls: [] } });
    expect(decode(init({ paddles: [wirePaddle(4)] })).ok).toBe(false);
    expect(decode(init({ balls: [wireBall(1, 5)] })).ok).toBe(false);
    expect(decode(init({ players: [{ ...wirePlayer(0), score: 'x' }] })).ok).toBe(false);
  });
});
