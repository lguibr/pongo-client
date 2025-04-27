// File: frontend/src/components/GameCanvas.tsx
import React from 'react';
import styled from 'styled-components';
import { GameState } from '../types/game';
import { CANVAS_SIZE } from '../config';
import Paddle from './Paddle';
import Ball from './Ball';
import Brick from './Brick';

interface GameCanvasProps {
  gameState: GameState | null;
  wsStatus: 'connecting' | 'open' | 'closing' | 'closed' | 'error';
}

const CanvasContainer = styled.div`
  position: relative; /* Crucial for absolute positioning of children */
  width: ${CANVAS_SIZE}px;
  height: ${CANVAS_SIZE}px;
  background-color: #000; /* Black background for the canvas */
  border: 2px solid #555; /* Optional border */
  overflow: hidden; /* Hide anything slightly outside */
  margin: auto; /* Center horizontally if parent allows */
`;

const StatusMessage = styled.div`
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  color: white;
  font-size: 1.5em;
  background-color: rgba(0, 0, 0, 0.7);
  padding: 10px 20px;
  border-radius: 5px;
  z-index: 10; /* Ensure it's above game elements */
`;

const Scoreboard = styled.div`
  position: absolute;
  top: 10px;
  left: 10px;
  color: white;
  background-color: rgba(0, 0, 0, 0.6);
  padding: 5px 10px;
  border-radius: 3px;
  font-size: 0.9em;
  z-index: 5;
  text-align: left;
`;

const GameCanvas: React.FC<GameCanvasProps> = ({ gameState, wsStatus }) => {
  const renderStatus = () => {
    switch (wsStatus) {
      case 'connecting':
        return <StatusMessage>Connecting...</StatusMessage>;
      case 'closed':
        return <StatusMessage>Disconnected</StatusMessage>;
      case 'error':
        return <StatusMessage>Connection Error</StatusMessage>;
      case 'closing':
        return <StatusMessage>Closing...</StatusMessage>;
      case 'open':
        if (!gameState || !gameState.canvas) { // Check for canvas as well
          return <StatusMessage>Waiting for game state...</StatusMessage>;
        }
        return null; // Game state received, no status message needed
      default:
        return null;
    }
  };

  const renderScores = () => {
    if (!gameState || !gameState.players) return null;
    return (
      <Scoreboard>
        {gameState.players.map((player, index) =>
          player ? ( // Check if player is not null
            <div key={player.id || index} style={{ color: `rgb(${player.color.join(',')})` }}>
              P{index}: {player.score}
            </div>
          ) : null // Render nothing for null player slots
        )}
      </Scoreboard>
    );
  };

  return (
    <CanvasContainer>
      {renderStatus()}
      {gameState && gameState.canvas && wsStatus === 'open' && ( // Ensure gameState and canvas exist
        <>
          {renderScores()}
          {/* Render Bricks */}
          {gameState.canvas.grid?.flat().map((cell) => // Use optional chaining
            // Check cell, cell.data, type, and life
            cell && cell.data && cell.data.type === 0 && cell.data.life > 0 ? (
              <Brick key={`brick-${cell.x}-${cell.y}`} $cellData={cell} />
            ) : null
          )}

          {/* Render Paddles */}
          {gameState.paddles?.map((paddle) => // Use optional chaining
            paddle ? <Paddle key={`paddle-${paddle.index}`} $paddleData={paddle} /> : null
          )}

          {/* Render Balls */}
          {gameState.balls?.map((ball) => // Use optional chaining
            ball ? <Ball key={`ball-${ball.id}`} $ballData={ball} /> : null
          )}
        </>
      )}
    </CanvasContainer>
  );
};

export default GameCanvas;