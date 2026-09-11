// A failed session (9.5, 9.6): a centred card with a title, a body, the server's reason when there is one,
// and actions derived from the failure's flags (retry, join as new, the code's extras, then Home).

import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import styled from 'styled-components';
import { useApp } from '../../app/AppContext';
import { Button } from '../common/Button';
import type { ButtonVariant } from '../common/Button';
import { H1 } from '../common/Heading';
import { Caption, Text } from '../common/Text';
import { Card } from '../layout/AppShell';
import { theme } from '../theme';
import { failureActions, failureText } from './roomView';
import type { FailureActionId } from './roomView';
import type { RoomViewModel } from './roomView';

const Scroll = styled.div`
  position: absolute;
  inset: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 16px calc(16px + ${theme.safe.r}) calc(16px + ${theme.safe.b}) calc(16px + ${theme.safe.l});
  background: ${theme.color.bg};
  pointer-events: auto;

  & > * {
    margin-block: auto;
  }
`;

const Box = styled(Card)`
  max-width: 480px;
  gap: 14px;
  text-align: center;
  align-items: center;
`;

const Actions = styled.div`
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 100%;
  margin-top: 6px;
`;

function variantFor(id: FailureActionId, index: number): ButtonVariant {
  if (id === 'home') return 'outline';
  return index === 0 ? 'primary' : 'secondary';
}

export function FailureView({ view }: { view: Extract<RoomViewModel, { kind: 'failed' }> }): JSX.Element {
  const { session } = useApp();
  const navigate = useNavigate();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const text = failureText(view.failure, view.code);
  const actions = failureActions(view.failure);

  // The failure replaces the whole screen, so reading starts at its title.
  useEffect(() => {
    titleRef.current?.focus();
  }, [view.failure.code]);

  const run = (id: FailureActionId): void => {
    switch (id) {
      case 'retry':
        session.retry();
        return;
      case 'joinAsNew':
        session.joinAsNew();
        return;
      case 'quick':
        session.start({ kind: 'quick' });
        navigate('/room');
        return;
      case 'home':
        session.leave({ explicit: false });
        navigate('/');
        return;
    }
  };

  return (
    <Scroll>
      <Box as="section" aria-labelledby="failure-title">
        <H1 id="failure-title" ref={titleRef} tabIndex={-1}>
          {text.title}
        </H1>
        {text.body !== null && <Text $tone="muted">{text.body}</Text>}
        {text.serverSaid !== null && <Caption>{text.serverSaid}</Caption>}
        <Actions>
          {actions.map((a, i) => (
            <Button key={a.id} block variant={variantFor(a.id, i)} onClick={() => run(a.id)}>
              {a.label}
            </Button>
          ))}
        </Actions>
      </Box>
    </Scroll>
  );
}
