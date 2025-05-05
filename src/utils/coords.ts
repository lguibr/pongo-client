// File: src/utils/coords.ts
// NEW FILE

/**
 * Maps original world coordinates (0,0 top-left) to R3F centered coordinates
 * (0,0 center, Y-up).
 * @param x Original X coordinate.
 * @param y Original Y coordinate.
 * @param canvasSize The size of the square canvas.
 * @returns An array containing [r3fX, r3fY].
 */
export function mapToR3FCoords(x: number, y: number, canvasSize: number): [number, number] {
  if (canvasSize <= 0) {
    console.warn('mapToR3FCoords called with invalid canvasSize:', canvasSize);
    return [0, 0]; // Return default coords if canvas size is invalid
  }
  const halfSize = canvasSize / 2.0;
  const r3fX = x - halfSize;
  const r3fY = -(y - halfSize); // Invert Y
  return [r3fX, r3fY];
}