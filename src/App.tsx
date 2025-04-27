// File: frontend/src/App.tsx
import { useEffect, useState, useCallback, useRef } from 'react';
import styled, { createGlobalStyle } from 'styled-components';
import useWebSocket, { ReadyState } from 'react-use-websocket';
import GameCanvas from './components/GameCanvas';
import { WEBSOCKET_URL } from './config';
import { DirectionMessage, GameState } from './types/game';
// Removed: import './App.css';

const GlobalStyle = createGlobalStyle`
  * {
    box-sizing: border-box;
  }

  html, body, #root {
    height: 100%;
    margin: 0;
    padding: 0;
    overflow: hidden; /* Prevent scrollbars due to slight overflows */
  }

  body {
    background-color: #1a1a1a; /* Dark background */
    color: white;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen',
      'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue',
      sans-serif;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    display: flex;
    justify-content: center;
    align-items: center;
  }
`;

const AppContainer = styled.div`
  text-align: center;
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  padding: 10px; /* Add some padding around the content */
`;

const Header = styled.header`
    display: flex;
    align-items: center;
    justify-content: center;
    margin-bottom: 10px; /* Space between header and canvas */
    color: #E0E0E0; /* Light grey text */
`;

const Logo = styled.img`
    height: 40px; /* Adjust logo size */
    margin-right: 15px;
`;

const Instructions = styled.p`
  margin-top: 15px; /* Space above instructions */
  color: #aaa; /* Lighter grey for instructions */
  font-size: 0.9em;
`


function App() {
  const [gameState, setGameState] = useState<GameState | null>(null);
  const pressedKeys = useRef(new Set<string>());
  const lastSentDirection = useRef<DirectionMessage['direction'] | null>(null);

  const { sendMessage, lastMessage, readyState } = useWebSocket(WEBSOCKET_URL, {
    onOpen: () => {
      console.log('WS: Connection Opened');
      pressedKeys.current.clear(); // Reset keys on new connection
      lastSentDirection.current = null; // Reset last sent direction
    },
    onClose: () => {
      console.log('WS: Connection Closed');
      setGameState(null); // Clear game state on close
      pressedKeys.current.clear(); // Reset keys
      lastSentDirection.current = null;
    },
    onError: (event) => console.error('WS: Error:', event),
    shouldReconnect: () => true, // Attempt to reconnect automatically
    reconnectInterval: 3000, // Reconnect attempt interval
    filter: (message): message is MessageEvent<string> => {
      // Ensure message data is a string starting with '{' (basic JSON check)
      return message.data && typeof message.data === 'string' && message.data.startsWith('{');
    },
  });

  // Process incoming WebSocket messages
  useEffect(() => {
    if (lastMessage !== null) {
      try {
        const data = JSON.parse(lastMessage.data);
        // Basic validation for GameState structure
        if (data && typeof data === 'object' && data.players && data.paddles && data.balls) {
          setGameState(data as GameState);
        } else {
          console.warn("WS: Received data doesn't match expected GameState structure:", data);
        }
      } catch (e) {
        console.error("WS: Failed to parse message:", e, "Raw data:", lastMessage.data);
      }
    }
  }, [lastMessage]);

  // Map react-use-websocket ReadyState to a simpler status string
  const mapReadyStateToStatus = (state: ReadyState): 'connecting' | 'open' | 'closing' | 'closed' | 'error' => {
    switch (state) {
      case ReadyState.CONNECTING: return 'connecting';
      case ReadyState.OPEN: return 'open';
      case ReadyState.CLOSING: return 'closing';
      case ReadyState.CLOSED: return 'closed';
      case ReadyState.UNINSTANTIATED: return 'connecting'; // Treat as connecting initially
      default: return 'closed'; // Fallback
    }
  };

  const connectionStatus = mapReadyStateToStatus(readyState);

  // Send paddle direction updates to the backend
  const sendDirection = useCallback((direction: DirectionMessage['direction']) => {
    if (connectionStatus === 'open') {
      // Only send if the direction has actually changed
      if (direction !== lastSentDirection.current) {
        const message: DirectionMessage = { direction };
        console.log("WS: Sending direction:", message);
        sendMessage(JSON.stringify(message));
        lastSentDirection.current = direction; // Update last sent direction
      }
    } else {
      console.warn("WS: Cannot send direction, connection not open. Status:", connectionStatus);
    }
  }, [sendMessage, connectionStatus]); // Depends on sendMessage and connectionStatus

  // Handle keyboard input for paddle movement
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Ignore if connection isn't open or if it's a key repeat event
      if (connectionStatus !== 'open' || event.repeat) return;

      const key = event.key;
      if (key === 'ArrowLeft' || key === 'ArrowRight') {
        // Avoid redundant adds if key is already considered pressed
        if (pressedKeys.current.has(key)) {
          return;
        }
        pressedKeys.current.add(key);
        // Send the direction of the key that was just pressed
        sendDirection(key);
      }
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      if (connectionStatus !== 'open') return;

      const key = event.key;
      if (key === 'ArrowLeft' || key === 'ArrowRight') {
        pressedKeys.current.delete(key); // Remove the released key

        let newDirection: DirectionMessage['direction'] = 'Stop'; // Default to Stop

        // Determine the new direction based on remaining pressed keys
        if (key === 'ArrowLeft' && pressedKeys.current.has('ArrowRight')) {
          newDirection = 'ArrowRight'; // If left released, but right still held
        } else if (key === 'ArrowRight' && pressedKeys.current.has('ArrowLeft')) {
          newDirection = 'ArrowLeft'; // If right released, but left still held
        }
        // If no relevant keys are pressed, newDirection remains 'Stop'

        sendDirection(newDirection);
      }
    };

    // Add event listeners
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    // Cleanup function
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      // Ensure paddle stops moving if component unmounts or connection closes mid-movement
      if (connectionStatus === 'open' && lastSentDirection.current !== 'Stop') {
        sendDirection('Stop');
      }
    };
  }, [sendDirection, connectionStatus]); // Re-run if sendDirection or connectionStatus changes

  return (
    <>
      <GlobalStyle />
      <AppContainer>
        <Header>
          <Logo src="/bitmap.png" alt="PonGo Logo" />
          <h1>PonGo</h1>
        </Header>
        <GameCanvas gameState={gameState} wsStatus={connectionStatus} />
        <Instructions>Hold Left/Right Arrow Keys to move. Release to stop.</Instructions>
      </AppContainer>
    </>
  );
}

export default App;
