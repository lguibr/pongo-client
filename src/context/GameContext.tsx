import React, { createContext, useContext, useEffect, useMemo, useState, useCallback } from 'react';
import useWebSocket, { ReadyState } from 'react-use-websocket';
import { WEBSOCKET_URL } from '../utils/constants';
import { useGameState, GameState } from '../hooks/useGameState';
import { useSoundManager, SoundEventType } from '../hooks/useSoundManager';
// import { GameState } from '../types/game'; // Removed as we use the extended one from hook

interface GameContextType {
  sendMessage: (message: string) => void;
  lastMessage: MessageEvent<string> | null;
  readyState: ReadyState;
  connectionStatus: string;
  gameState: GameState;
  playSound: (type: SoundEventType, index?: number) => void;
  setVolume: (volume: number) => void;
  connect: () => void;
  disconnect: () => void;
}

const GameContext = createContext<GameContextType | undefined>(undefined);

export const useGame = () => {
  const context = useContext(GameContext);
  if (!context) {
    throw new Error('useGame must be used within a GameProvider');
  }
  return context;
};

interface GameProviderProps {
  children: React.ReactNode;
  volume: number;
}

export const GameProvider: React.FC<GameProviderProps> = ({ children, volume }) => {
  const { playSound, setVolume } = useSoundManager();

  // Sync volume from prop to sound manager
  useEffect(() => {
    setVolume(volume);
  }, [volume, setVolume]);

  const handleGameSound = useCallback((type: SoundEventType, index?: number) => {
    console.log(`[GameContext] Playing sound: ${type}`);
    playSound(type, index);
  }, [playSound]);

  const gameState = useGameState(handleGameSound);

  const [shouldConnect, setShouldConnect] = useState(true);

  const { sendMessage, lastMessage, readyState } = useWebSocket(shouldConnect ? WEBSOCKET_URL : null, {
    shouldReconnect: () => true,
    reconnectInterval: 3000,
    filter: (msg): msg is MessageEvent<string> =>
      typeof msg.data === 'string' && msg.data.startsWith('{'),
    share: true,
    onMessage: (event) => {
      gameState.processMessage(event as MessageEvent<string>);
    }
  });

  const { resetState } = gameState;

  const disconnect = useCallback(() => {
    console.log('[GameContext] Disconnecting...');
    setShouldConnect(false);
    resetState();
  }, [resetState]);

  const connect = useCallback(() => {
    console.log('[GameContext] Connecting...');
    setShouldConnect(true);
  }, []);

  const connectionStatus = useMemo(() => {
    console.log(`[GameContext] Connection Status: ${readyState}, ShouldConnect: ${shouldConnect}`);
    if (!shouldConnect) return 'closed';
    switch (readyState) {
      case ReadyState.CONNECTING: return 'connecting';
      case ReadyState.OPEN: return 'open';
      case ReadyState.CLOSING: return 'closing';
      case ReadyState.CLOSED: return 'closed';
      case ReadyState.UNINSTANTIATED: return 'connecting';
      default: return 'error';
    }
  }, [readyState, shouldConnect]);

  const value = {
    sendMessage,
    lastMessage,
    readyState,
    connectionStatus,
    gameState,
    playSound,
    setVolume,
    connect,
    disconnect
  };

  return (
    <GameContext.Provider value={value}>
      {children}
    </GameContext.Provider>
  );
};
