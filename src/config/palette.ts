// Player, brick-life, UI and HDR constants (C63). Brick colours keep an OKLab distance of at least 0.07
// from every player colour (palette.test.ts), so a brick never reads as a seat.

export const PLAYER_COLORS = ['#3b82f6', '#22c55e', '#eab308', '#ef4444'] as const; // Blue, Green, Yellow, Red
export const BRICK_LIFE_COLORS = ['#64748b', '#22d3ee', '#818cf8', '#a78bfa', '#e879f9', '#f9a8d4', '#f5f5f4'] as const; // life 1..7
export const COLORS = {
  background: '#09090b', floor: '#0b0b10', gridLine: '#1c1c24', wallEmpty: '#3f3f46',
  unownedBall: '#bdbdbd', phase: '#a855f7', gold: '#fbbf24', danger: '#ef4444', success: '#22c55e',
} as const;
/** Linear multipliers. Only HDR elements exceed 1.0, so threshold bloom at 1.0 is selective (D10). */
export const HDR = {
  ballCore: 2.2, ballCoreUnowned: 0.9, spark: 3.0, ring: 2.5, trail: 1.6, flashPeak: 3.0,
  paddleEdge: 1.4, shell: 2.0, halo: 1.2, brickMax: 0.85, wallMax: 0.9, floorMax: 0.6,
  lowBitScale: 0.6, // multiply every HDR constant when the composer falls back to UnsignedByte buffers
} as const;

/** Clamps life to 1..7 (a non-finite life reads as 1). */
export function lifeColor(life: number): string {
  const level = Number.isFinite(life) ? Math.min(BRICK_LIFE_COLORS.length, Math.max(1, Math.round(life))) : 1;
  return BRICK_LIFE_COLORS[level - 1];
}
