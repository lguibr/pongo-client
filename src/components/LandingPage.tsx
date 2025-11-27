import React, { useState } from 'react';
import styled, { DefaultTheme, keyframes } from 'styled-components';

const fadeIn = keyframes`
  from { opacity: 0; transform: translateY(20px); }
  to { opacity: 1; transform: translateY(0); }
`;

const Container = styled.div<{ theme: DefaultTheme }>`
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  width: 100%;
  background-color: ${({ theme }) => theme.colors.background};
  color: ${({ theme }) => theme.colors.text};
  padding: 20px;
  gap: 40px;
  animation: ${fadeIn} 0.6s ease-out;
`;



const Subtitle = styled.p<{ theme: DefaultTheme }>`
  font-size: 1.2rem;
  color: ${({ theme }) => theme.colors.text};
  opacity: 0.7;
  margin-top: -30px;
  margin-bottom: 20px;
`;

const MenuContainer = styled.div`
  display: flex;
  flex-direction: column;
  gap: 20px;
  width: 100%;
  max-width: 400px;
`;

const Section = styled.div<{ theme: DefaultTheme }>`
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 15px;
  background: rgba(255, 255, 255, 0.03);
  padding: 25px;
  border-radius: 20px;
  width: 100%;
  border: 1px solid rgba(255, 255, 255, 0.1);
  box-shadow: 0 4px 30px rgba(0, 0, 0, 0.1);
  backdrop-filter: blur(5px);
  transition: transform 0.2s, border-color 0.2s;

  &:hover {
    transform: translateY(-2px);
    border-color: ${({ theme }) => theme.colors.accent};
  }

  h2 {
    font-size: 1.5rem;
    margin: 0;
    color: ${({ theme }) => theme.colors.text};
    font-weight: 600;
  }
`;

const Button = styled.button<{ theme: DefaultTheme; $variant?: 'primary' | 'secondary' }>`
  padding: 15px 30px;
  font-size: 1.1rem;
  font-weight: 700;
  border: none;
  border-radius: 12px;
  cursor: pointer;
  width: 100%;
  transition: all 0.2s ease;
  text-transform: uppercase;
  letter-spacing: 1px;

  background-color: ${({ theme, $variant }) => 
    $variant === 'secondary' ? 'rgba(255, 255, 255, 0.1)' : theme.colors.accent};
  
  color: ${({ theme, $variant }) => 
    $variant === 'secondary' ? theme.colors.text : '#000'};
    
  border: ${({ $variant }) => 
    $variant === 'secondary' ? '1px solid rgba(255, 255, 255, 0.2)' : 'none'};

  &:hover {
    opacity: 1;
    transform: scale(1.02);
    box-shadow: 0 0 15px ${({ theme, $variant }) => 
      $variant === 'secondary' ? 'rgba(255, 255, 255, 0.1)' : theme.colors.accentGlow};
    background-color: ${({ theme, $variant }) => 
      $variant === 'secondary' ? 'rgba(255, 255, 255, 0.2)' : theme.colors.accent};
  }

  &:active {
    transform: scale(0.98);
  }

  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
    transform: none;
    box-shadow: none;
  }
`;

const Input = styled.input<{ theme: DefaultTheme }>`
  padding: 15px;
  font-size: 1.2rem;
  border-radius: 12px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  background: rgba(0, 0, 0, 0.3);
  color: ${({ theme }) => theme.colors.text};
  width: 100%;
  text-align: center;
  text-transform: uppercase;
  letter-spacing: 3px;
  transition: border-color 0.2s;

  &:focus {
    outline: none;
    border-color: ${({ theme }) => theme.colors.accent};
    box-shadow: 0 0 10px ${({ theme }) => theme.colors.accentGlow};
  }
  
  &::placeholder {
    color: rgba(255, 255, 255, 0.3);
    letter-spacing: 1px;
  }
`;

const ToggleContainer = styled.label`
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 1rem;
  cursor: pointer;
  user-select: none;
  
  input {
    accent-color: ${({ theme }) => theme.colors.accent};
    width: 18px;
    height: 18px;
    cursor: pointer;
  }
`;

interface LandingPageProps {
  onCreateRoom: (isPublic: boolean) => void;
  onJoinRoom: (code: string) => void;
  onQuickPlay: () => void;
}

export const LandingPage: React.FC<LandingPageProps> = ({ 
  onCreateRoom, 
  onJoinRoom, 
  onQuickPlay 
}) => {
  const [joinCode, setJoinCode] = useState('');
  const [isPublic, setIsPublic] = useState(true);

  return (
    <Container>
      <div style={{ textAlign: 'center' }}>
        <Subtitle>Multiplayer Arcade Action</Subtitle>
      </div>

      <MenuContainer>
        <Button onClick={onQuickPlay} style={{ height: '60px', fontSize: '1.3rem' }}>
          QUICK PLAY
        </Button>

        <Section>
          <h2>Create Room</h2>
          <ToggleContainer>
            <input 
              type="checkbox" 
              checked={isPublic} 
              onChange={(e) => setIsPublic(e.target.checked)} 
            />
            Public Room
          </ToggleContainer>
          <Button $variant="secondary" onClick={() => onCreateRoom(isPublic)}>
            Create
          </Button>
        </Section>

        <Section>
          <h2>Join Room</h2>
          <Input 
            placeholder="ENTER CODE" 
            value={joinCode}
            maxLength={6}
            onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
          />
          <Button 
            $variant="secondary" 
            onClick={() => onJoinRoom(joinCode)}
            disabled={joinCode.length !== 6}
          >
            Join
          </Button>
        </Section>
      </MenuContainer>
    </Container>
  );
};
