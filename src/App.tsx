// File: src/App.tsx
import { SpeedInsights } from "@vercel/speed-insights/react"
import { Analytics } from "@vercel/analytics/react"
// File: src/App.tsx
import { useCallback, useMemo, useState, useRef, useEffect } from 'react';
import styled, { DefaultTheme, ThemeProvider, keyframes } from 'styled-components';
import useWebSocket, { ReadyState } from 'react-use-websocket';
import * as THREE from 'three';

import R3FCanvas from './components/R3FCanvas';
import StatusOverlay from './components/StatusOverlay';
import { WEBSOCKET_URL } from './utils/constants';
import { DirectionMessage, Player, VisualDirection } from './types/game';
import { useInputHandler } from './hooks/useInputHandler';
import { useGameState } from './hooks/useGameState';
import { usePlayerRotation } from './utils/rotation';
import { useWindowSize } from './hooks/useWindowSize';
import theme from './styles/theme';
import { useSoundManager } from './hooks/useSoundManager';

// Import SVG Icons
import VolumeHighIcon from './components/icons/VolumeHighIcon';
import VolumeMediumIcon from './components/icons/VolumeMediumIcon';
import VolumeLowIcon from './components/icons/VolumeLowIcon';
import VolumeMuteIcon from './components/icons/VolumeMuteIcon';


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

const Logo = styled.img<{ animate: boolean }>`
  height: calc(var(--header-height) * 0.5); /* Scale logo with header */
  max-height: 30px; /* Max size */
  margin-right: 10px;
  animation: ${({ animate }) => (animate ? logoShakeAnimation : 'none')} 0.5s ease-in-out;
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

// This wrapper will maintain the aspect ratio for the R3F Canvas
const GameCanvasWrapper = styled.div`
  width: 100%;
  height: 100%;
  max-width: 100%; /* Ensure it doesn't overflow GameAreaContainer width */
  max-height: 100%; /* Ensure it doesn't overflow GameAreaContainer height */
  aspect-ratio: var(--game-aspect-ratio); /* Enforce aspect ratio */
  position: relative; /* If R3FCanvas needs to be absolute or for other children */
  display: flex; /* To make R3FCanvas fill this wrapper */
  justify-content: center;
  align-items: center;

  & > canvas { /* Target the R3F canvas element directly */
    display: block; /* Remove extra space below canvas */
    width: 100% !important; /* Force R3F canvas to fill wrapper */
    height: 100% !important; /* Force R3F canvas to fill wrapper */
  }
`;


const ScoreBoard = styled.div<{ theme: DefaultTheme }>`
  position: fixed; /* Changed from absolute to fixed for simplicity with new layout */
  top: calc(var(--header-height) + 10px); /* Position below header */
  left: 10px;
  padding: 8px;
  opacity: 0.6; /* Slightly more visible */
  z-index: 20;
  background: ${({ theme }) => theme.colors.scoreboardBackground};
  border-radius: ${({ theme }) => theme.sizes.borderRadius};
  border: 1px solid ${({ theme }) => theme.colors.scoreboardBorder};
  font-size: ${({ theme }) => theme.fonts.sizes.mobileScore};
  font-family: ${({ theme }) => theme.fonts.monospace};
  color: ${({ theme }) => theme.colors.text};
  box-shadow: ${({ theme }) => theme.shadows.scoreboard};
  line-height: 1.5;
  font-weight: 500;

  @media (min-width: 768px) {
    padding: 10px 15px;
    font-size: ${({ theme }) => theme.fonts.sizes.score};
    opacity: 0.8;
  }
  
  div {
    margin-bottom: 5px;
    &:last-child {
      margin-bottom: 0;
    }
  }
`;

const GameOverOverlay = styled.div<{ theme: DefaultTheme }>`
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: rgba(0, 0, 0, 0.85); /* Slightly darker */
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  color: ${({ theme }) => theme.colors.text};
  z-index: 50;
  text-align: center;
  padding: 20px;
  h2 { font-size: 2.5em; margin-bottom: 20px; color: ${({ theme }) => theme.colors.accent}; }
  p { font-size: 1.2em; margin-bottom: 15px; }
  ul { list-style: none; padding: 0; margin-top: 10px; }
  li { margin-bottom: 5px; font-size: 1em; }
`;

const MobileControlsContainer = styled.div<{ theme: DefaultTheme }>`
  height: var(--controls-height); /* Use CSS Variable */
  display: flex;
  gap: 0.5rem; /* Reduced gap slightly */
  padding: 0.5rem;
  flex-shrink: 0; /* Prevent controls from shrinking */
  z-index: 30;
  user-select: none;
  -webkit-user-select: none;
  -webkit-tap-highlight-color: transparent;
  justify-content: space-around;
  /* Add safe area padding to the bottom of the controls container itself */
  padding-bottom: max(env(safe-area-inset-bottom, 0.5rem), 0.5rem);
  background-color: ${({ theme }) => theme.colors.background}; /* Ensure controls have bg */
`;

const ControlButton = styled.button<{ theme: DefaultTheme; isActive: boolean }>`
  flex: 1;
  height: 100%;
  display: flex;
  justify-content: center;
  align-items: center;
  background-color: ${({ theme, isActive }) => isActive ? theme.colors.mobileButtonBackgroundActive : theme.colors.mobileButtonBackground};
  border: 1px solid ${({ theme }) => theme.colors.mobileButtonBorder}; /* Consistent border */
  border-radius: ${({ theme }) => theme.sizes.borderRadius}; /* Rounded corners */
  color: ${({ theme }) => theme.colors.mobileButtonSymbol};
  font-size: ${({ theme }) => theme.fonts.sizes.mobileButtonSymbol};
  font-weight: bold;
  cursor: pointer;
  transition: background-color 0.1s ease-out, transform 0.05s ease-out;
  outline: none;
  transform: ${({ isActive }) => isActive ? 'scale(0.98)' : 'scale(1)'};

  /* Remove specific border-right for first-child, rely on gap and individual borders */
  /* &:first-child {
    border-right: 1px solid ${({ theme }) => theme.colors.mobileButtonBorder};
  } */

  &:active {
    background-color: ${({ theme }) => theme.colors.mobileButtonBackgroundActive};
    transform: scale(0.98);
  }

  &:disabled {
    background-color: ${({ theme }) => theme.colors.mobileButtonBackground};
    opacity: 0.5;
    cursor: not-allowed;
  }
`;

function AppContent() {
  const { width } = useWindowSize();
  const isMobileView = useMemo(() => width < 768, [width]);
  const lastSentMobileLogicalDir = useRef<DirectionMessage['direction'] | null>(null);
  const lastSentLogicalKeyboardDir = useRef<DirectionMessage['direction'] | null>(null);
  const [leftActive, setLeftActive] = useState(false);
  const [rightActive, setRightActive] = useState(false);
  const [animateLogo, setAnimateLogo] = useState(false);

  const { playSound, volume, setVolume, isLoading: soundsLoading, error: soundError, resumeContext } = useSoundManager();
  const previousVolumeRef = useRef(volume);

  const { sendMessage, lastMessage, readyState } = useWebSocket(WEBSOCKET_URL, {
    shouldReconnect: () => true,
    reconnectInterval: 3000,
    filter: (msg): msg is MessageEvent<string> =>
      typeof msg.data === 'string' && msg.data.startsWith('{'),
  });

  const {
    originalPlayers,
    originalPaddles,
    originalBalls,
    brickStates,
    cellSize,
    myPlayerIndex,
    gameOverInfo,
  } = useGameState(lastMessage, playSound);

  const rotationDegrees = usePlayerRotation(myPlayerIndex);
  const rotationRadians = useMemo(() => THREE.MathUtils.degToRad(rotationDegrees), [rotationDegrees]);

  const connectionStatus = useMemo(() => {
    switch (readyState) {
      case ReadyState.CONNECTING: return ReadyState.CONNECTING;
      case ReadyState.OPEN: return ReadyState.OPEN;
      case ReadyState.CLOSING: return ReadyState.CLOSING;
      case ReadyState.CLOSED: return ReadyState.CLOSED;
      case ReadyState.UNINSTANTIATED: return ReadyState.CONNECTING;
      default: return 'error';
    }
  }, [readyState]);

  const isGameActive = connectionStatus === ReadyState.OPEN && !gameOverInfo;
  const isGameReady = isGameActive && brickStates.length > 0 && cellSize > 0;

  const displayStatus = useMemo(() => {
    if (gameOverInfo) return null;
    if (isGameReady) return null;
    if (connectionStatus === ReadyState.OPEN && !isGameReady) return 'waiting';
    if (connectionStatus === ReadyState.OPEN) return null;
    return connectionStatus;
  }, [connectionStatus, isGameReady, gameOverInfo]);

  useEffect(() => {
    const intervalId = setInterval(() => {
      setAnimateLogo(true);
      setTimeout(() => setAnimateLogo(false), 500);
    }, 15000);
    return () => clearInterval(intervalId);
  }, []);

  const sendLogicalDirectionMessage = useCallback(
    (logicalDir: DirectionMessage['direction'], source: 'kb' | 'mobile') => {
      if (!isGameActive) return;
      if (source === 'kb') {
        if (logicalDir === lastSentLogicalKeyboardDir.current) return;
        lastSentLogicalKeyboardDir.current = logicalDir;
      } else {
        if (logicalDir === lastSentMobileLogicalDir.current) return;
        lastSentMobileLogicalDir.current = logicalDir;
      }
      sendMessage(JSON.stringify({ direction: logicalDir }));
    },
    [isGameActive, sendMessage]
  );

  const mapDirection = useCallback((visualDir: VisualDirection): DirectionMessage['direction'] => {
    if (visualDir === 'Stop') return 'Stop';
    const needsSwap = myPlayerIndex === 0 || myPlayerIndex === 1;
    if (needsSwap) {
      return visualDir === 'ArrowLeft' ? 'ArrowRight' : 'ArrowLeft';
    }
    return visualDir;
  }, [myPlayerIndex]);

  const handleKeyboardVisualChange = useCallback((visualDir: VisualDirection) => {
    setLeftActive(visualDir === 'ArrowLeft');
    setRightActive(visualDir === 'ArrowRight');
    const logicalDir = mapDirection(visualDir);
    sendLogicalDirectionMessage(logicalDir, 'kb');
  }, [mapDirection, sendLogicalDirectionMessage]);

  useInputHandler({
    isEnabled: isGameActive,
    onVisualDirectionChange: handleKeyboardVisualChange,
  });

  const handleTouchStart = useCallback((visualDir: 'ArrowLeft' | 'ArrowRight') => (e: React.TouchEvent) => {
    e.preventDefault();
    resumeContext();
    if (!isGameActive) return;
    if (visualDir === 'ArrowLeft') setLeftActive(true);
    if (visualDir === 'ArrowRight') setRightActive(true);
    const logicalDir = mapDirection(visualDir);
    sendLogicalDirectionMessage(logicalDir, 'mobile');
  }, [mapDirection, sendLogicalDirectionMessage, isGameActive, resumeContext]);

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    e.preventDefault();
    if (!isGameActive) return;
    setLeftActive(false);
    setRightActive(false);
    const logicalDir = mapDirection('Stop');
    sendLogicalDirectionMessage(logicalDir, 'mobile');
  }, [mapDirection, sendLogicalDirectionMessage, isGameActive]);

  const renderGameOver = () => {
    if (!gameOverInfo) return null;
    const winnerText =
      gameOverInfo.winnerIndex === -1
        ? 'It\'s a Tie!'
        : `Player ${gameOverInfo.winnerIndex} Wins!`;
    return (
      <GameOverOverlay theme={theme}>
        <h2>Game Over!</h2>
        <p>{winnerText}</p>
        <p>Reason: {gameOverInfo.reason}</p>
        <p>Final Scores:</p>
        <ul>
          {gameOverInfo.finalScores.map((score, index) => (
            <li key={index}>
              Player {index}: {score}
            </li>
          ))}
        </ul>
      </GameOverOverlay>
    );
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

  return (
    <AppContainer theme={theme}>
      <Header theme={theme}>
        <div style={{ width: isMobileView ? '30px' : '130px', flexShrink: 0 }} />
        <LogoContainer>
          <Logo src="/bitmap.png" alt="PonGo Logo" animate={animateLogo} />
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
        <GameCanvasWrapper>
          {(isGameReady || displayStatus === 'waiting') && (
            <R3FCanvas
              brickStates={brickStates}
              cellSize={cellSize}
              paddles={originalPaddles}
              balls={originalBalls}
              rotationAngle={rotationRadians}
              wsStatus={connectionStatus === ReadyState.OPEN ? 'open' : 'closed'}
            />
          )}
        </GameCanvasWrapper>
        {/* StatusOverlay and GameOverOverlay will be positioned relative to GameAreaContainer */}
        {displayStatus && (
          <StatusOverlay status={displayStatus} theme={theme} />
        )}
        {renderGameOver()}
      </GameAreaContainer>

      <ScoreBoard theme={theme}>
        {myPlayerIndex !== null && <div>You: P{myPlayerIndex}</div>}
        {originalPlayers
          .filter((p): p is Player => p !== null)
          .map((p) => (
            <div key={p.index}>
              P{p.index}: {String(p.score).padStart(3, ' ')}
            </div>
          ))}
      </ScoreBoard>

      {isMobileView && (
        <MobileControlsContainer theme={theme}>
          <ControlButton
            theme={theme}
            isActive={leftActive}
            onTouchStart={handleTouchStart('ArrowLeft')}
            onTouchEnd={handleTouchEnd}
            disabled={!isGameActive}
          >
            ◀
          </ControlButton>
          <ControlButton
            theme={theme}
            isActive={rightActive}
            onTouchStart={handleTouchStart('ArrowRight')}
            onTouchEnd={handleTouchEnd}
            disabled={!isGameActive}
          >
            ▶
          </ControlButton>
        </MobileControlsContainer>
      )}
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