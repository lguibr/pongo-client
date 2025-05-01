// File: src/components/GameCanvas.tsx
import React from 'react';
import styled from 'styled-components';
import {
  // Player type removed as prop is removed
  Paddle as PaddleType,
  Ball as BallType,
  Canvas as CanvasData,
  Cell,
} from '../types/game';
import Paddle from './Paddle';
import Ball from './Ball';
import Brick from './Brick';
import { AppTheme } from '../styles/theme';

interface GameCanvasProps {
  canvasData: CanvasData | null;
  // players prop removed
  paddles: (PaddleType | null)[];
  balls: (BallType | null)[];
  wsStatus: 'connecting' | 'open' | 'closing' | 'closed' | 'error';
  scaleFactor: number;
  // hideScore prop removed
}

// --- Styled Components ---

const CanvasContainer = styled.div<{
  $width: number;
  $height: number;
  $scale: number;
  theme: AppTheme;
}>`
  position: relative;
  width: ${(p) => p.$width}px;
  height: ${(p) => p.$height}px;
  background-color: ${({ theme }) => theme.colors.background};
  overflow: hidden;
  transform: scale(${(p) => p.$scale});
  transform-origin: top left;
  image-rendering: pixelated;
  image-rendering: crisp-edges;
`;

const StatusMessage = styled.div<{ theme: AppTheme }>`
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  color: ${({ theme }) => theme.colors.text};
  font-size: ${({ theme }) => theme.fonts.sizes.status};
  background-color: ${({ theme }) => theme.colors.statusMessageBackground};
  padding: 10px 20px;
  border-radius: ${({ theme }) => theme.sizes.borderRadius};
  z-index: 10;
  text-align: center;
  white-space: nowrap;
`;

// --- GameCanvas Component ---

const GameCanvas: React.FC<GameCanvasProps> = ({
  canvasData,
  // players prop removed from destructuring
  paddles,
  balls,
  wsStatus,
  scaleFactor,
  // hideScore prop removed from destructuring
}) => {
  const logicalWidth = canvasData?.canvasSize ?? 0;
  const logicalHeight = canvasData?.canvasSize ?? 0;

  const cellSize =
    canvasData && canvasData.canvasSize > 0 && canvasData.gridSize > 0
      ? canvasData.canvasSize / canvasData.gridSize
      : 0;

  const renderStatus = () => {
    switch (wsStatus) {
      case 'connecting':
        return <StatusMessage>Connecting...</StatusMessage>;
      case 'closed':
        return <StatusMessage>Disconnected</StatusMessage>;
      case 'error':
        return <StatusMessage>Connection Error</StatusMessage>;
      case 'closing':
        return <StatusMessage>Closing...</StatusMessage>;
      case 'open':
        if (!canvasData) {
          return <StatusMessage>Waiting for game state...</StatusMessage>;
        }
        return null;
      default:
        return null;
    }
  };

  const canRenderGame =
    wsStatus === 'open' &&
    canvasData &&
    Array.isArray(canvasData.grid) &&
    cellSize > 0;

  return (
    <CanvasContainer
      $width={logicalWidth}
      $height={logicalHeight}
      $scale={scaleFactor}
    >
      {renderStatus()}

      {canRenderGame && (
        <>
          {canvasData.grid
            .flat()
            .map((cell: Cell | null) =>
              cell?.data?.type === 0 && cell.data.life > 0 ? (
                <Brick
                  key={`brick-${cell.x}-${cell.y}`}
                  $cellData={cell}
                  $cellSize={cellSize}
                />
              ) : null
            )}

          {paddles.map((paddle) =>
            paddle ? (
              <Paddle key={`paddle-${paddle.index}`} $paddleData={paddle} />
            ) : null
          )}

          {balls.map((ball) =>
            ball ? <Ball key={`ball-${ball.id}`} $ballData={ball} /> : null
          )}
        </>
      )}
    </CanvasContainer>
  );
};

export default GameCanvas;