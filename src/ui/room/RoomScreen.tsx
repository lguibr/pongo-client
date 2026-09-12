// The room route container (9.3, D22, D33; C13, C36, C71). It binds the route to the session and picks the stage
// mode and the foreground views from the session view. The stage (GameStage inside StageBoundary) never renders
// under StrictMode, and it sits at one fixed place in RoomLayout for every mode except 'none'. So the Canvas, and
// its one WebGL context, stay mounted through the lobby, the countdown, play, a drop, the rejoin and the end: the
// table in 9.3 never passes through 'none' while stageRetained holds.

import { StrictMode } from 'react';
import { useParams } from 'react-router-dom';
import { useApp } from '../../app/AppContext';
import { useAppState, useSession } from '../../state/hooks';
import type { AppState } from '../../state/appStore';
import type { Failure } from '../../session/types';
import { GameStage } from '../../render/GameStage';
import { StageBoundary } from '../../render/StageBoundary';
import { createFxDirector } from '../../fx/director';
import { GraphicsFallback } from './GraphicsFallback';
import { RoomForeground, RoomLayout } from './RoomLayout';
import { stageMode, toRoomView } from './roomView';
import type { RoomViewModel } from './roomView';
import { useRoomBinding } from './useRoomBinding';

/** A bad code in the URL fails locally (T1's copy and flags): no socket, and only Home. */
const INVALID_CODE: Failure = { code: 'invalid-code', serverReason: null, retryable: false, canJoinAsNew: false, autoRetryOnOnline: false };
const INVALID_VIEW: RoomViewModel = { kind: 'failed', failure: INVALID_CODE, code: null };

const selectStageKey = (s: AppState): number => s.gfx.stageKey;

export default function RoomScreen(): JSX.Element {
  const { code } = useParams();
  const { invalid } = useRoomBinding(code);
  const app = useApp();
  const session = useSession();
  const stageKey = useAppState(selectStageKey);

  const mode = invalid ? 'none' : stageMode(session);
  const view = invalid ? INVALID_VIEW : toRoomView(session);
  const stage = mode === 'none' ? null : (
    <StageBoundary resetKey={stageKey} fallback={<GraphicsFallback />}>
      <GameStage app={app} fxFactory={createFxDirector} mode={mode} />
    </StageBoundary>
  );

  return (
    <RoomLayout frozen={mode === 'frozen'} stage={stage}>
      <StrictMode>
        <RoomForeground view={view} mode={mode} />
      </StrictMode>
    </RoomLayout>
  );
}
