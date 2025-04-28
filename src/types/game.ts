// File: frontend/src/types/game.ts

// These interfaces should mirror the JSON structure sent by the Go backend's GameState

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

export type Grid = Cell[][];

export interface Canvas {
  grid: Grid;
  width: number;
  height: number;
  gridSize: number;
  canvasSize: number;
  cellSize: number;
}

// Simplified Player info sent in GameState
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
  direction: string; // Internal backend state ("left", "right", "")
  vx: number; // Current horizontal velocity
  vy: number; // Current vertical velocity
}

export interface Ball {
  x: number; // Center X coordinate
  y: number; // Center Y coordinate
  vx: number; // Velocity X
  vy: number; // Velocity Y
  radius: number;
  id: number; // Unique ID
  ownerIndex: number; // Owning player index (0-3) or potentially another value (e.g., -1) if unowned.
  phasing: boolean; // If true, ignores brick collisions temporarily
  mass: number;
  isPermanent: boolean;
}

// Represents the overall state received from the backend WebSocket
export interface GameState {
  canvas: Canvas | null;
  // Note: Frontend assumes 0-based indexing for players/paddles (0=Blue, 1=Green, etc.)
  // The backend might use 1-based indexing in its arrays (index 0 null).
  // Frontend components rely on the 'index' field within Player/Paddle objects.
  players: (Player | null)[];
  paddles: (Paddle | null)[];
  balls: (Ball | null)[];
}

// Message sent from frontend to backend for paddle movement
export interface DirectionMessage {
  direction: "ArrowLeft" | "ArrowRight" | "Stop";
}