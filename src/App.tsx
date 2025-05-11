// File: src/App.tsx
import { useCallback, useMemo, useState, useRef, useEffect } from 'react';
import styled, { DefaultTheme, ThemeProvider, keyframes } from 'styled-components';
import useWebSocket, { ReadyState } from 'react-use-websocket';
import * as THREE from 'three';

import R3FCanvas from './components/R3FCanvas';
import StatusOverlay from './components/StatusOverlay';
import { WEBSOCKET_URL } from './utils/constants';
import { DirectionMessage, Player, VisualDirection } from './types/game';
import { useInputHandler } from './hooks/useInputHandler';
import { useGameState } from './hooks/useGameState';
import { usePlayerRotation } from './utils/rotation';
import { useWindowSize } from './hooks/useWindowSize';
import theme from './styles/theme';
import { useSoundManager } from './hooks/useSoundManager';

// --- Keyframes for Animations ---
const logoShakeAnimation = keyframes`
  0%, 100% { transform: rotate(0deg); }
  10%, 30%, 50%, 70%, 90% { transform: rotate(-2deg); }
  20%, 40%, 60%, 80% { transform: rotate(2deg); }
`;

// --- Styled Components ---
const AppContainer = styled.div<{ theme: DefaultTheme }>`
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background-color: ${({ theme }) => theme.colors.background};
  padding-top: env(safe-area-inset-top, 0px);
  padding-right: env(safe-area-inset-right, 0px);
  padding-bottom: env(safe-area-inset-bottom, 0px);
  padding-left: env(safe-area-inset-left, 0px);
`;

const Header = styled.header<{ theme: DefaultTheme }>`
  height: ${({ theme }) => theme.sizes.headerHeight};
  display: flex;
  align-items: center;
  justify-content: space-between; /* Keep space-between for sound toggle */
  padding: 0 20px; /* Increased padding */
  z-index: 10;
  flex-shrink: 0;
  position: relative; /* For absolute positioning of sound toggle if needed, or centering logo */
`;

const LogoContainer = styled.div`
  display: flex;
  align-items: center;
  /* Centering the logo container itself if it's the main middle element */
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
`;

const Logo = styled.img<{ animate: boolean }>`
  height: 35px; /* Slightly larger logo */
  margin-right: 12px;
  animation: ${({ animate }) => (animate ? logoShakeAnimation : 'none')} 0.5s ease-in-out;
`;

const Title = styled.h1<{ theme: DefaultTheme }>`
  font-size: ${({ theme }) => theme.fonts.sizes.title};
  font-weight: 600; /* Bolder title */
  color: ${({ theme }) => theme.colors.text}; /* Brighter title */
  text-shadow: 0 0 5px ${({ theme }) => theme.colors.accentGlow};
`;

const SoundToggle = styled.button<{ theme: DefaultTheme }>`
  background: none;
  border: none;
  color: ${({ theme }) => theme.colors.text};
  font-size: 1.8em; /* Larger toggle */
  cursor: pointer;
  padding: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0.8;
  transition: opacity 0.2s;
  margin-left: auto; /* Pushes to the right */

  &:hover {
    opacity: 1;
  }
`;

const CanvasArea = styled.div<{ theme: DefaultTheme }>`
  position: relative;
  flex-grow: 1;
  min-height: 0;
  display: flex;
  justify-content: center;
  align-items: center;
  padding: ${({ theme }) => theme.sizes.minScreenPadding};
  overflow: hidden;
`;

const ScoreBoard = styled.div<{ theme: DefaultTheme }>`
  position: absolute;
  top: 20px; /* Increased spacing from top */
  left: 20px; /* Increased spacing from left */
  z-index: 20;
  background: ${({ theme }) => theme.colors.scoreboardBackground};
  padding: 12px 18px; /* Increased padding */
  border-radius: ${({ theme }) => theme.sizes.borderRadius};
  border: 1px solid ${({ theme }) => theme.colors.scoreboardBorder};
  font-size: ${({ theme }) => theme.fonts.sizes.score};
  font-family: ${({ theme }) => theme.fonts.monospace};
  color: ${({ theme }) => theme.colors.text};
  box-shadow: ${({ theme }) => theme.shadows.scoreboard};
  line-height: 1.5; /* Increased line height for readability */
  font-weight: 500; /* Slightly bolder score text */

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
  background-color: rgba(0, 0, 0, 0.8); /* Darker overlay */
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  color: ${({ theme }) => theme.colors.text};
  z-index: 50;
  text-align: center;
  h2 { font-size: 3em; margin-bottom: 25px; color: ${({ theme }) => theme.colors.accent}; }
  p { font-size: 1.3em; margin-bottom: 18px; }
  ul { list-style: none; padding: 0; margin-top: 12px; }
  li { margin-bottom: 6px; font-size: 1.1em; }
`;

const MobileControlsContainer = styled.div<{ theme: DefaultTheme }>`
  height: ${({ theme }) => theme.sizes.mobileControlsHeight};
  display: flex;
  flex-shrink: 0;
  z-index: 30;
  user-select: none;
  -webkit-user-select: none;
  -webkit-tap-highlight-color: transparent;
`;

const ControlButton = styled.button<{ theme: DefaultTheme; isActive: boolean }>`
  flex: 1;
  height: 100%;
  display: flex;
  justify-content: center;
  align-items: center;
  background-color: ${({ theme, isActive }) => isActive ? theme.colors.mobileButtonBackgroundActive : theme.colors.mobileButtonBackground};
  border: none;
  border-top: 1px solid ${({ theme }) => theme.colors.mobileButtonBorder};
  color: ${({ theme }) => theme.colors.mobileButtonSymbol};
  font-size: ${({ theme }) => theme.fonts.sizes.mobileButtonSymbol};
  font-weight: bold;
  cursor: pointer;
  transition: background-color 0.1s ease-out, transform 0.05s ease-out;
  outline: none;
  transform: ${({ isActive }) => isActive ? 'scale(0.98)' : 'scale(1)'};

  &:first-child {
    border-right: 1px solid ${({ theme }) => theme.colors.mobileButtonBorder};
  }

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

function AppContent() {
  const { width } = useWindowSize();
  const isMobileView = useMemo(() => width < 1024, [width]);
  const lastSentMobileLogicalDir = useRef<DirectionMessage['direction'] | null>(null);
  const lastSentLogicalKeyboardDir = useRef<DirectionMessage['direction'] | null>(null);
  const [leftActive, setLeftActive] = useState(false);
  const [rightActive, setRightActive] = useState(false);
  const [animateLogo, setAnimateLogo] = useState(false);

  const { playSound, toggleMute, isMuted, isLoading: soundsLoading, error: soundError } = useSoundManager();

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
  } = useGameState(lastMessage, playSound);

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
    if (gameOverInfo) return null;
    if (isGameReady) return null;
    if (connectionStatus === ReadyState.OPEN && !isGameReady) return 'waiting';
    if (connectionStatus === ReadyState.OPEN) return null;
    return connectionStatus;
  }, [connectionStatus, isGameReady, gameOverInfo]);

  // Logo animation trigger
  useEffect(() => {
    const intervalId = setInterval(() => {
      setAnimateLogo(true);
      setTimeout(() => setAnimateLogo(false), 500); // Duration of animation
    }, 15000); // Trigger every 15 seconds

    return () => clearInterval(intervalId);
  }, []);

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
      sendMessage(JSON.stringify({ direction: logicalDir }));
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
    if (!isGameActive) return;
    if (visualDir === 'ArrowLeft') setLeftActive(true);
    if (visualDir === 'ArrowRight') setRightActive(true);
    const logicalDir = mapDirection(visualDir);
    sendLogicalDirectionMessage(logicalDir, 'mobile');
  }, [mapDirection, sendLogicalDirectionMessage, isGameActive]);

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
      </GameOverOverlay>
    );
  };

  useEffect(() => {
    if (soundsLoading) {
      console.log('Sounds loading...');
    } else if (soundError) {
      console.error('Sound loading error:', soundError);
    } else {
      console.log('Sounds loaded successfully.');
    }
  }, [soundsLoading, soundError]);


  return (
    <AppContainer theme={theme}>
      <Header theme={theme}>
        <LogoContainer>
          <Logo src="/bitmap.png" alt="PonGo Logo" animate={animateLogo} />
          <Title theme={theme}>PonGo</Title>
        </LogoContainer>
        <SoundToggle onClick={toggleMute} theme={theme} title={isMuted ? "Unmute" : "Mute"}>
          {isMuted ? '🔇' : '🔊'}
        </SoundToggle>
      </Header>

      <CanvasArea theme={theme}>
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
        {displayStatus && (
          <StatusOverlay status={displayStatus} theme={theme} />
        )}
        {renderGameOver()}
      </CanvasArea>

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
    </AppContainer>
  );
}

export default function App() {
  return (
    <ThemeProvider theme={theme}>
      <AppContent />
    </ThemeProvider>
  );
}