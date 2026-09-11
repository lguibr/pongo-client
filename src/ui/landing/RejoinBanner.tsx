// Rejoin after an explicit leave (C17). Shown while `lastLeft.canRejoin` and less than rejoinWindowMs
// (30 s) have passed: "Rejoin match ABC123 (23 s)", counting down each second, with a dismiss button.
// Pressing it restores the previous identity and navigates back to the room.

import { useEffect, useReducer, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { RotateCcw, X } from 'lucide-react';
import styled from 'styled-components';
import { useApp } from '../../app/AppContext';
import { useLastLeft } from '../../state/hooks';
import { roomPath } from '../../net/roomCode';
import { T } from '../../config/tuning';
import { now as clockNow } from '../../lib/clock';
import type { Now } from '../../lib/clock';
import { browserTimers } from '../../lib/timers';
import type { TimerHost } from '../../lib/timers';
import { IconButton } from '../common/IconButton';
import { theme } from '../theme';

const rejoinLabel = (code: string, seconds: number): string => `Rejoin match ${code} (${seconds} s)`;

const Banner = styled.div`
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  max-width: 800px;
  margin: 0 auto;
  padding: 4px 4px 4px 4px;
  border: 1px solid ${theme.color.primary};
  border-radius: ${theme.size.radius};
  background: rgba(37, 99, 235, 0.12);
`;

const Rejoin = styled.button`
  flex: 1;
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: ${theme.size.touch};
  padding: 0 10px;
  text-align: left;
  font-size: 1.3rem;
  color: ${theme.color.fg};
  border-radius: ${theme.size.radius};
  font-variant-numeric: tabular-nums;

  &:hover {
    background: rgba(37, 99, 235, 0.2);
  }
`;

export function RejoinBanner({ now = clockNow, timers = browserTimers }: { now?: Now; timers?: TimerHost }): JSX.Element | null {
  const lastLeft = useLastLeft();
  const { session } = useApp();
  const navigate = useNavigate();
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [tick, bump] = useReducer((n: number) => n + 1, 0);

  const remaining = lastLeft !== null && lastLeft.canRejoin ? lastLeft.at + T.session.rejoinWindowMs - now() : 0;
  const seconds = Math.ceil(remaining / 1000);
  const visible = lastLeft !== null && remaining > 0 && dismissedAt !== lastLeft.at;

  // Re-render when the displayed second changes, and hide at zero. Every tick re-renders, and every render
  // re-arms from a fresh reading, so an early timer cannot freeze the count.
  useEffect(() => {
    if (!visible) return;
    const ms = Math.max(1, remaining - (seconds - 1) * 1000);
    const h = timers.setTimeout(bump, ms);
    return () => timers.clearTimeout(h);
    // `remaining` and `seconds` are read fresh on every render that `tick` causes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, tick, timers]);

  if (!visible || lastLeft === null) return null;
  const { code, at } = lastLeft;

  return (
    <Banner>
      <Rejoin
        type="button"
        onClick={() => {
          session.rejoinPrevious(code);
          navigate(roomPath(code));
        }}
      >
        <RotateCcw size={20} aria-hidden="true" />
        <span>{rejoinLabel(code, seconds)}</span>
      </Rejoin>
      <IconButton label="Dismiss rejoin" onClick={() => setDismissedAt(at)}>
        <X size={20} />
      </IconButton>
    </Banner>
  );
}
