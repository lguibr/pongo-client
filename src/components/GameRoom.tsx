import React, { useCallback, useMemo, useRef, useEffect } from 'react';
import nipplejs from 'nipplejs';
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
import { getPlayerColorName, getPaddleColorByPlayerIndex } from '../utils/colors';
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

const JoystickZone = styled.div`
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  z-index: 40; /* Above canvas but below overlays */
  touch-action: none; /* Prevent scrolling */
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
  // Check for touch capability instead of just screen width
  const isTouchDevice = useMemo(() => {
    return (('ontouchstart' in window) ||
      (navigator.maxTouchPoints > 0));
  }, []);

  const lastSentMobileLogicalDir = useRef<DirectionMessage['direction'] | null>(null);
  const lastSentLogicalKeyboardDir = useRef<DirectionMessage['direction'] | null>(null);
  
  const { sendMessage, gameState, connectionStatus, sessionId } = useGame();

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

  // --- Reconnection / Join Logic ---
  const hasSentJoinRequest = useRef(false);

  // Reset request flag if connection drops
  useEffect(() => {
    if (connectionStatus !== 'open') {
      hasSentJoinRequest.current = false;
    }
  }, [connectionStatus]);

  useEffect(() => {
    if (connectionStatus === 'open' && code && !hasSentJoinRequest.current) {
      // If we are not yet assigned a player index (or if we are reconnecting), try to join.
      // Even if we have an index, sending joinRoom is safe/idempotent.
      console.log(`[GameRoom] Sending joinRoom request for ${code}`);
      
      const req = { 
        messageType: 'joinRoom', 
        code, 
        sessionId 
      };
      sendMessage(JSON.stringify(req));
      hasSentJoinRequest.current = true;
    }
  }, [connectionStatus, code, sendMessage, sessionId]);

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
    const logicalDir = mapDirection(visualDir);
    sendLogicalDirectionMessage(logicalDir, 'kb');
  }, [mapDirection, sendLogicalDirectionMessage]);

  useInputHandler({
    isEnabled: isGameActive,
    onVisualDirectionChange: handleKeyboardVisualChange,
  });

  // Nipple.js Integration
  const joystickManagerRef = useRef<nipplejs.JoystickManager | null>(null);
  const joystickZoneRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isTouchDevice || phase !== 'playing' || !joystickZoneRef.current) return;

    // Initialize nipplejs
    const manager = nipplejs.create({
      zone: joystickZoneRef.current,
      mode: 'dynamic',
      color: getPaddleColorByPlayerIndex(myPlayerIndex ?? 0),
      size: 100,
      threshold: 0.1,
      fadeTime: 250,
      multitouch: false, // Single joystick
    });

    joystickManagerRef.current = manager;

    manager.on('move', (_, data) => {
      resumeContext();
      if (!isGameActive) return;

      // data.vector.x is between -1 and 1 (mostly)
      // nipplejs provides angle and force too, but vector is convenient
      const x = data.vector.x;
      const threshold = 0.2;

      let visualDir: VisualDirection = 'Stop';
      if (x < -threshold) {
        visualDir = 'ArrowLeft';
      } else if (x > threshold) {
        visualDir = 'ArrowRight';
      }

      const logicalDir = mapDirection(visualDir);
      sendLogicalDirectionMessage(logicalDir, 'mobile');
    });

    manager.on('end', () => {
      if (!isGameActive) return;
      const logicalDir = mapDirection('Stop');
      sendLogicalDirectionMessage(logicalDir, 'mobile');
    });

    return () => {
      manager.destroy();
      joystickManagerRef.current = null;
    };
  }, [isTouchDevice, phase, theme.colors.primary, isGameActive, mapDirection, sendLogicalDirectionMessage, resumeContext]);

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

      {isTouchDevice && phase === 'playing' && (
        <JoystickZone ref={joystickZoneRef} />
      )}
    </>
  );
};
