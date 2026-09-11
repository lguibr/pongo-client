// The app store (4.13). Each slice has exactly one writer module (SLICE_WRITERS). A writer only ever calls
// store.patch({ <its slice>: next }), and only when the slice's value actually changed, so each slice keeps
// its identity until then.

import type { Store } from '../lib/store';
import type { Seat, Owner } from '../game/events';
import { SeatConn } from '../game/events';
import { SEATS } from '../game/orientation';
import type { RoomPhase } from '../protocol/messages';
import type { Intent, RoomCode, Failure, DropCause, SessionStateName, NoticeKind } from '../session/types';
import type { Tier } from '../render/contracts';
import type { AudioState } from '../audio/types';

export interface SessionView {
  s: SessionStateName; intent: Intent | null; code: RoomCode | null; myIndex: Seat | null; phase: RoomPhase | null;
  attempt: number; nextAt: number | null; offline: boolean; suspended: boolean;
  failure: Failure | null; cause: DropCause | null; roomKnown: boolean;
  worldReady: boolean;   // true once an ingest reports boardReady for the current epoch; false after game.reset
  stageRetained: boolean; // true while boundCode equals the code of the room whose board was last ready (D33)
  canReady: boolean;
  gen: number; epoch: number;
}
export interface SeatView {
  index: Seat; conn: SeatConn; score: number | null; ready: boolean; isMe: boolean;
  graceEndsAt: number;   // performance.now ms, NaN unknown
  name: string; color: string; glyph: string;
}
export interface CountdownView { seconds: number; endsAt: number }   // endsAt: performance.now ms
export interface ResultRow { index: Seat; score: number; left: boolean; isMe: boolean; winner: boolean }
export interface ResultsView { winner: Owner; rows: readonly ResultRow[]; reason: string; derived: boolean }
export interface Notice { id: number; kind: NoticeKind; text: string; tone: 'info' | 'warn'; expiresAt: number }
export type GfxHealth = 'ok' | 'lost' | 'restoring' | 'failed' | 'unsupported';
export interface AppState {
  session: SessionView;                                         // writer: session/runtime.ts
  seats: readonly [SeatView, SeatView, SeatView, SeatView];     // writer: game/coldBridge.ts
  countdown: CountdownView | null;                              // writer: session/runtime.ts
  results: ResultsView | null;                                  // writer: session/runtime.ts
  notices: readonly Notice[];                                   // writer: session/runtime.ts
  net: { unstable: boolean };                                   // writer: session/runtime.ts
  lastLeft: { code: RoomCode; at: number; canRejoin: boolean } | null; // writer: session/runtime.ts
  page: { visible: boolean; online: boolean };                  // writer: session/lifecycle.ts
  gfx: { health: GfxHealth; tier: Tier; stageKey: number };     // writer: render/GameStage.tsx
  audio: { state: AudioState; musicReady: boolean };            // writer: audio/engine.ts
  pwa: { updateReady: boolean };                                // writer: ui/pwa/registerSW.ts
  motion: { reduced: boolean };                                 // writer: app/runtime.ts (watchReducedMotion)
}
export type AppStore = Store<AppState>;

function emptySeat(index: Seat): SeatView {
  const info = SEATS[index];
  return {
    index, conn: SeatConn.Empty, score: null, ready: false, isMe: false, graceEndsAt: NaN,
    name: info.name, color: info.color, glyph: info.glyph,
  };
}

/** A fresh state: idle session, empty seats. `page` starts visible and online; lifecycle.ts corrects it on attach. */
export function initialAppState(): AppState {
  return {
    session: {
      s: 'idle', intent: null, code: null, myIndex: null, phase: null,
      attempt: 0, nextAt: null, offline: false, suspended: false,
      failure: null, cause: null, roomKnown: false,
      worldReady: false, stageRetained: false, canReady: false,
      gen: 0, epoch: 0,
    },
    seats: [emptySeat(0), emptySeat(1), emptySeat(2), emptySeat(3)],
    countdown: null,
    results: null,
    notices: [],
    net: { unstable: false },
    lastLeft: null,
    page: { visible: true, online: true },
    gfx: { health: 'ok', tier: 'high', stageKey: 0 },
    audio: { state: 'uninitialized', musicReady: false },
    pwa: { updateReady: false },
    motion: { reduced: false },
  };
}

/** Module path per slice (asserted by a test). */
export const SLICE_WRITERS: Readonly<Record<keyof AppState, string>> = {
  session: 'src/session/runtime.ts',
  seats: 'src/game/coldBridge.ts',
  countdown: 'src/session/runtime.ts',
  results: 'src/session/runtime.ts',
  notices: 'src/session/runtime.ts',
  net: 'src/session/runtime.ts',
  lastLeft: 'src/session/runtime.ts',
  page: 'src/session/lifecycle.ts',
  gfx: 'src/render/GameStage.tsx',
  audio: 'src/audio/engine.ts',
  pwa: 'src/ui/pwa/registerSW.ts',
  motion: 'src/app/runtime.ts',
};
