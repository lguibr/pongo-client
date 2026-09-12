// The countdown (9.5; C13, C106, C107): max(1, ceil((endsAt - now)/1000)) in an assertive status region.
// Focus moves to the overlay container, never to a button, so a stray Space cannot cancel the countdown for
// the room; "Not ready" is reached with Tab. The digit is keyed per second (scale 1.4 -> 1 and fade; no
// scale under reduced motion).
//
// While a modal dialog is open (the Leave confirm), this overlay is inert behind it and its region is not
// spoken, so each new digit is mirrored into the dialog's assertive region. The digit shown on mount is not
// mirrored: it arrives with "Countdown started.", which LiveAnnouncer puts in that same region.

import { useEffect, useReducer, useRef } from 'react';
import styled, { keyframes } from 'styled-components';
import { useApp } from '../../app/AppContext';
import { useAppState, useCountdown, useMyReady } from '../../state/hooks';
import { now as clockNow } from '../../lib/clock';
import { Button } from '../common/Button';
import { announce, modalRegionsOpen } from '../common/LiveAnnouncer';
import { theme } from '../theme';
import { COUNTDOWN } from './copy';

const pop = keyframes`
  from { transform: scale(calc(1 + 0.4 * ${theme.motion})); opacity: 0.4; }
  to { transform: scale(1); opacity: 1; }
`;

const Overlay = styled.div`
  position: absolute;
  inset: 0;
  z-index: ${theme.z.overlay};
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  padding: 16px calc(16px + ${theme.safe.r}) calc(16px + ${theme.safe.b}) calc(16px + ${theme.safe.l});
  background: rgba(0, 0, 0, 0.5);
  pointer-events: auto;

  &:focus {
    outline: none;
  }
`;

const Label = styled.p`
  font-size: 1.5rem;
  letter-spacing: 0.1em;
  color: ${theme.color.muted};
  text-transform: uppercase;
`;

const Digit = styled.p`
  font-size: min(10rem, 32vh);
  line-height: 1;
  color: ${theme.color.primary};
  text-shadow: 0 0 20px rgba(37, 99, 235, 0.6);
  font-variant-numeric: tabular-nums;
  animation: ${pop} ${theme.dur.slow} ease-out;
`;

const Status = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
`;

export function CountdownOverlay(): JSX.Element {
  const countdown = useCountdown();
  const myReady = useMyReady();
  const canReady = useAppState((s) => s.session.canReady);
  const { session } = useApp();
  const ref = useRef<HTMLDivElement>(null);
  const [, bump] = useReducer((n: number) => n + 1, 0);

  const remaining = countdown === null ? 0 : countdown.endsAt - clockNow();
  const digit = countdown === null ? null : Math.max(1, Math.ceil(remaining / 1000));
  const spoken = useRef(digit);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  useEffect(() => {
    if (digit === spoken.current) return;
    spoken.current = digit;
    if (digit !== null && modalRegionsOpen()) announce(String(digit), 'assertive');
  }, [digit]);

  // Re-render when the digit changes; the last second holds at 1 until the session moves on.
  useEffect(() => {
    if (digit === null || remaining <= 1000) return;
    const h = window.setTimeout(bump, Math.max(1, remaining - (digit - 1) * 1000));
    return () => window.clearTimeout(h);
  });

  return (
    <Overlay ref={ref} tabIndex={-1} role="group" aria-label={COUNTDOWN.label}>
      <Status role="status" aria-live="assertive" aria-atomic="true">
        <Label>{COUNTDOWN.startingIn}</Label>
        {digit === null ? <Label>{COUNTDOWN.starting}</Label> : <Digit key={digit}>{digit}</Digit>}
      </Status>
      {myReady && (
        <Button variant="outline" disabled={!canReady} onClick={() => session.setReady(false)}>
          {COUNTDOWN.notReady}
        </Button>
      )}
    </Overlay>
  );
}
