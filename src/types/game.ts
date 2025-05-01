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

export type Grid = (Cell | null)[][]; // Grid can contain null cells

export interface Canvas {
  grid: Grid;
  width: number; // Logical width (usually same as canvasSize)
  height: number; // Logical height (usually same as canvasSize)
  gridSize: number; // Number of cells per side (e.g., 20 for a 20x20 grid)
  canvasSize: number; // Logical dimension of the square canvas (e.g., 1000)
  cellSize: number; // Calculated size of each grid cell (canvasSize / gridSize)
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
  direction: string; // Internal backend state ("left", "right", "") - may not be needed by frontend display
  vx: number; // Current horizontal velocity
  vy: number; // Current vertical velocity (usually 0 for horizontal paddles)
  isMoving: boolean; // Reflects paddle movement state
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
}

// Represents the overall state received from the backend WebSocket
export interface GameState {
  canvas: Canvas | null;
  players: (Player | null)[]; // Array might contain null if a player slot is empty
  paddles: (Paddle | null)[]; // Array might contain null
  balls: (Ball | null)[];     // Array might contain null
}

// Message sent from frontend to backend for paddle movement
export interface DirectionMessage {
  direction: "ArrowLeft" | "ArrowRight" | "Stop";
}

// Message received from backend upon connection, indicating the client's player index
export interface PlayerAssignmentMessage {
  playerIndex: number; // The index assigned to this specific client (0-3)
}