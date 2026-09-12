import { describe, expect, it } from 'vitest';
import { BRICK_LIFE_COLORS, PLAYER_COLORS, lifeColor } from './palette';
import { oklabDistance } from '../lib/math';

describe('palette', () => {
  it('keeps the OKLab distance from every brick colour to every player colour at 0.07 or more', () => {
    for (const brick of BRICK_LIFE_COLORS) {
      for (const player of PLAYER_COLORS) {
        expect(oklabDistance(brick, player), `${brick} vs ${player}`).toBeGreaterThanOrEqual(0.07);
      }
    }
  });

  it('measures OKLab distance', () => {
    expect(oklabDistance('#3b82f6', '#3b82f6')).toBe(0);
    expect(oklabDistance('#000000', '#ffffff')).toBeCloseTo(1, 3);
    expect(oklabDistance('#fff', '#ffffff')).toBe(0);
    expect(oklabDistance('#22c55e', '#ef4444')).toBeCloseTo(oklabDistance('#ef4444', '#22c55e'), 12);
    expect(oklabDistance('red', '#ffffff')).toBeNaN();
  });

  it('lifeColor clamps life to 1..7', () => {
    expect(lifeColor(1)).toBe(BRICK_LIFE_COLORS[0]);
    expect(lifeColor(3)).toBe(BRICK_LIFE_COLORS[2]);
    expect(lifeColor(7)).toBe(BRICK_LIFE_COLORS[6]);
    expect(lifeColor(0)).toBe(BRICK_LIFE_COLORS[0]);
    expect(lifeColor(12)).toBe(BRICK_LIFE_COLORS[6]);
    expect(lifeColor(NaN)).toBe(BRICK_LIFE_COLORS[0]);
  });
});
