// File: src/App.tsx
import { useState, useEffect, useCallback, useMemo } from 'react';
import styled from 'styled-components';
import useWebSocket, { ReadyState } from 'react-use-websocket';

import GameCanvas from './components/GameCanvas';
import { WEBSOCKET_URL } from './utils/constants';
import {
  DirectionMessage,
  GameStateUpdateMessage,
  PlayerAssignmentMessage,
  InitialGridStateMessage,
  GameOverMessage,
  IncomingMessage, // Union type
  isPlayerAssignment, // Type guards
  isInitialGridState,
  isGameStateUpdate,
  isGameOver,
  Player,
  Paddle,
  Ball,
  Grid,
} from './types/game';
import { useWindowSize } from './hooks/useWindowSize';
import { usePlayerRotation } from './hooks/usePlayerRotation';
import { useInputHandler } from './hooks/useInputHandler';
import { AppTheme } from './styles/theme'; // Import theme type for props
import theme from './styles/theme'; // Import theme for useMemo calculation

// --- Styled Components --- (Using Theme)

const AppContainer = styled.div`
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
`;

const Header = styled.header<{ theme: AppTheme }>`
  height: ${({ theme }) => theme.sizes.headerHeight};
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10; // Ensure header is above canvas elements if needed
`;

const Logo = styled.img`
  height: 30px; // Consider making this themeable
  margin-right: 10px;
`;

const Title = styled.h1<{ theme: AppTheme }>`
  font-size: ${({ theme }) => theme.fonts.sizes.title};
  font-weight: 500;
  color: ${({ theme }) => theme.colors.textDim};
`;

const CanvasArea = styled.div`
  position: relative; // Needed for absolute positioning of ScoreBoard/GameOver
  flex: 1;
  display: flex;
  justify-content: center; // Center canvas horizontally
  align-items: center; // Center canvas vertically
  touch-action: none; // Prevent default touch actions like scrolling/zooming
`;

const ScoreBoard = styled.div<{ theme: AppTheme }>`
  position: absolute;
  top: 10px;
  left: 10px;
  z-index: 20; // Above canvas
  background: ${({ theme }) => theme.colors.scoreboardBackground};
  padding: 5px 10px;
  border-radius: ${({ theme }) => theme.sizes.borderRadius};
  font-size: ${({ theme }) => theme.fonts.sizes.score};
  color: ${({ theme }) => theme.colors.text}; // Use primary text color
`;

const CanvasWrapper = styled.div<{
  $size: number;
  $rotate: number;
  theme: AppTheme;
}>`
  width: ${(p) => p.$size}px;
  height: ${(p) => p.$size}px;
  background: ${({ theme }) => theme.colors.background}; // Use theme background
  box-shadow: ${({ theme }) => theme.shadows.canvas};
  transform: rotate(${(p) => p.$rotate}deg);
  transform-origin: center center;
`;

const GameOverOverlay = styled.div<{ theme: AppTheme }>`
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

  h2 {
    font-size: 2.5em;
    margin-bottom: 20px;
    color: ${({ theme }) => theme.colors.accent};
  }

  p {
    font-size: 1.2em;
    margin-bottom: 15px;
  }

  ul {
    list-style: none;
    padding: 0;
    margin-top: 10px;
  }

  li {
    margin-bottom: 5px;
  }
`;

// --- App Component ---

export default function App() {
  // State for dynamic game elements
  const [players, setPlayers] = useState<(Player | null)[]>([]);
  const [paddles, setPaddles] = useState<(Paddle | null)[]>([]);
  const [balls, setBalls] = useState<(Ball | null)[]>([]);

  // State for static grid/canvas info (received once)
  const [grid, setGrid] = useState<Grid | null>(null);
  const [canvasSize, setCanvasSize] = useState<number>(0);
  const [gridSize, setGridSize] = useState<number>(0);
  const [cellSize, setCellSize] = useState<number>(0);

  // State for client-specific info
  const [myPlayerIndex, setMyPlayerIndex] = useState<number | null>(null);

  // State for game over
  const [gameOverInfo, setGameOverInfo] = useState<GameOverMessage | null>(
    null
  );

  const { width: windowWidth, height: windowHeight } = useWindowSize();
  const rotationDegrees = usePlayerRotation(myPlayerIndex);

  const { sendMessage, lastMessage, readyState } = useWebSocket(WEBSOCKET_URL, {
    shouldReconnect: () => true,
    reconnectInterval: 3000,
    filter: (msg): msg is MessageEvent<string> =>
      typeof msg.data === 'string' && msg.data.startsWith('{'), // Basic JSON filter
  });

  const connectionStatus = useMemo(() => {
    switch (readyState) {
      case ReadyState.CONNECTING: return 'connecting';
      case ReadyState.OPEN: return 'open';
      case ReadyState.CLOSING: return 'closing';
      case ReadyState.CLOSED: return 'closed';
      default: return 'error'; // Assuming UNINSTANTIATED maps to error or similar
    }
  }, [readyState]);

  // Handle incoming WebSocket messages
  useEffect(() => {
    if (!lastMessage?.data) return;
    try {
      const data: IncomingMessage = JSON.parse(lastMessage.data); // Parse into union type

      // Use type guards to handle different messages
      if (isPlayerAssignment(data)) {
        console.log(`Assigning Player Index: ${data.playerIndex}`);
        setMyPlayerIndex(data.playerIndex);
        setGameOverInfo(null); // Reset game over state on new assignment
      } else if (isInitialGridState(data)) {
        console.log('Received Initial Grid State');
        setCanvasSize(data.canvasWidth); // Assuming width=height=canvasSize
        setGridSize(data.gridSize);
        setCellSize(data.cellSize);
        setGrid(data.grid);
      } else if (isGameStateUpdate(data)) {
        // Update dynamic state only if game is not over
        if (!gameOverInfo) {
          setPlayers(data.players);
          setPaddles(data.paddles);
          setBalls(data.balls);
        }
      } else if (isGameOver(data)) {
        console.log('Received Game Over message:', data);
        setGameOverInfo(data);
      } else {
        console.warn('Received unknown message structure:', data);
      }
    } catch (e) {
      console.error('Failed to parse WebSocket message:', e);
    }
  }, [lastMessage, gameOverInfo]); // Add gameOverInfo dependency

  // Callback to send direction messages
  const sendDirectionMessage = useCallback(
    (direction: DirectionMessage['direction']) => {
      if (connectionStatus === 'open' && !gameOverInfo) { // Don't send input if game over
        sendMessage(JSON.stringify({ direction }));
      }
    },
    [connectionStatus, sendMessage, gameOverInfo] // Add gameOverInfo dependency
  );

  // Setup input handling using the custom hook
  useInputHandler({
    isEnabled: connectionStatus === 'open' && !gameOverInfo, // Disable input if game over
    rotationDegrees,
    sendDirection: sendDirectionMessage,
  });

  // Calculate canvas display size based on window dimensions
  const canvasDisplaySize = useMemo(() => {
    const headerHeight = parseInt(theme.sizes.headerHeight, 10) || 50;
    const gap = parseInt(theme.sizes.canvasGap, 10) || 20;
    const availableWidth = windowWidth - gap;
    const availableHeight = windowHeight - headerHeight - gap;
    return Math.max(100, Math.min(availableWidth, availableHeight)); // Ensure a minimum size
  }, [windowWidth, windowHeight]);

  // Calculate scale factor for rendering game elements
  const scaleFactor = useMemo(() => {
    // Use the canvasSize state variable
    return canvasSize > 0 ? canvasDisplaySize / canvasSize : 1;
  }, [canvasSize, canvasDisplaySize]);

  const renderGameOver = () => {
    if (!gameOverInfo) return null;

    const winnerText =
      gameOverInfo.winnerIndex === -1
        ? 'It\'s a Tie!'
        : `Player ${gameOverInfo.winnerIndex} Wins!`;

    return (
      <GameOverOverlay>
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
        {/* Add a button to reconnect/start new game? */}
      </GameOverOverlay>
    );
  };

  return (
    <AppContainer>
      <Header>
        <Logo src="/bitmap.png" alt="PonGo Logo" />
        <Title>PonGo</Title>
      </Header>
      <CanvasArea>
        {/* Scoreboard outside the rotated wrapper */}
        <ScoreBoard>
          {myPlayerIndex !== null && <div>Player: {myPlayerIndex}</div>}
          {players
            .filter((p): p is Player => p !== null) // Type assertion
            .map((p) => (
              <div key={p.index}>
                P{p.index}: {p.score}
              </div>
            ))}
        </ScoreBoard>

        <CanvasWrapper $size={canvasDisplaySize} $rotate={rotationDegrees}>
          <GameCanvas
            // Pass static info
            logicalWidth={canvasSize}
            logicalHeight={canvasSize} // Assuming square
            grid={grid}
            cellSize={cellSize}
            // Pass dynamic info
            paddles={paddles}
            balls={balls}
            // Pass status and scale
            wsStatus={connectionStatus}
            scaleFactor={scaleFactor}
          />
        </CanvasWrapper>
        {renderGameOver()}
      </CanvasArea>
    </AppContainer>
  );
}