// The 60 px header (C25): a real Home button and the two audio controls. In a live room (lobby, countdown,
// playing, reconnecting, and a reconnect's connecting or requesting over the frozen board) Home first asks
// "Leave the match?" with Stay focused; elsewhere it leaves at once.

import { useEffect, useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { House } from 'lucide-react';
import styled from 'styled-components';
import { useApp } from '../../app/AppContext';
import { useAppState } from '../../state/hooks';
import type { AppState } from '../../state/appStore';
import type { SessionStateName } from '../../session/types';
import { Button } from '../common/Button';
import { Dialog } from '../common/Dialog';
import { H2 } from '../common/Heading';
import { IconButton } from '../common/IconButton';
import { Text } from '../common/Text';
import { LEAVE_CONFIRM } from '../room/copy';
import { theme } from '../theme';
import { VolumeControl } from './VolumeControl';

const CONFIRM_STATES: ReadonlySet<SessionStateName> = new Set(['lobby', 'countdown', 'playing', 'reconnecting']);
/** States in which the match the confirm asks about is over, so an open confirm is stale. */
const ENDED_STATES: ReadonlySet<SessionStateName> = new Set(['idle', 'failed', 'finished']);

/** In-room recovery cycles reconnecting -> connecting -> requesting while the frozen HUD and the reconnect bar
 *  stay up and the seat is still held: toRoomView's third row. Those sub-states confirm too. */
const selectNeedsConfirm = (st: AppState): boolean => {
  const x = st.session;
  if (CONFIRM_STATES.has(x.s)) return true;
  return (x.s === 'connecting' || x.s === 'requesting') && x.roomKnown && (x.worldReady || x.stageRetained);
};

const Bar = styled.header`
  position: relative;
  z-index: ${theme.z.header};
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  height: ${theme.size.headerH};
  padding: 0 calc(12px + ${theme.safe.r}) 0 calc(12px + ${theme.safe.l});
  background: ${theme.color.bg};
`;

const Audio = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;

  @media (min-width: 768px) {
    gap: 16px;
  }
`;

const Actions = styled.div`
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  margin-top: 20px;
  flex-wrap: wrap;
`;

export function Header(): JSX.Element {
  const { session } = useApp();
  const s = useAppState((st) => st.session.s);
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);
  const stayRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const bodyId = useId();
  const needsConfirm = useAppState(selectNeedsConfirm);

  // A confirm about a match that has meanwhile ended or failed is stale. The recovery sub-states are not an
  // end, so a confirm opened while reconnecting survives the retry cycle. `confirmOpen` is derived during
  // render, so the Dialog closes and restores focus in the same commit that shows the end (before a view such
  // as FailureView moves focus to its title in its passive effect); the effect only resets the flag.
  const confirmOpen = confirming && !ENDED_STATES.has(s);
  useEffect(() => {
    if (ENDED_STATES.has(s)) setConfirming(false);
  }, [s]);

  const onHome = (): void => {
    if (needsConfirm) {
      setConfirming(true);
      return;
    }
    // Cancelling a join or rejoin is an explicit leave: with a room known, it offers the rejoin banner (C17).
    if (s === 'connecting' || s === 'requesting') session.leave({ explicit: true });
    else if (s !== 'idle') session.leave({ explicit: false });
    navigate('/');
  };

  const onLeave = (): void => {
    setConfirming(false);
    session.leave({ explicit: true });
    navigate('/');
  };

  return (
    <Bar>
      <IconButton label="Home" onClick={onHome}>
        <House size={24} />
      </IconButton>
      <Audio>
        <VolumeControl channel="music" />
        <VolumeControl channel="sfx" />
      </Audio>
      <Dialog open={confirmOpen} labelledBy={titleId} describedBy={bodyId} onCancel={() => setConfirming(false)} initialFocus={stayRef}>
        <H2 id={titleId}>{LEAVE_CONFIRM.title}</H2>
        <Text id={bodyId} $tone="muted" style={{ marginTop: 8 }}>
          {LEAVE_CONFIRM.body}
        </Text>
        <Actions>
          <Button variant="danger" onClick={onLeave}>
            {LEAVE_CONFIRM.leave}
          </Button>
          <Button ref={stayRef} variant="secondary" onClick={() => setConfirming(false)}>
            {LEAVE_CONFIRM.stay}
          </Button>
        </Actions>
      </Dialog>
    </Bar>
  );
}
