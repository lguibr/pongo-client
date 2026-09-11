// The lobby card (9.4; C27, C38, C99, C107): a scroll region over the dimmed arena with the status line, the
// room code (Copy, Share), four seat rows, the Ready toggle and Leave, then the rules carousel. During the
// countdown the whole region is inert (useInert), so neither Tab nor a stray Space can reach Ready.

import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Copy, Share2 } from 'lucide-react';
import styled from 'styled-components';
import { useApp } from '../../app/AppContext';
import { useMyReady, useSeats, useSession } from '../../state/hooks';
import type { SeatView } from '../../state/appStore';
import { SeatConn } from '../../game/events';
import { roomPath } from '../../net/roomCode';
import { Button } from '../common/Button';
import { Carousel } from '../common/Carousel';
import { H1 } from '../common/Heading';
import { announce } from '../common/LiveAnnouncer';
import { GraceRing, SeatBadge } from '../common/SeatBadge';
import { Caption, Text } from '../common/Text';
import { useInert } from '../common/useInert';
import { RULES } from '../landing/rules';
import { theme } from '../theme';
import { HUD, LOBBY } from './copy';
import { lobbyStatus } from './roomView';

const COPIED_MS = 2000;

const Region = styled.div`
  position: absolute;
  inset: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 20px;
  padding: 16px calc(16px + ${theme.safe.r}) calc(16px + ${theme.safe.b}) calc(16px + ${theme.safe.l});
  pointer-events: auto;

  & > * {
    margin-block: auto;
  }

  @media (max-height: 500px) and (orientation: landscape) {
    flex-direction: row;
    align-items: flex-start;
    justify-content: center;
    & > * {
      margin-block: 0;
    }
  }
`;

const LobbyCard = styled.section`
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 14px;
  width: 100%;
  max-width: 480px;
  flex: none;
  padding: 24px;
  background: rgba(9, 9, 11, 0.9);
  border: 1px solid ${theme.color.border};
  border-radius: ${theme.size.radius};
  box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);

  @media (max-width: 767px), (max-height: 500px) {
    padding: 14px;
    gap: 10px;
  }
`;

const Centered = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  text-align: center;
`;

const Code = styled.p`
  font-size: 2.5rem;
  line-height: 1;
  letter-spacing: 0.2em;
  padding-left: 0.2em;
  font-variant-numeric: tabular-nums;
`;

const CodeActions = styled.div`
  display: flex;
  gap: 8px;
`;

const Seats = styled.ul`
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
`;

const Row = styled.li<{ $ready: boolean }>`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-height: 48px;
  padding: 8px 12px;
  border-radius: ${theme.size.radius};
  background: ${({ $ready }) => ($ready ? 'rgba(34, 197, 94, 0.08)' : theme.color.secondary)};
  border: 1px solid ${({ $ready }) => ($ready ? theme.color.success : 'transparent')};
  transition: border-color ${theme.dur.base}, background ${theme.dur.base};
`;

const Who = styled.span`
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
`;

const Status = styled.span<{ $tone: 'ready' | 'waiting' | 'grace' }>`
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 1.05rem;
  letter-spacing: 0.06em;
  color: ${({ $tone }) => ($tone === 'ready' ? theme.color.success : $tone === 'grace' ? theme.color.warn : theme.color.muted)};
`;

const Empty = styled.li`
  display: flex;
  align-items: center;
  min-height: 48px;
  padding: 8px 12px;
  border-radius: ${theme.size.radius};
  border: 1px dashed ${theme.color.border};
  color: ${theme.color.muted};
  font-style: italic;
`;

const Rules = styled.div`
  width: 100%;
  max-width: 600px;

  @media (max-height: 500px) and (orientation: landscape) {
    max-width: 420px;
  }
  @media (max-height: 419px) {
    display: none;
  }
`;

function SeatRow({ seat }: { seat: SeatView }): JSX.Element {
  if (seat.conn === SeatConn.Empty) return <Empty>{LOBBY.emptySeat}</Empty>;
  const grace = seat.conn === SeatConn.Grace;
  return (
    <Row $ready={seat.ready && !grace}>
      <Who>
        <SeatBadge seat={seat.index} ghost={grace} />
        <span>
          {seat.name}
          {seat.isMe && <Caption style={{ marginLeft: 6 }}>{LOBBY.you}</Caption>}
        </span>
      </Who>
      {grace ? (
        <Status $tone="grace">
          {LOBBY.seatReconnecting}
          <GraceRing key={seat.graceEndsAt} endsAt={seat.graceEndsAt} label={HUD.graceLeft} />
        </Status>
      ) : (
        <Status $tone={seat.ready ? 'ready' : 'waiting'}>{seat.ready ? LOBBY.seatReady : LOBBY.seatWaiting}</Status>
      )}
    </Row>
  );
}

export function LobbyView(): JSX.Element {
  const { session: api } = useApp();
  const session = useSession();
  const seats = useSeats();
  const myReady = useMyReady();
  const navigate = useNavigate();
  const regionRef = useRef<HTMLDivElement>(null);
  const reasonId = useId();
  const titleId = useId();
  const [copied, setCopied] = useState(false);
  const readyRef = useRef<HTMLButtonElement>(null);
  const prevState = useRef(session.s);
  const code = session.code;

  useInert(regionRef, session.s === 'countdown');

  // "Not ready" in the countdown, or a cancel by another player, unmounts the overlay that held focus, and
  // focus would fall to the body. Bring it back to Ready (useInert has already lifted inert: layout effect).
  useEffect(() => {
    const was = prevState.current;
    prevState.current = session.s;
    if (was !== 'countdown' || session.s !== 'lobby') return;
    const active = document.activeElement;
    if (active === null || active === document.body) readyRef.current?.focus();
  }, [session.s]);

  useEffect(() => {
    if (!copied) return;
    const h = window.setTimeout(() => setCopied(false), COPIED_MS);
    return () => window.clearTimeout(h);
  }, [copied]);

  const copy = (): void => {
    if (code === null) return;
    const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
    if (clip === undefined) {
      announce(LOBBY.copyFailed);
      return;
    }
    clip.writeText(code).then(
      () => {
        setCopied(true);
        announce(LOBBY.copied);
      },
      () => announce(LOBBY.copyFailed),
    );
  };

  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  const share = (): void => {
    if (code === null || !canShare) return;
    navigator.share({ title: LOBBY.shareTitle, text: `${LOBBY.shareTitle}: ${code}`, url: location.origin + roomPath(code) }).catch(() => {
      // Dismissed by the user, or unavailable; nothing to report.
    });
  };

  const onReadyKeyDown = (e: KeyboardEvent<HTMLButtonElement>): void => {
    if (e.repeat) e.preventDefault(); // a held key must not toggle Ready over and over
  };

  return (
    <Region ref={regionRef}>
      <LobbyCard aria-labelledby={titleId}>
        <Centered>
          <H1 id={titleId}>{LOBBY.title}</H1>
          <Text $tone="muted">{lobbyStatus(seats)}</Text>
        </Centered>

        {code !== null && (
          <Centered>
            <Caption>{LOBBY.roomCode}</Caption>
            <Code>{code}</Code>
            <CodeActions>
              <Button variant="outline" onClick={copy}>
                <Copy size={18} aria-hidden="true" />
                {copied ? LOBBY.copied : LOBBY.copy}
              </Button>
              {canShare && (
                <Button variant="outline" onClick={share}>
                  <Share2 size={18} aria-hidden="true" />
                  {LOBBY.share}
                </Button>
              )}
            </CodeActions>
          </Centered>
        )}

        <Seats aria-label={LOBBY.seats}>
          {seats.map((seat) => (
            <SeatRow key={seat.index} seat={seat} />
          ))}
        </Seats>

        <Button
          ref={readyRef}
          size="lg"
          block
          variant={myReady ? 'primary' : 'outline'}
          aria-pressed={myReady}
          disabled={!session.canReady}
          aria-describedby={session.canReady ? undefined : reasonId}
          onKeyDown={onReadyKeyDown}
          onClick={() => api.setReady(!myReady)}
        >
          {myReady ? LOBBY.ready : LOBBY.notReady}
        </Button>
        {!session.canReady && (
          <Caption id={reasonId} style={{ textAlign: 'center' }}>
            {LOBBY.connecting}
          </Caption>
        )}
        <Button
          variant="secondary"
          block
          onClick={() => {
            api.leave({ explicit: true });
            navigate('/');
          }}
        >
          {LOBBY.leave}
        </Button>
      </LobbyCard>

      <Rules>
        <Carousel slides={RULES} label="How to play" />
      </Rules>
    </Region>
  );
}
