// The catch-all route (C36, C100). It never opens a socket.

import { useNavigate } from 'react-router-dom';
import styled from 'styled-components';
import { Button } from './common/Button';
import { H1 } from './common/Heading';
import { Text } from './common/Text';
import { Card, ScreenScroll } from './layout/AppShell';

const Narrow = styled(Card)`
  max-width: 440px;
  text-align: center;
  align-items: center;
  gap: 16px;
`;

export default function NotFound(): JSX.Element {
  const navigate = useNavigate();
  return (
    <ScreenScroll>
      <Narrow>
        <H1>Page not found</H1>
        <Text $tone="muted">There is nothing at this address. Room links look like /room/ABC123.</Text>
        <Button onClick={() => navigate('/')}>Home</Button>
      </Narrow>
    </ScreenScroll>
  );
}
