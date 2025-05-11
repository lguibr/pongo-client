// File: src/hooks/useGameState.ts
import { useState, useEffect, useRef } from 'react';
import {
  Player, Paddle, Ball, GameOverMessage, IncomingMessage, AtomicUpdate,
  isPlayerAssignment, isInitialPlayersAndBallsState,
  isGameOver, isGameUpdatesBatch, isFullGridUpdate, isPlayerJoined,
  isPlayerLeft, isScoreUpdate, isPaddlePositionUpdate, isBallSpawned,
  isBallRemoved, isBallPositionUpdate, isBallOwnershipChange, BrickStateUpdate
} from '../types/game';
import { SoundEventType } from './useSoundManager';

interface GameState {
  originalPlayers: (Player | null)[];
  originalPaddles: (Paddle | null)[];
  originalBalls: Ball[];
  brickStates: BrickStateUpdate[];
  cellSize: number;
  myPlayerIndex: number | null;
  gameOverInfo: GameOverMessage | null;
}

const getTimestamp = (): string => {
  const now = new Date();
  const time = now.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const ms = String(now.getMilliseconds()).padStart(3, '0');
  return `${time}.${ms}`;
};

// --- Specific Update Processors (Modified to include playSound calls) ---
const processPlayerUpdate = (
  currentPlayers: (Player | null)[],
  update: AtomicUpdate
  // playSound parameter removed as it was unused here
): (Player | null)[] | null => {
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

const processPaddleUpdate = (
  currentPaddles: (Paddle | null)[],
  update: AtomicUpdate,
  playSound: (type: SoundEventType, index?: number) => void
): (Paddle | null)[] | null => {
  let newPaddles = currentPaddles;
  let changed = false;
  if (isPlayerJoined(update)) {
    const paddleIndex = update.paddle.index;
    if (paddleIndex >= 0 && paddleIndex < 4) {
      if (newPaddles[paddleIndex] === null || newPaddles[paddleIndex]?.index !== update.paddle.index) {
        if (!changed) { newPaddles = [...currentPaddles]; changed = true; }
        newPaddles[paddleIndex] = { ...update.paddle, r3fX: update.r3fX, r3fY: update.r3fY };
      }
    }
  } else if (isPlayerLeft(update)) {
    if (update.index >= 0 && update.index < 4 && newPaddles[update.index] !== null) {
      if (!changed) { newPaddles = [...currentPaddles]; changed = true; }
      newPaddles[update.index] = null;
    }
  } else if (isPaddlePositionUpdate(update)) {
    const paddleIndex = update.index;
    if (paddleIndex >= 0 && paddleIndex < 4 && newPaddles[paddleIndex]) {
      const currentPaddle = newPaddles[paddleIndex]!;
      const relevantPropsChanged = currentPaddle.x !== update.x || currentPaddle.y !== update.y ||
        currentPaddle.r3fX !== update.r3fX || currentPaddle.r3fY !== update.r3fY ||
        currentPaddle.vx !== update.vx || currentPaddle.vy !== update.vy ||
        currentPaddle.isMoving !== update.isMoving || currentPaddle.collided !== update.collided;

      if (relevantPropsChanged) {
        if (!changed) { newPaddles = [...currentPaddles]; changed = true; }
        newPaddles[paddleIndex] = {
          index: update.index, x: update.x, y: update.y,
          r3fX: update.r3fX, r3fY: update.r3fY,
          width: update.width, height: update.height,
          vx: update.vx, vy: update.vy,
          isMoving: update.isMoving, collided: update.collided,
        };
        if (update.collided && !currentPaddle.collided) {
          playSound('paddle_collision');
        }
      }
    }
  }
  return changed ? newPaddles : null;
};

const processBallUpdate = (
  currentBalls: Ball[],
  update: AtomicUpdate,
  playSound: (type: SoundEventType, index?: number) => void,
  myPlayerIndex: number | null
): Ball[] | null => {
  let newBalls = currentBalls;
  let changed = false;
  const timestamp = getTimestamp();

  if (isBallSpawned(update)) {
    if (newBalls.findIndex(b => b.id === update.ball.id) === -1) {
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
      const positionChanged = currentBall.x !== update.x || currentBall.y !== update.y ||
        currentBall.r3fX !== update.r3fX || currentBall.r3fY !== update.r3fY;
      const velocityChanged = currentBall.vx !== update.vx || currentBall.vy !== update.vy;
      const collisionChanged = currentBall.collided !== update.collided;
      const phasingChanged = currentBall.phasing !== update.phasing;

      if (positionChanged || velocityChanged || collisionChanged || phasingChanged) {
        if (!changed) { newBalls = [...currentBalls]; changed = true; }
        newBalls[index] = {
          ...currentBall, x: update.x, y: update.y,
          r3fX: update.r3fX, r3fY: update.r3fY,
          vx: update.vx, vy: update.vy,
          collided: update.collided, phasing: update.phasing,
        };
        if (update.collided && !currentBall.collided) { // Check if collision state changed to true
          playSound('ball_collision');
        }
      }
    } else {
      console.warn(`[${timestamp}][GameState] Received BallPositionUpdate for unknown Ball ID: ${update.id}`);
    }
  } else if (isBallOwnershipChange(update)) {
    const index = newBalls.findIndex(b => b.id === update.id);
    if (index !== -1) {
      const currentBall = newBalls[index];
      const oldOwner = currentBall.ownerIndex;
      const newOwner = update.newOwnerIndex;

      if (oldOwner !== newOwner) {
        if (!changed) { newBalls = [...currentBalls]; changed = true; }
        newBalls[index] = { ...currentBall, ownerIndex: newOwner };

        if (myPlayerIndex !== null) {
          if (oldOwner === myPlayerIndex && newOwner !== myPlayerIndex) {
            playSound('ball_lost_by_player');
          } else if (oldOwner !== myPlayerIndex && newOwner === myPlayerIndex) {
            playSound('ball_gained_by_player');
          } else {
            playSound('ball_ownership_change'); // Changed between other players or unowned
          }
        } else {
          playSound('ball_ownership_change'); // myPlayerIndex is null, play generic
        }
      }
    }
  }
  return changed ? newBalls : null;
};

function applyUpdates<T>(
  currentState: T,
  updates: AtomicUpdate[],
  processor: (state: T, update: AtomicUpdate, playSound: (type: SoundEventType, index?: number) => void, myPlayerIndex: number | null) => T | null,
  playSound: (type: SoundEventType, index?: number) => void,
  myPlayerIndex: number | null
): T {
  let newState = currentState;
  updates.forEach(update => {
    if (isFullGridUpdate(update)) return; // FullGridUpdate is handled separately
    const processedState = processor(newState, update, playSound, myPlayerIndex);
    if (processedState !== null) {
      newState = processedState;
    }
  });
  return newState;
}

export function useGameState(
  lastMessage: MessageEvent<string> | null,
  playSound: (type: SoundEventType, index?: number) => void
): GameState {
  const [originalPlayers, setOriginalPlayers] = useState<(Player | null)[]>(Array(4).fill(null));
  const [originalPaddles, setOriginalPaddles] = useState<(Paddle | null)[]>(Array(4).fill(null));
  const [originalBalls, setOriginalBalls] = useState<Ball[]>([]);
  const [brickStates, setBrickStates] = useState<BrickStateUpdate[]>([]);
  const [cellSize, setCellSize] = useState<number>(0);
  const [myPlayerIndex, setMyPlayerIndex] = useState<number | null>(null);
  const [gameOverInfo, setGameOverInfo] = useState<GameOverMessage | null>(null);
  const isGameOverRef = useRef(false);
  const prevBrickStatesRef = useRef<BrickStateUpdate[]>([]);

  useEffect(() => {
    if (!lastMessage?.data) return;
    try {
      const data: IncomingMessage = JSON.parse(lastMessage.data);
      const timestamp = getTimestamp();

      if (isPlayerAssignment(data)) {
        console.log(`[${timestamp}][GameState] Assigning Player Index: ${data.playerIndex}`);
        setMyPlayerIndex(data.playerIndex);
        setGameOverInfo(null);
        isGameOverRef.current = false;
        setBrickStates([]);
        prevBrickStatesRef.current = [];
        setOriginalPlayers(Array(4).fill(null));
        setOriginalPaddles(Array(4).fill(null));
        setOriginalBalls([]);
        setCellSize(0);
      } else if (isInitialPlayersAndBallsState(data)) {
        console.log(`[${timestamp}][GameState] Received Initial Players/Paddles/Balls State`);
        const initialPlayers = Array(4).fill(null);
        const initialPaddles = Array(4).fill(null);
        const initialBalls: Ball[] = [];

        data.players.forEach(p => {
          if (p && p.index >= 0 && p.index < 4) initialPlayers[p.index] = { ...p };
        });
        data.paddles.forEach(pState => {
          if (pState && pState.index >= 0 && pState.index < 4) {
            initialPaddles[pState.index] = { ...pState };
          }
        });
        data.balls.forEach(bState => {
          if (bState) {
            initialBalls.push({ ...bState });
          }
        });

        setOriginalPlayers(initialPlayers);
        setOriginalPaddles(initialPaddles);
        setOriginalBalls(initialBalls);
      } else if (isGameOver(data)) {
        console.log(`[${timestamp}][GameState] Received Game Over message:`, data);
        setGameOverInfo(data);
        isGameOverRef.current = true;
      } else if (isGameUpdatesBatch(data)) {
        if (isGameOverRef.current) return;

        // Pass myPlayerIndex to the applyUpdates for balls
        setOriginalPlayers(current => applyUpdates(current, data.updates, processPlayerUpdate, playSound, myPlayerIndex));
        setOriginalPaddles(current => applyUpdates(current, data.updates, processPaddleUpdate, playSound, myPlayerIndex));
        setOriginalBalls(current => applyUpdates(current, data.updates, processBallUpdate, playSound, myPlayerIndex));


        const gridUpdate = data.updates.find(isFullGridUpdate);
        if (gridUpdate) {
          setCellSize(gridUpdate.cellSize);

          const prevBricksMap = new Map(prevBrickStatesRef.current.map(b => [`${b.x.toFixed(2)},${b.y.toFixed(2)}`, b]));
          gridUpdate.bricks.forEach(newBrick => {
            const key = `${newBrick.x.toFixed(2)},${newBrick.y.toFixed(2)}`;
            const prevBrick = prevBricksMap.get(key);
            if (prevBrick && prevBrick.type !== 2 && newBrick.type !== 2 && newBrick.life < prevBrick.life) {
              playSound('brick_break');
            }
          });

          setBrickStates(gridUpdate.bricks);
          prevBrickStatesRef.current = gridUpdate.bricks;
        }
      } else {
        console.warn(`[${timestamp}][GameState] Received unknown message structure:`, data);
      }
    } catch (e) {
      console.error('Failed to parse WebSocket message:', e);
    }
  }, [lastMessage, playSound, myPlayerIndex]); // Added myPlayerIndex to dependencies

  return {
    originalPlayers,
    originalPaddles,
    originalBalls,
    brickStates,
    cellSize,
    myPlayerIndex,
    gameOverInfo,
  };
}