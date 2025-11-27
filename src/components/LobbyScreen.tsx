import React, { useEffect } from 'react';
import styled, { DefaultTheme } from 'styled-components';
import { useNavigate, useParams, useLocation } from 'react-router-dom';
import { useGame } from '../context/GameContext';
import { CreateRoomRequest, JoinRoomRequest, QuickPlayRequest } from '../types/game';
import { getPlayerColorName } from '../utils/colors';
import { Carousel } from './common/Carousel';
import { rulesSlides } from '../data/gameRules';
import { Button } from './common/Button';
import { Typography } from './common/Typography';
import { Avatar } from './common/Avatar';

const LobbyContainer = styled.div<{ theme: DefaultTheme }>`
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  color: ${({ theme }) => theme.colors.foreground};
  background-color: ${({ theme }) => theme.colors.background};
`;

const Card = styled.div<{ theme: DefaultTheme }>`
  background-color: ${({ theme }) => theme.colors.card};
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.sizes.borderRadius};
  padding: 2rem;
  width: 100%;
  max-width: 400px;
  display: flex;
  flex-direction: column;
  align-items: center;
  box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
`;

const PlayerList = styled.div`
  width: 100%;
  margin: 2rem 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
`;

const PlayerItem = styled.div<{ theme: DefaultTheme; $isReady: boolean }>`
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px;
  background-color: ${({ theme }) => theme.colors.muted};
  border-radius: ${({ theme }) => theme.sizes.borderRadius};
  border: 1px solid transparent;
  transition: all 0.2s;
  
  ${({ $isReady, theme }) => $isReady && `
    border-color: ${theme.colors.success};
    background-color: ${theme.colors.success}10;
  `}
`;

const CountdownOverlay = styled.div<{ theme: DefaultTheme }>`
  position: absolute;
  top: 0; left: 0; right: 0; bottom: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: ${({ theme }) => theme.colors.background}cc;
  backdrop-filter: blur(4px);
  z-index: 45;
  font-size: 10rem;
  font-weight: bold;
  color: ${({ theme }) => theme.colors.primary};
  text-shadow: 0 0 20px ${({ theme }) => theme.colors.primary}40;
  animation: pulse 1s infinite;

  @keyframes pulse {
    0% { transform: scale(1); opacity: 1; }
    50% { transform: scale(1.2); opacity: 0.8; }
    100% { transform: scale(1); opacity: 1; }
  }
`;

interface LobbyScreenProps {
  theme: DefaultTheme;
  createRoom?: boolean;
  quickPlay?: boolean;
}

export const LobbyScreen: React.FC<LobbyScreenProps> = ({ theme, createRoom, quickPlay }) => {
  const { code } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { sendMessage, gameState, connectionStatus, lastMessage } = useGame();
  const { phase, lobbyPlayers, myPlayerIndex, countdownSeconds } = gameState;

  const [statusText, setStatusText] = React.useState('Initializing...');
  const hasSentRequest = React.useRef(false);

  // Reset request flag if connection drops
  useEffect(() => {
    if (connectionStatus !== 'open') {
      hasSentRequest.current = false;
      setStatusText('Connecting to server...');
    }
  }, [connectionStatus]);

  // connect() is now handled in App.tsx based on route

  // Handshake Logic
  useEffect(() => {
    console.log(`[LobbyScreen] Handshake Check - Status: ${connectionStatus}, Create: ${createRoom}, Quick: ${quickPlay}, Code: ${code}, Sent: ${hasSentRequest.current}`);
    
    if (connectionStatus === 'open' && !hasSentRequest.current) {
      if (createRoom) {
        console.log('[LobbyScreen] Sending createRoom request');
        setStatusText('Creating room...');
        const isPublic = location.state?.isPublic ?? true;
        const req: CreateRoomRequest = { messageType: 'createRoom', isPublic };
        sendMessage(JSON.stringify(req));
        hasSentRequest.current = true;
      } else if (quickPlay) {
        console.log('[LobbyScreen] Sending quickPlay request');
        setStatusText('Looking for a match...');
        const req: QuickPlayRequest = { messageType: 'quickPlay' };
        sendMessage(JSON.stringify(req));
        hasSentRequest.current = true;
      } else if (code) {
        console.log(`[LobbyScreen] Sending joinRoom request for ${code}`);
        setStatusText(`Joining room ${code}...`);
        const req: JoinRoomRequest = { messageType: 'joinRoom', code };
        sendMessage(JSON.stringify(req));
        hasSentRequest.current = true;
      }
    }
  }, [connectionStatus, createRoom, quickPlay, code, sendMessage, location.state]);

  // Navigation Logic
  useEffect(() => {
    if (lastMessage) {
      try {
        const data = JSON.parse(lastMessage.data);
        if (data.messageType === 'roomCreated') {
           navigate(`/lobby/${data.code}`, { replace: true });
        } else if (data.messageType === 'roomJoined') {
           if (data.success && data.code && data.code !== code) {
              if (data.phase === 'playing') {
                navigate(`/game/${data.code}`, { replace: true });
              } else {
                navigate(`/lobby/${data.code}`, { replace: true });
              }
           }
        }
      } catch (e) {
        // ignore
      }
    }
  }, [lastMessage, navigate, code]);

  useEffect(() => {
    if (phase === 'playing' && code && code !== 'create' && code !== 'quickplay') {
       navigate(`/game/${code}`, { replace: true });
    }
  }, [phase, code, navigate]);

  const toggleReady = () => {
    const me = lobbyPlayers.find(p => p.index === myPlayerIndex);
    const newReadyState = !me?.isReady;
    sendMessage(JSON.stringify({ messageType: 'playerReady', isReady: newReadyState }));
  };

  const me = lobbyPlayers.find(p => p.index === myPlayerIndex);

  return (
    <LobbyContainer theme={theme}>
      <Card theme={theme}>
        <Typography variant="h1" align="center" style={{ marginBottom: '0.5rem' }}>Lobby</Typography>
        <Typography variant="body" align="center" style={{ marginBottom: '1rem', opacity: 0.7 }}>{statusText}</Typography>
        
        {code && code !== 'create' && code !== 'quickplay' && (
          <div style={{ marginBottom: '1.5rem', textAlign: 'center' }}>
            <Typography variant="caption">Room Code</Typography>
            <Typography variant="h3" style={{ letterSpacing: '0.1em' }}>{code}</Typography>
          </div>
        )}
        
        <PlayerList>
          {lobbyPlayers.map((p: { index: number; isReady: boolean }) => (
            <PlayerItem key={p.index} theme={theme} $isReady={p.isReady}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <Avatar playerIndex={p.index} isReady={p.isReady} />
                <Typography>
                  {getPlayerColorName(p.index)}
                  {p.index === myPlayerIndex && <span style={{ opacity: 0.5, marginLeft: '4px' }}>(You)</span>}
                </Typography>
              </div>
              <Typography 
                variant="caption" 
                style={{ 
                  color: p.isReady ? theme.colors.success : theme.colors.mutedForeground,
                  fontWeight: 600 
                }}
              >
                {p.isReady ? 'READY' : 'WAITING'}
              </Typography>
            </PlayerItem>
          ))}
          {Array.from({ length: 4 - lobbyPlayers.length }).map((_, i) => (
              <PlayerItem key={`empty-${i}`} theme={theme} $isReady={false} style={{ opacity: 0.5 }}>
                <Typography variant="caption" style={{ fontStyle: 'italic' }}>Waiting for player...</Typography>
              </PlayerItem>
          ))}
        </PlayerList>

        <Button 
          size="lg" 
          variant={me?.isReady ? 'default' : 'outline'}
          onClick={toggleReady}
          style={{ width: '100%' }}
        >
          {me?.isReady ? 'Ready!' : 'Click to Ready'}
        </Button>
      </Card>

      <div style={{ width: '100%', maxWidth: '600px', marginTop: '20px' }}>
        <Carousel slides={rulesSlides} />
      </div>

      {phase === 'countingDown' && countdownSeconds !== null && (
        <CountdownOverlay theme={theme}>
          {countdownSeconds}
        </CountdownOverlay>
      )}
    </LobbyContainer>
  );
};
