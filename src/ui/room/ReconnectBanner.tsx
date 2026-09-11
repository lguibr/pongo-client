// The reconnect bar (9.5, E44): a top status bar over the frozen board, or on the plain ground when there is
// no board. The attempt line is spoken; the seconds to the next try are shown but not spoken. Retry now and
// Leave appear once an attempt has failed, or while offline. Retry now acts only in `reconnecting`: during an
// attempt in flight (connecting, requesting) it is aria-disabled, which keeps it focusable.
//
// Over the frozen HUD the bar publishes its height as --banner-h on the foreground layer, so the ScoreBoard
// and the room pill move below it instead of under it. Without the HUD (`standalone`) the bar carries the
// screen's h1 itself.

import { useEffect, useLayoutEffect, useReducer, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import styled from 'styled-components';
import { useApp } from '../../app/AppContext';
import { useAppState } from '../../state/hooks';
import { now as clockNow } from '../../lib/clock';
import { Button } from '../common/Button';
import { VisuallyHidden } from '../common/VisuallyHidden';
import { theme } from '../theme';
import { RECONNECT } from './copy';
import { reconnectParts } from './roomView';
import type { ReconnectingViewModel } from './roomView';

const TOP_PX = 8;

// Inside <main>, which already starts below the top inset (AppShell).
const Bar = styled.div`
  position: absolute;
  top: ${TOP_PX}px;
  left: 50%;
  transform: translateX(-50%);
  z-index: ${theme.z.overlay};
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 10px 14px;
  width: min(640px, calc(100% - 16px - ${theme.safe.l} - ${theme.safe.r}));
  padding: 10px 14px;
  border: 1px solid ${theme.color.warn};
  border-radius: ${theme.size.radius};
  background: rgba(9, 9, 11, 0.94);
  pointer-events: auto;
`;

const Line = styled.p`
  flex: 1 1 260px;
  font-size: 1.25rem;
  font-variant-numeric: tabular-nums;
`;

const Actions = styled.div`
  display: flex;
  gap: 8px;
`;

export function ReconnectBanner({ view, standalone = false }: { view: ReconnectingViewModel; standalone?: boolean }): JSX.Element {
  const { session } = useApp();
  const canRetry = useAppState((st) => st.session.s === 'reconnecting');
  const navigate = useNavigate();
  const barRef = useRef<HTMLDivElement>(null);
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const now = clockNow();
  const { head, tail } = reconnectParts(view, now);

  // Count the seconds down to the next try.
  useEffect(() => {
    if (view.offline || view.nextAt === null || view.nextAt <= now) return;
    const left = view.nextAt - now;
    const h = window.setTimeout(bump, Math.max(1, left - (Math.ceil(left / 1000) - 1) * 1000));
    return () => window.clearTimeout(h);
  });

  // Room for the HUD below the bar, kept current as the bar wraps or its text changes.
  useLayoutEffect(() => {
    const bar = barRef.current;
    const host = bar?.parentElement ?? null;
    if (bar === null || host === null) return;
    const publish = (): void => host.style.setProperty('--banner-h', `${bar.offsetHeight + TOP_PX}px`);
    publish();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(publish) : null;
    observer?.observe(bar);
    return () => {
      observer?.disconnect();
      host.style.removeProperty('--banner-h');
    };
  }, []);

  return (
    <Bar ref={barRef}>
      {standalone && <VisuallyHidden as="h1">{RECONNECT.title}</VisuallyHidden>}
      {/* The status role is on the line, not the bar, so the buttons are not read out with every update. */}
      <Line role="status">
        <span>{head}</span>
        {tail !== '' && <span aria-hidden="true">{tail}</span>}
      </Line>
      {view.showActions && (
        <Actions>
          <Button
            aria-disabled={!canRetry}
            onClick={() => {
              if (canRetry) session.retry();
            }}
          >
            {RECONNECT.retryNow}
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              session.leave({ explicit: true });
              navigate('/');
            }}
          >
            {RECONNECT.leave}
          </Button>
        </Actions>
      )}
    </Bar>
  );
}
