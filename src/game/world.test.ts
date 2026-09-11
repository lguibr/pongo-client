import { describe, expect, it, vi } from 'vitest';
import { allocSlot, createWorld, freeSlot, graceSeats, resetWorld } from './world';
import { SeatConn } from './events';
import { CELLS, CellType, MAX_BALLS } from '../config/constants';

describe('world', () => {
  it('starts with every slot free and every cell empty', () => {
    const w = createWorld();
    expect(w.balls).toHaveLength(MAX_BALLS);
    expect(w.balls.every((b) => !b.live && b.removedTick === -1 && b.id === -1)).toBe(true);
    expect(w.brickType).toHaveLength(CELLS);
    expect(w.brickType.every((t) => t === CellType.Empty)).toBe(true);
    expect(w.gridKnown).toBe(false);
  });

  it('allocates the lowest free slot and binds the id', () => {
    const w = createWorld();
    expect(allocSlot(w, 101)).toBe(0);
    expect(allocSlot(w, 102)).toBe(1);
    expect(w.slotById.get(102)).toBe(1);
    expect(w.balls[1].live).toBe(true);
    expect(allocSlot(w, 101)).toBe(0);   // a live id keeps its slot
    freeSlot(w, 0);
    expect(w.slotById.has(101)).toBe(false);
    expect(allocSlot(w, 103)).toBe(0);
  });

  it('never reuses a slot that is waiting to be freed after a removal', () => {
    const w = createWorld();
    allocSlot(w, 1);
    w.balls[0].live = false;
    w.balls[0].removedTick = 12;
    expect(allocSlot(w, 2)).toBe(1);
    expect(w.balls[0].id).toBe(1);
  });

  it('returns -1 when full and warns once', () => {
    const w = createWorld();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (let i = 0; i < MAX_BALLS; i++) expect(allocSlot(w, i + 1)).toBe(i);
    expect(allocSlot(w, 999)).toBe(-1);
    expect(allocSlot(w, 1000)).toBe(-1);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('resetWorld clears the epoch state and bumps the brick version', () => {
    const w = createWorld();
    allocSlot(w, 5);
    w.seats[2].conn = SeatConn.Connected;
    w.seats[2].score = 9;
    w.paddles[2].present = true;
    w.brickType[40] = CellType.Brick;
    w.brickLife[40] = 3;
    w.gridKnown = true;
    w.tick = 88;
    const v = w.brickVersion;
    resetWorld(w, 4, 2);
    expect(w.epoch).toBe(4);
    expect(w.myIndex).toBe(2);
    expect(w.tick).toBe(0);
    expect(w.slotById.size).toBe(0);
    expect(w.balls[0].live).toBe(false);
    expect(w.seats[2].conn).toBe(SeatConn.Empty);
    expect(w.seats[2].score).toBe(0);
    expect(w.paddles[2].present).toBe(false);
    expect(w.brickType[40]).toBe(CellType.Empty);
    expect(w.brickLife[40]).toBe(0);
    expect(w.gridKnown).toBe(false);
    expect(w.brickVersion).toBeGreaterThan(v);
  });

  it('counts Grace seats other than my own', () => {
    const w = createWorld();
    w.myIndex = 1;
    w.seats[0].conn = SeatConn.Grace;
    w.seats[1].conn = SeatConn.Grace;
    w.seats[3].conn = SeatConn.Connected;
    expect(graceSeats(w)).toBe(1);
  });
});
