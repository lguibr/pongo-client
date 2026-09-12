// The in-game HUD (9.5): scores top left, the room code pill top centre with the unstable-link dot (E46),
// and the "Sound off" chip bottom right while audio is not running during play (selectSoundOff). Each part subscribes to its own
// slice, so a server batch re-renders nothing here unless what it shows changed. The HUD sits above the
// joystick zone; only its controls take pointer events. The pill's "Room ABC123" is the screen's h1 (C107).
// The top row starts 8 px into <main> (the shell owns the top inset) and drops below the reconnect bar.

import { useEffect, useState } from 'react';
import { Copy, VolumeX } from 'lucide-react';
import styled from 'styled-components';
import { useApp } from '../../app/AppContext';
import { useAppState } from '../../state/hooks';
import type { AppState } from '../../state/appStore';
import { announce } from '../common/LiveAnnouncer';
import { IconButton } from '../common/IconButton';
import { VisuallyHidden } from '../common/VisuallyHidden';
import { theme } from '../theme';
import { HUD, LOBBY } from './copy';
import { selectSoundOff } from './roomView';
import { ScoreBoard } from './ScoreBoard';

export const COPIED_MS = 1500;

const Layer = styled.div`
  position: absolute;
  inset: 0;
  z-index: 2;
  pointer-events: none;
`;

const Pill = styled.div`
  position: absolute;
  top: calc(8px + ${theme.size.bannerH});
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 4px 0 14px;
  border: 1px solid ${theme.color.border};
  border-radius: 999px;
  background: rgba(9, 9, 11, 0.85);
  font-size: 1.15rem;
  white-space: nowrap;
  pointer-events: auto;

  @media (max-width: 420px) {
    left: auto;
    right: calc(${theme.safe.r} + 8px);
    transform: none;
  }
`;

const CodeText = styled.h1`
  font-size: inherit;
  font-weight: 400;
  line-height: inherit;
  letter-spacing: 0.08em;
  font-variant-numeric: tabular-nums;
`;

const Unstable = styled.span`
  width: 10px;
  height: 10px;
  margin-left: 4px;
  border-radius: 50%;
  background: ${theme.color.warn};
  box-shadow: 0 0 6px ${theme.color.warn};
`;

const SoundChip = styled.button`
  position: absolute;
  right: calc(${theme.safe.r} + 12px);
  bottom: calc(${theme.safe.b} + 12px);
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: ${theme.size.touch};
  padding: 0 14px;
  border: 1px solid ${theme.color.border};
  border-radius: 999px;
  background: rgba(9, 9, 11, 0.9);
  color: ${theme.color.fg};
  font-size: 1.1rem;
  pointer-events: auto;
`;

const selectCode = (s: AppState): string | null => s.session.code;
const selectUnstable = (s: AppState): boolean => s.net.unstable && s.session.s === 'playing';

function RoomPill(): JSX.Element {
  const code = useAppState(selectCode);
  const unstable = useAppState(selectUnstable);
  // A counter rather than a flag, so a second copy restarts the "Copied" period instead of inheriting the
  // first one's timer; the timer is cleared on unmount.
  const [copies, setCopies] = useState(0);
  useEffect(() => {
    if (copies === 0) return;
    const h = window.setTimeout(() => setCopies(0), COPIED_MS);
    return () => window.clearTimeout(h);
  }, [copies]);

  // The HUD is shown only with a known room, but the screen keeps its h1 regardless.
  if (code === null) return <VisuallyHidden as="h1">{HUD.title}</VisuallyHidden>;
  const copy = (): void => {
    const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
    if (clip === undefined) return announce(LOBBY.copyFailed);
    clip.writeText(code).then(
      () => {
        setCopies((n) => n + 1);
        announce(LOBBY.copied);
      },
      () => announce(LOBBY.copyFailed),
    );
  };
  return (
    <Pill>
      <CodeText>{HUD.roomPill(code)}</CodeText>
      {unstable && <Unstable role="img" aria-label={HUD.unstable} title={HUD.unstable} />}
      <IconButton label={copies > 0 ? LOBBY.copied : HUD.copyCode} onClick={copy}>
        <Copy size={16} />
      </IconButton>
    </Pill>
  );
}

function SoundOffChip(): JSX.Element | null {
  const show = useAppState(selectSoundOff);
  const { audio } = useApp();
  if (!show) return null;
  // The tap itself is the unlock gesture (the audio engine listens on the window); the cue confirms it.
  return (
    <SoundChip type="button" onClick={() => audio.playUi('uiTap')}>
      <VolumeX size={18} aria-hidden="true" />
      {HUD.soundOff}
    </SoundChip>
  );
}

export function GameHud(): JSX.Element {
  return (
    <Layer>
      <ScoreBoard />
      <RoomPill />
      <SoundOffChip />
    </Layer>
  );
}
