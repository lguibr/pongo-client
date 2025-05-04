// File: src/types/game.ts

// These interfaces should mirror the JSON structure sent by the Go backend

// --- Static Grid/Canvas Info ---
export interface BrickData {
  type: number; // Corresponds to utils.CellType (0: brick, 1: block, 2: empty)
  life: number;
  level: number; // Score value of the brick when broken
}

export interface Cell {
  x: number; // Grid column index
  y: number; // Grid row index
  data: BrickData | null; // Can be null if cell is empty or data missing
}

export type Grid = (Cell | null)[][]; // Grid can contain null cells

// --- Dynamic State Elements ---
export interface Player {
  index: number; // Player index (0-3, corresponds to array index)
  id: string;
  color: [number, number, number]; // Backend RGB (frontend uses index for specific palette)
  score: number;
}

export interface Paddle {
  x: number; // Top-left X coordinate
  y: number; // Top-left Y coordinate
  width: number;
  height: number;
  index: number; // Player index (0-3, corresponds to array index)
  // direction: string; // Internal backend state - removed from frontend type
  vx: number; // Current horizontal velocity
  vy: number; // Current vertical velocity
  isMoving: boolean; // Reflects paddle movement state
  collided: boolean; // Indicates if the paddle has collided with a ball
}

export interface Ball {
  x: number; // Center X coordinate
  y: number; // Center Y coordinate
  vx: number; // Velocity X
  vy: number; // Velocity Y
  radius: number;
  id: number; // Unique ID
  ownerIndex: number; // Owning player index (0-3) or another value (e.g., -1) if unowned.
  phasing: boolean; // If true, ignores brick collisions temporarily
  mass: number;
  isPermanent: boolean;
  collided: boolean; // Indicates if the ball has collided with something
}

// --- WebSocket Message Types ---

// Message sent from frontend to backend for paddle movement
export interface DirectionMessage {
  direction: 'ArrowLeft' | 'ArrowRight' | 'Stop';
}

// Message received from backend upon connection, indicating the client's player index
export interface PlayerAssignmentMessage {
  messageType: 'playerAssignment'; // Type identifier
  playerIndex: number; // The index assigned to this specific client (0-3)
}

// Message received from backend upon connection, providing static layout
export interface InitialGridStateMessage {
  messageType: 'initialGridState'; // Type identifier
  canvasWidth: number;
  canvasHeight: number;
  gridSize: number;
  cellSize: number;
  grid: Grid; // The initial static grid layout
}

// Represents the dynamic game state update received from the backend WebSocket
export interface GameStateUpdateMessage {
  messageType: 'gameStateUpdate'; // Type identifier
  players: (Player | null)[]; // Array might contain null if a player slot is empty
  paddles: (Paddle | null)[]; // Array might contain null
  balls: (Ball | null)[]; // Array might contain null
}

// Message received when the game ends
export interface GameOverMessage {
  messageType: 'gameOver'; // Type identifier
  winnerIndex: number; // Index of the winning player (-1 if draw/no winner)
  finalScores: number[]; // Final scores of all players (adjust if backend sends [4]int32)
  reason: string; // e.g., "All bricks destroyed"
  roomPid: string; // PID of the game room that ended
}

// Type guard for PlayerAssignmentMessage
export function isPlayerAssignment(
  data: unknown
): data is PlayerAssignmentMessage {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as PlayerAssignmentMessage).messageType === 'playerAssignment' &&
    typeof (data as PlayerAssignmentMessage).playerIndex === 'number'
  );
}

// Type guard for InitialGridStateMessage
export function isInitialGridState(
  data: unknown
): data is InitialGridStateMessage {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as InitialGridStateMessage).messageType === 'initialGridState' &&
    typeof (data as InitialGridStateMessage).canvasWidth === 'number' &&
    typeof (data as InitialGridStateMessage).gridSize === 'number' &&
    Array.isArray((data as InitialGridStateMessage).grid)
  );
}

// Type guard for GameStateUpdateMessage
export function isGameStateUpdate(
  data: unknown
): data is GameStateUpdateMessage {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as GameStateUpdateMessage).messageType === 'gameStateUpdate' &&
    Array.isArray((data as GameStateUpdateMessage).players) &&
    Array.isArray((data as GameStateUpdateMessage).paddles) &&
    Array.isArray((data as GameStateUpdateMessage).balls)
  );
}

// Type guard for GameOverMessage
export function isGameOver(data: unknown): data is GameOverMessage {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as GameOverMessage).messageType === 'gameOver' &&
    typeof (data as GameOverMessage).winnerIndex === 'number' &&
    Array.isArray((data as GameOverMessage).finalScores)
  );
}

// Union type for all possible incoming messages
export type IncomingMessage =
  | PlayerAssignmentMessage
  | InitialGridStateMessage
  | GameStateUpdateMessage
  | GameOverMessage;