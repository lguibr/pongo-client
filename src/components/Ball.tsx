// File: src/components/Ball.tsx
import { useState, useEffect, useRef } from 'react';
import styled, { keyframes, css } from 'styled-components';
import { Ball as BallType } from '../types/game';
import { getColorByOwnerIndex } from '../utils/colors';
import { AppTheme } from '../styles/theme'; // Import theme type

const TRAIL_LENGTH = 5;
const TRAIL_OPACITY_STEP = 0.15;

interface BallProps {
  $ballData: BallType;
}

interface Position {
  x: number;
  y: number;
}

// Keyframes for phasing effect
const phasingAnimation = keyframes`
  0% { opacity: 1; }
  50% { opacity: 0.3; }
  100% { opacity: 1; }
`;

// Base style using theme potentially for fallback or shared properties
const BaseBallStyle = styled.div<{
  $color: string;
  $radius: number;
  $x: number;
  $y: number;
  theme: AppTheme; // Receive theme
}>`
  position: absolute;
  background-color: ${(props) => props.$color};
  width: ${(props) => props.$radius * 2}px;
  height: ${(props) => props.$radius * 2}px;
  // Center the ball based on its radius
  left: ${(props) => props.$x - props.$radius}px;
  top: ${(props) => props.$y - props.$radius}px;
  border-radius: 50%;
  will-change: left, top, opacity, border; // Optimize rendering
`;

const BallPrimitive = styled(BaseBallStyle) <{
  $isPhasing: boolean;
  $isPermanent: boolean;
}>`
  box-shadow: 0 0 8px ${(props) => props.$color}; // Glow effect
  transition: left 0.016s linear, top 0.016s linear; // Smooth movement
  border: ${(props) =>
    props.$isPermanent
      ? `2px solid ${props.theme.colors.unownedBall}` // White border if permanent
      : 'none'};

  ${(props) =>
    props.$isPhasing &&
    css`
      animation: ${phasingAnimation} 0.3s infinite ease-in-out;
    `}
`;

const TrailSegment = styled(BaseBallStyle) <{ $opacity: number }>`
  opacity: ${(props) => props.$opacity};
  box-shadow: none; // No shadow for trail
  transition: none; // Trail segments jump to position
  pointer-events: none; // Trail shouldn't interfere with interactions
`;

const BallComponent: React.FC<BallProps> = ({ $ballData }) => {
  const [trail, setTrail] = useState<Position[]>([]);
  const previousPosition = useRef<Position | null>(null);

  // Determine ball color based on owner
  const ballColor = getColorByOwnerIndex($ballData.ownerIndex);

  // Update trail effect
  useEffect(() => {
    const currentPos = { x: $ballData.x, y: $ballData.y };

    // Only update trail if the ball has moved significantly (prevents jitter)
    if (
      previousPosition.current &&
      (Math.abs(currentPos.x - previousPosition.current.x) > 0.1 || // Threshold
        Math.abs(currentPos.y - previousPosition.current.y) > 0.1)
    ) {
      setTrail((prevTrail) => {
        const newTrail = [currentPos, ...prevTrail];
        // Limit trail length
        if (newTrail.length > TRAIL_LENGTH) {
          newTrail.pop();
        }
        return newTrail;
      });
    } else if (!previousPosition.current) {
      // Initialize trail on first render
      setTrail([currentPos]);
    }

    previousPosition.current = currentPos;
  }, [$ballData.x, $ballData.y]); // Depend on position

  return (
    <>
      {/* Render trail segments */}
      {trail.slice(1).map((pos, index) => (
        <TrailSegment
          key={`trail-${$ballData.id}-${index}`}
          $color={ballColor}
          $radius={$ballData.radius}
          $x={pos.x}
          $y={pos.y}
          $opacity={1 - (index + 1) * TRAIL_OPACITY_STEP} // Fade out
        />
      ))}
      {/* Render the main ball */}
      <BallPrimitive
        $color={ballColor}
        $radius={$ballData.radius}
        $x={$ballData.x}
        $y={$ballData.y}
        $isPhasing={$ballData.phasing}
        $isPermanent={$ballData.isPermanent}
      />
    </>
  );
};

export default BallComponent;