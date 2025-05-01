// File: src/components/Brick.tsx
import React, { useState, useEffect, useRef, useContext } from 'react';
import styled, { keyframes, css, ThemeContext } from 'styled-components';
import { Cell, BrickData } from '../types/game';
import { AppTheme } from '../styles/theme';

const MAX_LIFE_FOR_SCALE = 6;

interface BrickProps {
  $cellData: Cell;
  $cellSize: number;
}

// --- Helper Functions ---

const getBrickColor = (data: BrickData | null, theme: AppTheme): string => {
  if (!data || data.life <= 0) return 'transparent';
  const lifeIndex = Math.max(0, data.life - 1);
  return theme.colors.brickLife[
    Math.min(lifeIndex, theme.colors.brickLife.length - 1)
  ];
};

const getBrickOpacity = (data: BrickData | null): number => {
  if (!data || data.life <= 0) return 0;
  const scale = MAX_LIFE_FOR_SCALE > 1 ? MAX_LIFE_FOR_SCALE - 1 : 1;
  const lifeFactor = (Math.min(data.life, MAX_LIFE_FOR_SCALE) - 1) / scale;
  const opacity = 0.4 + 0.6 * lifeFactor;
  return Math.max(0.4, Math.min(1.0, opacity));
};

// --- Keyframes for Hit Effect ---

const hitAnimation = keyframes`
  0% { transform: scale(1); }
  50% { transform: scale(1.08); opacity: 0.85; }
  100% { transform: scale(1); }
`;

// --- Styled Component ---

const StyledBrick = styled.div<{
  $bgColor: string;
  $opacityValue: number;
  $width: number;
  $height: number;
  $left: number;
  $top: number;
  $isHit: boolean;
}>`
  position: absolute;
  background-color: ${(props) => props.$bgColor};
  opacity: ${(props) => props.$opacityValue};
  width: ${(props) => props.$width}px;
  height: ${(props) => props.$height}px;
  left: ${(props) => props.$left}px;
  top: ${(props) => props.$top}px;
  border: 1px solid ${({ theme }) => theme.colors.brickBorder};
  border-radius: ${({ theme }) => theme.sizes.brickBorderRadius};
  box-shadow: ${({ theme }) => theme.shadows.brick};
  box-sizing: border-box;
  transition:
    background-color 0.15s ease-in-out,
    opacity 0.15s ease-in-out;
  will-change: background-color, opacity, transform;

  ${(props) =>
    props.$isHit &&
    css`
      animation: ${hitAnimation} 0.15s ease-out;
    `}
`;

// --- Brick Component ---

const BrickComponent: React.FC<BrickProps> = ({ $cellData, $cellSize }) => {
  const [isHit, setIsHit] = useState(false);
  const prevLife = useRef<number | undefined>(undefined);
  const themeContext = useContext(ThemeContext); // Get theme context

  const brickData = $cellData.data;
  const currentLife = brickData?.life;

  // HOOK MOVED HERE - Before any potential early returns
  useEffect(() => {
    if (
      prevLife.current !== undefined &&
      currentLife !== undefined &&
      currentLife < prevLife.current
    ) {
      setIsHit(true);
      const timer = setTimeout(() => setIsHit(false), 150);
      return () => clearTimeout(timer);
    }
    prevLife.current = currentLife;
  }, [currentLife]);

  // Early return if theme is not available
  if (!themeContext) {
    console.error("Theme context is not available in BrickComponent");
    return null;
  }

  // Early return if brick has no life or data
  if (!brickData || brickData.life <= 0) {
    return null;
  }

  // Calculate styles only if rendering
  const leftPos = $cellData.x * $cellSize;
  const topPos = $cellData.y * $cellSize;
  const bgColor = getBrickColor(brickData, themeContext);
  const opacity = getBrickOpacity(brickData);

  return (
    <StyledBrick
      $bgColor={bgColor}
      $opacityValue={opacity}
      $width={$cellSize}
      $height={$cellSize}
      $left={leftPos}
      $top={topPos}
      $isHit={isHit}
    />
  );
};

export default BrickComponent;