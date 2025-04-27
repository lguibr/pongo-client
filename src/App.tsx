// File: frontend/src/App.tsx
import { useEffect, useState, useCallback, useRef } from 'react';
import styled, { createGlobalStyle } from 'styled-components';
import useWebSocket, { ReadyState } from 'react-use-websocket';
import GameCanvas from './components/GameCanvas';
import { WEBSOCKET_URL } from './config';
import { DirectionMessage, GameState } from './types/game';

const GlobalStyle = createGlobalStyle`
  * {
    box-sizing: border-box;
  }

  html, body, #root {
    height: 100%;
    margin: 0;
    padding: 0;
    overflow: hidden;
  }

  body {
    background-color: #1a1a1a;
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
  padding: 10px;
`;

const Header = styled.header`
    display: flex;
    align-items: center;
    justify-content: center;
    margin-bottom: 10px;
    color: #E0E0E0;
`;

const Logo = styled.img`
    height: 40px;
    margin-right: 15px;
`;

const Instructions = styled.p`
  margin-top: 15px;
  color: #aaa;
  font-size: 0.9em;
`;


function App() {
  const [gameState, setGameState] = useState<GameState | null>(null);
  const pressedKeys = useRef(new Set<string>());
  const lastSentDirection = useRef<DirectionMessage['direction'] | null>(null);

  const { sendMessage, lastMessage, readyState } = useWebSocket(WEBSOCKET_URL, {
    onOpen: () => {
      console.log('WS: Connection Opened');
      pressedKeys.current.clear();
      lastSentDirection.current = null;
    },
    onClose: () => {
      console.log('WS: Connection Closed');
      setGameState(null);
      pressedKeys.current.clear();
      lastSentDirection.current = null;
    },
    onError: (event) => console.error('WS: Error:', event),
    shouldReconnect: () => true,
    reconnectInterval: 3000,
    filter: (message) => {
      return message.data && typeof message.data === 'string' && message.data.startsWith('{');
    },
  });

  useEffect(() => {
    if (lastMessage !== null) {
      try {
        const data = JSON.parse(lastMessage.data);
        if (data && typeof data === 'object' && data.players && data.paddles && data.balls) {
          setGameState(data as GameState);
        } else {
          console.warn("WS: Parsed data does not look like valid GameState:", data);
        }
      } catch (e) {
        console.error("WS: Failed to parse last message:", e, "Raw data:", lastMessage.data);
      }
    }
  }, [lastMessage]);

  const mapReadyStateToStatus = (state: ReadyState): 'connecting' | 'open' | 'closing' | 'closed' | 'error' => {
    switch (state) {
      case ReadyState.CONNECTING: return 'connecting';
      case ReadyState.OPEN: return 'open';
      case ReadyState.CLOSING: return 'closing';
      case ReadyState.CLOSED: return 'closed';
      case ReadyState.UNINSTANTIATED: return 'connecting';
      default: return 'closed';
    }
  };

  const connectionStatus = mapReadyStateToStatus(readyState);

  const sendDirection = useCallback((direction: DirectionMessage['direction']) => {
    if (connectionStatus === 'open') {
      if (direction !== lastSentDirection.current) {
        const message: DirectionMessage = { direction };
        console.log("Sending direction:", message);
        sendMessage(JSON.stringify(message));
        lastSentDirection.current = direction;
      }
    } else {
      console.warn("WS: Cannot send direction, connection not open. Status:", connectionStatus);
    }
  }, [sendMessage, connectionStatus]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (connectionStatus !== 'open' || event.repeat) return;

      const key = event.key;
      if (key === 'ArrowLeft' || key === 'ArrowRight') {
        if (pressedKeys.current.has(key)) {
          return;
        }
        pressedKeys.current.add(key);
        // Send the direction of the key just pressed
        sendDirection(key);
      }
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      if (connectionStatus !== 'open') return;

      const key = event.key;
      if (key === 'ArrowLeft' || key === 'ArrowRight') {
        pressedKeys.current.delete(key);

        let newDirection: DirectionMessage['direction'] = 'Stop'; // Default to Stop

        // Check if the *other* movement key is still pressed
        if (key === 'ArrowLeft' && pressedKeys.current.has('ArrowRight')) {
          newDirection = 'ArrowRight';
        } else if (key === 'ArrowRight' && pressedKeys.current.has('ArrowLeft')) {
          newDirection = 'ArrowLeft';
        }
        // If no movement keys are pressed, newDirection remains 'Stop'

        sendDirection(newDirection);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      // Send stop on cleanup if connection is still open
      if (connectionStatus === 'open' && lastSentDirection.current !== 'Stop') {
        sendDirection('Stop');
      }
    };
  }, [sendDirection, connectionStatus]); // Add connectionStatus dependency

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