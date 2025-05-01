// File: src/hooks/usePlayerRotation.ts
import { useMemo } from 'react';

/**
 * Calculates the canvas rotation angle based on the player's index.
 * Player 0: Top-left (needs 90 deg rotation)
 * Player 1: Top-right (needs 180 deg rotation)
 * Player 2: Bottom-right (needs 270 deg rotation)
 * Player 3: Bottom-left (needs 0 deg rotation - default view)
 * Null/Undefined index: Default 0 deg rotation.
 *
 * @param playerIndex The index assigned to the player (0-3) or null/undefined.
 * @returns The rotation angle in degrees.
 */
export function usePlayerRotation(playerIndex: number | null | undefined): number {
  const rotationDegrees = useMemo(() => {
    if (playerIndex === null || playerIndex === undefined) {
      return 0; // Default rotation if no index assigned yet
    }
    // Calculate rotation so player's paddle is at the bottom
    // Base rotation seems to be player 3 at 0 degrees.
    // Player 0 needs +90, Player 1 needs +180, Player 2 needs +270
    // Let's adjust the formula slightly for clarity:
    // Player 3 (index 3) -> 0 deg
    // Player 0 (index 0) -> 90 deg
    // Player 1 (index 1) -> 180 deg
    // Player 2 (index 2) -> 270 deg
    // Formula: (3 - playerIndex + 1) * 90 mod 360 ? No...
    // Let's try direct mapping or a simpler formula.
    // If player 3 is 0 deg, then:
    // Player 0 is (0+1)*90 = 90
    // Player 1 is (1+1)*90 = 180
    // Player 2 is (2+1)*90 = 270
    // Player 3 is (3+1)*90 = 360 -> 0
    // Formula: ((playerIndex + 1) % 4) * 90 seems correct. Let's test.
    // P0: (0+1)%4 * 90 = 90
    // P1: (1+1)%4 * 90 = 180
    // P2: (2+1)%4 * 90 = 270
    // P3: (3+1)%4 * 90 = 0
    // This looks right. Let's use this.
    // Original code used: (360 + 90 + playerIndex * 90) % 360
    // P0: (360 + 90 + 0) % 360 = 450 % 360 = 90
    // P1: (360 + 90 + 90) % 360 = 540 % 360 = 180
    // P2: (360 + 90 + 180) % 360 = 630 % 360 = 270
    // P3: (360 + 90 + 270) % 360 = 720 % 360 = 0
    // Both formulas yield the same result. Let's stick to the original for consistency.
    return (360 + 90 + playerIndex * 90) % 360;
  }, [playerIndex]);

  return rotationDegrees;
}
