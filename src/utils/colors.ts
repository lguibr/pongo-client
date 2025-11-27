
import theme from '../styles/theme'; // Import the theme

// Use colors defined in the theme for consistency
const GOOGLE_PLAYER_COLORS_MAP: { [key: number]: string } = {
  0: theme.colors.player0,
  1: theme.colors.player1,
  2: theme.colors.player2,
  3: theme.colors.player3,
};

const UNOWNED_BALL_COLOR = theme.colors.unownedBall;

// Fallback color (can also be from theme if defined)
const FALLBACK_COLOR = '#808080'; // Neutral Grey as a fallback

/**
 * Gets the color based on an owner index, primarily for Balls.
 * Indices 0-3 return the corresponding player color.
 * Any other index (e.g., -1, null, undefined, >3) is treated as "unowned".
 * @param ownerIndex The owner index (0-3 for players, other values mean unowned).
 * @returns The corresponding color hex string.
 */
export const getColorByOwnerIndex = (
  ownerIndex: number | null | undefined
): string => {
  if (
    ownerIndex !== null &&
    ownerIndex !== undefined &&
    ownerIndex >= 0 &&
    ownerIndex <= 3
  ) {
    return GOOGLE_PLAYER_COLORS_MAP[ownerIndex];
  }
  return UNOWNED_BALL_COLOR;
};

/**
 * Gets the paddle color strictly for player indices 0-3.
 * Logs an error and returns a fallback color for any other index.
 * @param playerIndex The player index (must be 0-3).
 * @returns The corresponding player color hex string.
 */
export const getPaddleColorByPlayerIndex = (playerIndex: number): string => {
  if (playerIndex >= 0 && playerIndex <= 3) {
    return GOOGLE_PLAYER_COLORS_MAP[playerIndex];
  }
  console.error(
    `getPaddleColorByPlayerIndex: Invalid player index ${playerIndex}. Must be 0-3. Using fallback color.`
  );
  return FALLBACK_COLOR;
};

/**
 * Gets the display name for a player based on their index (color).
 * @param index The player index.
 * @returns The color name (Blue, Green, Yellow, Red).
 */
export const getPlayerColorName = (index: number): string => {
  const names = ['Blue', 'Green', 'Yellow', 'Red'];
  return names[index % names.length];
};