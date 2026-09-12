// Connecting (9.3): "Creating room…", "Finding a match…" or "Joining room ABC123…", "Retrying (n)…" once an
// attempt has failed, and a Cancel that leaves and goes home. On a rejoin over the frozen board it is a
// compact card at the top, so the last frame stays visible.

import { useNavigate } from 'react-router-dom';
import styled from 'styled-components';
import { useApp } from '../../app/AppContext';
import { Button } from '../common/Button';
import { H1 } from '../common/Heading';
import { Text } from '../common/Text';
import { Card } from '../layout/AppShell';
import { theme } from '../theme';
import { CONNECTING } from './copy';
import { connectingLines } from './roomView';
import type { ConnectingViewModel } from './roomView';

const Full = styled.div<{ $compact: boolean }>`
  position: absolute;
  inset: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: ${({ $compact }) => ($compact ? 'flex-start' : 'center')};
  /* The top inset belongs to the shell (AppShell pads it above the header), so it is not added again here. */
  padding: 16px calc(16px + ${theme.safe.r}) calc(16px + ${theme.safe.b}) calc(16px + ${theme.safe.l});
  pointer-events: ${({ $compact }) => ($compact ? 'none' : 'auto')};
`;

const Box = styled(Card)<{ $compact: boolean }>`
  max-width: ${({ $compact }) => ($compact ? '420px' : '440px')};
  align-items: center;
  text-align: center;
  gap: ${({ $compact }) => ($compact ? '10px' : '16px')};
  pointer-events: auto;
  background: ${({ $compact }) => ($compact ? 'rgba(9, 9, 11, 0.92)' : theme.color.card)};
`;

const Title = styled(H1)<{ $compact: boolean }>`
  font-size: ${({ $compact }) => ($compact ? '1.75rem' : 'clamp(1.9rem, 5vw, 2.5rem)')};
`;

const Spinner = styled.span`
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: 4px solid rgba(255, 255, 255, 0.2);
  border-top-color: ${theme.color.warn};
  animation: pongo-spin 1s linear infinite;
`;

export function ConnectingView({ view }: { view: ConnectingViewModel }): JSX.Element {
  const { session } = useApp();
  const navigate = useNavigate();
  const { title, detail } = connectingLines(view);
  const compact = view.rejoin;

  return (
    <Full $compact={compact}>
      <Box $compact={compact}>
        <Spinner aria-hidden="true" data-anim="" />
        <div role="status">
          <Title $compact={compact}>{title}</Title>
          {detail !== null && <Text $tone="muted">{detail}</Text>}
        </div>
        <Button
          variant="secondary"
          onClick={() => {
            // Explicit: with a room known this is leaving the match, so the rejoin banner is offered (C17).
            session.leave({ explicit: true });
            navigate('/');
          }}
        >
          {CONNECTING.cancel}
        </Button>
      </Box>
    </Full>
  );
}
