// File: frontend/src/components/Brick.tsx
import styled from 'styled-components';
import { Cell, BrickData } from '../types/game';
import { useEffect } from 'react'; // Import useEffect for logging

// Color constants remain the same...
const BRICK_LIFE_COLORS = [
  '#4285F4', '#34A853', '#FBBC05', '#EA4335', '#DB4437', '#C53929',
];
const BORDER_COLOR = '#333';
const MAX_LIFE_FOR_SCALE = 6;

interface BrickProps {
  $cellData: Cell;
  $cellSize: number; // Accept cell size as a prop
}

const getBrickColor = (data: BrickData | null): string => {
  if (!data || data.life <= 0) return 'transparent';
  const lifeIndex = Math.max(0, data.life - 1);
  return BRICK_LIFE_COLORS[Math.min(lifeIndex, BRICK_LIFE_COLORS.length - 1)];
};

const getBrickOpacity = (data: BrickData | null): number => {
  if (!data || data.life <= 0) return 0;
  const scale = MAX_LIFE_FOR_SCALE > 1 ? (MAX_LIFE_FOR_SCALE - 1) : 1;
  const opacity = 0.4 + (0.6 * (Math.min(data.life, MAX_LIFE_FOR_SCALE) - 1)) / scale;
  return Math.max(0.4, Math.min(1.0, opacity));
};

// Use the $cellSize prop for dimensions and positioning
const StyledBrick = styled.div<{ $bgColor: string; $opacity: number; $width: number; $height: number; $left: number; $top: number; }>`
  position: absolute;
  background-color: ${(props) => props.$bgColor};
  opacity: ${(props) => props.$opacity};
  width: ${(props) => props.$width}px;
  height: ${(props) => props.$height}px;
  left: ${(props) => props.$left}px;
  top: ${(props) => props.$top}px;
  border: 1px solid ${BORDER_COLOR};
  box-sizing: border-box;
  transition: background-color 0.15s ease-in-out, opacity 0.15s ease-in-out;
  will-change: background-color, opacity;
`;

const BrickComponent: React.FC<BrickProps> = ({ $cellData, $cellSize }) => {
  const leftPos = $cellData.x * $cellSize;
  const topPos = $cellData.y * $cellSize;
  const bgColor = getBrickColor($cellData.data);
  const opacity = getBrickOpacity($cellData.data);

  // Log calculated values
  useEffect(() => {
    console.log(`Brick [${$cellData.x},${$cellData.y}]: cellSize=${$cellSize}, left=${leftPos}, top=${topPos}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [$cellSize, $cellData.x, $cellData.y]); // Log when these change

  return (
    <StyledBrick
      $bgColor={bgColor}
      $opacity={opacity}
      $width={$cellSize}
      $height={$cellSize}
      $left={leftPos}
      $top={topPos}
    />
  );
};


export default BrickComponent;