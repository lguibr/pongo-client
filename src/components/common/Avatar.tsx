import React from 'react';
import styled, { DefaultTheme, css } from 'styled-components';
import { getPlayerColorName } from '../../utils/colors';

interface AvatarProps {
  playerIndex: number;
  size?: 'sm' | 'md' | 'lg';
  showName?: boolean;
  isReady?: boolean;
  theme?: DefaultTheme;
}

const getSize = (size: AvatarProps['size'] = 'md') => {
  switch (size) {
    case 'sm': return '24px';
    case 'lg': return '48px';
    case 'md':
    default: return '32px';
  }
};

const AvatarContainer = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
`;

const AvatarCircle = styled.div<{ $color: string; $size: string; $isReady?: boolean }>`
  width: ${({ $size }) => $size};
  height: ${({ $size }) => $size};
  border-radius: 50%;
  background-color: ${({ $color }) => $color};
  box-shadow: 0 0 10px ${({ $color }) => $color}80;
  border: 2px solid ${({ $isReady }) => $isReady ? '#fff' : 'transparent'};
  transition: all 0.3s ease;
  
  ${({ $isReady }) => $isReady && css`
    transform: scale(1.1);
    box-shadow: 0 0 15px currentColor;
  `}
`;

const PlayerName = styled.span<{ theme: DefaultTheme }>`
  font-weight: 600;
  color: ${({ theme }) => theme.colors.foreground};
  font-size: 0.9rem;
`;

export const Avatar: React.FC<AvatarProps> = ({ playerIndex, size = 'md', showName = false, isReady }) => {
  // Map index to theme color key
  const getColor = (index: number) => {
    const colors = ['#3b82f6', '#22c55e', '#eab308', '#ef4444'];
    return colors[index % 4];
  };

  const color = getColor(playerIndex);
  const name = getPlayerColorName(playerIndex);

  return (
    <AvatarContainer>
      <AvatarCircle $color={color} $size={getSize(size)} $isReady={isReady} />
      {showName && <PlayerName>{name}</PlayerName>}
    </AvatarContainer>
  );
};
