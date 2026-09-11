import { describe, expect, it } from 'vitest';
import { SEATS, boardToView, canvasToBoard, isSeat, rotationRad, toWire, wallNormal } from './orientation';
import type { Seat } from './events';
import type { Visual } from '../input/types';
import type { WireDirection } from '../protocol/messages';
import { CANVAS, PADDLE_LEN, PADDLE_STEP, PADDLE_THICK } from '../config/constants';
import { PLAYER_COLORS } from '../config/palette';

const ALL: readonly Seat[] = [0, 1, 2, 3];

/** Paddle start centre in canvas px: the top-left corner from pongo/game/paddle.go:51-70 plus half the size. */
function startCentre(seat: Seat): { x: number; y: number } {
  const vertical = seat === 0 || seat === 2;
  const w = vertical ? PADDLE_THICK : PADDLE_LEN;
  const h = vertical ? PADDLE_LEN : PADDLE_THICK;
  const corner = [
    { x: CANVAS - w, y: (CANVAS - h) / 2 },
    { x: (CANVAS - w) / 2, y: 0 },
    { x: 0, y: (CANVAS - h) / 2 },
    { x: (CANVAS - w) / 2, y: CANVAS - h },
  ][seat];
  return { x: corner.x + w / 2, y: corner.y + h / 2 };
}

/** The server's move rule (paddle.go:89-116): "left" is canvas -Y for vertical paddles, -X for horizontal. */
function canvasStep(seat: Seat, d: WireDirection): { dx: number; dy: number } {
  const sign = d === 'ArrowLeft' ? -1 : d === 'ArrowRight' ? 1 : 0;
  return seat === 0 || seat === 2 ? { dx: 0, dy: sign * PADDLE_STEP } : { dx: sign * PADDLE_STEP, dy: 0 };
}

function toView(seat: Seat | null, x: number, y: number): { x: number; y: number } {
  const b = { x: 0, y: 0 };
  const v = { x: 0, y: 0 };
  canvasToBoard(x, y, CANVAS, b);
  boardToView(seat, b.x, b.y, v);
  return v;
}

describe('orientation', () => {
  for (const seat of ALL) {
    it(`seat ${seat}: the rotated own paddle is at the bottom of the screen`, () => {
      const c = startCentre(seat);
      const v = toView(seat, c.x, c.y);
      expect(v.x).toBeCloseTo(0, 9);
      expect(v.y).toBeCloseTo(-(CANVAS / 2 - PADDLE_THICK / 2), 9);
    });

    it(`seat ${seat}: visual left moves the paddle toward screen left, visual right toward screen right`, () => {
      const c = startCentre(seat);
      const before = toView(seat, c.x, c.y);
      for (const visual of [-1, 1] as const satisfies readonly Visual[]) {
        const s = canvasStep(seat, toWire(seat, visual));
        const after = toView(seat, c.x + s.dx, c.y + s.dy);
        expect(Math.sign(after.x - before.x)).toBe(visual);
        expect(after.y - before.y).toBeCloseTo(0, 9);
      }
    });

    it(`seat ${seat}: boardToView is the rotation by rotationRad`, () => {
      const a = rotationRad(seat);
      const v = { x: 0, y: 0 };
      boardToView(seat, 123, -45, v);
      expect(v.x).toBeCloseTo(123 * Math.cos(a) + 45 * Math.sin(a), 9);
      expect(v.y).toBeCloseTo(123 * Math.sin(a) - 45 * Math.cos(a), 9);
    });

    it(`seat ${seat}: the wall normal points outward, through the own paddle`, () => {
      const c = startCentre(seat);
      const b = { x: 0, y: 0 };
      const n = { x: 0, y: 0 };
      canvasToBoard(c.x, c.y, CANVAS, b);
      wallNormal(seat, n);
      expect(Math.hypot(n.x, n.y)).toBe(1);
      expect(b.x * n.x + b.y * n.y).toBeCloseTo(CANVAS / 2 - PADDLE_THICK / 2, 9);
    });
  }

  it('toWire: a null seat and visual 0 give Stop; seats 0 and 1 swap', () => {
    expect(toWire(null, -1)).toBe('Stop');
    expect(toWire(null, 1)).toBe('Stop');
    for (const seat of ALL) expect(toWire(seat, 0)).toBe('Stop');
    expect(toWire(0, -1)).toBe('ArrowRight');
    expect(toWire(1, -1)).toBe('ArrowRight');
    expect(toWire(2, -1)).toBe('ArrowLeft');
    expect(toWire(3, -1)).toBe('ArrowLeft');
    expect(toWire(0, 1)).toBe('ArrowLeft');
    expect(toWire(3, 1)).toBe('ArrowRight');
  });

  it('the seat table matches the palette and the rotation rule', () => {
    SEATS.forEach((info, i) => {
      expect(info.index).toBe(i);
      expect(info.color).toBe(PLAYER_COLORS[i]);
      expect(info.rotationDeg).toBe((3 - i) * 90);
    });
  });

  it('rotationRad is 0 without a seat, and boardToView leaves the point unrotated', () => {
    expect(rotationRad(null)).toBe(0);
    const v = { x: 0, y: 0 };
    boardToView(null, 7, -3, v);
    expect(v).toEqual({ x: 7, y: -3 });
  });

  it('canvasToBoard puts the origin at the centre with +y up', () => {
    const b = { x: 0, y: 0 };
    canvasToBoard(0, 0, CANVAS, b);
    expect(b).toEqual({ x: -450, y: 450 });
    canvasToBoard(900, 900, CANVAS, b);
    expect(b).toEqual({ x: 450, y: -450 });
  });

  it('isSeat accepts 0..3 only', () => {
    for (const n of [0, 1, 2, 3]) expect(isSeat(n)).toBe(true);
    for (const n of [-1, 4, 1.5, NaN]) expect(isSeat(n)).toBe(false);
  });
});
