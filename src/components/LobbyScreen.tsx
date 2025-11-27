import React, { useEffect } from 'react';
import { getColorByOwnerIndex, getPlayerColorName } from '../utils/colors';
import styled, { DefaultTheme } from 'styled-components';
import { useNavigate, useParams, useLocation } from 'react-router-dom';
import { useGame } from '../context/GameContext';
import { CreateRoomRequest, JoinRoomRequest, QuickPlayRequest } from '../types/game';

const LobbyContainer = styled.div<{ theme: DefaultTheme }>`
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  color: ${({ theme }) => theme.colors.text};
  background-color: ${({ theme }) => theme.colors.background};
`;

const Title = styled.h2<{ theme: DefaultTheme }>`
  font-size: 2.5rem;
  margin-bottom: 2rem;
  color: ${({ theme }) => theme.colors.accent};
`;

const PlayerList = styled.ul`
  list-style: none;
  padding: 0;
  width: 300px;
  margin-bottom: 2rem;
`;

const PlayerItem = styled.li<{ theme: DefaultTheme }>`
  display: flex;
  justify-content: space-between;
  padding: 10px;
  border-bottom: 1px solid rgba(255,255,255,0.1);
  font-size: 1.2rem;
`;

const ReadyButton = styled.button<{ theme: DefaultTheme; $isReady: boolean }>`
  padding: 15px 40px;
  font-size: 1.5rem;
  background-color: ${({ theme, $isReady }) => $isReady ? theme.colors.success : theme.colors.primary};
  color: white;
  border: none;
  border-radius: 8px;
  cursor: pointer;
  margin-top: 30px;
  transition: transform 0.1s;
  
  &:hover {
    transform: scale(1.05);
    opacity: 0.9;
  }
  &:active {
    transform: scale(0.95);
  }
`;

const CountdownOverlay = styled.div<{ theme: DefaultTheme }>`
  position: absolute;
  top: 0; left: 0; right: 0; bottom: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0,0,0,0.8);
  z-index: 45;
  font-size: 10rem;
  font-weight: bold;
  color: ${({ theme }) => theme.colors.accent};
  text-shadow: 0 0 20px ${({ theme }) => theme.colors.accent};
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
  const { sendMessage, gameState, connectionStatus, connect } = useGame();
  const { phase, lobbyPlayers, myPlayerIndex, countdownSeconds } = gameState;

  useEffect(() => {
    connect();
  }, [connect]);

  console.log('LobbyScreen Render:', { phase, lobbyPlayers, myPlayerIndex, connectionStatus });

  // Handshake Logic
  useEffect(() => {
    if (connectionStatus === 'open') {
      if (createRoom) {
        console.log("Creating room...");
        const isPublic = location.state?.isPublic ?? true; // Default to true if not specified
        const req: CreateRoomRequest = { messageType: 'createRoom', isPublic };
        sendMessage(JSON.stringify(req));
      } else if (quickPlay) {
        console.log("Quick playing...");
        const req: QuickPlayRequest = { messageType: 'quickPlay' };
        sendMessage(JSON.stringify(req));
      } else if (code) {
        // Only join if we aren't already in this room? 
        // For now, let's assume if we hit this route, we want to join.
        // The backend handles duplicate joins gracefully usually.
        console.log("Joining room:", code);
        const req: JoinRoomRequest = { messageType: 'joinRoom', code };
        sendMessage(JSON.stringify(req));
      }
    }
  }, [connectionStatus, createRoom, quickPlay, code, sendMessage]); // Be careful with deps

  // Navigation Logic
  useEffect(() => {
    if (phase === 'playing') {
       // Navigate to game room
       // If we created/quickplayed, we might not have the code in URL yet, but gameState might not have it either?
       // Actually RoomJoinedResponse updates the URL in GameRoom previously.
       // We need to know the room code to navigate to /game/:code
       // Let's assume the URL is already updated or we can get it from somewhere?
       // If we are in /lobby/:code, we go to /game/:code.
       if (code && code !== 'create' && code !== 'quickplay') {
          navigate(`/game/${code}`, { replace: true });
       }
    }
  }, [phase, code, navigate]);

  // Handle Room Created/Joined to update URL (for create/quickplay)
  // This logic was in GameRoom, need to replicate or rely on context?
  // The context doesn't handle navigation. We need to handle it here.
  // But we don't have access to the raw messages in a clean way unless we use useGameState's effect?
  // Wait, useGameState handles state updates. We need to intercept the "RoomJoined" or "RoomCreated" message to navigate.
  // `useGame` exposes `lastMessage`.

  useEffect(() => {
      if (!useGame) return;
      // We can't easily parse lastMessage here again without duplicating logic or exposing it from context.
      // But wait, if we successfully joined, the URL should be updated.
      // If we used `createRoom` prop, we are at /lobby/create.
      // We need to move to /lobby/:actualCode.
      // Let's look at `gameState`. It doesn't store the room code.
      // We might need to add room code to GameState or handle it here.
  }, []);

  // Actually, let's just use the same logic as GameRoom for the initial handshake response
  const { lastMessage } = useGame();
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


  const toggleReady = () => {
    const me = lobbyPlayers.find(p => p.index === myPlayerIndex);
    const newReadyState = !me?.isReady;
    sendMessage(JSON.stringify({ messageType: 'playerReady', isReady: newReadyState }));
    // resumeContext(); // Sound context
  };

  const me = lobbyPlayers.find(p => p.index === myPlayerIndex);

  return (
    <LobbyContainer theme={theme}>
      <Title theme={theme}>Lobby</Title>
      {code && code !== 'create' && code !== 'quickplay' && (
        <div style={{ marginBottom: '20px', opacity: 0.7 }}>
          Room Code: <strong>{code}</strong>
        </div>
      )}
      
      <PlayerList>
        {lobbyPlayers.map((p: { index: number; isReady: boolean }) => (
          <PlayerItem key={p.index} theme={theme} style={{ 
            color: p.isReady ? theme.colors.success : theme.colors.text,
            borderLeft: `4px solid ${getColorByOwnerIndex(p.index)}`
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <div style={{ 
                width: '12px', 
                height: '12px', 
                borderRadius: '50%', 
                backgroundColor: getColorByOwnerIndex(p.index),
                boxShadow: `0 0 8px ${getColorByOwnerIndex(p.index)}`
              }} />
              <span>
                {getPlayerColorName(p.index)}
                {p.index === myPlayerIndex ? ' (You)' : ''}
              </span>
            </div>
            <span>{p.isReady ? 'READY' : 'WAITING'}</span>
          </PlayerItem>
        ))}
        {Array.from({ length: 4 - lobbyPlayers.length }).map((_, i) => (
            <PlayerItem key={`empty-${i}`} theme={theme} style={{ opacity: 0.3 }}>
              <span>Waiting for player...</span>
            </PlayerItem>
        ))}
      </PlayerList>

      <ReadyButton theme={theme} $isReady={!!me?.isReady} onClick={toggleReady}>
        {me?.isReady ? 'Ready!' : 'Click to Ready'}
      </ReadyButton>

      {phase === 'countingDown' && countdownSeconds !== null && (
        <CountdownOverlay theme={theme}>
          {countdownSeconds}
        </CountdownOverlay>
      )}
      {/* Debug Overlay */}
      <div style={{ position: 'absolute', bottom: 10, left: 10, color: 'lime', fontSize: '10px', fontFamily: 'monospace', background: 'rgba(0,0,0,0.8)', padding: '5px', zIndex: 100 }}>
        <pre>{JSON.stringify({ phase, myPlayerIndex, lobbyPlayers, connectionStatus }, null, 2)}</pre>
      </div>
    </LobbyContainer>
  );
};
