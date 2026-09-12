// The landing page (9.2; C26, C100, C17), in today's layout: logo, subtitle, the Create and Join cards,
// QUICK PLAY and the rules carousel. It scrolls instead of clipping on short or landscape screens, and it
// never opens a socket: Create and Quick Play start the session only when pressed.

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import styled from 'styled-components';
import { useApp } from '../../app/AppContext';
import { roomPath } from '../../net/roomCode';
import { Button } from '../common/Button';
import { Carousel } from '../common/Carousel';
import { H1, H2 } from '../common/Heading';
import { Switch } from '../common/Switch';
import { Card, ScreenScroll } from '../layout/AppShell';
import { theme } from '../theme';
import { JoinForm } from './JoinForm';
import { RejoinBanner } from './RejoinBanner';
import { RULES } from './rules';

const Column = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 20px;
  max-width: 1200px;
  margin-inline: auto;

  @media (max-width: 767px) {
    gap: 14px;
  }
`;

const Hero = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  text-align: center;
`;

const Logo = styled.img`
  width: 200px;
  height: auto;
  image-rendering: pixelated;

  @media (max-height: 699px), (max-width: 399px) {
    width: 120px;
  }
`;

const Subtitle = styled(H2)`
  font-size: 1.5rem;
  color: ${theme.color.muted};

  @media (max-width: 767px) {
    font-size: 1.15rem;
  }
`;

const Actions = styled.div`
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 100%;
  max-width: 800px;

  @media (min-width: 768px) {
    flex-direction: row;
    align-items: stretch;
    gap: 20px;
  }
`;

const ActionCard = styled(Card)`
  flex: 1;
  align-items: center;
  transition: border-color ${theme.dur.base};

  &:hover,
  &:focus-within {
    border-color: ${theme.color.primary};
  }

  & > :last-child {
    margin-top: auto;
  }
`;

const Quick = styled.div`
  width: 100%;
  max-width: 400px;
`;

export default function LandingScreen(): JSX.Element {
  const { session } = useApp();
  const navigate = useNavigate();
  const [isPublic, setPublic] = useState(true);

  return (
    <ScreenScroll>
      <Column>
        <RejoinBanner />
        <Hero>
          <H1>
            <Logo src="/bitmap.png" alt="PonGo" width={200} height={200} />
          </H1>
          <Subtitle>Multiplayer Arcade Action</Subtitle>
        </Hero>

        <Actions>
          <ActionCard as="section" aria-labelledby="create-room-title">
            <H2 id="create-room-title">Create room</H2>
            <Switch id="public-room" label="Public room" checked={isPublic} onChange={setPublic} />
            <Button
              variant="secondary"
              block
              onClick={() => {
                session.start({ kind: 'create', isPublic });
                navigate('/room');
              }}
            >
              Create
            </Button>
          </ActionCard>
          <ActionCard as="section" aria-labelledby="join-room-title">
            <H2 id="join-room-title">Join room</H2>
            <JoinForm onJoin={(code) => navigate(roomPath(code))} />
          </ActionCard>
        </Actions>

        <Quick>
          <Button
            size="xl"
            block
            onClick={() => {
              session.start({ kind: 'quick' });
              navigate('/room');
            }}
          >
            QUICK PLAY
          </Button>
        </Quick>

        <Carousel slides={RULES} label="How to play" />
      </Column>
    </ScreenScroll>
  );
}
