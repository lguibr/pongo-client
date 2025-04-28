// File: frontend/src/components/GameCanvas.tsx
import React, { useEffect } from 'react';
import styled from 'styled-components';
import { Player, Paddle as PaddleType, Ball as BallType, Canvas as CanvasData, Cell } from '../types/game';
import Paddle from './Paddle';
import Ball from './Ball';
import Brick from './Brick';

interface GameCanvasProps {
  canvasData: CanvasData | null;
  players: (Player | null)[];
  paddles: (PaddleType | null)[];
  balls: (BallType | null)[];
  wsStatus: 'connecting' | 'open' | 'closing' | 'closed' | 'error';
  scaleFactor: number;
  hideScore?: boolean;
}

const CanvasContainer = styled.div<{ $width: number; $height: number; $scale: number }>`
  position: relative;
  width: ${(p) => p.$width}px;
  height: ${(p) => p.$height}px;
  background-color: #000;
  overflow: hidden;
  transform: scale(${(p) => p.$scale});
  transform-origin: top left;
  image-rendering: pixelated;
  image-rendering: crisp-edges;
`;

const StatusMessage = styled.div`
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  color: white;
  font-size: 1.5em;
  background-color: rgba(0,0,0,0.7);
  padding: 10px 20px;
  border-radius: 5px;
  z-index: 10;
`;

const Scoreboard = styled.div`
  position: absolute;
  top: 10px;
  left: 10px;
  color: white;
  background-color: rgba(0,0,0,0.6);
  padding: 5px 10px;
  border-radius: 3px;
  font-size: 0.9em;
  z-index: 5;
  text-align: left;
`;

const GameCanvas: React.FC<GameCanvasProps> = ({
  canvasData,
  players,
  paddles,
  balls,
  wsStatus,
  scaleFactor,
  hideScore = false,
}) => {
  const logicalWidth = canvasData?.canvasSize ?? 0;
  const cellSize = canvasData && canvasData.canvasSize > 0 && canvasData.gridSize > 0
    ? canvasData.canvasSize / canvasData.gridSize
    : 0;

  const renderStatus = () => {
    switch (wsStatus) {
      case 'connecting': return <StatusMessage>Connecting...</StatusMessage>;
      case 'closed': return <StatusMessage>Disconnected</StatusMessage>;
      case 'error': return <StatusMessage>Connection Error</StatusMessage>;
      case 'closing': return <StatusMessage>Closing...</StatusMessage>;
      case 'open':
        if (!canvasData) return <StatusMessage>Waiting for game state...</StatusMessage>;
        return null;
      default: return null;
    }
  };

  const renderScores = () => {
    if (hideScore) return null;
    return (
      <Scoreboard>
        {players.filter((p): p is Player => p !== null).map((p) => (
          <div key={p.index}>
            P{p.index}: {p.score}
          </div>
        ))}
      </Scoreboard>
    );
  };

  const canRenderGame = wsStatus === 'open' && canvasData && Array.isArray(canvasData.grid) && cellSize > 0;

  return (
    <CanvasContainer $width={logicalWidth} $height={logicalWidth} $scale={scaleFactor}>
      {renderStatus()}
      {renderScores()}
      {canRenderGame && (
        <>
          {canvasData!.grid.flat().map((cell: Cell | null) =>
            cell?.data?.type === 0 && cell.data.life > 0 ? (
              <Brick
                key={`brick-${cell.x}-${cell.y}`}
                $cellData={cell}
                $cellSize={cellSize}
              />
            ) : null
          )}
          {paddles.map((p) =>
            p ? <Paddle key={`paddle-${p.index}`} $paddleData={p} /> : null
          )}
          {balls.map((b) =>
            b ? <Ball key={`ball-${b.id}`} $ballData={b} /> : null
          )}
        </>
      )}
    </CanvasContainer>
  );
};

export default GameCanvas;
