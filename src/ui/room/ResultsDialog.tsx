// Game over (9.5; C46, C58, C107): a native modal dialog, focus on its h1. It opens 1.2 s after the end when
// the board is showing its end effects (E45), at once otherwise. Rows are seated players only, and seats that
// left are marked. Escape is prevented, because the dialog is a terminal state.

import { useEffect, useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import styled from 'styled-components';
import { useApp } from '../../app/AppContext';
import { useAppState, useResults } from '../../state/hooks';
import { COLORS } from '../../config/palette';
import { SEATS } from '../../game/orientation';
import { Button } from '../common/Button';
import { Dialog } from '../common/Dialog';
import { H1 } from '../common/Heading';
import { SeatBadge } from '../common/SeatBadge';
import { Caption, Text } from '../common/Text';
import { VisuallyHidden } from '../common/VisuallyHidden';
import { theme } from '../theme';
import { RESULTS } from './copy';

export const RESULTS_DELAY_MS = 1200;

const Winner = styled.p`
  margin-top: 6px;
  font-size: 1.9rem;
  color: ${COLORS.gold};
`;

const Rows = styled.ol`
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 16px 0;
`;

const Row = styled.li<{ $winner: boolean }>`
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-radius: ${theme.size.radius};
  background: ${theme.color.secondary};
  border: 1px solid ${({ $winner }) => ($winner ? COLORS.gold : 'transparent')};
`;

const Name = styled.span`
  flex: 1;
  min-width: 0;
`;

const Score = styled.span`
  min-width: 3ch;
  text-align: right;
  font-size: 1.5rem;
  font-variant-numeric: tabular-nums;
`;

const Actions = styled.div`
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 16px;
`;

export function ResultsDialog(): JSX.Element {
  const results = useResults();
  const finished = useAppState((s) => s.session.s === 'finished');
  const worldReady = useAppState((s) => s.session.worldReady);
  const { session } = useApp();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (!finished) {
      setOpen(false);
      return;
    }
    if (!worldReady) {
      setOpen(true);
      return;
    }
    const h = window.setTimeout(() => setOpen(true), RESULTS_DELAY_MS);
    return () => window.clearTimeout(h);
  }, [finished, worldReady]);

  const winnerLine = results === null ? null : results.winner === -1 ? RESULTS.tie : RESULTS.wins(SEATS[results.winner].name);

  return (
    <Dialog open={open} labelledBy={titleId} initialFocus={titleRef}>
      <H1 id={titleId} ref={titleRef} tabIndex={-1}>
        {RESULTS.title}
      </H1>
      {winnerLine !== null && <Winner>{winnerLine}</Winner>}
      {results === null ? (
        <Text $tone="muted" style={{ margin: '16px 0' }}>
          {RESULTS.unavailable}
        </Text>
      ) : (
        <Rows aria-label={RESULTS.scores}>
          {results.rows.map((r) => (
            <Row key={r.index} $winner={r.winner}>
              <SeatBadge seat={r.index} size={22} ghost={r.left} />
              <Name>
                {SEATS[r.index].name}
                {r.isMe && <Caption style={{ marginLeft: 6 }}>{RESULTS.you}</Caption>}
                {r.left && <Caption style={{ marginLeft: 6 }}>{RESULTS.left}</Caption>}
                {r.winner && <VisuallyHidden>, {RESULTS.winner}</VisuallyHidden>}
              </Name>
              <Score>{r.score}</Score>
            </Row>
          ))}
        </Rows>
      )}
      {results?.derived === true && <Caption>{RESULTS.derived}</Caption>}
      <Actions>
        <Button
          block
          onClick={() => {
            session.start({ kind: 'quick' });
            navigate('/room');
          }}
        >
          {RESULTS.quickAgain}
        </Button>
        <Button
          block
          variant="secondary"
          onClick={() => {
            session.leave({ explicit: false });
            navigate('/');
          }}
        >
          {RESULTS.backToMenu}
        </Button>
      </Actions>
    </Dialog>
  );
}
