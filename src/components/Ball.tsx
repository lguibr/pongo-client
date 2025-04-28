// File: frontend/src/components/Ball.tsx
import { useState, useEffect, useRef } from 'react';
import styled from 'styled-components';
import { Ball as BallType } from '../types/game';
// Ensure the correct utility function is imported
import { getColorByOwnerIndex } from '../utils/colors';

const TRAIL_LENGTH = 5;
const TRAIL_OPACITY_STEP = 0.15;

interface BallProps {
  $ballData: BallType;
}

interface Position {
  x: number;
  y: number;
}

const BaseBallStyle = styled.div<{ $color: string; $radius: number; $x: number; $y: number }>`
  position: absolute;
  background-color: ${(props) => props.$color};
  width: ${(props) => props.$radius * 2}px;
  height: ${(props) => props.$radius * 2}px;
  left: ${(props) => props.$x - props.$radius}px;
  top: ${(props) => props.$y - props.$radius}px;
  border-radius: 50%;
  will-change: left, top, opacity; /* Optimize */
`;

const BallPrimitive = styled(BaseBallStyle)`
  box-shadow: 0 0 8px ${(props) => props.$color};
  transition: left 0.016s linear, top 0.016s linear;
`;

const TrailSegment = styled(BaseBallStyle) <{ $opacity: number }>`
  opacity: ${(props) => props.$opacity};
  box-shadow: none;
  transition: none;
  pointer-events: none;
`;

const BallComponent: React.FC<BallProps> = ({ $ballData }) => {
  const [trail, setTrail] = useState<Position[]>([]);
  const previousPosition = useRef<Position | null>(null);

  // Log the received ownerIndex (expecting 0, 1, 2, 3, or potentially -1/null for unowned)
  console.log(`BallComponent: Rendering ball ID ${$ballData.id} with ownerIndex: ${$ballData.ownerIndex}`);

  // Calculate the color using the 0-based utility
  // It handles indices 0-3 for players and others (like -1 or null) for unowned (white)
  const ballColor = getColorByOwnerIndex($ballData.ownerIndex);

  // Log the calculated color
  console.log(`BallComponent: Calculated color for ownerIndex ${$ballData.ownerIndex}: ${ballColor}`);

  useEffect(() => {
    const currentPos = { x: $ballData.x, y: $ballData.y };

    if (
      previousPosition.current &&
      (Math.abs(currentPos.x - previousPosition.current.x) > 1 ||
        Math.abs(currentPos.y - previousPosition.current.y) > 1)
    ) {
      setTrail((prevTrail) => {
        const newTrail = [currentPos, ...prevTrail];
        if (newTrail.length > TRAIL_LENGTH) {
          newTrail.pop();
        }
        return newTrail;
      });
    } else if (!previousPosition.current) {
      setTrail([currentPos]);
    }

    previousPosition.current = currentPos;

  }, [$ballData.x, $ballData.y]);

  return (
    <>
      {trail.slice(1).map((pos, index) => (
        <TrailSegment
          key={`trail-${$ballData.id}-${index}`}
          $color={ballColor} // Use calculated color
          $radius={$ballData.radius}
          $x={pos.x}
          $y={pos.y}
          $opacity={1 - (index + 1) * TRAIL_OPACITY_STEP}
        />
      ))}
      <BallPrimitive
        $color={ballColor} // Use calculated color
        $radius={$ballData.radius}
        $x={$ballData.x}
        $y={$ballData.y}
      />
    </>
  );
};

export default BallComponent;