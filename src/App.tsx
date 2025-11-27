import { SpeedInsights } from "@vercel/speed-insights/react"
import { Analytics } from "@vercel/analytics/react"
import { useCallback, useMemo, useRef, useEffect } from 'react';
import { useNavigate, Routes, Route, useLocation } from 'react-router-dom';
import styled, { DefaultTheme, ThemeProvider } from 'styled-components';
import { ErrorBoundary } from './components/common/ErrorBoundary';

// Keep if needed for global constants, but unused here? No, used in GameRoom. Not here.
// Actually App.tsx doesn't use WEBSOCKET_URL anymore.

import { useWindowSize } from './hooks/useWindowSize';
import theme from './styles/theme';
import { useSoundManager } from './hooks/useSoundManager';

import { Music, Gamepad2, Home } from 'lucide-react';
import { LandingPage } from './components/LandingPage';
import { GameRoom } from './components/GameRoom';

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

// LogoContainer and Logo removed

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

import { GameProvider, useGame } from './context/GameContext';
import { LobbyScreen } from './components/LobbyScreen';

const VolumeGroup = styled.div`
  display: flex;
  align-items: center;
  margin-left: 15px;
  &:first-child {
    margin-left: 0;
  }
`;



interface MainLayoutProps {
  volume: number;
  setVolume: (volume: number) => void;
  soundtrackVolume: number;
  setSoundtrackVolume: (volume: number) => void;
  resumeContext: () => void;
}

function MainLayout({ volume, setVolume, soundtrackVolume, setSoundtrackVolume, resumeContext }: MainLayoutProps) {
  const { width } = useWindowSize();
  const isMobileView = useMemo(() => width < 768, [width]);
  const navigate = useNavigate();
  const location = useLocation();

  const { disconnect, connect } = useGame();
  
  const previousVolumeRef = useRef(volume);
  const previousSoundtrackVolumeRef = useRef(soundtrackVolume);

  const handleHomeClick = useCallback(() => {
    disconnect();
    navigate('/');
  }, [disconnect, navigate]);

  // Centralized Connection Logic
  useEffect(() => {
    console.log(`[App] Route changed to: ${location.pathname}`);
    if (location.pathname === '/') {
      console.log('[App] Disconnecting (Home Route)');
      disconnect();
    } else if (
      location.pathname.startsWith('/lobby') || 
      location.pathname.startsWith('/game') || 
      location.pathname.startsWith('/room')
    ) {
      console.log('[App] Connecting (Game/Lobby Route)');
      connect();
    }
  }, [location.pathname, disconnect, connect]);

  const handleVolumeChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const newVolume = parseFloat(event.target.value);
    setVolume(newVolume);
  };

  const handleSoundtrackVolumeChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const newVolume = parseFloat(event.target.value);
    setSoundtrackVolume(newVolume);
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

  const handleSoundtrackIconClick = () => {
    resumeContext();
    if (soundtrackVolume > 0) {
      previousSoundtrackVolumeRef.current = soundtrackVolume;
      setSoundtrackVolume(0);
    } else {
      setSoundtrackVolume(previousSoundtrackVolumeRef.current > 0 ? previousSoundtrackVolumeRef.current : 0.5);
    }
  };

  const handleCreateRoom = useCallback((isPublic: boolean) => {
    navigate('/lobby/create', { state: { isPublic } });
  }, [navigate]);

  const handleJoinRoom = useCallback((code: string) => {
    navigate(`/lobby/${code}`);
  }, [navigate]);

  const handleQuickPlay = useCallback(() => {
    navigate('/lobby/quickplay');
  }, [navigate]);

  return (
    <ErrorBoundary>
      <AppContainer theme={theme}>
        <Header theme={theme}>
          <div style={{ width: isMobileView ? '30px' : '130px', flexShrink: 0, display: 'flex', alignItems: 'center' }}>
             <VolumeIconContainer onClick={handleHomeClick} theme={theme} title="Back to Home">
                <Home size={24} />
             </VolumeIconContainer>
          </div>
          {/* Logo removed from header */}
          <VolumeControlContainer>
            {/* Soundtrack Control */}
            <VolumeGroup>
              <VolumeIconContainer 
                onClick={handleSoundtrackIconClick} 
                theme={theme} 
                title={soundtrackVolume === 0 ? "Unmute Music" : "Mute Music"}
                style={{ opacity: soundtrackVolume === 0 ? 0.5 : 1 }}
              >
                <Music size={24} />
              </VolumeIconContainer>
              {!isMobileView && (
                <VolumeSliderInput
                  theme={theme}
                  min="0"
                  max="1"
                  step="0.01"
                  value={soundtrackVolume}
                  onChange={handleSoundtrackVolumeChange}
                  title={`Music Volume: ${Math.round(soundtrackVolume * 100)}%`}
                />
              )}
            </VolumeGroup>

            {/* SFX Control */}
            <VolumeGroup>
              <VolumeIconContainer 
                onClick={handleIconClick} 
                theme={theme} 
                title={volume === 0 ? "Unmute SFX" : "Mute SFX"}
                style={{ opacity: volume === 0 ? 0.5 : 1 }}
              >
                 <Gamepad2 size={24} />
              </VolumeIconContainer>
              {!isMobileView && (
                <VolumeSliderInput
                  theme={theme}
                  min="0"
                  max="1"
                  step="0.01"
                  value={volume}
                  onChange={handleVolumeChange}
                  title={`SFX Volume: ${Math.round(volume * 100)}%`}
                />
              )}
            </VolumeGroup>
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
            <Route path="/lobby/create" element={
              <LobbyScreen theme={theme} createRoom={true} />
            } />
            <Route path="/lobby/quickplay" element={
              <LobbyScreen theme={theme} quickPlay={true} />
            } />
            <Route path="/lobby/:code" element={
              <LobbyScreen theme={theme} />
            } />
            <Route path="/game/:code" element={
              <GameRoom theme={theme} volume={volume} resumeContext={resumeContext} />
            } />
            <Route path="/room/:code" element={
              <GameRoom theme={theme} volume={volume} resumeContext={resumeContext} />
            } />
          </Routes>
        </GameAreaContainer>
      </AppContainer>
    </ErrorBoundary>
  );
}

function AppContent() {
  const { 
    volume, 
    setVolume, 
    soundtrackVolume, 
    setSoundtrackVolume, 
    isLoading: soundsLoading, 
    error: soundError, 
    resumeContext 
  } = useSoundManager();

  useEffect(() => {
    if (soundsLoading) {
      console.log('Sounds loading...');
    } else if (soundError) {
      console.error('Sound loading error:', soundError);
    } else {
      console.log('Sounds loaded successfully.');
    }
  }, [soundsLoading, soundError]);

  return (
    <GameProvider volume={volume}>
      <MainLayout 
        volume={volume} 
        setVolume={setVolume} 
        soundtrackVolume={soundtrackVolume}
        setSoundtrackVolume={setSoundtrackVolume}
        resumeContext={resumeContext} 
      />
    </GameProvider>
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