// File: src/components/Paddle.tsx
import styled from 'styled-components';
import { Paddle as PaddleType } from '../types/game';
import { getPaddleColorByPlayerIndex } from '../utils/colors';
import { AppTheme } from '../styles/theme'; // Import theme type

interface PaddleProps {
  $paddleData: PaddleType;
}

const StyledPaddle = styled.div<{
  $bgColor: string;
  $width: number;
  $height: number;
  $x: number;
  $y: number;
  theme: AppTheme; // Receive theme
}>`
  position: absolute;
  background-color: ${(props) => props.$bgColor};
  width: ${(props) => props.$width}px;
  height: ${(props) => props.$height}px;
  left: ${(props) => props.$x}px;
  top: ${(props) => props.$y}px;
  box-shadow: 0 0 5px ${(props) => props.$bgColor}; // Subtle glow effect
  // Smooth transitions for position changes
  transition: left 0.05s linear, top 0.05s linear;
  will-change: left, top; // Optimize rendering
  border-radius: 2px; // Slightly rounded edges
`;

const PaddleComponent: React.FC<PaddleProps> = ({ $paddleData }) => {
  // Calculate the color using the utility function which maps index 0-3
  const paddleColor = getPaddleColorByPlayerIndex($paddleData.index);

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