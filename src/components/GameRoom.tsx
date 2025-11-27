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
import { Button } from './common/Button';
import { Typography } from './common/Typography';
import { Avatar } from './common/Avatar';

// Styled Components
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
  padding: 12px;
  z-index: 20;
  background: ${({ theme }) => theme.colors.card}cc;
  backdrop-filter: blur(4px);
  border-radius: ${({ theme }) => theme.sizes.borderRadius};
  border: 1px solid ${({ theme }) => theme.colors.border};
  box-shadow: ${({ theme }) => theme.shadows.scoreboard};
  display: flex;
  flex-direction: column;
  gap: 8px;
`;

const ScoreItem = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
`;

const GameOverOverlay = styled.div<{ theme: DefaultTheme }>`
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: ${({ theme }) => theme.colors.background}f2; // 95% opacity
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  color: ${({ theme }) => theme.colors.foreground};
  z-index: 50;
  text-align: center;
  padding: 20px;
  gap: 1.5rem;
`;

const MobileControlsContainer = styled.div<{ theme: DefaultTheme }>`
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: var(--controls-height);
  display: flex;
  gap: 1rem;
  padding: 1rem;
  flex-shrink: 0;
  z-index: 30;
  user-select: none;
  -webkit-user-select: none;
  -webkit-tap-highlight-color: transparent;
  justify-content: space-around;
  padding-bottom: max(env(safe-area-inset-bottom, 20px), 20px);
  background: linear-gradient(to top, ${({ theme }) => theme.colors.background}, transparent);
`;

const ControlButton = styled.button<{ theme: DefaultTheme; isActive: boolean }>`
  flex: 1;
  height: 100%;
  display: flex;
  justify-content: center;
  align-items: center;
  background-color: ${({ theme, isActive }) => isActive ? theme.colors.primary : theme.colors.secondary};
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.sizes.borderRadius};
  color: ${({ theme }) => theme.colors.foreground};
  font-size: 2rem;
  font-weight: bold;
  cursor: pointer;
  transition: all 0.1s ease-out;
  outline: none;
  transform: ${({ isActive }) => isActive ? 'scale(0.98)' : 'scale(1)'};
  box-shadow: 0 4px 0 ${({ theme }) => theme.colors.background};

  &:active {
    transform: scale(0.98);
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
  color: ${({ theme }) => theme.colors.primary};
  text-shadow: 0 0 20px ${({ theme }) => theme.colors.primary};
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
    countdownSeconds,
  } = gameState;

  const rotationDegrees = usePlayerRotation(myPlayerIndex);
  const rotationRadians = useMemo(() => THREE.MathUtils.degToRad(rotationDegrees), [rotationDegrees]);

  const isGameActive = connectionStatus === 'open' && !gameOverInfo && phase === 'playing';

  const displayStatus = useMemo(() => {
    if (connectionStatus !== 'open') return 'waiting';
    if (gameOverInfo) return null;
    if (phase === 'lobby' || phase === 'countingDown') return null;
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
        <Typography variant="h1" style={{ color: theme.colors.primary }}>Game Over!</Typography>
        <Typography variant="h2">{winnerText}</Typography>
        <Typography variant="body">Reason: {gameOverInfo.reason}</Typography>
        
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', width: '100%', maxWidth: '300px' }}>
          <Typography variant="h3" align="center">Final Scores</Typography>
          {gameOverInfo.finalScores.map((score, index) => (
            <div key={index} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px', background: theme.colors.muted, borderRadius: '4px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Avatar playerIndex={index} size="sm" />
                <Typography>{getPlayerColorName(index)}</Typography>
              </div>
              <Typography style={{ fontWeight: 'bold' }}>{score}</Typography>
            </div>
          ))}
        </div>

        <Button onClick={() => navigate('/')} size="lg" style={{ marginTop: '20px' }}>
          Back to Menu
        </Button>
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
            backgroundColor: theme.colors.card,
            padding: '8px 16px',
            borderRadius: '20px',
            border: `1px solid ${theme.colors.border}`,
            color: theme.colors.foreground,
            fontSize: '1rem',
            zIndex: 100,
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
          }}>
            <span style={{ opacity: 0.7 }}>Room Code:</span>
            <span style={{ fontWeight: 'bold', letterSpacing: '0.05em' }}>{code}</span>
          </div>
      )}

      <ScoreBoard theme={theme}>
        {myPlayerIndex !== null && (
          <ScoreItem>
            <Avatar playerIndex={myPlayerIndex} size="sm" />
            <Typography variant="caption" style={{ fontWeight: 'bold' }}>You</Typography>
          </ScoreItem>
        )}
        {originalPlayers
          .filter((p): p is Player => p !== null)
          .map((p) => (
            <ScoreItem key={p.index}>
              <Avatar playerIndex={p.index} size="sm" />
              <Typography style={{ fontFamily: theme.fonts.monospace }}>
                {String(p.score).padStart(3, ' ')}
              </Typography>
            </ScoreItem>
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
