// The room's two layers: the stage (full-bleed under the header) and the foreground views. While frozen on
// the low tier there is no composer, so the reconnect desaturation is a CSS filter on the stage (E44, D29).
// RoomForeground renders the 9.3 table's foreground column for a view and stage mode; children are keyed so
// the lobby card stays mounted into the countdown and the HUD stays mounted across play, drops and the end.
//
// Whenever a stage is mounted, RoomLayout draws the graphics notice over it (5.8, 9.5). While the WebGL
// context is lost or restoring it reads "Graphics paused — restoring…" and is pass-through, so the joystick
// and the HUD underneath still take input. When graphics have failed, or StageBoundary shows GraphicsFallback,
// it carries the failed text and a Reload button. It lives in the foreground, above the joystick zone and the
// lobby card, because a button in the stage layer is covered by both.

import { useState } from 'react';
import type { ReactNode } from 'react';
import styled from 'styled-components';
import { useGfx } from '../../state/hooks';
import type { GfxHealth } from '../../state/appStore';
import type { StageMode } from '../../render/contracts';
import { Button } from '../common/Button';
import { SOUND_OFF_ROW_PX } from '../pwa/UpdateChip';
import { theme } from '../theme';
import type { RoomViewModel } from './roomView';
import { ConnectingView } from './ConnectingView';
import { CountdownOverlay } from './CountdownOverlay';
import { FailureView } from './FailureView';
import { GameHud } from './GameHud';
import { GraphicsFallbackReporter } from './GraphicsFallback';
import { GRAPHICS } from './copy';
import { JoystickZone } from './JoystickZone';
import { LobbyView } from './LobbyView';
import { ReconnectBanner } from './ReconnectBanner';
import { ResultsDialog } from './ResultsDialog';

const Area = styled.div`
  position: absolute;
  inset: 0;
  overflow: hidden;
  background: ${theme.color.bg};
`;

const StageLayer = styled.div<{ $filtered: boolean }>`
  position: absolute;
  inset: 0;
  z-index: ${theme.z.stage};
  filter: ${({ $filtered }) => ($filtered ? 'grayscale(0.75) brightness(0.6)' : 'none')};
  transition: filter calc(300ms * ${theme.motion});

  & canvas {
    display: block;
    width: 100%;
    height: 100%;
  }
`;

/** Passes pointer events through to the stage except where a view opts back in. */
const Foreground = styled.div`
  position: absolute;
  inset: 0;
  z-index: ${theme.z.hud};
  pointer-events: none;
`;

/** Clears GameHud's "Sound off" row and UpdateChip's row lifted above it (both bottom corners). */
const NOTICE_BOTTOM_PX = 12 + 2 * SOUND_OFF_ROW_PX;

// z-index 3: above GameHud's layer (2) and JoystickZone (1) inside the foreground's stacking context.
// `width: max-content` keeps a centred absolute box from wrapping at half the width.
const Notice = styled.div<{ $interactive: boolean }>`
  position: absolute;
  left: 50%;
  bottom: calc(${theme.safe.b} + ${NOTICE_BOTTOM_PX}px);
  transform: translateX(-50%);
  z-index: 3;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 8px 12px;
  width: max-content;
  max-width: calc(100% - 32px);
  padding: 8px 14px;
  border: 1px solid ${theme.color.border};
  border-radius: 22px;
  background: rgba(9, 9, 11, 0.9);
  color: ${theme.color.fg};
  font-size: 1.1rem;
  text-align: center;
  pointer-events: ${({ $interactive }) => ($interactive ? 'auto' : 'none')};
`;

/** One status container for both states, so going from paused to failed updates the same live region. */
function GraphicsNotice({ health, fallbackShown }: { health: GfxHealth; fallbackShown: boolean }): JSX.Element | null {
  const failed = fallbackShown || health === 'failed' || health === 'unsupported';
  if (!failed && health !== 'lost' && health !== 'restoring') return null;
  return (
    <Notice role="status" $interactive={failed}>
      {failed ? (
        <>
          <span>{GRAPHICS.body}</span>
          <Button variant="secondary" onClick={() => window.location.reload()}>
            {GRAPHICS.reload}
          </Button>
        </>
      ) : (
        GRAPHICS.paused
      )}
    </Notice>
  );
}

export function RoomLayout({ stage, frozen, children }: { stage: ReactNode; frozen: boolean; children: ReactNode }): JSX.Element {
  const { tier, health } = useGfx();
  const [fallbackShown, setFallbackShown] = useState(false);
  const hasStage = stage !== null && stage !== undefined;
  return (
    <Area data-frozen={frozen ? '' : undefined}>
      <StageLayer $filtered={frozen && tier === 'low'}>
        <GraphicsFallbackReporter onChange={setFallbackShown}>{stage}</GraphicsFallbackReporter>
      </StageLayer>
      <Foreground>
        {hasStage && <GraphicsNotice health={health} fallbackShown={fallbackShown} />}
        {children}
      </Foreground>
    </Area>
  );
}

export function RoomForeground({ view, mode }: { view: RoomViewModel; mode: StageMode | 'none' }): JSX.Element {
  switch (view.kind) {
    case 'connecting':
      return <><ConnectingView key="connecting" view={view} /></>;
    case 'lobby':
      return <><LobbyView key="lobby" /></>;
    case 'countdown':
      return <><LobbyView key="lobby" /><CountdownOverlay key="countdown" /></>;
    case 'playing':
      return <><GameHud key="hud" /><JoystickZone key="joystick" /></>;
    case 'reconnecting':
      return mode === 'frozen'
        ? <><GameHud key="hud" /><ReconnectBanner key="reconnect" view={view} /></>
        : <><ReconnectBanner key="reconnect" view={view} standalone /></>;
    case 'failed':
      return <><FailureView key="failed" view={view} /></>;
    case 'finished':
      return mode === 'ended'
        ? <><GameHud key="hud" /><ResultsDialog key="results" /></>
        : <><ResultsDialog key="results" /></>;
  }
}
