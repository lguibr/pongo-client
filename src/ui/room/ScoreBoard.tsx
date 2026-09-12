// Scores, top left inside the game area and clear of the safe areas (9.5; C58, C104, C105). One row per seat
// that is Connected or Grace. The list itself subscribes only to which seats are present; each row
// subscribes to its own SeatView, which the cold bridge reuses when unchanged, so a score change re-renders
// exactly one row (E50). Scores sit in a tabular 3ch cell. `onRowRender` is a render probe for tests.

import { Profiler, useLayoutEffect, useRef } from 'react';
import styled, { keyframes } from 'styled-components';
import type { Seat } from '../../game/events';
import { SeatConn } from '../../game/events';
import type { AppState } from '../../state/appStore';
import { useAppState, useSeat } from '../../state/hooks';
import { GraceRing, SeatBadge } from '../common/SeatBadge';
import { VisuallyHidden } from '../common/VisuallyHidden';
import { theme } from '../theme';
import { HUD } from './copy';

const ALL: readonly Seat[] = [0, 1, 2, 3];

/** Bit i set when seat i is Connected or Grace. A number, so the list re-renders only when membership changes. */
const presentMask = (s: AppState): number => {
  let m = 0;
  for (const seat of s.seats) if (seat.conn !== SeatConn.Empty) m |= 1 << seat.index;
  return m;
};

const bumpUp = keyframes`
  from { transform: scale(calc(1 + 0.15 * ${theme.motion})); color: #4ade80; }
  to { transform: scale(1); }
`;
const bumpDown = keyframes`
  from { transform: scale(calc(1 + 0.15 * ${theme.motion})); color: #f87171; }
  to { transform: scale(1); }
`;

// Inside <main>, which already starts below the top inset (AppShell); drops below the reconnect bar while it shows.
const Board = styled.div`
  position: absolute;
  top: calc(8px + ${theme.size.bannerH});
  left: calc(${theme.safe.l} + 8px);
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  background: rgba(9, 9, 11, 0.8);
  border: 1px solid ${theme.color.border};
  border-radius: ${theme.size.radius};
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
  pointer-events: auto;
`;

const Row = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  transform-origin: left center;

  &.bump-up {
    animation: ${bumpUp} 200ms ease-out;
  }
  &.bump-down {
    animation: ${bumpDown} 200ms ease-out;
  }
`;

const Name = styled.span`
  min-width: 4.5ch;

  @media (max-width: 599px) {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
`;

const You = styled.span`
  font-size: 0.95rem;
  padding: 0 4px;
  border-radius: 2px;
  background: ${theme.color.fg};
  color: ${theme.color.bg};
`;

const Score = styled.span`
  display: inline-block;
  min-width: 3ch;
  text-align: right;
  font-size: 1.5rem;
  line-height: 1;
  font-variant-numeric: tabular-nums;
`;

function ScoreRow({ index }: { index: Seat }): JSX.Element {
  const seat = useSeat(index);
  const ref = useRef<HTMLDivElement>(null);
  const prev = useRef(seat.score);

  // E50: restart the bump animation on the row element itself, without another React commit.
  useLayoutEffect(() => {
    const before = prev.current;
    prev.current = seat.score;
    const el = ref.current;
    if (el === null || before === null || seat.score === null || before === seat.score) return;
    el.classList.remove('bump-up', 'bump-down');
    void el.offsetWidth;
    el.classList.add(seat.score > before ? 'bump-up' : 'bump-down');
  }, [seat.score]);

  const grace = seat.conn === SeatConn.Grace;
  return (
    <Row ref={ref} role="listitem" data-seat={index}>
      <SeatBadge seat={index} size={22} ghost={grace} />
      <Name>{seat.name}</Name>
      {seat.isMe && <You>{HUD.you}</You>}
      <Score>
        {seat.score ?? HUD.unknownScore}
        {seat.score === null && <VisuallyHidden>unknown</VisuallyHidden>}
      </Score>
      {grace && <GraceRing key={seat.graceEndsAt} endsAt={seat.graceEndsAt} label={HUD.graceLeft} />}
    </Row>
  );
}

export function ScoreBoard({ onRowRender }: { onRowRender?: (seat: Seat) => void }): JSX.Element {
  const mask = useAppState(presentMask);
  return (
    <Board role="list" aria-label={HUD.scores}>
      {ALL.filter((i) => (mask & (1 << i)) !== 0).map((i) =>
        onRowRender === undefined ? (
          <ScoreRow key={i} index={i} />
        ) : (
          <Profiler key={i} id={`score-${i}`} onRender={() => onRowRender(i)}>
            <ScoreRow index={i} />
          </Profiler>
        ),
      )}
    </Board>
  );
}
