// File: frontend/src/components/Brick.tsx
import styled from 'styled-components';
import { Cell, BrickData } from '../types/game';
import { CELL_SIZE } from '../config';

// Google Colors - Adjusted for more life levels potentially
const BRICK_COLORS = [
  '#DB4437', // Red (Life 1)
  '#F4B400', // Yellow (Life 2)
  '#0F9D58', // Darker Green (Life 3)
  '#4285F4', // Blue (Life 4)
  '#7E57C2', // Purple (Life 5+) - Example
];
const BORDER_COLOR = '#444'; // Dark grey border
const MAX_LIFE_FOR_OPACITY = 4; // Base opacity calculation on this max life

interface BrickProps {
  $cellData: Cell;
}

// Use life to determine color
const getBrickColor = (data: BrickData | null): string => {
  if (!data || data.life <= 0) return 'transparent'; // Handle null data or 0 life
  const lifeIndex = Math.max(0, data.life - 1); // Life 1 -> index 0
  return BRICK_COLORS[Math.min(lifeIndex, BRICK_COLORS.length - 1)]; // Use last color for higher life
};

// Calculate opacity based on life
const getBrickOpacity = (data: BrickData | null): number => {
  if (!data || data.life <= 0) return 0;
  // Ensure opacity doesn't go below a minimum threshold (e.g., 0.3)
  // and doesn't exceed 1.0
  return Math.max(0.3, Math.min(1.0, data.life / MAX_LIFE_FOR_OPACITY));
};


const BrickComponent = styled.div<BrickProps>`
  position: absolute;
  background-color: ${(props) => getBrickColor(props.$cellData.data)};
  width: ${CELL_SIZE}px;
  height: ${CELL_SIZE}px;
  left: ${(props) => props.$cellData.x * CELL_SIZE}px;
  top: ${(props) => props.$cellData.y * CELL_SIZE}px;
  border: 1px solid ${BORDER_COLOR};
  box-sizing: border-box; /* Include border in size */
  opacity: ${(props) => getBrickOpacity(props.$cellData.data)};
  transition: background-color 0.1s ease-in-out, opacity 0.1s ease-in-out; /* Smooth transitions */
`;

export default BrickComponent;