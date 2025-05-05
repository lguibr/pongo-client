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
// Corrected import path if usePlayerRotation is in utils/rotation.ts
import { usePlayerRotation } from './utils/rotation';
import { useWindowSize } from './hooks/useWindowSize';
import GlobalStyle from './styles/GlobalStyle';
import theme from './styles/theme';

// --- Styled Components ---
const AppContainer = styled.div<{ theme: DefaultTheme }>`
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
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
  min-height: 0;
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
  flex-shrink: 0;
  z-index: 30;
  user-select: none;
  -webkit-user-select: none;
  -webkit-tap-highlight-color: transparent;
`;

// Add isActive prop for styling
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
  transform: ${({ isActive }) => isActive ? 'scale(0.98)' : 'scale(1)'}; /* Apply scale when active */

  &:first-child {
    border-right: 1px solid ${({ theme }) => theme.colors.mobileButtonBorder};
  }

  /* Keep :active for immediate feedback, but rely on isActive for sustained visual state */
  &:active {
    background-color: ${({ theme }) => theme.colors.mobileButtonBackgroundActive};
    transform: scale(0.98);
  }
`;


// --- App Component ---

function AppContent() {
  const { width } = useWindowSize();
  const isMobileView = useMemo(() => width < 1024, [width]);
  const lastSentMobileLogicalDir = useRef<DirectionMessage['direction'] | null>(null);
  const lastSentLogicalKeyboardDir = useRef<DirectionMessage['direction'] | null>(null);
  const [leftActive, setLeftActive] = useState(false); // State for button visual feedback
  const [rightActive, setRightActive] = useState(false); // State for button visual feedback

  // --- WebSocket Connection ---
  const { sendMessage, lastMessage, readyState } = useWebSocket(WEBSOCKET_URL, {
    shouldReconnect: () => true,
    reconnectInterval: 3000,
    filter: (msg): msg is MessageEvent<string> =>
      typeof msg.data === 'string' && msg.data.startsWith('{'),
  });

  // --- Game State Management ---
  const {
    originalPlayers,
    originalPaddles,
    originalBalls,
    brickStates,
    cellSize,
    myPlayerIndex,
    gameOverInfo,
  } = useGameState(lastMessage);

  // --- Rotation Angle Calculation ---
  const rotationDegrees = usePlayerRotation(myPlayerIndex);
  const rotationRadians = useMemo(() => THREE.MathUtils.degToRad(rotationDegrees), [rotationDegrees]);

  // --- Connection Status Logic ---
  const connectionStatus = useMemo(() => {
    switch (readyState) {
      case ReadyState.CONNECTING: return ReadyState.CONNECTING;
      case ReadyState.OPEN: return ReadyState.OPEN;
      case ReadyState.CLOSING: return ReadyState.CLOSING;
      case ReadyState.CLOSED: return ReadyState.CLOSED;
      case ReadyState.UNINSTANTIATED: return ReadyState.CONNECTING; // Treat uninstantiated as connecting
      default: return 'error'; // Custom error state
    }
  }, [readyState]);

  const isGameActive = connectionStatus === ReadyState.OPEN && !gameOverInfo; // Game is active if connected and not over
  const isGameReady = isGameActive && brickStates.length > 0 && cellSize > 0;

  const displayStatus = useMemo(() => {
    if (gameOverInfo) return null;
    if (isGameReady) return null;
    if (connectionStatus === ReadyState.OPEN && !isGameReady) return 'waiting'; // Custom waiting state
    if (connectionStatus === ReadyState.OPEN) return null; // Don't show overlay if open but not ready yet (handled by 'waiting')
    return connectionStatus; // Return ReadyState enum value or 'error'
  }, [connectionStatus, isGameReady, gameOverInfo]);

  // --- Input Logic ---

  // Callback to send the final logical direction message
  const sendLogicalDirectionMessage = useCallback(
    (logicalDir: DirectionMessage['direction'], source: 'kb' | 'mobile') => {
      if (!isGameActive) return; // Use isGameActive check

      // Prevent sending duplicate commands from the *same source*
      if (source === 'kb') {
        if (logicalDir === lastSentLogicalKeyboardDir.current) return;
        lastSentLogicalKeyboardDir.current = logicalDir;
      } else { // mobile
        if (logicalDir === lastSentMobileLogicalDir.current) return;
        lastSentMobileLogicalDir.current = logicalDir;
      }

      // console.log(`[Input App] Sending Logical: ${logicalDir} from ${source} (Player: ${myPlayerIndex})`); // Removed log
      sendMessage(JSON.stringify({ direction: logicalDir }));
    },
    [isGameActive, sendMessage, myPlayerIndex] // Use isGameActive
  );

  // Mapping function
  const mapDirection = useCallback((visualDir: VisualDirection): DirectionMessage['direction'] => {
    if (visualDir === 'Stop') return 'Stop';

    // Determine if the direction needs to be swapped based on the player index.
    // Players 0 (Right side, rotated 270deg) and 1 (Top side, rotated 180deg)
    // need their visual left/right controls swapped to match the backend's expectation.
    const needsSwap = myPlayerIndex === 0 || myPlayerIndex === 1;

    if (needsSwap) {
      // Swap: Visual Left becomes Logical Right, Visual Right becomes Logical Left
      return visualDir === 'ArrowLeft' ? 'ArrowRight' : 'ArrowLeft';
    } else {
      // No Swap: Players 2 (Left side, rotated 90deg) and 3 (Bottom side, rotated 0deg)
      // Visual Left is Logical Left, Visual Right is Logical Right
      return visualDir;
    }
    // Add myPlayerIndex back as a dependency
  }, [myPlayerIndex]);


  // Handler for visual direction changes from the keyboard hook
  const handleKeyboardVisualChange = useCallback((visualDir: VisualDirection) => {
    // Update button active state based on keyboard
    setLeftActive(visualDir === 'ArrowLeft');
    setRightActive(visualDir === 'ArrowRight');

    // Map and send logical direction
    const logicalDir = mapDirection(visualDir);
    sendLogicalDirectionMessage(logicalDir, 'kb');
  }, [mapDirection, sendLogicalDirectionMessage]);

  // Keyboard Input Hook - Now always enabled when game is active
  useInputHandler({
    isEnabled: isGameActive, // Enable hook whenever game is active
    onVisualDirectionChange: handleKeyboardVisualChange,
  });

  // --- Mobile Button Handlers ---
  const handleTouchStart = useCallback((visualDir: 'ArrowLeft' | 'ArrowRight') => (e: React.TouchEvent) => {
    e.preventDefault();
    // Set active state for the pressed button
    if (visualDir === 'ArrowLeft') setLeftActive(true);
    if (visualDir === 'ArrowRight') setRightActive(true);

    const logicalDir = mapDirection(visualDir);
    sendLogicalDirectionMessage(logicalDir, 'mobile');
  }, [mapDirection, sendLogicalDirectionMessage]);

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    e.preventDefault();
    // Deactivate both buttons on release
    setLeftActive(false);
    setRightActive(false);

    const logicalDir = mapDirection('Stop');
    sendLogicalDirectionMessage(logicalDir, 'mobile');
  }, [mapDirection, sendLogicalDirectionMessage]);


  // --- Render Logic ---
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
            wsStatus={connectionStatus === ReadyState.OPEN ? 'open' : 'closed'} // Simplify status for canvas
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
        {/* Simplified condition: Render overlay if displayStatus is truthy */}
        {displayStatus && (
          <StatusOverlay status={displayStatus} theme={theme} />
        )}
        {renderGameOver()}
      </CanvasArea>

      {/* Mobile Controls - Render based on viewport, enable based on game state */}
      {isMobileView && (
        <MobileControlsContainer theme={theme}>
          <ControlButton
            theme={theme}
            isActive={leftActive} // Pass active state
            onTouchStart={isGameActive ? handleTouchStart('ArrowLeft') : undefined} // Only handle if game active
            onTouchEnd={isGameActive ? handleTouchEnd : undefined}
            // Disable button visually if game not active
            disabled={!isGameActive}
            style={{ cursor: isGameActive ? 'pointer' : 'not-allowed' }}
          >
            ◀
          </ControlButton>
          <ControlButton
            theme={theme}
            isActive={rightActive} // Pass active state
            onTouchStart={isGameActive ? handleTouchStart('ArrowRight') : undefined} // Only handle if game active
            onTouchEnd={isGameActive ? handleTouchEnd : undefined}
            // Disable button visually if game not active
            disabled={!isGameActive}
            style={{ cursor: isGameActive ? 'pointer' : 'not-allowed' }}
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
      <GlobalStyle />
      <AppContent />
    </ThemeProvider>
  );
}