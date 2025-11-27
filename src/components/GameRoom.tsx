import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import useWebSocket, { ReadyState } from 'react-use-websocket';
import * as THREE from 'three';
import styled, { DefaultTheme } from 'styled-components';

import R3FCanvas from './R3FCanvas';
import StatusOverlay from './StatusOverlay';
import { WEBSOCKET_URL } from '../utils/constants';
import { 
  DirectionMessage, 
  Player, 
  VisualDirection, 
  CreateRoomRequest, 
  JoinRoomRequest, 
  QuickPlayRequest, 
  RoomCreatedResponse, 
  RoomJoinedResponse 
} from '../types/game';
import { useInputHandler } from '../hooks/useInputHandler';
import { useGameState } from '../hooks/useGameState';
import { usePlayerRotation } from '../utils/rotation';
import { useWindowSize } from '../hooks/useWindowSize';
import { useSoundManager, SoundEventType } from '../hooks/useSoundManager';

// Styled Components (Reused from App.tsx or moved here)
const GameCanvasWrapper = styled.div`
  width: 100%;
  height: 100%;
  max-width: 100%;
  max-height: 100%;
  aspect-ratio: var(--game-aspect-ratio);
  position: relative;
  display: flex;
  justify-content: center;
  align-items: center;

  & > canvas {
    display: block;
    width: 100% !important;
    height: 100% !important;
  }
`;

const ScoreBoard = styled.div<{ theme: DefaultTheme }>`
  position: fixed;
  top: calc(var(--header-height) + 10px);
  left: 10px;
  padding: 8px;
  opacity: 0.6;
  z-index: 20;
  background: ${({ theme }) => theme.colors.scoreboardBackground};
  border-radius: ${({ theme }) => theme.sizes.borderRadius};
  border: 1px solid ${({ theme }) => theme.colors.scoreboardBorder};
  font-size: ${({ theme }) => theme.fonts.sizes.mobileScore};
  font-family: ${({ theme }) => theme.fonts.monospace};
  color: ${({ theme }) => theme.colors.text};
  box-shadow: ${({ theme }) => theme.shadows.scoreboard};
  line-height: 1.5;
  font-weight: 500;

  @media (min-width: 768px) {
    padding: 10px 15px;
    font-size: ${({ theme }) => theme.fonts.sizes.score};
    opacity: 0.8;
  }
  
  div {
    margin-bottom: 5px;
    &:last-child {
      margin-bottom: 0;
    }
  }
`;

const GameOverOverlay = styled.div<{ theme: DefaultTheme }>`
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: rgba(0, 0, 0, 0.85);
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  color: ${({ theme }) => theme.colors.text};
  z-index: 50;
  text-align: center;
  padding: 20px;
  h2 { font-size: 2.5em; margin-bottom: 20px; color: ${({ theme }) => theme.colors.accent}; }
  p { font-size: 1.2em; margin-bottom: 15px; }
  ul { list-style: none; padding: 0; margin-top: 10px; }
  li { margin-bottom: 5px; font-size: 1em; }
`;

const MobileControlsContainer = styled.div<{ theme: DefaultTheme }>`
  height: var(--controls-height);
  display: flex;
  gap: 0.5rem;
  padding: 0.5rem;
  flex-shrink: 0;
  z-index: 30;
  user-select: none;
  -webkit-user-select: none;
  -webkit-tap-highlight-color: transparent;
  justify-content: space-around;
  padding-bottom: max(env(safe-area-inset-bottom, 20px), 20px);
  background-color: ${({ theme }) => theme.colors.background};
`;

const ControlButton = styled.button<{ theme: DefaultTheme; isActive: boolean }>`
  flex: 1;
  height: 100%;
  display: flex;
  justify-content: center;
  align-items: center;
  background-color: ${({ theme, isActive }) => isActive ? theme.colors.mobileButtonBackgroundActive : theme.colors.mobileButtonBackground};
  border: 1px solid ${({ theme }) => theme.colors.mobileButtonBorder};
  border-radius: ${({ theme }) => theme.sizes.borderRadius};
  color: ${({ theme }) => theme.colors.mobileButtonSymbol};
  font-size: ${({ theme }) => theme.fonts.sizes.mobileButtonSymbol};
  font-weight: bold;
  cursor: pointer;
  transition: background-color 0.1s ease-out, transform 0.05s ease-out;
  outline: none;
  transform: ${({ isActive }) => isActive ? 'scale(0.98)' : 'scale(1)'};

  &:active {
    background-color: ${({ theme }) => theme.colors.mobileButtonBackgroundActive};
    transform: scale(0.98);
  }

  &:disabled {
    background-color: ${({ theme }) => theme.colors.mobileButtonBackground};
    opacity: 0.5;
    cursor: not-allowed;
  }
`;

interface GameRoomProps {
  theme: DefaultTheme;
  volume: number;
  resumeContext: () => void;
  createRoom?: boolean;
  quickPlay?: boolean;
}

export const GameRoom: React.FC<GameRoomProps> = ({ theme, volume, resumeContext, createRoom, quickPlay }) => {
  const { code } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const { width } = useWindowSize();
  const isMobileView = useMemo(() => width < 768, [width]);

  const lastSentMobileLogicalDir = useRef<DirectionMessage['direction'] | null>(null);
  const lastSentLogicalKeyboardDir = useRef<DirectionMessage['direction'] | null>(null);
  const [leftActive, setLeftActive] = useState(false);
  const [rightActive, setRightActive] = useState(false);
  const [isConnecting, setIsConnecting] = useState(true);
  
  // Track if we have already sent the initial handshake for this mount/code
  const hasHandshaked = useRef(false);

  const { playSound, setVolume } = useSoundManager();

  // Sync volume from prop to sound manager
  useEffect(() => {
    setVolume(volume);
  }, [volume, setVolume]);

  const handleGameSound = useCallback((type: SoundEventType, index?: number) => {
    playSound(type, index);
  }, [playSound]);

  const { sendMessage, lastMessage, readyState } = useWebSocket(WEBSOCKET_URL, {
    shouldReconnect: () => true,
    reconnectInterval: 3000,
    filter: (msg): msg is MessageEvent<string> =>
      typeof msg.data === 'string' && msg.data.startsWith('{'),
  });

  const {
    originalPlayers,
    originalPaddles,
    originalBalls,
    brickStates,
    cellSize,
    myPlayerIndex,
    gameOverInfo,
  } = useGameState(lastMessage, handleGameSound);

  // Handshake Logic
  useEffect(() => {
    if (readyState === ReadyState.OPEN && !hasHandshaked.current) {
      hasHandshaked.current = true;
      console.log("WebSocket Open. Performing handshake. Code:", code, "Create:", createRoom, "QuickPlay:", quickPlay);

      if (createRoom) {
        const req: CreateRoomRequest = { messageType: 'createRoom', isPublic: true };
        sendMessage(JSON.stringify(req));
      } else if (quickPlay) {
        const req: QuickPlayRequest = { messageType: 'quickPlay' };
        sendMessage(JSON.stringify(req));
      } else if (code) {
        // Join specific room
        const req: JoinRoomRequest = { messageType: 'joinRoom', code };
        sendMessage(JSON.stringify(req));
      }
    }
  }, [readyState, code, createRoom, quickPlay, sendMessage]);

  // Handle Room Responses (Navigation and Errors)
  useEffect(() => {
    if (lastMessage) {
      try {
        const data = JSON.parse(lastMessage.data);
        if (data.messageType === 'roomCreated') {
          const response = data as RoomCreatedResponse;
          setIsConnecting(false);
          // Update URL to the actual room code without reloading
          navigate(`/room/${response.code}`, { replace: true });
        } else if (data.messageType === 'roomJoined') {
          const response = data as RoomJoinedResponse;
          setIsConnecting(false);
          if (response.success) {
            if (response.code && response.code !== code) {
               // Update URL if we joined via quickplay or create
               navigate(`/room/${response.code}`, { replace: true });
            }
          } else {
            alert(`Failed to join room: ${response.reason}`);
            navigate('/');
          }
        }
      } catch (e) {
        console.error("Error parsing message:", e);
      }
    }
  }, [lastMessage, navigate, code]);

  const rotationDegrees = usePlayerRotation(myPlayerIndex);
  const rotationRadians = useMemo(() => THREE.MathUtils.degToRad(rotationDegrees), [rotationDegrees]);

  const connectionStatus = useMemo(() => {
    switch (readyState) {
      case ReadyState.CONNECTING: return ReadyState.CONNECTING;
      case ReadyState.OPEN: return ReadyState.OPEN;
      case ReadyState.CLOSING: return ReadyState.CLOSING;
      case ReadyState.CLOSED: return ReadyState.CLOSED;
      case ReadyState.UNINSTANTIATED: return ReadyState.CONNECTING;
      default: return 'error';
    }
  }, [readyState]);

  const isGameActive = connectionStatus === ReadyState.OPEN && !gameOverInfo;
  const isGameReady = isGameActive && brickStates.length > 0 && cellSize > 0;

  const displayStatus = useMemo(() => {
    if (isConnecting) return 'waiting';
    if (gameOverInfo) return null;
    if (isGameReady) return null;
    if (connectionStatus === ReadyState.OPEN && !isGameReady) return 'waiting';
    if (connectionStatus === ReadyState.OPEN) return null;
    return connectionStatus;
  }, [connectionStatus, isGameReady, gameOverInfo, isConnecting]);

  // Input Handling
  const sendLogicalDirectionMessage = useCallback(
    (logicalDir: DirectionMessage['direction'], source: 'kb' | 'mobile') => {
      if (!isGameActive) return;
      if (source === 'kb') {
        if (logicalDir === lastSentLogicalKeyboardDir.current) return;
        lastSentLogicalKeyboardDir.current = logicalDir;
      } else {
        if (logicalDir === lastSentMobileLogicalDir.current) return;
        lastSentMobileLogicalDir.current = logicalDir;
      }
      sendMessage(JSON.stringify({ messageType: 'direction', direction: logicalDir }));
    },
    [isGameActive, sendMessage]
  );

  const mapDirection = useCallback((visualDir: VisualDirection): DirectionMessage['direction'] => {
    if (visualDir === 'Stop') return 'Stop';
    const needsSwap = myPlayerIndex === 0 || myPlayerIndex === 1;
    if (needsSwap) {
      return visualDir === 'ArrowLeft' ? 'ArrowRight' : 'ArrowLeft';
    }
    return visualDir;
  }, [myPlayerIndex]);

  const handleKeyboardVisualChange = useCallback((visualDir: VisualDirection) => {
    setLeftActive(visualDir === 'ArrowLeft');
    setRightActive(visualDir === 'ArrowRight');
    const logicalDir = mapDirection(visualDir);
    sendLogicalDirectionMessage(logicalDir, 'kb');
  }, [mapDirection, sendLogicalDirectionMessage]);

  useInputHandler({
    isEnabled: isGameActive,
    onVisualDirectionChange: handleKeyboardVisualChange,
  });

  const handleTouchStart = useCallback((visualDir: 'ArrowLeft' | 'ArrowRight') => (e: React.TouchEvent) => {
    e.preventDefault();
    resumeContext();
    if (!isGameActive) return;
    if (visualDir === 'ArrowLeft') setLeftActive(true);
    if (visualDir === 'ArrowRight') setRightActive(true);
    const logicalDir = mapDirection(visualDir);
    sendLogicalDirectionMessage(logicalDir, 'mobile');
  }, [mapDirection, sendLogicalDirectionMessage, isGameActive, resumeContext]);

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    e.preventDefault();
    if (!isGameActive) return;
    setLeftActive(false);
    setRightActive(false);
    const logicalDir = mapDirection('Stop');
    sendLogicalDirectionMessage(logicalDir, 'mobile');
  }, [mapDirection, sendLogicalDirectionMessage, isGameActive]);

  const renderGameOver = () => {
    if (!gameOverInfo) return null;
    const winnerText =
      gameOverInfo.winnerIndex === -1
        ? 'It\'s a Tie!'
        : `Player ${gameOverInfo.winnerIndex} Wins!`;
    return (
      <GameOverOverlay theme={theme}>
        <h2>Game Over!</h2>
        <p>{winnerText}</p>
        <p>Reason: {gameOverInfo.reason}</p>
        <p>Final Scores:</p>
        <ul>
          {gameOverInfo.finalScores.map((score, index) => (
            <li key={index}>
              Player {index}: {score}
            </li>
          ))}
        </ul>
        <button 
          onClick={() => navigate('/')}
          style={{
            marginTop: '20px',
            padding: '10px 20px',
            fontSize: '1.2em',
            cursor: 'pointer',
            backgroundColor: theme.colors.accent,
            border: 'none',
            borderRadius: '5px'
          }}
        >
          Back to Menu
        </button>
      </GameOverOverlay>
    );
  };

  return (
    <>
      <GameCanvasWrapper>
        {(isGameReady || displayStatus === 'waiting') && (
          <R3FCanvas
            brickStates={brickStates}
            cellSize={cellSize}
            paddles={originalPaddles}
            balls={originalBalls}
            rotationAngle={rotationRadians}
            wsStatus={connectionStatus === ReadyState.OPEN ? 'open' : 'closed'}
          />
        )}
      </GameCanvasWrapper>
      
      {displayStatus && (
        <StatusOverlay status={displayStatus} theme={theme} />
      )}
      
      {renderGameOver()}
      
      {code && code !== 'create' && code !== 'quickplay' && !isGameReady && (
          <div style={{
            position: 'absolute',
            top: '10px',
            left: '50%',
            transform: 'translateX(-50%)',
            backgroundColor: 'rgba(0,0,0,0.7)',
            padding: '10px 20px',
            borderRadius: '10px',
            color: 'white',
            fontSize: '1.2rem',
            zIndex: 100
          }}>
            Room Code: <strong>{code}</strong>
          </div>
      )}

      <ScoreBoard theme={theme}>
        {myPlayerIndex !== null && <div>You: P{myPlayerIndex}</div>}
        {originalPlayers
          .filter((p): p is Player => p !== null)
          .map((p) => (
            <div key={p.index}>
              P{p.index}: {String(p.score).padStart(3, ' ')}
            </div>
          ))}
      </ScoreBoard>

      {isMobileView && (
        <MobileControlsContainer theme={theme}>
          <ControlButton
            theme={theme}
            isActive={leftActive}
            onTouchStart={handleTouchStart('ArrowLeft')}
            onTouchEnd={handleTouchEnd}
            disabled={!isGameActive}
          >
            ◀
          </ControlButton>
          <ControlButton
            theme={theme}
            isActive={rightActive}
            onTouchStart={handleTouchStart('ArrowRight')}
            onTouchEnd={handleTouchEnd}
            disabled={!isGameActive}
          >
            ▶
          </ControlButton>
        </MobileControlsContainer>
      )}
    </>
  );
};
