// Session notices (9.6) as toasts above the bottom safe area. The runtime expires them after their TTL; the
// close button dismisses one early. The LiveAnnouncer speaks each notice once, so this list is not a live
// region itself.
//
// In a room the update chip sits bottom left (UpdateChip), so the stack rises above it. During play on a
// device with any coarse pointer (the query that shows JoystickZone) the toasts lie over the joystick zone
// (the bottom 55 %): they are pass-through there, and
// their close button is hidden because a tap would reach the joystick instead; they still expire by TTL.

import { X } from 'lucide-react';
import styled, { css } from 'styled-components';
import { useApp } from '../../app/AppContext';
import { useAppState, useNotices, useUpdateReady } from '../../state/hooks';
import type { Notice } from '../../state/appStore';
import { selectSoundOff } from '../room/roomView';
import { SOUND_OFF_ROW_PX } from '../pwa/UpdateChip';
import { theme } from '../theme';
import { IconButton } from './IconButton';

/** Room for the update chip in a room (up to two lines of text, or its Reload button) plus a gap. */
const UPDATE_ROW_PX = 64;

const Stack = styled.section<{ $liftPx: number }>`
  position: fixed;
  left: 50%;
  bottom: calc(${theme.safe.b} + 16px + ${({ $liftPx }) => $liftPx}px);
  transform: translateX(-50%);
  width: min(480px, calc(100% - 24px - ${theme.safe.l} - ${theme.safe.r}));
  display: flex;
  flex-direction: column;
  gap: 8px;
  z-index: ${theme.z.toast};
  pointer-events: none;
`;

const Toast = styled.div<{ $tone: Notice['tone']; $overJoystick: boolean }>`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 4px 4px 14px;
  min-height: ${theme.size.touch};
  border: 1px solid ${({ $tone }) => ($tone === 'warn' ? theme.color.warn : theme.color.border)};
  border-radius: ${theme.size.radius};
  background: #18181b;
  color: ${theme.color.fg};
  font-size: 1.15rem;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
  pointer-events: auto;

  & > p {
    flex: 1;
    min-width: 0;
  }

  ${({ $overJoystick }) =>
    $overJoystick &&
    css`
      /* The same query that shows JoystickZone: any coarse pointer. */
      @media (any-pointer: coarse) {
        pointer-events: none;
        padding-right: 14px;
        & > button {
          display: none;
        }
      }
    `}
`;

export function NoticeToasts(): JSX.Element | null {
  const notices = useNotices();
  const s = useAppState((st) => st.session.s);
  const soundOff = useAppState(selectSoundOff);
  const updateReady = useUpdateReady();
  const { session } = useApp();
  if (notices.length === 0) return null;
  const liftPx = updateReady && s !== 'idle' ? UPDATE_ROW_PX + (soundOff ? SOUND_OFF_ROW_PX : 0) : 0;
  return (
    <Stack aria-label="Notifications" $liftPx={liftPx}>
      {notices.map((n) => (
        <Toast key={n.id} $tone={n.tone} $overJoystick={s === 'playing'}>
          <p>{n.text}</p>
          <IconButton label="Dismiss notification" onClick={() => session.dismissNotice(n.id)}>
            <X size={20} />
          </IconButton>
        </Toast>
      ))}
    </Stack>
  );
}
