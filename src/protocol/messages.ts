// Wire protocol, transcribed from pongo/game/messages.go:40-190,381-415, ball.go:12-24, paddle.go:15-28,
// player.go:10-15 and utils/constants.go. The Go structs have no omitempty, so every field is always present.
// Go nil slices marshal to null; src/net/decode.ts normalises null arrays to [] and drops null items,
// so these types never contain null.
//
// Coordinates: a paddle's x and y are its top-left corner in canvas px; a ball's x and y are its centre.
// The client stores paddle centres (x + w/2, y + h/2) everywhere. r3fX and r3fY are ignored.

export type RoomPhase = 'lobby' | 'countingDown' | 'playing';
export type WireDirection = 'ArrowLeft' | 'ArrowRight' | 'Stop';
export type WireCellType = 0 | 1 | 2; // Brick 0, Block 1 (never generated), Empty 2

export interface WirePlayer { index: number; id: string; color: [number, number, number]; score: number }
export interface WirePaddle {
  x: number; y: number; width: number; height: number; index: number;
  vx: number; vy: number; isMoving: boolean; collided: boolean;
}
export interface WireBall {
  x: number; y: number; vx: number; vy: number; radius: number; id: number;
  ownerIndex: number; phasing: boolean; mass: number; isPermanent: boolean; collided: boolean;
}
export interface R3FCoords { r3fX: number; r3fY: number }

// ---- top level: sent directly to one client ----
export interface RoomCreated { messageType: 'roomCreated'; code: string; roomPID: string }
export interface RoomJoined {
  messageType: 'roomJoined'; success: boolean; roomPID: string;
  code: string;            // "" on failure
  phase: RoomPhase | '';   // "" on failure
  reason: string;          // "" on success
}
export interface PlayerAssignment { messageType: 'playerAssignment'; playerIndex: number; phase: RoomPhase }
export interface InitialState {
  messageType: 'initialPlayersAndBallsState';
  players: WirePlayer[];                   // connected players only
  paddles: (WirePaddle & R3FCoords)[];     // every non-nil paddle, grace seats included
  balls: (WireBall & R3FCoords)[];         // true current radius and mass
}
export interface GameUpdates { messageType: 'gameUpdates'; updates: BatchItem[] }
export interface GameOver {
  messageType: 'gameOver'; winnerIndex: number;             // -1 = tie or no winner
  finalScores: [number, number, number, number]; reason: string; roomPID: string;
}

// ---- items that only arrive inside gameUpdates ----
export interface PlayerJoined { messageType: 'playerJoined'; player: WirePlayer; paddle: WirePaddle; r3fX: number; r3fY: number }
export interface PlayerLeft { messageType: 'playerLeft'; index: number }
export interface BallSpawned { messageType: 'ballSpawned'; ball: WireBall; r3fX: number; r3fY: number }
export interface BallRemoved { messageType: 'ballRemoved'; id: number }
export interface BallPositionUpdate {
  messageType: 'ballPositionUpdate'; id: number; x: number; y: number; r3fX: number; r3fY: number;
  vx: number; vy: number; collided: boolean; phasing: boolean;
}
export interface PaddlePositionUpdate {
  messageType: 'paddlePositionUpdate'; index: number; x: number; y: number; r3fX: number; r3fY: number;
  width: number; height: number; vx: number; vy: number; isMoving: boolean; collided: boolean;
}
export interface BrickCell { x: number; y: number; life: number; type: WireCellType } // x, y already R3F
export interface FullGridUpdate { messageType: 'fullGridUpdate'; cellSize: number; bricks: BrickCell[] } // row-major
export interface ScoreUpdate { messageType: 'scoreUpdate'; index: number; score: number }
export interface BallOwnerChanged { messageType: 'ballOwnerChanged'; id: number; newOwnerIndex: number }
export interface LobbyState { messageType: 'lobbyState'; players: { index: number; isReady: boolean }[] }
export interface GameStartCountdown { messageType: 'gameStartCountdown'; seconds: number }
export interface GameStarted { messageType: 'gameStarted' }
export interface GameStartCancelled { messageType: 'gameStartCancelled'; reason: string }

export type PositionItem = BallPositionUpdate | PaddlePositionUpdate;
export type ControlItem = GameStartCountdown | GameStarted | GameStartCancelled;
export type BatchItem = PositionItem | PlayerJoined | PlayerLeft | BallSpawned | BallRemoved
  | FullGridUpdate | ScoreUpdate | BallOwnerChanged | LobbyState | ControlItem;
export type AdmissionMessage = RoomCreated | RoomJoined | PlayerAssignment;
export type ServerMessage = AdmissionMessage | InitialState | GameUpdates | GameOver;

// ---- client -> server (unchanged wire) ----
export type ClientMessage =
  | { messageType: 'createRoom'; isPublic: boolean; sessionId: string }
  | { messageType: 'joinRoom'; code: string; sessionId: string }
  | { messageType: 'quickPlay'; sessionId: string }
  | { messageType: 'playerReady'; isReady: boolean }
  | { messageType: 'direction'; direction: WireDirection };
