import { describe, expect, it } from 'vitest';
import { SLICE_WRITERS, initialAppState } from './appStore';
import { SEATS } from '../game/orientation';
import { SeatConn } from '../game/events';

describe('appStore', () => {
  it('names exactly one writer module for every slice', () => {
    expect(Object.keys(SLICE_WRITERS).sort()).toEqual(Object.keys(initialAppState()).sort());
    for (const path of Object.values(SLICE_WRITERS)) expect(path).toMatch(/^src\/[\w/]+\.tsx?$/);
  });

  it('starts idle with four empty seats named from the seat table', () => {
    const s = initialAppState();
    expect(s.session.s).toBe('idle');
    s.seats.forEach((seat, i) => {
      expect(seat).toMatchObject({ index: i, conn: SeatConn.Empty, score: null, isMe: false, name: SEATS[i].name, color: SEATS[i].color, glyph: SEATS[i].glyph });
      expect(seat.graceEndsAt).toBeNaN();
    });
    expect(initialAppState()).not.toBe(s);
    expect(initialAppState().seats[0]).not.toBe(s.seats[0]);
  });
});
