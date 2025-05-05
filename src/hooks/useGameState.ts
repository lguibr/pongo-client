// File: src/hooks/useGameState.ts
import { useState, useEffect, useRef } from 'react';
import {
  Player, Paddle, Ball, GameOverMessage, IncomingMessage, AtomicUpdate,
  isPlayerAssignment, isInitialPlayersAndBallsState,
  isGameOver, isGameUpdatesBatch, isFullGridUpdate, isPlayerJoined,
  isPlayerLeft, isScoreUpdate, isPaddlePositionUpdate, isBallSpawned,
  isBallRemoved, isBallPositionUpdate, isBallOwnershipChange, BrickStateUpdate
} from '../types/game';

interface GameState {
  originalPlayers: (Player | null)[];
  originalPaddles: (Paddle | null)[]; // Now includes r3fX/Y
  originalBalls: Ball[];             // Now includes r3fX/Y
  brickStates: BrickStateUpdate[];   // Store flat list of bricks with R3F coords
  cellSize: number;                  // Store cell size for geometry
  myPlayerIndex: number | null;
  gameOverInfo: GameOverMessage | null;
}

// --- Specific Update Processors (Internal Helpers - Modified for R3F Coords) ---
const processPlayerUpdate = (currentPlayers: (Player | null)[], update: AtomicUpdate): (Player | null)[] | null => {
  let newPlayers = currentPlayers;
  let changed = false;
  if (isPlayerJoined(update)) {
    const playerIndex = update.player.index;
    if (playerIndex >= 0 && playerIndex < 4) {
      if (newPlayers[playerIndex] === null || newPlayers[playerIndex]?.id !== update.player.id) {
        if (!changed) { newPlayers = [...currentPlayers]; changed = true; }
        newPlayers[playerIndex] = { ...update.player };
      }
    }
  } else if (isPlayerLeft(update)) {
    if (update.index >= 0 && update.index < 4 && newPlayers[update.index] !== null) {
      if (!changed) { newPlayers = [...currentPlayers]; changed = true; }
      newPlayers[update.index] = null;
    }
  } else if (isScoreUpdate(update)) {
    if (update.index >= 0 && update.index < 4 && newPlayers[update.index]) {
      const currentPlayer = newPlayers[update.index]!;
      if (currentPlayer.score !== update.score) {
        if (!changed) { newPlayers = [...currentPlayers]; changed = true; }
        newPlayers[update.index] = { ...currentPlayer, score: update.score };
      }
    }
  }
  return changed ? newPlayers : null;
};

const processPaddleUpdate = (currentPaddles: (Paddle | null)[], update: AtomicUpdate): (Paddle | null)[] | null => {
  let newPaddles = currentPaddles;
  let changed = false;
  if (isPlayerJoined(update)) {
    const paddleIndex = update.paddle.index;
    if (paddleIndex >= 0 && paddleIndex < 4) {
      if (newPaddles[paddleIndex] === null || newPaddles[paddleIndex]?.index !== update.paddle.index) {
        if (!changed) { newPaddles = [...currentPaddles]; changed = true; }
        // PlayerJoined now includes R3F coords
        newPaddles[paddleIndex] = { ...update.paddle, r3fX: update.r3fX, r3fY: update.r3fY };
      }
    }
  } else if (isPlayerLeft(update)) {
    if (update.index >= 0 && update.index < 4 && newPaddles[update.index] !== null) {
      if (!changed) { newPaddles = [...currentPaddles]; changed = true; }
      newPaddles[update.index] = null;
    }
  } else if (isPaddlePositionUpdate(update)) {
    if (update.index >= 0 && update.index < 4 && newPaddles[update.index]) {
      const currentPaddle = newPaddles[update.index]!;
      // Check if any relevant property changed
      if (currentPaddle.x !== update.x || currentPaddle.y !== update.y ||
        currentPaddle.r3fX !== update.r3fX || currentPaddle.r3fY !== update.r3fY || // Check R3F coords too
        currentPaddle.vx !== update.vx || currentPaddle.vy !== update.vy ||
        currentPaddle.isMoving !== update.isMoving || currentPaddle.collided !== update.collided) {
        if (!changed) { newPaddles = [...currentPaddles]; changed = true; }
        newPaddles[update.index] = {
          // ...currentPaddle, // Spread existing paddle data
          index: update.index, // Ensure index is kept
          x: update.x, y: update.y, // Update original coords
          r3fX: update.r3fX, r3fY: update.r3fY, // Update R3F coords
          width: update.width, height: update.height, // Update dimensions
          vx: update.vx, vy: update.vy,
          isMoving: update.isMoving, collided: update.collided,
        };
      }
    }
  }
  return changed ? newPaddles : null;
};

const processBallUpdate = (currentBalls: Ball[], update: AtomicUpdate): Ball[] | null => {
  let newBalls = currentBalls;
  let changed = false;
  if (isBallSpawned(update)) {
    if (newBalls.findIndex(b => b.id === update.ball.id) === -1) {
      // BallSpawned now includes R3F coords
      newBalls = [...currentBalls, { ...update.ball, r3fX: update.r3fX, r3fY: update.r3fY }];
      changed = true;
    }
  } else if (isBallRemoved(update)) {
    const initialLength = newBalls.length;
    const filteredBalls = newBalls.filter(b => b.id !== update.id);
    if (filteredBalls.length !== initialLength) {
      newBalls = filteredBalls;
      changed = true;
    }
  } else if (isBallPositionUpdate(update)) {
    const index = newBalls.findIndex(b => b.id === update.id);
    if (index !== -1) {
      const currentBall = newBalls[index];
      // Check if any relevant property changed
      if (currentBall.x !== update.x || currentBall.y !== update.y ||
        currentBall.r3fX !== update.r3fX || currentBall.r3fY !== update.r3fY || // Check R3F coords too
        currentBall.vx !== update.vx || currentBall.vy !== update.vy ||
        currentBall.collided !== update.collided) {
        if (!changed) { newBalls = [...currentBalls]; changed = true; }
        newBalls[index] = {
          ...currentBall, // Spread existing ball data
          x: update.x, y: update.y, // Update original coords
          r3fX: update.r3fX, r3fY: update.r3fY, // Update R3F coords
          vx: update.vx, vy: update.vy,
          collided: update.collided,
        };
      }
    }
  } else if (isBallOwnershipChange(update)) {
    const index = newBalls.findIndex(b => b.id === update.id);
    if (index !== -1) {
      const currentBall = newBalls[index];
      if (currentBall.ownerIndex !== update.newOwnerIndex) {
        if (!changed) { newBalls = [...currentBalls]; changed = true; }
        newBalls[index] = { ...currentBall, ownerIndex: update.newOwnerIndex };
      }
    }
  }
  return changed ? newBalls : null;
};

// --- Generic Update Application Function (Internal Helper - Unchanged) ---
function applyUpdates<T>(
  currentState: T,
  updates: AtomicUpdate[],
  processor: (state: T, update: AtomicUpdate) => T | null
): T {
  let newState = currentState;
  let stateChangedInBatch = false;
  updates.forEach(update => {
    if (isFullGridUpdate(update)) return; // Skip grid updates here
    const processedState = processor(newState, update);
    if (processedState !== null) {
      newState = processedState;
      stateChangedInBatch = true;
    }
  });
  return stateChangedInBatch ? newState : currentState;
}

export function useGameState(lastMessage: MessageEvent<string> | null): GameState {
  const [originalPlayers, setOriginalPlayers] = useState<(Player | null)[]>(Array(4).fill(null));
  const [originalPaddles, setOriginalPaddles] = useState<(Paddle | null)[]>(Array(4).fill(null));
  const [originalBalls, setOriginalBalls] = useState<Ball[]>([]);
  const [brickStates, setBrickStates] = useState<BrickStateUpdate[]>([]); // Store flat list
  const [cellSize, setCellSize] = useState<number>(0); // Store cell size for geometry
  const [myPlayerIndex, setMyPlayerIndex] = useState<number | null>(null);
  const [gameOverInfo, setGameOverInfo] = useState<GameOverMessage | null>(null);
  const isGameOverRef = useRef(false);

  useEffect(() => {
    if (!lastMessage?.data) return;
    try {
      const data: IncomingMessage = JSON.parse(lastMessage.data);
      const timestamp = new Date().toLocaleTimeString('en-US', {
        hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
      });

      if (isPlayerAssignment(data)) {
        console.log(`[${timestamp}] Assigning Player Index: ${data.playerIndex}`);
        setMyPlayerIndex(data.playerIndex);
        // Reset all game state on new assignment
        setGameOverInfo(null);
        isGameOverRef.current = false;
        setBrickStates([]); // Reset bricks
        setOriginalPlayers(Array(4).fill(null));
        setOriginalPaddles(Array(4).fill(null));
        setOriginalBalls([]);
        setCellSize(0);
      } else if (isInitialPlayersAndBallsState(data)) {
        console.log(`[${timestamp}] Received Initial Players/Paddles/Balls State`);
        const initialPlayers = Array(4).fill(null);
        const initialPaddles = Array(4).fill(null);
        const initialBalls: Ball[] = [];

        data.players.forEach(p => {
          if (p && p.index >= 0 && p.index < 4) initialPlayers[p.index] = { ...p };
        });
        // Process paddles, ensuring R3fX/Y are included
        data.paddles.forEach(pState => {
          if (pState && pState.index >= 0 && pState.index < 4) {
            // Directly use the combined struct which includes R3F coords
            initialPaddles[pState.index] = { ...pState };
          }
        });
        // Process balls, ensuring R3fX/Y are included
        data.balls.forEach(bState => {
          if (bState) {
            // Directly use the combined struct which includes R3F coords
            initialBalls.push({ ...bState });
          }
        });

        setOriginalPlayers(initialPlayers);
        setOriginalPaddles(initialPaddles);
        setOriginalBalls(initialBalls);
        // Optional: Set canvasSize if received: setCanvasSize(data.canvasSize);
      } else if (isGameOver(data)) {
        console.log(`[${timestamp}] Received Game Over message:`, data);
        setGameOverInfo(data);
        isGameOverRef.current = true;
      } else if (isGameUpdatesBatch(data)) {
        if (isGameOverRef.current) return; // Don't process updates after game over

        // Apply updates to players, paddles, balls
        setOriginalPlayers(current => applyUpdates(current, data.updates, processPlayerUpdate));
        setOriginalPaddles(current => applyUpdates(current, data.updates, processPaddleUpdate));
        setOriginalBalls(current => applyUpdates(current, data.updates, processBallUpdate));

        // Handle grid updates separately using the new format
        const gridUpdate = data.updates.find(isFullGridUpdate);
        if (gridUpdate) {
          setCellSize(gridUpdate.cellSize); // Update cell size
          setBrickStates(gridUpdate.bricks); // Directly store the flat list
        }
      } else {
        console.warn(`[${timestamp}] Received unknown message structure:`, data);
      }
    } catch (e) {
      console.error('Failed to parse WebSocket message:', e);
    }
  }, [lastMessage]); // Dependency is the last message

  return {
    originalPlayers,
    originalPaddles,
    originalBalls,
    brickStates, // Return flat list
    cellSize, // Return cell size
    myPlayerIndex,
    gameOverInfo,
  };
}