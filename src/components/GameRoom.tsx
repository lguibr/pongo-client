import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import * as THREE from 'three';
import styled, { DefaultTheme } from 'styled-components';

import R3FCanvas from './R3FCanvas';
import StatusOverlay from './StatusOverlay';
import { 
  DirectionMessage, 
  Player, 
  VisualDirection, 
} from '../types/game';
import { useInputHandler } from '../hooks/useInputHandler';
import { usePlayerRotation } from '../utils/rotation';
import { getPlayerColorName } from '../utils/colors';
import { useWindowSize } from '../hooks/useWindowSize';
import { useGame } from '../context/GameContext';

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
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
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

const LobbyOverlay = styled.div<{ theme: DefaultTheme }>`
  position: absolute;
  top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(0,0,0,0.85);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: ${({ theme }) => theme.colors.text};
  z-index: 40;
  h2 { font-size: 2.5rem; margin-bottom: 2rem; color: ${({ theme }) => theme.colors.accent}; }
  ul { list-style: none; padding: 0; width: 300px; }
  li { 
    display: flex; 
    justify-content: space-between; 
    padding: 10px; 
    border-bottom: 1px solid rgba(255,255,255,0.1);
    font-size: 1.2rem;
  }
`;

const ReadyButton = styled.button<{ theme: DefaultTheme; $isReady: boolean }>`
  padding: 15px 40px;
  font-size: 1.5rem;
  background-color: ${({ theme, $isReady }) => $isReady ? theme.colors.success : theme.colors.primary};
  color: white;
  border: none;
  border-radius: 8px;
  cursor: pointer;
  margin-top: 30px;
  transition: transform 0.1s;
  
  &:hover {
    transform: scale(1.05);
    opacity: 0.9;
  }
  &:active {
    transform: scale(0.95);
  }
`;

const CountdownOverlay = styled.div<{ theme: DefaultTheme }>`
  position: absolute;
  top: 0; left: 0; right: 0; bottom: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0,0,0,0.5);
  z-index: 45;
  font-size: 10rem;
  font-weight: bold;
  color: ${({ theme }) => theme.colors.accent};
  text-shadow: 0 0 20px ${({ theme }) => theme.colors.accent};
  animation: pulse 1s infinite;

  @keyframes pulse {
    0% { transform: scale(1); opacity: 1; }
    50% { transform: scale(1.2); opacity: 0.8; }
    100% { transform: scale(1); opacity: 1; }
  }
`;

interface GameRoomProps {
  theme: DefaultTheme;
  volume: number;
  resumeContext: () => void;
  createRoom?: boolean; // Deprecated/Unused in this refactor but kept for prop compat
  quickPlay?: boolean; // Deprecated/Unused
}

export const GameRoom: React.FC<GameRoomProps> = ({ theme, resumeContext }) => {
  const { code } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const { width } = useWindowSize();
  const isMobileView = useMemo(() => width < 768, [width]);

  const lastSentMobileLogicalDir = useRef<DirectionMessage['direction'] | null>(null);
  const lastSentLogicalKeyboardDir = useRef<DirectionMessage['direction'] | null>(null);
  const [leftActive, setLeftActive] = useState(false);
  const [rightActive, setRightActive] = useState(false);
  
  const { sendMessage, gameState, connectionStatus } = useGame();

  const {
    originalPlayers,
    originalPaddles,
    originalBalls,
    brickStates,
    cellSize,
    myPlayerIndex,
    gameOverInfo,
    phase,
    lobbyPlayers,
    countdownSeconds,
  } = gameState;

  const rotationDegrees = usePlayerRotation(myPlayerIndex);
  const rotationRadians = useMemo(() => THREE.MathUtils.degToRad(rotationDegrees), [rotationDegrees]);

  const isGameActive = connectionStatus === 'open' && !gameOverInfo && phase === 'playing';

  const displayStatus = useMemo(() => {
    console.log('[GameRoom] displayStatus calc:', { connectionStatus, phase, gameOverInfo });
    if (connectionStatus !== 'open') return 'waiting';
    if (gameOverInfo) return null;
    if (phase === 'lobby' || phase === 'countingDown') return null; // Should be in LobbyScreen, but if we are here, maybe just show waiting?
    if (connectionStatus === 'open' && phase === 'playing') return null;
    return connectionStatus;
  }, [connectionStatus, phase, gameOverInfo]);

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

  const toggleReady = () => {
    const me = lobbyPlayers.find(p => p.index === myPlayerIndex);
    const newReadyState = !me?.isReady;
    sendMessage(JSON.stringify({ messageType: 'playerReady', isReady: newReadyState }));
    resumeContext(); // Ensure audio context is resumed on user interaction
  };

  const renderLobby = () => {
    if (phase !== 'lobby') return null;
    const me = lobbyPlayers.find(p => p.index === myPlayerIndex);
    return (
      <LobbyOverlay theme={theme}>
        <h2>Lobby</h2>
        <ul>
          {lobbyPlayers.map(p => (
            <li key={p.index} style={{ color: p.isReady ? theme.colors.success : theme.colors.text }}>
              <span>{getPlayerColorName(p.index)} {p.index === myPlayerIndex ? '(You)' : ''}</span>
              <span>{p.isReady ? 'READY' : 'WAITING'}</span>
            </li>
          ))}
          {/* Show placeholders for empty slots? */}
          {Array.from({ length: 4 - lobbyPlayers.length }).map((_, i) => (
             <li key={`empty-${i}`} style={{ opacity: 0.5 }}>
               <span>Waiting for player...</span>
             </li>
          ))}
        </ul>
        <ReadyButton theme={theme} $isReady={!!me?.isReady} onClick={toggleReady}>
          {me?.isReady ? 'Ready!' : 'Click to Ready'}
        </ReadyButton>
        <div style={{ marginTop: '20px', fontSize: '0.9rem', opacity: 0.7 }}>
          Room Code: {code}
        </div>
      </LobbyOverlay>
    );
  };

  const renderCountdown = () => {
    if (phase !== 'countingDown' || countdownSeconds === null) return null;
    return (
      <CountdownOverlay theme={theme}>
        {countdownSeconds}
      </CountdownOverlay>
    );
  };

  const renderGameOver = () => {
    if (!gameOverInfo) return null;
    const winnerText =
      gameOverInfo.winnerIndex === -1
        ? 'It\'s a Tie!'
        : `${getPlayerColorName(gameOverInfo.winnerIndex)} Wins!`;
    return (
      <GameOverOverlay theme={theme}>
        <h2>Game Over!</h2>
        <p>{winnerText}</p>
        <p>Reason: {gameOverInfo.reason}</p>
        <p>Final Scores:</p>
        <ul>
          {gameOverInfo.finalScores.map((score, index) => (
            <li key={index}>
              {getPlayerColorName(index)}: {score}
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
        {connectionStatus === 'open' && (
          <R3FCanvas
            brickStates={brickStates}
            cellSize={cellSize}
            paddles={originalPaddles}
            balls={originalBalls}
            rotationAngle={rotationRadians}
            wsStatus={connectionStatus === 'open' ? 'open' : 'closed'}
          />
        )}
      </GameCanvasWrapper>
      
      {renderLobby()}
      {renderCountdown()}

      {displayStatus && (
        <StatusOverlay status={displayStatus} theme={theme} />
      )}
      
      {renderGameOver()}
      
      {code && phase === 'playing' && (
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
        {myPlayerIndex !== null && <div>{getPlayerColorName(myPlayerIndex)} (You)</div>}
        {originalPlayers
          .filter((p): p is Player => p !== null)
          .map((p) => (
            <div key={p.index}>
              {getPlayerColorName(p.index)}: {String(p.score).padStart(3, ' ')}
            </div>
          ))}
      </ScoreBoard>

      {isMobileView && phase === 'playing' && (
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
