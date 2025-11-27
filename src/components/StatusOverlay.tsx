// File: src/components/StatusOverlay.tsx
import React from 'react';
import styled, { keyframes, DefaultTheme } from 'styled-components';
import { ReadyState } from 'react-use-websocket';

// Define the type for the status prop more accurately
type StatusProp = ReadyState | 'waiting' | 'error' | string;

interface StatusOverlayProps {
  status: StatusProp;
  theme: DefaultTheme;
}

// --- Keyframes for Animations ---
const pulse = keyframes`
  0% { opacity: 0.6; }
  50% { opacity: 1; }
  100% { opacity: 0.6; }
`;

const spin = keyframes`
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
`;

// --- Styled Components ---
const OverlayContainer = styled.div<{ theme: DefaultTheme }>`
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: rgba(0, 0, 0, 0.6); /* More transparent */
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  z-index: 40; /* Below GameOver, above Scoreboard/Controls */
  padding: 20px;
  text-align: center;
  box-shadow: ${({ theme }) => theme.shadows.statusOverlay};
  border-radius: ${({ theme }) => theme.sizes.borderRadius}; /* Optional rounding */
  color: ${({ theme }) => theme.colors.statusOverlayText};
  font-size: ${({ theme }) => theme.fonts.sizes.status};
  font-family: ${({ theme }) => theme.fonts.primary};
`;

const StatusText = styled.p<{ color?: string }>`
  margin-top: 15px;
  font-weight: 500;
  color: ${({ color, theme }) => color || theme.colors.statusOverlayText};
  animation: ${pulse} 2s infinite ease-in-out;
`;

const Spinner = styled.div<{ color?: string }>`
  border: 4px solid rgba(255, 255, 255, 0.3);
  border-radius: 50%;
  border-top-color: ${({ color, theme }) => color || theme.colors.statusOverlayConnecting};
  width: 40px;
  height: 40px;
  animation: ${spin} 1s linear infinite;
`;

const Icon = styled.div`
  font-size: 2.5em; /* Larger icon */
  margin-bottom: 10px;
`;

// --- Component Logic ---
const StatusOverlay: React.FC<StatusOverlayProps> = ({ status, theme }) => {
  let content = null;

  // Use ReadyState enum values in the switch
  switch (status) {
    case ReadyState.CONNECTING:
    case ReadyState.UNINSTANTIATED: // Treat UNINSTANTIATED like CONNECTING
      content = (
        <>
          <Spinner color={theme.colors.statusOverlayConnecting} />
          <StatusText color={theme.colors.statusOverlayConnecting}>
            Connecting...
          </StatusText>
        </>
      );
      break;
    case 'waiting': // Custom state
      content = (
        <>
          <Spinner color={theme.colors.statusOverlayWaiting} />
          <StatusText color={theme.colors.statusOverlayWaiting}>
            Waiting for game state...
          </StatusText>
        </>
      );
      break;
    case ReadyState.CLOSING:
      content = (
        <>
          <Icon>⏳</Icon>
          <StatusText color={theme.colors.statusOverlayClosed}>
            Closing Connection...
          </StatusText>
        </>
      );
      break;
    case ReadyState.CLOSED:
      content = (
        <>
          <Icon>🚫</Icon>
          <StatusText color={theme.colors.statusOverlayClosed}>
            Connection Closed. Retrying...
          </StatusText>
        </>
      );
      break;
    case 'error': // Custom error state
      content = (
        <>
          <Icon>⚠️</Icon>
          <StatusText color={theme.colors.statusOverlayError}>
            Connection Error. Retrying...
          </StatusText>
        </>
      );
      break;
    // No case for ReadyState.OPEN as the overlay shouldn't show then
    // No default needed
  }

  // If content is null (e.g. status is 'open' or unknown), do not render the container
  if (!content) return null;

  return <OverlayContainer theme={theme}>{content}</OverlayContainer>;
};

export default StatusOverlay;