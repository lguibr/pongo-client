// "Update ready" (D24, 5.14). The update applies by itself once the session is idle on `/`. Outside an
// active match (idle or failed) the chip also offers to reload now. In `finished` it is passive text under
// the modal results dialog, whose "Back to menu" already leads to the apply. The page never reloads inside
// a room: on a /room path the button leaves and goes home, and the apply policy reloads there.
//
// Placement: top right under the header while idle. In a room it sits bottom left, where no HUD element
// lives (the room pill takes the top right below 420 px, and the reconnect bar the top), above GameHud's
// "Sound off" chip when that shows. With no button it is pass-through, so the joystick underneath still
// takes touches.

import { useLocation, useNavigate } from 'react-router-dom';
import styled, { css } from 'styled-components';
import { useApp } from '../../app/AppContext';
import { useAppState, useUpdateReady } from '../../state/hooks';
import { selectSoundOff } from '../room/roomView';
import { theme } from '../theme';

/** Height of GameHud's bottom row ("Sound off" chip, 44 px) plus a gap: the update chip stacks above it. */
export const SOUND_OFF_ROW_PX = 52;

const isRoomPath = (p: string): boolean => p === '/room' || p.startsWith('/room/');

const Chip = styled.div<{ $inRoom: boolean; $lift: boolean; $passive: boolean }>`
  position: fixed;
  z-index: ${theme.z.toast};
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: calc(100% - 16px - ${theme.safe.l} - ${theme.safe.r});
  padding: 6px 6px 6px 12px;
  border: 1px solid ${theme.color.border};
  border-radius: 999px;
  background: #18181b;
  color: ${theme.color.fg};
  font-size: 1.05rem;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
  pointer-events: ${({ $passive }) => ($passive ? 'none' : 'auto')};

  ${({ $inRoom, $lift }) =>
    $inRoom
      ? css`
          left: calc(${theme.safe.l} + 12px);
          bottom: calc(${theme.safe.b} + 12px + ${$lift ? SOUND_OFF_ROW_PX : 0}px);
        `
      : css`
          top: calc(${theme.safe.t} + ${theme.size.headerH} + 8px);
          right: calc(${theme.safe.r} + 8px);
        `}
`;

const Reload = styled.button`
  flex: none;
  min-height: 32px;
  padding: 0 10px;
  border-radius: 999px;
  background: ${theme.color.primary};
  color: ${theme.color.primaryFg};

  /* 44 px touch target around the compact pill. */
  position: relative;
  &::before {
    content: '';
    position: absolute;
    inset: -6px -2px;
  }
`;

export function UpdateChip(): JSX.Element {
  const ready = useUpdateReady();
  const s = useAppState((st) => st.session.s);
  const soundOff = useAppState(selectSoundOff);
  const { pwa, session } = useApp();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  if (!ready) return <></>;
  const canReload = s === 'idle' || s === 'failed';
  const reload = (): void => {
    if (!isRoomPath(pathname)) {
      pwa.applyUpdate();
      return;
    }
    if (s !== 'idle') session.leave({ explicit: false });
    navigate('/');
  };
  return (
    <Chip role="status" $inRoom={s !== 'idle'} $lift={soundOff} $passive={!canReload}>
      <span>Update ready: applies after this match</span>
      {canReload && <Reload type="button" onClick={reload}>Reload now</Reload>}
    </Chip>
  );
}
