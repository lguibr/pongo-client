// The single seat table (C64, C98), derived from pongo/game/paddle.go:37-80,83-123 and the walls at
// game_actor_physics.go:42-56. "Left" is canvas -Y for vertical paddles and -X for horizontal ones.
// The rotation (3 - i) * 90 degrees counter-clockwise puts every player's own wall at the bottom of the screen.

import type { Seat } from './events';
import type { Visual } from '../input/types';
import type { WireDirection } from '../protocol/messages';

export interface SeatInfo {
  index: Seat; wall: 'right' | 'top' | 'left' | 'bottom'; axis: 'vertical' | 'horizontal';
  rotationDeg: 0 | 90 | 180 | 270; swap: boolean;
  color: string; name: 'Blue' | 'Green' | 'Yellow' | 'Red'; glyph: '◆' | '▲' | '●' | '■';
}
export const SEATS: readonly [SeatInfo, SeatInfo, SeatInfo, SeatInfo] = [
  { index: 0, wall: 'right',  axis: 'vertical',   rotationDeg: 270, swap: true,  color: '#3b82f6', name: 'Blue',   glyph: '◆' },
  { index: 1, wall: 'top',    axis: 'horizontal', rotationDeg: 180, swap: true,  color: '#22c55e', name: 'Green',  glyph: '▲' },
  { index: 2, wall: 'left',   axis: 'vertical',   rotationDeg: 90,  swap: false, color: '#eab308', name: 'Yellow', glyph: '●' },
  { index: 3, wall: 'bottom', axis: 'horizontal', rotationDeg: 0,   swap: false, color: '#ef4444', name: 'Red',    glyph: '■' },
];

export function isSeat(n: number): n is Seat {
  return n === 0 || n === 1 || n === 2 || n === 3;
}

/** 0 or null seat -> 'Stop'; swap -> negate. */
export function toWire(seat: Seat | null, visual: Visual): WireDirection {
  if (seat === null || visual === 0) return 'Stop';
  const v = SEATS[seat].swap ? -visual : visual;
  return v < 0 ? 'ArrowLeft' : 'ArrowRight';
}

/** 0 when null. */
export function rotationRad(seat: Seat | null): number {
  return seat === null ? 0 : (SEATS[seat].rotationDeg * Math.PI) / 180;
}

/** Canvas px (origin top left, +y down) to board space (origin at the centre, +y up). */
export function canvasToBoard(x: number, y: number, canvas: number, out: { x: number; y: number }): void {
  const half = canvas / 2;
  out.x = x - half;
  out.y = half - y;
}

/** Rotates board space by rotationRad(seat) counter-clockwise, exactly (quarter turns, no trigonometry). */
export function boardToView(seat: Seat | null, bx: number, by: number, out: { x: number; y: number }): void {
  switch (seat === null ? 0 : SEATS[seat].rotationDeg) {
    case 90:
      out.x = -by;
      out.y = bx;
      return;
    case 180:
      out.x = -bx;
      out.y = -by;
      return;
    case 270:
      out.x = by;
      out.y = -bx;
      return;
    default:
      out.x = bx;
      out.y = by;
  }
}

/** Outward, board space. */
export function wallNormal(wall: Seat, out: { x: number; y: number }): void {
  switch (wall) {
    case 0:
      out.x = 1;
      out.y = 0;
      return;
    case 1:
      out.x = 0;
      out.y = 1;
      return;
    case 2:
      out.x = -1;
      out.y = 0;
      return;
    case 3:
      out.x = 0;
      out.y = -1;
  }
}
