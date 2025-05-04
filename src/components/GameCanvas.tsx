// File: src/components/GameCanvas.tsx
import React from 'react';
import styled from 'styled-components';
import {
  Paddle as PaddleType,
  Ball as BallType,
  Grid, // Use Grid type
  Cell,
  Player, // Import Player type if needed for score display (though score is now outside)
} from '../types/game';
import Paddle from './Paddle';
import Ball from './Ball';
import Brick from './Brick';
import { AppTheme } from '../styles/theme';

interface GameCanvasProps {
  // Static Info
  logicalWidth: number;
  logicalHeight: number;
  grid: Grid | null;
  cellSize: number;
  // Dynamic Info
  paddles: (PaddleType | null)[];
  balls: (BallType | null)[];
  // Status & Scale
  wsStatus: 'connecting' | 'open' | 'closing' | 'closed' | 'error';
  scaleFactor: number;
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
  logicalWidth,
  logicalHeight,
  grid,
  cellSize,
  paddles,
  balls,
  wsStatus,
  scaleFactor,
}) => {
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
        // Check if grid is received, not just canvasData
        if (!grid) {
          return <StatusMessage>Waiting for game state...</StatusMessage>;
        }
        return null;
      default:
        return null;
    }
  };

  // Render game only if connected and grid is available
  const canRenderGame = wsStatus === 'open' && grid && cellSize > 0;

  return (
    <CanvasContainer
      $width={logicalWidth}
      $height={logicalHeight}
      $scale={scaleFactor}
    >
      {renderStatus()}

      {canRenderGame && (
        <>
          {/* Render grid based on the grid prop */}
          {grid
            .flat() // Flatten the 2D array
            .map((cell: Cell | null, index: number) =>
              // Check if cell and its data exist and it's a brick with life
              cell?.data?.type === 0 && cell.data.life > 0 ? (
                <Brick
                  // Use a more stable key if possible, index might change if grid structure changes
                  key={`brick-${cell.x}-${cell.y}-${index}`}
                  $cellData={cell}
                  $cellSize={cellSize}
                />
              ) : null
            )}

          {/* Render dynamic elements */}
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