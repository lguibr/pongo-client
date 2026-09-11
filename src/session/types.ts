// Session machine, ports and API types (4.3). Implemented by P1 (src/session/*, src/net/*).

import type { RoomPhase, WireDirection, RoomCreated, RoomJoined, PlayerAssignment, GameOver,
  InitialState, GameUpdates, ClientMessage } from '../protocol/messages';
import type { Seat, Owner } from '../game/events';
import type { MusicScene } from '../audio/types';
import type { AppStore, ResultsView } from '../state/appStore';
import type { TimerHost } from '../lib/timers';
import type { Now } from '../lib/clock';
import type { Rand } from '../lib/random';

export type RoomCode = string & { readonly __brand: 'RoomCode' };
export type Intent = { kind: 'create'; isPublic: boolean } | { kind: 'quick' } | { kind: 'join'; code: RoomCode };
export interface RoomRef { code: RoomCode; myIndex: Seat | null; lastPhase: RoomPhase | null }

export type FailCode = 'invalid-code' | 'room-not-found' | 'room-full' | 'room-closing' | 'server-full'
  | 'session-busy' | 'unreachable' | 'room-lost' | 'seat-taken' | 'protocol' | 'unknown';
export interface Failure {
  code: FailCode; serverReason: string | null;
  retryable: boolean; canJoinAsNew: boolean; autoRetryOnOnline: boolean;
}
export type DropCause = 'closed' | 'liveness' | 'admission-timeout' | 'connect-timeout' | 'rejected' | 'pagehide';
export type ReasonClass = 'room-gone' | 'room-full' | 'busy' | 'pending' | 'server-full' | 'transient' | 'unknown';
export interface RetryCounters { preAdmit: number; busy: number; pending: number; serverFull: number; transient: number }

export type SessionState =
  | { s: 'idle' }
  | { s: 'connecting'; intent: Intent; room: RoomRef | null; attempt: number; gen: number; retry: RetryCounters }
  | { s: 'requesting'; intent: Intent; room: RoomRef | null; attempt: number; gen: number; sentAt: number; retry: RetryCounters }
  | { s: 'lobby'; room: RoomRef; gen: number }
  | { s: 'countdown'; room: RoomRef; gen: number; seconds: number | null; endsAt: number | null }
  | { s: 'playing'; room: RoomRef; gen: number }
  | { s: 'reconnecting'; intent: Intent; room: RoomRef | null; attempt: number; nextAt: number | null;
      cause: DropCause; offline: boolean; suspended: boolean; retry: RetryCounters }
  | { s: 'failed'; failure: Failure; intent: Intent | null; room: RoomRef | null }
  | { s: 'finished'; room: RoomRef; gameOver: GameOver | null; derived: boolean };
export type SessionStateName = SessionState['s'];

export interface Model {
  state: SessionState;
  lastGen: number;               // gen = ++lastGen on every socket.open
  epoch: number;                 // ++ on every playerAssignment
  online: boolean;
  visible: boolean;
  resumeGraceUntil: number;      // liveness is not judged before this time
  unstable: boolean;             // soft stall in play
  badCount: number; badWindowStart: number;
  lastLeft: { code: RoomCode; at: number } | null;  // explicit leave, for the rejoin banner and the C17 toast
  // In-room recovery. These live on the model, not on a state variant, so they survive
  // reconnecting -> connecting -> requesting -> reconnecting cycles (5.5.1 "Budget accounting").
  budgetUsedMs: number;          // online time spent recovering since the drop
  budgetAt: number;              // when budgetUsedMs was last accounted
  droppedAt: number | null;      // when the admitted session last dropped; null when not recovering
  roomCloseFloorAt: number | null; // before this time the room cannot have closed for being empty (T13)
}

export type TimerName = 'connect' | 'admission' | 'retry' | 'liveness' | 'stall';
export type EnvInput =
  | { t: 'online' } | { t: 'offline' } | { t: 'visible' } | { t: 'hidden' }
  | { t: 'pagehide'; persisted: boolean } | { t: 'pageshow'; persisted: boolean }
  | { t: 'freeze' } | { t: 'resume' };
export type ControlEvent = { k: 'countdown'; seconds: number } | { k: 'cancelled'; reason: string } | { k: 'started' };
export type SessionInput =
  | { t: 'start'; intent: Intent }
  | { t: 'leave'; explicit: boolean }
  | { t: 'retry' }
  | { t: 'joinAsNew' }
  | { t: 'open'; gen: number }
  | { t: 'closed'; gen: number; code: number; wasClean: boolean }
  | { t: 'message'; gen: number; msg: RoomCreated | RoomJoined | PlayerAssignment | GameOver; at: number }
  | { t: 'control'; gen: number; ev: ControlEvent; at: number }
  | { t: 'frame'; gen: number; at: number }     // dispatched only while model.unstable (clears it)
  | { t: 'badFrame'; gen: number; at: number }
  | { t: 'timer'; name: TimerName }
  | EnvInput;

// Only the session runtime writes notices. Graphics and audio states are read from their own slices (gfx, audio).
export type NoticeKind = 'countdown-cancelled' | 'joined-as-new' | 'placed-in-left-room' | 'rejoin-failed'
  | 'seat-released' | 'seat-maybe-released';
export type CloseCode = 1000 | 4000 | 4001 | 4002;
export type SessionEffect =
  | { e: 'socket.open'; gen: number }
  | { e: 'socket.send'; gen: number; msg: ClientMessage }
  | { e: 'socket.close'; gen: number; code: CloseCode; reason: string }
  | { e: 'timer.set'; name: TimerName; ms: number }
  | { e: 'timer.clear'; name: TimerName | '*' }
  | { e: 'game.reset'; epoch: number; myIndex: Seat | null }
  | { e: 'game.freeze'; frozen: boolean }
  | { e: 'game.ended'; msg: GameOver | null; reason: string }
  | { e: 'identity.rotate' }
  | { e: 'input.resync' }
  | { e: 'input.halt' }
  | { e: 'audio.scene'; scene: MusicScene }
  | { e: 'notice'; kind: NoticeKind };

export interface WorldSummary {
  ready: boolean; bricksAlive: number | null; bricksAtStart: number | null; tick: number;
  graceSeats: number;            // seats other than myIndex whose conn is Grace (T31's roomCloseFloorAt)
}
export interface Policy {
  connectTimeoutMs: number; admissionTimeoutMs: number;
  preAdmit: { baseMs: number; capMs: number; maxAttempts: number };
  inRoom: { baseMs: number; capMs: number; onlineBudgetMs: number };
  busyDelaysMs: readonly number[]; pendingDelaysMs: readonly number[]; serverFullDelaysMs: readonly number[];
  transientMaxInRow: number;
  liveness: { lobbyMs: number; playHardMs: number; playSoftMs: number; offlineMs: number; resumeGraceMs: number };
  badFrames: { count: number; windowMs: number };
  firstRetryMaxMs: number; onlineRetryMaxMs: number;
}
export interface MachineEnv { now: number; rand: Rand; sessionId: string; lastFrameAt: number; world: WorldSummary; policy: Policy }

export interface IngestResult { readonly controls: readonly ControlEvent[]; readonly ticks: number; readonly boardReady: boolean }
/** What the session needs from the game runtime. Implemented by GameRuntime (P2). */
export interface GameSink {
  reset(epoch: number, myIndex: Seat | null): void;
  freeze(frozen: boolean): void;
  ingest(msg: InitialState | GameUpdates, arrivalMs: number): IngestResult;
  summary(): WorldSummary;
  results(msg: GameOver | null, reason: string): ResultsView;
  ended(winner: Owner, derived: boolean): void;
  snap(): void;
  setHeadless(headless: boolean): void;
}
export interface InputPort { resync(): void; halt(): void }
export interface AudioPort { setScene(scene: MusicScene): void; setHidden(hidden: boolean): void }
export interface IdentityApi {
  readonly ready: Promise<void>;          // resolves when the Web Lock is settled (or the fallback is chosen)
  current(): string;
  rotate(): void;                         // keeps the previous id for rejoinWindowMs (4.4)
  hasPrevious(): boolean;
  restorePrevious(): boolean;             // false when the window has passed
  onPageHide(persisted: boolean): void;
  onPageShow(persisted: boolean): Promise<void>;
}
export interface TransportSink {
  open(gen: number): void;
  frame(gen: number, text: string, at: number): void;
  closed(gen: number, ev: { code: number; reason: string; wasClean: boolean }): void;
}
export interface TransportLike {
  setSink(sink: TransportSink): void;
  open(gen: number, url: string): void;                 // closes any current socket with 4001 first
  send(gen: number, text: string): boolean;             // only if gen is current and OPEN; never queues
  close(gen: number, code: CloseCode, reason: string): void; // detaches handlers first; the sink never sees it
  readonly currentGen: number;
  readonly isOpen: boolean;
}
export interface SessionDeps {
  transport: TransportLike; game: GameSink; input: InputPort; audio: AudioPort; identity: IdentityApi;
  store: AppStore; wsUrl: () => string; timers?: TimerHost; now?: Now; rand?: Rand; policy?: Policy;
}
export interface SessionApi {
  start(intent: Intent): void;
  leave(opts: { explicit: boolean }): void;
  retry(): void;
  joinAsNew(): void;
  rejoinPrevious(code: RoomCode): void;
  setReady(ready: boolean): boolean;            // false unless lobby or countdown with an open current socket
  sendDirection(d: WireDirection): boolean;     // false unless playing with an open current socket
  bindRoute(code: RoomCode | null, key: string): () => void;
  notifyEnv(e: EnvInput): void;
  dismissNotice(id: number): void;
  getModel(): Readonly<Model>;
  subscribe(cb: () => void): () => void;        // fires after every model change
  dispose(): void;
}
