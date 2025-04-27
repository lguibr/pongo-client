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
  index: number;
  id: string;
  color: [number, number, number]; // RGB color array
  score: number;
}

export interface Paddle {
  x: number; // Top-left X coordinate
  y: number; // Top-left Y coordinate
  width: number;
  height: number;
  index: number; // Player index (0-3)
  direction: string; // Internal backend state ("left", "right", "")
  vx: number; // Current horizontal velocity (useful for frontend effects?)
  vy: number; // Current vertical velocity (useful for frontend effects?)
  // velocity field removed as it's internal backend config
}

export interface Ball {
  x: number; // Center X coordinate
  y: number; // Center Y coordinate
  vx: number; // Velocity X
  vy: number; // Velocity Y
  radius: number;
  id: number; // Unique ID
  ownerIndex: number; // Index of the player who last hit it
  phasing: boolean; // If true, ignores brick collisions temporarily
  mass: number;
  isPermanent: boolean; // Added field
}

// Represents the overall state received from the backend WebSocket
export interface GameState {
  canvas: Canvas | null;
  players: (Player | null)[];
  paddles: (Paddle | null)[];
  balls: (Ball | null)[]; // Backend now sends filtered list, but keep null check just in case
}

// Message sent from frontend to backend for paddle movement
export interface DirectionMessage {
  direction: "ArrowLeft" | "ArrowRight" | "Stop"; // Add "Stop"
}