// File: src/types/game.ts

// --- Base Data Structures ---

// Represents the full data for a cell, including level (used for initial state)
export interface BrickData {
  type: number; // Corresponds to utils.CellType (0: brick, 1: block, 2: empty)
  life: number;
  level: number;
}

// Represents the state of a single brick sent in the new FullGridUpdate list
export interface BrickStateUpdate {
  x: number; // R3F X coordinate (centered)
  y: number; // R3F Y coordinate (centered, Y-up)
  life: number;
  type: number; // utils.CellType as number
}


export interface Cell {
  x: number;
  y: number;
  data: BrickData | null; // Cell holds the full BrickData or null
}

export type Grid = (Cell | null)[][];

export interface Player {
  index: number;
  id: string;
  color: [number, number, number];
  score: number; // Keep as number, backend sends int32 but JS handles it
}

export interface Paddle {
  x: number; // Original X
  y: number; // Original Y
  r3fX: number; // R3F X (center) - Now required
  r3fY: number; // R3F Y (center) - Now required
  width: number;
  height: number;
  index: number;
  vx: number;
  vy: number;
  isMoving: boolean;
  collided: boolean;
}

export interface Ball {
  x: number; // Original X
  y: number; // Original Y
  r3fX: number; // R3F X - Now required
  r3fY: number; // R3F Y - Now required
  vx: number;
  vy: number;
  radius: number;
  id: number;
  ownerIndex: number;
  phasing: boolean;
  mass: number;
  isPermanent: boolean;
  collided: boolean;
}

// --- WebSocket Message Types ---

// Message sent from frontend to backend
export interface DirectionMessage {
  direction: 'ArrowLeft' | 'ArrowRight' | 'Stop';
}

// Type for visual direction used in input handling
export type VisualDirection = 'ArrowLeft' | 'ArrowRight' | 'Stop';


// --- Initial Messages from Backend (Directly to Client) ---

export interface PlayerAssignmentMessage {
  messageType: 'playerAssignment';
  playerIndex: number;
}

// --- Initial State Message Structures (Modified) ---

// InitialPaddleState includes core Paddle data and its initial R3F coordinates.
export interface InitialPaddleState extends Omit<Paddle, 'r3fX' | 'r3fY'> { // Omit R3F from base Paddle
  r3fX: number; // R3F X coordinate
  r3fY: number; // R3F Y coordinate
}

// InitialBallState includes core Ball data and its initial R3F coordinates.
export interface InitialBallState extends Omit<Ball, 'r3fX' | 'r3fY'> { // Omit R3F from base Ball
  r3fX: number; // R3F X coordinate
  r3fY: number; // R3F Y coordinate
}

// New message to send existing entity states to a new player
export interface InitialPlayersAndBallsState {
  messageType: 'initialPlayersAndBallsState';
  players: Player[];             // Array of existing Player data
  paddles: InitialPaddleState[]; // Array of existing Paddle data WITH R3F coords
  balls: InitialBallState[];     // Array of existing Ball data WITH R3F coords
  // canvasSize?: number; // Optional: Add if needed for frontend scaling
}

// --- End Initial State Message Structures ---


// --- Game Over Message ---

export interface GameOverMessage {
  messageType: 'gameOver';
  winnerIndex: number;
  finalScores: number[]; // Assuming backend converts [4]int32 to []int/number for JSON
  reason: string;
  roomPid: string;
}

// --- NEW Atomic Update Messages (Batched) ---

// Wrapper for a batch of updates
export interface GameUpdatesBatch {
  messageType: 'gameUpdates';
  updates: AtomicUpdate[]; // Array of individual update messages
}

// Individual update message types
export interface BallPositionUpdate {
  messageType: 'ballPositionUpdate';
  id: number;
  x: number; // Original X
  y: number; // Original Y
  r3fX: number; // R3F X
  r3fY: number; // R3F Y
  vx: number;
  vy: number;
  collided: boolean;
  phasing: boolean; // Added phasing status
}

export interface PaddlePositionUpdate {
  messageType: 'paddlePositionUpdate';
  index: number;
  x: number; // Original X
  y: number; // Original Y
  r3fX: number; // R3F X (center)
  r3fY: number; // R3F Y (center)
  width: number; // Original Width
  height: number; // Original Height
  vx: number;
  vy: number;
  isMoving: boolean;
  collided: boolean;
}

// FullGridUpdate sends the state of ALL grid cells as a flat list with R3F coordinates.
export interface FullGridUpdate {
  messageType: 'fullGridUpdate';
  cellSize: number; // Cell size for geometry scaling
  bricks: BrickStateUpdate[]; // List containing state and R3F coords for ALL cells
}


export interface ScoreUpdate {
  messageType: 'scoreUpdate';
  index: number;
  score: number; // Assuming backend sends int32 which becomes number
}

export interface BallOwnershipChange {
  messageType: 'ballOwnerChanged';
  id: number;
  newOwnerIndex: number;
}

export interface BallSpawned {
  messageType: 'ballSpawned';
  ball: Omit<Ball, 'r3fX' | 'r3fY'>; // Base ball data
  r3fX: number; // Initial R3F X
  r3fY: number; // Initial R3F Y
}

export interface BallRemoved {
  messageType: 'ballRemoved';
  id: number;
}

export interface PlayerJoined {
  messageType: 'playerJoined';
  player: Player;
  paddle: Omit<Paddle, 'r3fX' | 'r3fY'>; // Base paddle data
  r3fX: number; // Initial Paddle R3F X (center)
  r3fY: number; // Initial Paddle R3F Y (center)
}

export interface PlayerLeft {
  messageType: 'playerLeft';
  index: number;
}

// Union type for all possible atomic updates within a batch
export type AtomicUpdate =
  | BallPositionUpdate
  | PaddlePositionUpdate
  | FullGridUpdate // Updated
  | ScoreUpdate
  | BallOwnershipChange
  | BallSpawned
  | BallRemoved
  | PlayerJoined
  | PlayerLeft;

// --- Type Guards for Incoming Messages ---

export function isPlayerAssignment(data: unknown): data is PlayerAssignmentMessage {
  return typeof data === 'object' && data !== null && (data as PlayerAssignmentMessage).messageType === 'playerAssignment';
}

// New type guard for initial entity state
export function isInitialPlayersAndBallsState(data: unknown): data is InitialPlayersAndBallsState {
  return typeof data === 'object' && data !== null && (data as InitialPlayersAndBallsState).messageType === 'initialPlayersAndBallsState';
}


export function isGameOver(data: unknown): data is GameOverMessage {
  return typeof data === 'object' && data !== null && (data as GameOverMessage).messageType === 'gameOver';
}

export function isGameUpdatesBatch(data: unknown): data is GameUpdatesBatch {
  return typeof data === 'object' && data !== null && (data as GameUpdatesBatch).messageType === 'gameUpdates' && Array.isArray((data as GameUpdatesBatch).updates);
}

// --- Type Guards for Atomic Updates ---

export function isBallPositionUpdate(update: unknown): update is BallPositionUpdate {
  return typeof update === 'object' && update !== null && (update as BallPositionUpdate).messageType === 'ballPositionUpdate';
}

export function isPaddlePositionUpdate(update: unknown): update is PaddlePositionUpdate {
  return typeof update === 'object' && update !== null && (update as PaddlePositionUpdate).messageType === 'paddlePositionUpdate';
}

// Updated type guard for full grid update
export function isFullGridUpdate(update: unknown): update is FullGridUpdate {
  return typeof update === 'object' && update !== null && (update as FullGridUpdate).messageType === 'fullGridUpdate';
}

export function isScoreUpdate(update: unknown): update is ScoreUpdate {
  return typeof update === 'object' && update !== null && (update as ScoreUpdate).messageType === 'scoreUpdate';
}

export function isBallOwnershipChange(update: unknown): update is BallOwnershipChange {
  return typeof update === 'object' && update !== null && (update as BallOwnershipChange).messageType === 'ballOwnerChanged';
}

export function isBallSpawned(update: unknown): update is BallSpawned {
  return typeof update === 'object' && update !== null && (update as BallSpawned).messageType === 'ballSpawned';
}

export function isBallRemoved(update: unknown): update is BallRemoved {
  return typeof update === 'object' && update !== null && (update as BallRemoved).messageType === 'ballRemoved';
}

export function isPlayerJoined(update: unknown): update is PlayerJoined {
  return typeof update === 'object' && update !== null && (update as PlayerJoined).messageType === 'playerJoined';
}

export function isPlayerLeft(update: unknown): update is PlayerLeft {
  return typeof update === 'object' && update !== null && (update as PlayerLeft).messageType === 'playerLeft';
}


// Union type for all possible top-level incoming messages from WebSocket
export type IncomingMessage =
  | PlayerAssignmentMessage
  | InitialPlayersAndBallsState
  | GameOverMessage
  | GameUpdatesBatch;