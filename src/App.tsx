import { SpeedInsights } from "@vercel/speed-insights/react"
import { Analytics } from "@vercel/analytics/react"
import { useCallback, useMemo, useState, useRef, useEffect } from 'react';
import { useNavigate, Routes, Route } from 'react-router-dom';
import styled, { DefaultTheme, ThemeProvider, keyframes } from 'styled-components';

// Keep if needed for global constants, but unused here? No, used in GameRoom. Not here.
// Actually App.tsx doesn't use WEBSOCKET_URL anymore.

import { useWindowSize } from './hooks/useWindowSize';
import theme from './styles/theme';
import { useSoundManager } from './hooks/useSoundManager';

// Import SVG Icons
import VolumeHighIcon from './components/icons/VolumeHighIcon';
import VolumeMediumIcon from './components/icons/VolumeMediumIcon';
import VolumeLowIcon from './components/icons/VolumeLowIcon';
import VolumeMuteIcon from './components/icons/VolumeMuteIcon';

import { LandingPage } from './components/LandingPage';
import { GameRoom } from './components/GameRoom';

// --- Keyframes for Animations ---
const logoShakeAnimation = keyframes`
  0%, 100% { transform: rotate(0deg); }
  10%, 30%, 50%, 70%, 90% { transform: rotate(-2deg); }
  20%, 40%, 60%, 80% { transform: rotate(2deg); }
`;

// --- Styled Components ---
const AppContainer = styled.div<{ theme: DefaultTheme }>`
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%; /* Will fill #root */
  overflow: hidden;
  background-color: ${({ theme }) => theme.colors.background};
  /* Safe area padding only for top, left, right. Bottom is handled by controls. */
  padding-top: env(safe-area-inset-top, 0px);
  padding-right: env(safe-area-inset-right, 0px);
  padding-left: env(safe-area-inset-left, 0px);
`;

const Header = styled.header<{ theme: DefaultTheme }>`
  height: var(--header-height); /* Use CSS Variable */
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 15px;
  z-index: 10;
  flex-shrink: 0; /* Prevent header from shrinking */
  position: relative;
  background-color: ${({ theme }) => theme.colors.background}; /* Ensure header has bg */
`;

const LogoContainer = styled.div`
  display: flex;
  align-items: center;
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  pointer-events: none; 
  & > * {
    pointer-events: auto; 
  }
`;

const Logo = styled.img<{ $animate: boolean }>`
  height: calc(var(--header-height) * 0.5); /* Scale logo with header */
  max-height: 30px; /* Max size */
  margin-right: 10px;
  animation: ${({ $animate }) => ($animate ? logoShakeAnimation : 'none')} 0.5s ease-in-out;
`;

const Title = styled.h1<{ theme: DefaultTheme }>`
  font-size: ${({ theme }) => theme.fonts.sizes.titleMobile}; 
  @media (min-width: 768px) {
    font-size: ${({ theme }) => theme.fonts.sizes.title};
  }
  font-weight: 600;
  color: ${({ theme }) => theme.colors.text};
  text-shadow: 0 0 5px ${({ theme }) => theme.colors.accentGlow};
`;

const VolumeControlContainer = styled.div`
  display: flex;
  align-items: center;
  margin-left: auto; 
`;

const VolumeIconContainer = styled.div<{ theme: DefaultTheme }>`
  display: flex; 
  align-items: center;
  justify-content: center;
  color: ${({ theme }) => theme.colors.text};
  margin-right: 8px;
  cursor: pointer;
  opacity: 0.8;
  transition: opacity 0.2s;
  user-select: none;
  padding: 5px;

  &:hover {
    opacity: 1;
  }
`;

const VolumeSliderInput = styled.input.attrs({ type: 'range' }) <{ theme: DefaultTheme }>`
  width: 80px; 
  @media (min-width: 768px) {
    width: 100px;
  }
  height: 8px;
  -webkit-appearance: none;
  appearance: none;
  background: ${({ theme }) => theme.colors.volumeSliderTrack};
  border-radius: 5px;
  outline: none;
  cursor: pointer;

  &::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 18px;
    height: 18px;
    background: ${({ theme }) => theme.colors.volumeSliderThumb};
    border-radius: 50%;
    border: 2px solid ${({ theme }) => theme.colors.volumeSliderThumbBorder};
    cursor: pointer;
    transition: background-color 0.2s;
  }

  &::-moz-range-thumb {
    width: 18px;
    height: 18px;
    background: ${({ theme }) => theme.colors.volumeSliderThumb};
    border-radius: 50%;
    border: 2px solid ${({ theme }) => theme.colors.volumeSliderThumbBorder};
    cursor: pointer;
    transition: background-color 0.2s;
  }

  &:hover::-webkit-slider-thumb {
    background: ${({ theme }) => theme.colors.volumeSliderThumbHover};
  }
  &:hover::-moz-range-thumb {
    background: ${({ theme }) => theme.colors.volumeSliderThumbHover};
  }
`;

// This is the flex child that will grow and shrink
const GameAreaContainer = styled.div`
  flex-grow: 1; /* Takes up remaining vertical space */
  position: relative; /* For StatusOverlay and GameOverOverlay */
  display: flex;
  justify-content: center;
  align-items: center;
  overflow: hidden; /* Crucial: Prevents its content from causing scroll */
  padding: 5px; /* Small padding around the game canvas wrapper */
  min-height: 0; /* Allows flex item to shrink below content size */
`;

function AppContent() {
  const { width } = useWindowSize();
  const isMobileView = useMemo(() => width < 768, [width]);
  const [animateLogo, setAnimateLogo] = useState(false);

  const navigate = useNavigate();

  const { volume, setVolume, isLoading: soundsLoading, error: soundError, resumeContext } = useSoundManager();
  const previousVolumeRef = useRef(volume);

  useEffect(() => {
    const intervalId = setInterval(() => {
      setAnimateLogo(true);
      setTimeout(() => setAnimateLogo(false), 500);
    }, 15000);
    return () => clearInterval(intervalId);
  }, []);

  const handleLogoClick = () => {
      navigate('/');
      setAnimateLogo(true);
      setTimeout(() => setAnimateLogo(false), 500);
  };

  useEffect(() => {
    if (soundsLoading) {
      console.log('Sounds loading...');
    } else if (soundError) {
      console.error('Sound loading error:', soundError);
    } else {
      console.log('Sounds loaded successfully.');
    }
  }, [soundsLoading, soundError]);

  const handleVolumeChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const newVolume = parseFloat(event.target.value);
    setVolume(newVolume);
  };

  const handleIconClick = () => {
    resumeContext();
    if (volume > 0) {
      previousVolumeRef.current = volume;
      setVolume(0);
    } else {
      setVolume(previousVolumeRef.current > 0 ? previousVolumeRef.current : 0.5);
    }
  };

  const renderVolumeIcon = () => {
    const iconSize = 22;
    const iconColor = theme.colors.text;
    if (volume === 0) return <VolumeMuteIcon size={iconSize} color={iconColor} />;
    if (volume < 0.33) return <VolumeLowIcon size={iconSize} color={iconColor} />;
    if (volume < 0.66) return <VolumeMediumIcon size={iconSize} color={iconColor} />;
    return <VolumeHighIcon size={iconSize} color={iconColor} />;
  };

  // Simple navigation handlers for LandingPage
  const handleCreateRoom = useCallback(() => {
    // Navigate to create route, let GameRoom handle the rest
    navigate('/room/create');
  }, [navigate]);

  const handleJoinRoom = useCallback((code: string) => {
    navigate(`/room/${code}`);
  }, [navigate]);

  const handleQuickPlay = useCallback(() => {
    navigate('/room/quickplay');
  }, [navigate]);

  return (
    <AppContainer theme={theme}>
      <Header theme={theme}>
        <div style={{ width: isMobileView ? '30px' : '130px', flexShrink: 0 }} />
        <LogoContainer onClick={handleLogoClick} style={{ cursor: 'pointer', pointerEvents: 'auto' }}>
          <Logo src="/bitmap.png" alt="PonGo Logo" $animate={animateLogo} />
          <Title theme={theme}>PonGo</Title>
        </LogoContainer>
        <VolumeControlContainer>
          <VolumeIconContainer onClick={handleIconClick} theme={theme} title={volume === 0 ? "Unmute" : "Mute"}>
            {renderVolumeIcon()}
          </VolumeIconContainer>
          {!isMobileView && (
            <VolumeSliderInput
              theme={theme}
              min="0"
              max="1"
              step="0.01"
              value={volume}
              onChange={handleVolumeChange}
              title={`Volume: ${Math.round(volume * 100)}%`}
            />
          )}
        </VolumeControlContainer>
      </Header>

      <GameAreaContainer>
        <Routes>
          <Route path="/" element={
            <LandingPage 
              onCreateRoom={handleCreateRoom}
              onJoinRoom={handleJoinRoom}
              onQuickPlay={handleQuickPlay}
            />
          } />
          <Route path="/room/:code" element={
            <GameRoom theme={theme} volume={volume} resumeContext={resumeContext} />
          } />
          <Route path="/room/create" element={
            <GameRoom theme={theme} volume={volume} resumeContext={resumeContext} createRoom={true} />
          } />
          <Route path="/room/quickplay" element={
            <GameRoom theme={theme} volume={volume} resumeContext={resumeContext} quickPlay={true} />
          } />
        </Routes>
      </GameAreaContainer>
    </AppContainer>
  );
}

export default function App() {
  return (
    <>
      <SpeedInsights />
      <Analytics />
      <ThemeProvider theme={theme}>
        <AppContent />
      </ThemeProvider>
    </>
  );
}