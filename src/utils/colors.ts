// File: frontend/src/utils/colors.ts

// Defines the strict color mapping for player indices 0 through 3.
const GOOGLE_PLAYER_COLORS_MAP: { [key: number]: string } = {
  0: '#4285F4', // Player Index 0: Google Blue
  1: '#34A853', // Player Index 1: Google Green
  2: '#FBBC05', // Player Index 2: Google Yellow
  3: '#EA4335', // Player Index 3: Google Red
};

// Specific color for balls that do not have an owner.
const UNOWNED_BALL_COLOR = '#FFFFFF'; // White

// Fallback color for unexpected/invalid indices (e.g., if backend sends > 3).
const FALLBACK_COLOR = '#808080'; // Neutral Grey

/**
 * Gets the color based on an owner index, primarily for Balls.
 * Indices 0-3 return the corresponding player color (Blue, Green, Yellow, Red).
 * Any other index (e.g., -1, null, undefined, >3) is treated as "unowned" and returns White.
 * @param ownerIndex The owner index (0-3 for players, other values mean unowned).
 * @returns The corresponding color hex string.
 */
export const getColorByOwnerIndex = (ownerIndex: number | null | undefined): string => {
  if (ownerIndex !== null && ownerIndex !== undefined && ownerIndex >= 0 && ownerIndex <= 3) {
    // If index is 0, 1, 2, or 3, return the player color
    return GOOGLE_PLAYER_COLORS_MAP[ownerIndex];
  }
  // Otherwise, treat as unowned
  return UNOWNED_BALL_COLOR;
};

/**
 * Gets the paddle color strictly for player indices 0-3.
 * Logs an error and returns a fallback color for any other index.
 * @param playerIndex The player index (must be 0-3).
 * @returns The corresponding player color hex string (Blue, Green, Yellow, Red).
 */
export const getPaddleColorByPlayerIndex = (playerIndex: number): string => {
  if (playerIndex >= 0 && playerIndex <= 3) {
    return GOOGLE_PLAYER_COLORS_MAP[playerIndex];
  }
  // Paddles must belong to players 0-3.
  console.error(`getPaddleColorByPlayerIndex: Invalid player index ${playerIndex}. Must be 0-3. Using fallback color.`);
  return FALLBACK_COLOR; // Return fallback grey for unexpected cases
};