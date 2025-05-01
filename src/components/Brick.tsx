// File: src/components/Brick.tsx
import React, { useState, useEffect, useRef } from 'react';
import styled, { keyframes, css } from 'styled-components';
import { Cell, BrickData } from '../types/game';
import { AppTheme } from '../styles/theme';

const MAX_LIFE_FOR_SCALE = 6;
const PARTICLE_COUNT = 5;
const PARTICLE_DURATION = 400; // ms

interface BrickProps {
  $cellData: Cell;
  $cellSize: number;
}

interface ParticleState {
  id: number;
  x: number; // Initial offset X
  y: number; // Initial offset Y
  dx: number; // Target delta X
  dy: number; // Target delta Y
  color: string;
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

// --- Keyframes ---

const hitAnimation = keyframes`
  0% { transform: scale(1); }
  50% { transform: scale(1.08); opacity: 0.85; }
  100% { transform: scale(1); }
`;

const particleAnimation = (dx: number, dy: number) => keyframes`
  0% {
    transform: translate(0, 0);
    opacity: 1;
  }
  100% {
    transform: translate(${dx}px, ${dy}px);
    opacity: 0;
  }
`;

// --- Styled Components ---

const BrickContainer = styled.div<{
  $width: number;
  $height: number;
  $left: number;
  $top: number;
}>`
  position: absolute;
  width: ${(props) => props.$width}px;
  height: ${(props) => props.$height}px;
  left: ${(props) => props.$left}px;
  top: ${(props) => props.$top}px;
  pointer-events: none; // Container doesn't block interactions
`;

const StyledBrick = styled.div<{
  $bgColor: string;
  $opacityValue: number;
  $isHit: boolean;
  theme: AppTheme; // Theme is automatically passed here
}>`
  position: absolute;
  width: 100%;
  height: 100%;
  background-color: ${(props) => props.$bgColor};
  opacity: ${(props) => props.$opacityValue};
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

const Particle = styled.div.attrs<{ $state: ParticleState }>((props) => ({
  style: {
    left: `${props.$state.x}px`,
    top: `${props.$state.y}px`,
    backgroundColor: props.$state.color,
  },
})) <{ $state: ParticleState }>`
  position: absolute;
  width: 3px; // Particle size
  height: 3px;
  border-radius: 50%;
  opacity: 1;
  will-change: transform, opacity;
  animation: ${(props) => particleAnimation(props.$state.dx, props.$state.dy)}
    ${PARTICLE_DURATION}ms ease-out forwards;
`;

// --- Brick Component ---

const BrickComponent: React.FC<BrickProps> = ({ $cellData, $cellSize }) => {
  const [isHit, setIsHit] = useState(false);
  const [particles, setParticles] = useState<ParticleState[]>([]);
  const prevLife = useRef<number | undefined>(undefined);
  const particleIdCounter = useRef(0);

  const brickData = $cellData.data;
  const currentLife = brickData?.life;

  // Trigger hit animation and particles
  useEffect(() => {
    if (
      prevLife.current !== undefined &&
      currentLife !== undefined &&
      currentLife < prevLife.current &&
      brickData // Ensure brickData exists to get color
    ) {
      setIsHit(true);

      // Generate particles
      const newParticles: ParticleState[] = [];
      const hitColor = getBrickColor(brickData, theme); // Use theme directly
      for (let i = 0; i < PARTICLE_COUNT; i++) {
        const angle = Math.random() * Math.PI * 2;
        const distance = $cellSize * (0.5 + Math.random() * 0.5); // Fly outwards
        newParticles.push({
          id: particleIdCounter.current++,
          x: $cellSize / 2, // Start near center
          y: $cellSize / 2,
          dx: Math.cos(angle) * distance,
          dy: Math.sin(angle) * distance,
          color: hitColor,
        });
      }
      setParticles(newParticles);

      // Reset hit state after animation
      const hitTimer = setTimeout(() => setIsHit(false), 150);
      // Remove particles after their animation duration
      const particleTimer = setTimeout(
        () => setParticles([]),
        PARTICLE_DURATION
      );

      return () => {
        clearTimeout(hitTimer);
        clearTimeout(particleTimer);
      };
    }
    prevLife.current = currentLife;
  }, [currentLife, brickData, $cellSize]); // Add brickData and $cellSize dependencies

  // Early return if brick has no life or data
  if (!brickData || brickData.life <= 0) {
    return null;
  }

  // Calculate styles only if rendering
  const leftPos = $cellData.x * $cellSize;
  const topPos = $cellData.y * $cellSize;
  const bgColor = getBrickColor(brickData, theme); // Use theme directly
  const opacity = getBrickOpacity(brickData);

  return (
    <BrickContainer $width={$cellSize} $height={$cellSize} $left={leftPos} $top={topPos}>
      <StyledBrick
        $bgColor={bgColor}
        $opacityValue={opacity}
        $isHit={isHit}
      // theme prop is implicitly passed by styled-components
      />
      {/* Render particles */}
      {particles.map((p) => (
        <Particle key={p.id} $state={p} />
      ))}
    </BrickContainer>
  );
};

// Import the theme directly for use in the effect hook
import theme from '../styles/theme';

export default BrickComponent;