// File: frontend/src/components/Paddle.tsx
import styled from 'styled-components';
import { Paddle as PaddleType } from '../types/game';
// Ensure the correct utility function is imported
import { getPaddleColorByPlayerIndex } from '../utils/colors';

interface PaddleProps {
  $paddleData: PaddleType;
}

const StyledPaddle = styled.div<{ $bgColor: string; $width: number; $height: number; $x: number; $y: number }>`
  position: absolute;
  background-color: ${(props) => props.$bgColor};
  width: ${(props) => props.$width}px;
  height: ${(props) => props.$height}px;
  left: ${(props) => props.$x}px;
  top: ${(props) => props.$y}px;
  box-shadow: 0 0 5px ${(props) => props.$bgColor};
  transition: left 0.05s linear, top 0.05s linear;
`;

const PaddleComponent: React.FC<PaddleProps> = ({ $paddleData }) => {
  // Log the received index (expecting 0, 1, 2, or 3 from backend now)
  console.log(`PaddleComponent: Rendering paddle with index: ${$paddleData.index}`);

  // Calculate the color using the 0-based utility
  const paddleColor = getPaddleColorByPlayerIndex($paddleData.index);

  // Log the calculated color
  console.log(`PaddleComponent: Calculated color for index ${$paddleData.index}: ${paddleColor}`);

  return (
    <StyledPaddle
      $bgColor={paddleColor}
      $width={$paddleData.width}
      $height={$paddleData.height}
      $x={$paddleData.x}
      $y={$paddleData.y}
    />
  );
};

export default PaddleComponent;