// File: frontend/src/App.tsx
import { useEffect, useState, useCallback, useRef } from 'react';
import styled, { createGlobalStyle } from 'styled-components';
import useWebSocket, { ReadyState } from 'react-use-websocket';
import GameCanvas from './components/GameCanvas';
import { WEBSOCKET_URL } from './utils/constants';
import { DirectionMessage, GameState } from './types/game';

const GlobalStyle = createGlobalStyle`
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body, #root {
    width: 100vw; height: 100vh;
    background: #000; overflow: hidden;
  }
  body {
    color: #e0e0e0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto,
      Oxygen, Ubuntu, Cantarell, 'Fira Sans', 'Droid Sans', 'Helvetica Neue',
      sans-serif;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }
`;

const AppContainer = styled.div`
  display: flex; flex-direction: column;
  width: 100%; height: 100%;
`;

const Header = styled.header`
  height: 50px;
  display: flex; align-items: center; justify-content: center;
  z-index: 10;
`;

const Logo = styled.img`
  height: 30px; margin-right: 10px;
`;

const Title = styled.h1`
  font-size: 1.5em; font-weight: 500; color: #b0b0b0;
`;

const CanvasArea = styled.div`
  position: relative;
  flex: 1; display: flex; justify-content: center; align-items: center;
  touch-action: none;
`;

const ScoreBoard = styled.div`
  position: absolute; top: 10px; left: 10px; z-index: 20;
  background: rgba(0,0,0,0.6); padding: 5px 10px;
  border-radius: 3px; font-size: 0.9em; color: #fff;
`;

const CanvasWrapper = styled.div<{ $size: number; $rotate: number }>`
  width: ${(p) => p.$size}px;
  height: ${(p) => p.$size}px;
  background: #000;
  box-shadow: 0 0 4px rgba(255,255,255,0.2);
  transform: rotate(${(p) => p.$rotate}deg);
  transform-origin: center center;
`;

const useWindowSize = () => {
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  useEffect(() => {
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return size;
};

export default function App() {
  const [gameState, setGameState] = useState<GameState | null>(null);
  const lastDir = useRef<DirectionMessage['direction'] | null>(null);
  const { w: winW, h: winH } = useWindowSize();

  const { sendMessage, lastMessage, readyState } = useWebSocket(WEBSOCKET_URL, {
    shouldReconnect: () => true,
    reconnectInterval: 3000,
    filter: (msg): msg is MessageEvent<string> =>
      typeof msg.data === 'string' && msg.data.startsWith('{'),
  });

  // Recebe estado do jogo
  useEffect(() => {
    if (!lastMessage) return;
    try {
      const d = JSON.parse(lastMessage.data);
      if (d.canvas?.canvasSize > 0 && Array.isArray(d.canvas.grid)) {
        setGameState(d);
      }
    } catch { }
  }, [lastMessage]);

  const status = (() => {
    switch (readyState) {
      case ReadyState.CONNECTING: return 'connecting';
      case ReadyState.OPEN: return 'open';
      case ReadyState.CLOSING: return 'closing';
      case ReadyState.CLOSED: return 'closed';
      default: return 'error';
    }
  })() as 'connecting' | 'open' | 'closing' | 'closed' | 'error';

  const sendDir = useCallback((dir: DirectionMessage['direction']) => {
    if (status !== 'open' || dir === lastDir.current) return;
    sendMessage(JSON.stringify({ direction: dir }));
    lastDir.current = dir;
  }, [sendMessage, status]);

  // Índice do player (aquele cujo paddle != null)
  const myIndex = gameState?.paddles.findIndex(p => p !== null) ?? 2;

  // Rotação: myIndex * 90° (CW)
  let rotateDeg = (myIndex * 90) % 360;
  // Rotação: 360° – (myIndex×90°), para que cada um fique embaixo
  rotateDeg = (360 +90  - myIndex * 90) % 360;

  // Input handler (teclado / touch)
  const handleUserDirection = useCallback((dir: DirectionMessage['direction']) => {
    sendDir(dir);
  }, [sendDir]);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (status !== 'open' || e.repeat) return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') handleUserDirection(e.key);
    };
    const up = (e: KeyboardEvent) => {
      if (status !== 'open') return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') handleUserDirection('Stop');
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      handleUserDirection('Stop');
    };
  }, [handleUserDirection, status]);

  const handleTouchStart = (e: React.TouchEvent) => {
    if (status !== 'open') return;
    const x = e.touches[0].clientX;
    const dead = winW * 0.15;
    if (x < winW / 2 - dead) handleUserDirection('ArrowLeft');
    else if (x > winW / 2 + dead) handleUserDirection('ArrowRight');
  };
  const handleTouchEnd = () => status === 'open' && handleUserDirection('Stop');

  // Calcula tamanho do canvas
  const HEADER_H = 50, GAP = 20;
  const availW = winW - GAP, availH = winH - HEADER_H - GAP;
  const size = Math.max(100, Math.min(availW, availH));
  const logical = gameState?.canvas?.canvasSize ?? 0;
  const scale = logical > 0 ? size / logical : 1;

  return (
    <>
      <GlobalStyle />
      <AppContainer>
        <Header>
          <Logo src="/bitmap.png" alt="PonGo Logo" />
          <Title>PonGo</Title>
        </Header>
        <CanvasArea
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
        >
          <ScoreBoard>
            {gameState?.players
              .filter((p): p is Exclude<typeof p, null> => p !== null)
              .map(p => <div key={p.index}>P{p.index}: {p.score}</div>)
            }
          </ScoreBoard>
          <CanvasWrapper $size={size} $rotate={rotateDeg}>
            <GameCanvas
              canvasData={gameState?.canvas ?? null}
              players={gameState?.players ?? []}
              paddles={gameState?.paddles ?? []}
              balls={gameState?.balls ?? []}
              wsStatus={status}
              scaleFactor={scale}
              hideScore
            />
          </CanvasWrapper>
        </CanvasArea>
      </AppContainer>
    </>
  );
}
