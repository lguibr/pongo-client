// Room view selection (9.3) and the pure copy lookups the room views use (C99, C102). Nothing here reads
// React or the store, so every rule is unit-tested in node.

import type { AppState, Notice, ResultsView, SeatView, SessionView } from '../../state/appStore';
import type { StageMode } from '../../render/contracts';
import type { Failure, Intent, RoomCode } from '../../session/types';
import { SeatConn } from '../../game/events';
import { SEATS } from '../../game/orientation';
import { ANNOUNCE, CONNECTING, FAILURE, FAILURE_ACTION, LOBBY, RECONNECT } from './copy';

export type RoomViewModel =
  | { kind: 'connecting'; intent: Intent | null; code: RoomCode | null; attempt: number; rejoin: boolean }
  | { kind: 'lobby' } | { kind: 'countdown' } | { kind: 'playing' }
  | { kind: 'reconnecting'; attempt: number; nextAt: number | null; offline: boolean; suspended: boolean; showActions: boolean }
  | { kind: 'failed'; failure: Failure; code: RoomCode | null }
  | { kind: 'finished' };

export type ConnectingViewModel = Extract<RoomViewModel, { kind: 'connecting' }>;
export type ReconnectingViewModel = Extract<RoomViewModel, { kind: 'reconnecting' }>;

/** What the Suspense fallback shows, and what an idle session maps to while the binding redirects home. */
export const IDLE_CONNECTING: ConnectingViewModel = { kind: 'connecting', intent: null, code: null, attempt: 0, rejoin: false };

const hasBoard = (s: SessionView): boolean => s.worldReady || s.stageRetained;

function connecting(s: SessionView, rejoin: boolean): ConnectingViewModel {
  return { kind: 'connecting', intent: s.intent, code: s.code, attempt: s.attempt, rejoin };
}

function reconnecting(s: SessionView): ReconnectingViewModel {
  return {
    kind: 'reconnecting', attempt: s.attempt, nextAt: s.nextAt, offline: s.offline, suspended: s.suspended,
    showActions: s.attempt >= 1 || s.offline,
  };
}

/** The 9.3 table, rows checked in order. */
export function toRoomView(s: SessionView): RoomViewModel {
  switch (s.s) {
    case 'connecting':
    case 'requesting':
      if (s.roomKnown && hasBoard(s)) return reconnecting(s);
      return connecting(s, false);
    case 'lobby':
    case 'countdown':
    case 'playing':
      if (!s.worldReady) return connecting(s, s.stageRetained);
      return { kind: s.s };
    case 'reconnecting':
      return reconnecting(s);
    case 'failed':
      // failure is always set in `failed`; the fallback keeps the view total if a publish ever lags.
      return { kind: 'failed', failure: s.failure ?? UNKNOWN_FAILURE, code: s.code };
    case 'finished':
      return { kind: 'finished' };
    case 'idle':
      return IDLE_CONNECTING;
  }
}

const UNKNOWN_FAILURE: Failure = { code: 'unknown', serverReason: null, retryable: false, canJoinAsNew: false, autoRetryOnOnline: false };

/** The 9.3 table's stage column. */
export function stageMode(s: SessionView): StageMode | 'none' {
  switch (s.s) {
    case 'connecting':
    case 'requesting':
      return s.roomKnown && hasBoard(s) ? 'frozen' : 'none';
    case 'lobby':
    case 'countdown':
    case 'playing':
      if (!s.worldReady) return s.stageRetained ? 'frozen' : 'none';
      return s.s === 'lobby' ? 'lobby' : 'live';
    case 'reconnecting':
      return hasBoard(s) ? 'frozen' : 'none';
    case 'finished':
      return s.worldReady ? 'ended' : 'none';
    case 'failed':
    case 'idle':
      return 'none';
  }
}

/** GameHud's "Sound off — tap to enable" chip shows: audio is not running during play, including before the
 *  first gesture ('uninitialized', e.g. a reload straight into a playing room), where the unlock machine's
 *  window listeners make the tap on the chip the gesture that creates the context. 'running', 'closed' and
 *  'unsupported' show nothing, since a tap cannot help. The update chip and the toasts read it too, to sit
 *  above that chip. */
export const selectSoundOff = (s: AppState): boolean =>
  s.session.s === 'playing' &&
  (s.audio.state === 'uninitialized' || s.audio.state === 'locked' || s.audio.state === 'suspended' || s.audio.state === 'interrupted');

// ---- connecting and reconnecting copy ----

export interface ConnectingLines { title: string; detail: string | null }

export function connectingLines(v: ConnectingViewModel): ConnectingLines {
  const detail = v.attempt > 0 ? CONNECTING.retrying(v.attempt) : null;
  if (v.rejoin && v.code !== null) return { title: CONNECTING.rejoining(v.code), detail };
  // After T9 or T10 the intent is join(code), including for a create, so a known code always reads "Joining".
  if (v.code !== null) return { title: CONNECTING.joining(v.code), detail };
  switch (v.intent?.kind) {
    case 'create':
      return { title: CONNECTING.creating, detail };
    case 'quick':
      return { title: CONNECTING.finding, detail };
    case 'join':
      return { title: CONNECTING.joining(v.intent.code), detail };
    default:
      return { title: CONNECTING.generic, detail };
  }
}

/** Seconds until `at`, rounded up, never negative. */
export function secondsUntil(at: number, now: number): number {
  return Math.max(0, Math.ceil((at - now) / 1000));
}

/** `head` is announced; `tail` (the seconds) is shown but not spoken. */
export function reconnectParts(v: ReconnectingViewModel, now: number): { head: string; tail: string } {
  if (v.offline) return { head: RECONNECT.offline, tail: '' };
  const head = RECONNECT.head(Math.max(1, v.attempt));
  if (v.nextAt !== null && v.nextAt > now) return { head, tail: RECONNECT.nextTry(secondsUntil(v.nextAt, now)) };
  return { head, tail: RECONNECT.trying };
}

export function reconnectText(v: ReconnectingViewModel, now: number): string {
  const { head, tail } = reconnectParts(v, now);
  return head + tail;
}

// ---- failure ----

export type FailureActionId = 'retry' | 'joinAsNew' | 'quick' | 'home';
export interface FailureAction { id: FailureActionId; label: string }

/** From the flags, in order: retry, join as new, the code's extras, then Home (9.6). */
export function failureActions(f: Failure): FailureAction[] {
  const out: FailureAction[] = [];
  if (f.retryable) out.push({ id: 'retry', label: f.code === 'session-busy' ? FAILURE_ACTION.keepWaiting : FAILURE_ACTION.tryAgain });
  if (f.canJoinAsNew) out.push({ id: 'joinAsNew', label: FAILURE_ACTION.joinAsNew });
  for (const extra of FAILURE[f.code].extras) {
    if (extra === 'quick') out.push({ id: 'quick', label: FAILURE_ACTION.quick });
  }
  out.push({ id: 'home', label: FAILURE_ACTION.home });
  return out;
}

export interface FailureText { title: string; body: string | null; serverSaid: string | null }

export function failureText(f: Failure, code: RoomCode | null): FailureText {
  const c = FAILURE[f.code];
  const reason = f.serverReason !== null && f.serverReason.trim() !== '' ? f.serverReason : null;
  return { title: c.title(code), body: c.body, serverSaid: reason === null ? null : FAILURE_ACTION.serverSaid(reason) };
}

// ---- lobby ----

/** Derived from the seats, never stored (C99). Only connected seats have to ready up. */
export function lobbyStatus(seats: readonly SeatView[]): string {
  let present = 0;
  let ready = 0;
  for (const s of seats) {
    if (s.conn !== SeatConn.Connected) continue;
    present++;
    if (s.ready) ready++;
  }
  if (present > 0 && ready === present) return LOBBY.everyoneReady;
  if (ready === 0) return LOBBY.waitingForPlayers;
  return LOBBY.waitingForMore(present - ready);
}

// ---- live announcements (9.6) ----

export interface AnnounceSnapshot {
  session: SessionView;
  results: ResultsView | null;
  notices: readonly Notice[];
}
/** What the announcer remembers between snapshots. */
export interface AnnounceMemory {
  admittedCode: RoomCode | null;   // the room this session was admitted to, until it goes idle, fails or finishes
  lastNoticeId: number;            // highest notice id already announced
}
export interface Announcements { polite: string[]; assertive: string[]; memory: AnnounceMemory }

export const INITIAL_ANNOUNCE_MEMORY: AnnounceMemory = { admittedCode: null, lastNoticeId: -1 };

const isAdmitted = (s: SessionView): boolean => s.s === 'lobby' || s.s === 'countdown' || s.s === 'playing';
const REPLACES_RECONNECTED = new Set<Notice['kind']>(['seat-released', 'seat-maybe-released']);

/** Messages for the transition from `prev` to `next`. A rejoin that lost the seat announces the notice's text
 *  instead of "Reconnected."; every new notice is announced once. */
export function announcements(prev: AnnounceSnapshot, next: AnnounceSnapshot, memory: AnnounceMemory): Announcements {
  const polite: string[] = [];
  const assertive: string[] = [];
  let { admittedCode, lastNoticeId } = memory;
  const p = prev.session;
  const n = next.session;

  const fresh = next.notices.filter((x) => x.id > lastNoticeId);
  for (const x of fresh) lastNoticeId = Math.max(lastNoticeId, x.id);

  // A new start can follow a failure or the results without passing through idle (Quick Play, Try again),
  // and landing in the same room again is then a join, not a reconnect.
  if (n.s === 'idle' || n.s === 'failed' || n.s === 'finished') admittedCode = null;

  if (isAdmitted(n) && !isAdmitted(p)) {
    if (admittedCode !== null && admittedCode === n.code) {
      if (!fresh.some((x) => REPLACES_RECONNECTED.has(x.kind))) polite.push(ANNOUNCE.reconnected);
    } else if (n.code !== null) {
      if (n.myIndex !== null) polite.push(ANNOUNCE.joined(n.code, SEATS[n.myIndex].name));
      admittedCode = n.code;
    }
  } else if (isAdmitted(n) && isAdmitted(p)) {
    if (n.s === 'countdown' && p.s === 'lobby') assertive.push(ANNOUNCE.countdownStarted);
    if (n.s === 'playing' && p.s !== 'playing') polite.push(ANNOUNCE.gameStarted);
  } else if (isAdmitted(p) && (n.s === 'reconnecting' || n.s === 'connecting' || n.s === 'requesting')) {
    polite.push(ANNOUNCE.connectionLost);
  }

  if (prev.results === null && next.results !== null) {
    const w = next.results.winner;
    polite.push(w === -1 ? ANNOUNCE.gameOverTie : ANNOUNCE.gameOverWins(SEATS[w].name));
  }

  for (const x of fresh) polite.push(x.text);

  return { polite, assertive, memory: { admittedCode, lastNoticeId } };
}
