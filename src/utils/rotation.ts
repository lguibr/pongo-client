// File: src/utils/rotation.ts
import { useMemo } from 'react';

/**
 * Calculates the canvas rotation angle (in degrees) based on the player's index
 * so that the player's assigned paddle always appears at the bottom of the screen.
 *
 * Backend Index Mapping:
 * Player 0: Right (+X)
 * Player 1: Top (+Y)
 * Player 2: Left (-X)
 * Player 3: Bottom (-Y)
 *
 * Required Rotation (to bring paddle to Bottom/-Y):
 * Player 0 (+X to -Y): Rotate +270 deg
 * Player 1 (+Y to -Y): Rotate +180 deg
 * Player 2 (-X to -Y): Rotate +90 deg
 * Player 3 (-Y to -Y): Rotate 0 deg
 *
 * @param playerIndex The index assigned to the player (0-3) or null/undefined.
 * @returns The rotation angle in degrees.
 */
export function usePlayerRotation(playerIndex: number | null | undefined): number {
  const rotationDegrees = useMemo(() => {
    if (playerIndex === null || playerIndex === undefined || playerIndex < 0 || playerIndex > 3) {
      return 0; // Default rotation if no index assigned yet or invalid
    }
    // Formula: (3 - playerIndex) * 90
    return (3 - playerIndex) * 90;
  }, [playerIndex]);

  return rotationDegrees;
}