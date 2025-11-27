import React, { useState } from 'react';
import styled, { DefaultTheme, keyframes } from 'styled-components';
import { Button } from './common/Button';
import { Typography } from './common/Typography';
import { Toggle } from './common/Toggle';
import { Carousel } from './common/Carousel';
import { rulesSlides } from '../data/gameRules';

const fadeIn = keyframes`
  from { opacity: 0; transform: translateY(20px); }
  to { opacity: 1; transform: translateY(0); }
`;

const Container = styled.div<{ theme: DefaultTheme }>`
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center; /* Center vertically on desktop */
  height: 100%;
  width: 100%;
  max-width: 1200px; /* Limit width on desktop */
  margin: 0 auto; /* Center horizontally */
  background-color: ${({ theme }) => theme.colors.background};
  color: ${({ theme }) => theme.colors.foreground};
  padding: 20px; /* Reduced padding to prevent scroll */
  gap: 20px; /* Reduced gap to prevent scroll */
  animation: ${fadeIn} 0.6s ease-out;
  overflow-y: auto;

  @media (max-width: 768px) {
    display: flex;
    flex-direction: column;
    justify-content: flex-start;
    padding: 10px;
    gap: 15px;
  }
`;

const ActionsRow = styled.div`
  display: flex;
  flex-direction: row;
  gap: 20px; /* Larger gap on desktop */
  width: 100%;
  max-width: 800px;
  justify-content: center;
  align-items: stretch;

  @media (max-width: 768px) {
    flex-direction: column;
    align-items: center;
    gap: 8px;
  }
`;

const Section = styled.div<{ theme: DefaultTheme }>`
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 15px; /* Larger gap on desktop */
  background: ${({ theme }) => theme.colors.card};
  padding: 25px; /* Larger padding on desktop */
  border-radius: ${({ theme }) => theme.sizes.borderRadius};
  width: 100%;
  flex: 1;
  border: 1px solid ${({ theme }) => theme.colors.border};
  box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
  transition: transform 0.2s, border-color 0.2s;

  &:hover {
    transform: translateY(-2px);
    border-color: ${({ theme }) => theme.colors.primary};
  }

  @media (max-width: 768px) {
    gap: 8px;
    padding: 10px;
  }
`;

const Input = styled.input<{ theme: DefaultTheme }>`
  padding: 12px; /* Larger padding on desktop */
  font-size: 1.2rem; /* Larger font on desktop */
  border-radius: ${({ theme }) => theme.sizes.borderRadius};
  border: 1px solid ${({ theme }) => theme.colors.input};
  background: ${({ theme }) => theme.colors.background};
  color: ${({ theme }) => theme.colors.foreground};
  width: 100%;
  text-align: center;
  text-transform: uppercase;
  letter-spacing: 3px;
  transition: all 0.2s;
  font-family: ${({ theme }) => theme.fonts.monospace};

  &:focus {
    outline: none;
    box-shadow: 0 0 0 2px ${({ theme }) => theme.colors.background}, 0 0 0 4px ${({ theme }) => theme.colors.ring};
  }
  
  &::placeholder {
    color: ${({ theme }) => theme.colors.mutedForeground};
    letter-spacing: 1px;
  }

  @media (max-width: 768px) {
    padding: 8px;
    font-size: 1rem;
  }
`;

const ToggleLabel = styled.label<{ theme: DefaultTheme }>`
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 1rem;
  cursor: pointer;
  user-select: none;
  color: ${({ theme }) => theme.colors.foreground};
  font-weight: 500;
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
      <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px' }}>
        <img src="/bitmap.png" alt="PonGo Logo" style={{ width: '200px', height: 'auto', imageRendering: 'pixelated' }} className="logo-img" />
        <Typography variant="h3" style={{ opacity: 0.8 }} className="subtitle">Multiplayer Arcade Action</Typography>
      </div>

      <ActionsRow>
        <Section>
          <Typography variant="h3" className="section-title">Create Room</Typography>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <Toggle 
              id="public-room"
              checked={isPublic} 
              onCheckedChange={setIsPublic} 
            />
            <ToggleLabel htmlFor="public-room" className="toggle-label">Public Room</ToggleLabel>
          </div>
          <Button 
            variant="secondary" 
            onClick={() => onCreateRoom(isPublic)}
            style={{ width: '100%' }}
            className="action-btn"
          >
            Create
          </Button>
        </Section>

        <Section>
          <Typography variant="h3" className="section-title">Join Room</Typography>
          <Input 
            placeholder="ENTER CODE" 
            value={joinCode}
            maxLength={6}
            onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
          />
          <Button 
            variant="secondary" 
            onClick={() => onJoinRoom(joinCode)}
            disabled={joinCode.length !== 6}
            style={{ width: '100%' }}
            className="action-btn"
          >
            Join
          </Button>
        </Section>
      </ActionsRow>

      <div style={{ width: '100%', maxWidth: '400px' }}>
        <Button 
          onClick={onQuickPlay} 
          size="lg" 
          style={{ width: '100%' }}
          className="quick-play-btn"
        >
          QUICK PLAY
        </Button>
      </div>

      <div style={{ width: '100%', maxWidth: '600px', display: 'flex', alignItems: 'flex-start' }} className="carousel-container">
        <Carousel slides={rulesSlides} />
      </div>

      <style>{`
        .logo-img { width: 200px; }
        .subtitle { font-size: 1.5rem; }
        .section-title { font-size: 1.5rem; }
        .toggle-label { font-size: 1rem; }
        .action-btn { padding: 12px; }
        .quick-play-btn { height: 70px; font-size: 1.5rem; }
        .carousel-container { margin-top: 0; }

        @media (max-width: 768px) {
          .logo-img { width: 100px !important; }
          .subtitle { font-size: 0.9rem !important; }
          .section-title { font-size: 1.2rem !important; }
          .toggle-label { font-size: 0.9rem !important; }
          .action-btn { padding: 8px !important; }
          .quick-play-btn { height: 50px !important; font-size: 1.2rem !important; }
          .carousel-container { margin-top: auto !important; }
        }
      `}</style>
    </Container>
  );
};
