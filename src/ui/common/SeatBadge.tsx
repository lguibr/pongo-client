// A seat's colour dot with its glyph (C105): colour is never the only cue. Decorative, because the seat's
// name is always written beside it. GraceRing is the 30 s reconnect countdown shown next to a Grace seat's
// badge (E51).

import { useEffect, useReducer, useState } from 'react';
import styled from 'styled-components';
import type { Seat } from '../../game/events';
import { SEATS } from '../../game/orientation';
import { GRACE_MS } from '../../config/constants';
import { now as clockNow } from '../../lib/clock';
import { useReducedMotion } from '../../state/hooks';
import { theme } from '../theme';
import { VisuallyHidden } from './VisuallyHidden';

const Dot = styled.span<{ $size: number; $color: string; $ghost: boolean }>`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: ${({ $size }) => $size}px;
  height: ${({ $size }) => $size}px;
  border-radius: 50%;
  background: ${({ $color, $ghost }) => ($ghost ? 'transparent' : $color)};
  border: 2px ${({ $ghost }) => ($ghost ? 'dashed' : 'solid')} ${({ $color }) => $color};
  color: ${({ $ghost, $color }) => ($ghost ? $color : '#09090b')};
  font-size: ${({ $size }) => Math.round($size * 0.6)}px;
  line-height: 1;
  box-shadow: 0 0 8px ${({ $color }) => $color}66;
`;

export function SeatBadge({ seat, size = 24, ghost = false }: { seat: Seat; size?: number; ghost?: boolean }): JSX.Element {
  const info = SEATS[seat];
  return (
    <Dot aria-hidden="true" $size={size} $color={info.color} $ghost={ghost}>
      {info.glyph}
    </Dot>
  );
}

const Ring = styled.span`
  display: inline-block;
  flex: none;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: conic-gradient(${theme.color.warn} calc(var(--grace-p) * 360deg), ${theme.color.secondary} 0);
  -webkit-mask: radial-gradient(circle, transparent 4px, #000 5px);
  mask: radial-gradient(circle, transparent 4px, #000 5px);
  animation-name: pongo-grace;
  animation-timing-function: linear;
  animation-fill-mode: forwards;
`;

const Wrap = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-variant-numeric: tabular-nums;
  color: ${theme.color.warn};
`;

/** Seconds left of a seat's reconnect grace. Unknown (NaN) for late joiners, and then nothing is shown (D17).
 *  The ring runs on the compositor; the seconds text re-renders only this component, once per second. */
export function GraceRing({ endsAt, label }: { endsAt: number; label: (seconds: number) => string }): JSX.Element | null {
  const reduced = useReducedMotion();
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const remaining = Number.isFinite(endsAt) ? endsAt - clockNow() : 0;
  const seconds = Math.max(0, Math.ceil(remaining / 1000));
  // Fixed at mount (the component is keyed by endsAt), so re-renders do not move the animation.
  const [delayMs] = useState(() => -Math.min(GRACE_MS, Math.max(0, GRACE_MS - remaining)));

  useEffect(() => {
    if (seconds <= 0) return;
    const h = window.setTimeout(bump, Math.max(1, remaining - (seconds - 1) * 1000));
    return () => window.clearTimeout(h);
  });

  if (!Number.isFinite(endsAt) || seconds <= 0) return null;
  const text = label(seconds);
  return (
    <Wrap>
      {!reduced && <Ring aria-hidden="true" style={{ animationDuration: `${GRACE_MS}ms`, animationDelay: `${delayMs}ms` }} />}
      {reduced ? <span>{text}</span> : <VisuallyHidden>{text}</VisuallyHidden>}
    </Wrap>
  );
}
