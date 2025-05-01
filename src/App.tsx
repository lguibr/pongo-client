// File: src/App.tsx
import { useState, useEffect, useCallback, useMemo } from 'react';
import styled from 'styled-components';
// Joystick import removed
import useWebSocket, { ReadyState } from 'react-use-websocket';

import GameCanvas from './components/GameCanvas';
import { WEBSOCKET_URL } from './utils/constants';
import {
  DirectionMessage,
  GameState,
  PlayerAssignmentMessage,
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
  position: relative; // Needed for absolute positioning of ScoreBoard
  flex: 1;
  display: flex;
  // Removed flex-direction: column
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

const CanvasWrapper = styled.div<{ $size: number; $rotate: number; theme: AppTheme }>`
  width: ${(p) => p.$size}px;
  height: ${(p) => p.$size}px;
  background: ${({ theme }) => theme.colors.background}; // Use theme background
  box-shadow: ${({ theme }) => theme.shadows.canvas};
  transform: rotate(${(p) => p.$rotate}deg);
  transform-origin: center center;
  // Removed margin-bottom
`;

// JoystickWrapper removed

// --- Helper Functions ---

// Use unknown instead of any for type guards
function isPlayerAssignment(data: unknown): data is PlayerAssignmentMessage {
  return (
    typeof data === 'object' &&
    data !== null &&
    'playerIndex' in data && // Check for property existence
    typeof (data as PlayerAssignmentMessage).playerIndex === 'number'
  );
}

function isGameState(data: unknown): data is GameState {
  // Add more robust checks if necessary
  return (
    typeof data === 'object' &&
    data !== null &&
    'canvas' in data && // Check for property existence
    'players' in data &&
    'paddles' in data &&
    'balls' in data &&
    (data as GameState).canvas !== undefined && // Check if not undefined (null is allowed by type)
    Array.isArray((data as GameState).players) &&
    Array.isArray((data as GameState).paddles) &&
    Array.isArray((data as GameState).balls)
  );
}

// --- App Component ---

export default function App() {
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [myPlayerIndex, setMyPlayerIndex] = useState<number | null>(null);
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
      const data: unknown = JSON.parse(lastMessage.data); // Parse into unknown first

      if (isPlayerAssignment(data)) {
        console.log(`Assigning Player Index: ${data.playerIndex}`);
        setMyPlayerIndex(data.playerIndex);
      } else if (isGameState(data)) {
        // Add validation if needed
        setGameState(data);
      } else {
        console.warn('Received unknown message structure:', data);
      }
    } catch (e) {
      console.error('Failed to parse WebSocket message:', e);
    }
  }, [lastMessage]);

  // Callback to send direction messages
  const sendDirectionMessage = useCallback(
    (direction: DirectionMessage['direction']) => {
      if (connectionStatus === 'open') {
        sendMessage(JSON.stringify({ direction }));
      }
    },
    [connectionStatus, sendMessage]
  );

  // Setup input handling using the custom hook
  // No longer need to destructure joystick handlers
  useInputHandler({
    isEnabled: connectionStatus === 'open',
    rotationDegrees,
    sendDirection: sendDirectionMessage,
  });

  // Calculate canvas size based on window dimensions
  const canvasDisplaySize = useMemo(() => {
    const headerHeight = parseInt(theme.sizes.headerHeight, 10) || 50;
    // Removed joystickAreaHeight
    const gap = parseInt(theme.sizes.canvasGap, 10) || 20;
    const availableWidth = windowWidth - gap;
    // Use full available height minus header
    const availableHeight = windowHeight - headerHeight - gap;
    return Math.max(100, Math.min(availableWidth, availableHeight)); // Ensure a minimum size
  }, [windowWidth, windowHeight]);

  // Calculate scale factor for rendering game elements
  const scaleFactor = useMemo(() => {
    const logicalSize = gameState?.canvas?.canvasSize ?? 0;
    return logicalSize > 0 ? canvasDisplaySize / logicalSize : 1;
  }, [gameState, canvasDisplaySize]);

  return (
    // ThemeProvider is now in main.tsx
    <AppContainer>
      <Header>
        <Logo src="/bitmap.png" alt="PonGo Logo" />
        <Title>PonGo</Title>
      </Header>
      <CanvasArea>
        {/* Scoreboard outside the rotated wrapper */}
        <ScoreBoard>
          {myPlayerIndex !== null && <div>Player: {myPlayerIndex}</div>}
          {gameState?.players
            .filter((p): p is Exclude<typeof p, null> => p !== null)
            .map((p) => (
              <div key={p.index}>
                P{p.index}: {p.score}
              </div>
            ))}
        </ScoreBoard>

        <CanvasWrapper $size={canvasDisplaySize} $rotate={rotationDegrees}>
          <GameCanvas
            canvasData={gameState?.canvas ?? null}
            // players prop removed
            paddles={gameState?.paddles ?? []}
            balls={gameState?.balls ?? []}
            wsStatus={connectionStatus}
            scaleFactor={scaleFactor}
          // hideScore prop removed
          />
        </CanvasWrapper>

        {/* Joystick component removed */}

      </CanvasArea>
    </AppContainer>
  );
}