
// File: src/App.tsx
import { useCallback, useMemo, useState, useRef } from 'react';
import styled, { DefaultTheme, ThemeProvider } from 'styled-components';
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

// --- Styled Components ---
const AppContainer = styled.div<{ theme: DefaultTheme }>`
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%; /* Fill the #root element which has dynamic height */
  overflow: hidden;
  background-color: ${({ theme }) => theme.colors.background};
`;
const Header = styled.header<{ theme: DefaultTheme }>`
  height: ${({ theme }) => theme.sizes.headerHeight};
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10;
  flex-shrink: 0;
`;
const Logo = styled.img`
  height: 30px;
  margin-right: 10px;
`;
const Title = styled.h1<{ theme: DefaultTheme }>`
  font-size: ${({ theme }) => theme.fonts.sizes.title};
  font-weight: 500;
  color: ${({ theme }) => theme.colors.textDim};
`;
const CanvasArea = styled.div<{ theme: DefaultTheme }>`
  position: relative;
  flex-grow: 1;
  min-height: 0; /* Important for flex-grow to work correctly in a flex column */
  display: flex;
  justify-content: center;
  align-items: center;
  padding: ${({ theme }) => theme.sizes.minScreenPadding};
  overflow: hidden;
`;
const ScoreBoard = styled.div<{ theme: DefaultTheme }>`
  position: absolute;
  top: 15px;
  left: 15px;
  z-index: 20;
  background: ${({ theme }) => theme.colors.scoreboardBackground};
  padding: 10px 15px;
  border-radius: ${({ theme }) => theme.sizes.borderRadius};
  border: 1px solid ${({ theme }) => theme.colors.scoreboardBorder};
  font-size: ${({ theme }) => theme.fonts.sizes.score};
  font-family: ${({ theme }) => theme.fonts.monospace};
  color: ${({ theme }) => theme.colors.text};
  box-shadow: ${({ theme }) => theme.shadows.scoreboard};
  line-height: 1.4;

  div {
    margin-bottom: 4px;
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
  background-color: rgba(0, 0, 0, 0.75);
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  color: ${({ theme }) => theme.colors.text};
  z-index: 50;
  text-align: center;
  h2 { font-size: 2.5em; margin-bottom: 20px; color: ${({ theme }) => theme.colors.accent}; }
  p { font-size: 1.2em; margin-bottom: 15px; }
  ul { list-style: none; padding: 0; margin-top: 10px; }
  li { margin-bottom: 5px; }
`;
const MobileControlsContainer = styled.div<{ theme: DefaultTheme }>`
  height: ${({ theme }) => theme.sizes.mobileControlsHeight};
  display: flex;
  flex-shrink: 0; /* Prevent shrinking */
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


// --- App Component ---

function AppContent() {
  const { width } = useWindowSize();
  const isMobileView = useMemo(() => width < 1024, [width]);
  const lastSentMobileLogicalDir = useRef<DirectionMessage['direction'] | null>(null);
  const lastSentLogicalKeyboardDir = useRef<DirectionMessage['direction'] | null>(null);
  const [leftActive, setLeftActive] = useState(false);
  const [rightActive, setRightActive] = useState(false);

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
  } = useGameState(lastMessage);

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
    [isGameActive, sendMessage] // Removed myPlayerIndex as it's not directly used here
  );

  const mapDirection = useCallback((visualDir: VisualDirection): DirectionMessage['direction'] => {
    if (visualDir === 'Stop') return 'Stop';
    const needsSwap = myPlayerIndex === 0 || myPlayerIndex === 1;
    if (needsSwap) {
      return visualDir === 'ArrowLeft' ? 'ArrowRight' : 'ArrowLeft';
    } else {
      return visualDir;
    }
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
    if (!isGameActive) return; // Check if game is active before processing touch
    if (visualDir === 'ArrowLeft') setLeftActive(true);
    if (visualDir === 'ArrowRight') setRightActive(true);
    const logicalDir = mapDirection(visualDir);
    sendLogicalDirectionMessage(logicalDir, 'mobile');
  }, [mapDirection, sendLogicalDirectionMessage, isGameActive]); // Added isGameActive

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    e.preventDefault();
    if (!isGameActive) return; // Check if game is active
    setLeftActive(false);
    setRightActive(false);
    const logicalDir = mapDirection('Stop');
    sendLogicalDirectionMessage(logicalDir, 'mobile');
  }, [mapDirection, sendLogicalDirectionMessage, isGameActive]); // Added isGameActive

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

  return (
    <AppContainer theme={theme}>
      <Header theme={theme}>
        <Logo src="/bitmap.png" alt="PonGo Logo" />
        <Title theme={theme}>PonGo</Title>
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
            disabled={!isGameActive} // Disable button if game not active
          >
            ◀
          </ControlButton>
          <ControlButton
            theme={theme}
            isActive={rightActive}
            onTouchStart={handleTouchStart('ArrowRight')}
            onTouchEnd={handleTouchEnd}
            disabled={!isGameActive} // Disable button if game not active
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
      {/* GlobalStyle is applied once here, affecting the whole app including AppContent */}
      {/* No need to pass theme to AppContainer if ThemeProvider is already wrapping it */}
      <AppContent />
    </ThemeProvider>
  );
}