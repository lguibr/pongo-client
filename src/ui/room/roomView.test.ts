import { describe, expect, it } from 'vitest';
import { initialAppState } from '../../state/appStore';
import type { AppState, Notice, ResultsView, SeatView, SessionView } from '../../state/appStore';
import type { AudioState } from '../../audio/types';
import type { StageMode } from '../../render/contracts';
import type { FailCode, Failure, RoomCode, SessionStateName } from '../../session/types';
import { SeatConn } from '../../game/events';
import type { Seat } from '../../game/events';
import { SEATS } from '../../game/orientation';
import {
  IDLE_CONNECTING, INITIAL_ANNOUNCE_MEMORY, announcements, connectingLines, failureActions, failureText,
  lobbyStatus, reconnectParts, reconnectText, selectSoundOff, stageMode, toRoomView,
} from './roomView';
import type { AnnounceMemory, AnnounceSnapshot, Announcements, ReconnectingViewModel, RoomViewModel } from './roomView';

const CODE = 'ABC123' as RoomCode;

function sv(p: Partial<SessionView> = {}): SessionView {
  return { ...initialAppState().session, code: CODE, myIndex: 0, gen: 1, epoch: 1, ...p };
}

function failure(code: FailCode, p: Partial<Failure> = {}): Failure {
  return { code, serverReason: null, retryable: false, canJoinAsNew: false, autoRetryOnOnline: false, ...p };
}

// ---- 9.3, encoded as data straight from the spec table; rows are checked in order ----

interface Combo { roomKnown: boolean; worldReady: boolean; stageRetained: boolean }
interface SpecRow { states: readonly SessionStateName[]; when: (c: Combo) => boolean; mode: StageMode | 'none'; kind: RoomViewModel['kind'] | null; rejoin?: boolean }

const SPEC: readonly SpecRow[] = [
  { states: ['connecting', 'requesting'], when: (c) => !c.roomKnown, mode: 'none', kind: 'connecting' },
  { states: ['connecting', 'requesting'], when: (c) => c.roomKnown && !c.worldReady && !c.stageRetained, mode: 'none', kind: 'connecting' },
  { states: ['connecting', 'requesting'], when: (c) => c.roomKnown && (c.worldReady || c.stageRetained), mode: 'frozen', kind: 'reconnecting' },
  { states: ['lobby', 'countdown', 'playing'], when: (c) => !c.worldReady && !c.stageRetained, mode: 'none', kind: 'connecting' },
  { states: ['lobby', 'countdown', 'playing'], when: (c) => !c.worldReady && c.stageRetained, mode: 'frozen', kind: 'connecting', rejoin: true },
  { states: ['lobby'], when: (c) => c.worldReady, mode: 'lobby', kind: 'lobby' },
  { states: ['countdown'], when: (c) => c.worldReady, mode: 'live', kind: 'countdown' },
  { states: ['playing'], when: (c) => c.worldReady, mode: 'live', kind: 'playing' },
  { states: ['reconnecting'], when: (c) => c.worldReady || c.stageRetained, mode: 'frozen', kind: 'reconnecting' },
  { states: ['reconnecting'], when: () => true, mode: 'none', kind: 'reconnecting' },
  { states: ['failed'], when: () => true, mode: 'none', kind: 'failed' },
  { states: ['finished'], when: (c) => c.worldReady, mode: 'ended', kind: 'finished' },
  { states: ['finished'], when: () => true, mode: 'none', kind: 'finished' },
  { states: ['idle'], when: () => true, mode: 'none', kind: null },
];

const STATES: readonly SessionStateName[] = ['idle', 'connecting', 'requesting', 'lobby', 'countdown', 'playing', 'reconnecting', 'failed', 'finished'];
const COMBOS: readonly Combo[] = [false, true].flatMap((roomKnown) =>
  [false, true].flatMap((worldReady) => [false, true].map((stageRetained) => ({ roomKnown, worldReady, stageRetained }))));

function sessionFor(s: SessionStateName, c: Combo): SessionView {
  return sv({
    s, ...c,
    intent: s === 'connecting' || s === 'requesting' || s === 'reconnecting' ? { kind: 'join', code: CODE } : null,
    failure: s === 'failed' ? failure('room-not-found') : null,
  });
}

describe('9.3 table: stageMode and toRoomView', () => {
  it('matches the spec table for every state and every roomKnown, worldReady and stageRetained combination', () => {
    let checked = 0;
    for (const s of STATES) {
      for (const c of COMBOS) {
        const row = SPEC.find((r) => r.states.includes(s) && r.when(c));
        expect(row, `${s} ${JSON.stringify(c)} has a spec row`).toBeDefined();
        if (row === undefined) continue;
        const session = sessionFor(s, c);
        const view = toRoomView(session);
        expect(stageMode(session), `${s} ${JSON.stringify(c)}`).toBe(row.mode);
        if (row.kind === null) expect(view).toEqual(IDLE_CONNECTING);
        else expect(view.kind, `${s} ${JSON.stringify(c)}`).toBe(row.kind);
        if (view.kind === 'connecting') expect(view.rejoin, `${s} ${JSON.stringify(c)}`).toBe(row.rejoin ?? false);
        checked++;
      }
    }
    expect(checked).toBe(STATES.length * COMBOS.length);
  });

  it('row 1: connecting without a room shows the connecting view, even when a stage is retained', () => {
    const s = sv({ s: 'connecting', roomKnown: false, stageRetained: true, code: null, intent: { kind: 'quick' }, attempt: 2 });
    expect(stageMode(s)).toBe('none');
    expect(toRoomView(s)).toEqual({ kind: 'connecting', intent: { kind: 'quick' }, code: null, attempt: 2, rejoin: false });
  });

  it('row 2: requesting with a known room and no board is connecting to that code', () => {
    const s = sv({ s: 'requesting', roomKnown: true, intent: { kind: 'join', code: CODE } });
    expect(stageMode(s)).toBe('none');
    expect(toRoomView(s)).toMatchObject({ kind: 'connecting', code: CODE, rejoin: false });
  });

  it('row 3: connecting with a room and a board is shown as reconnecting over the frozen board', () => {
    const s = sv({ s: 'connecting', roomKnown: true, worldReady: true, attempt: 3, offline: false });
    expect(stageMode(s)).toBe('frozen');
    expect(toRoomView(s)).toEqual({ kind: 'reconnecting', attempt: 3, nextAt: null, offline: false, suspended: false, showActions: true });
  });

  it('rows 4 and 5: admitted without a ready world is connecting, with rejoin only when the stage is retained', () => {
    for (const s of ['lobby', 'countdown', 'playing'] as const) {
      expect(toRoomView(sv({ s, worldReady: false, stageRetained: false }))).toMatchObject({ kind: 'connecting', rejoin: false, code: CODE });
      expect(stageMode(sv({ s, worldReady: false, stageRetained: false }))).toBe('none');
      expect(toRoomView(sv({ s, worldReady: false, stageRetained: true }))).toMatchObject({ kind: 'connecting', rejoin: true, code: CODE });
      expect(stageMode(sv({ s, worldReady: false, stageRetained: true }))).toBe('frozen');
    }
  });

  it('rows 6 to 8: lobby is the lobby stage, countdown and playing are live', () => {
    expect([stageMode(sv({ s: 'lobby', worldReady: true })), toRoomView(sv({ s: 'lobby', worldReady: true }))]).toEqual(['lobby', { kind: 'lobby' }]);
    expect([stageMode(sv({ s: 'countdown', worldReady: true })), toRoomView(sv({ s: 'countdown', worldReady: true }))]).toEqual(['live', { kind: 'countdown' }]);
    expect([stageMode(sv({ s: 'playing', worldReady: true })), toRoomView(sv({ s: 'playing', worldReady: true }))]).toEqual(['live', { kind: 'playing' }]);
  });

  it('rows 9 and 10: reconnecting is frozen over a board and plain without one; actions from attempt 1 or offline', () => {
    const withBoard = sv({ s: 'reconnecting', stageRetained: true, attempt: 0, nextAt: 5000 });
    expect(stageMode(withBoard)).toBe('frozen');
    expect(toRoomView(withBoard)).toEqual({ kind: 'reconnecting', attempt: 0, nextAt: 5000, offline: false, suspended: false, showActions: false });
    const bare = sv({ s: 'reconnecting', attempt: 0, offline: true, suspended: true });
    expect(stageMode(bare)).toBe('none');
    expect(toRoomView(bare)).toEqual({ kind: 'reconnecting', attempt: 0, nextAt: null, offline: true, suspended: true, showActions: true });
  });

  it('row 11: failed carries the failure and the code, never a stage', () => {
    const f = failure('seat-taken');
    const s = sv({ s: 'failed', failure: f, worldReady: true, stageRetained: true });
    expect(stageMode(s)).toBe('none');
    expect(toRoomView(s)).toEqual({ kind: 'failed', failure: f, code: CODE });
  });

  it('rows 12 and 13: finished is ended over a ready world, and stageless otherwise even when retained', () => {
    expect(stageMode(sv({ s: 'finished', worldReady: true }))).toBe('ended');
    expect(stageMode(sv({ s: 'finished', worldReady: false, stageRetained: true }))).toBe('none');
    expect(toRoomView(sv({ s: 'finished' }))).toEqual({ kind: 'finished' });
  });

  it('row 14: idle has no stage and a neutral connecting view while the binding redirects', () => {
    expect(stageMode(sv({ s: 'idle' }))).toBe('none');
    expect(toRoomView(sv({ s: 'idle' }))).toEqual({ kind: 'connecting', intent: null, code: null, attempt: 0, rejoin: false });
  });
});

describe('connectingLines', () => {
  const v = (p: Partial<Extract<RoomViewModel, { kind: 'connecting' }>>) => ({ ...IDLE_CONNECTING, ...p });

  it('reads by intent while no code is known', () => {
    expect(connectingLines(v({ intent: { kind: 'create', isPublic: true } })).title).toBe('Creating room…');
    expect(connectingLines(v({ intent: { kind: 'quick' } })).title).toBe('Finding a match…');
    expect(connectingLines(v({ intent: { kind: 'join', code: CODE } })).title).toBe('Joining room ABC123…');
    expect(connectingLines(v({})).title).toBe('Connecting…');
  });

  it('reads "Joining" once the code is known, including for a create', () => {
    expect(connectingLines(v({ intent: { kind: 'create', isPublic: false }, code: CODE })).title).toBe('Joining room ABC123…');
  });

  it('reads "Rejoining" only for a rejoin, and adds "Retrying (n)…" after a failed attempt', () => {
    expect(connectingLines(v({ code: CODE, rejoin: true }))).toEqual({ title: 'Rejoining room ABC123…', detail: null });
    expect(connectingLines(v({ intent: { kind: 'quick' }, attempt: 2 })).detail).toBe('Retrying (2)…');
  });
});

describe('reconnect copy', () => {
  const v = (p: Partial<ReconnectingViewModel>): ReconnectingViewModel =>
    ({ kind: 'reconnecting', attempt: 1, nextAt: null, offline: false, suspended: false, showActions: true, ...p });

  it('counts the seconds to the next try, rounding up', () => {
    expect(reconnectText(v({ attempt: 2, nextAt: 13_200 }), 10_000)).toBe('Connection lost — reconnecting (attempt 2), next try in 4 s');
  });

  it('shows the attempt in flight when no retry is scheduled, never attempt 0', () => {
    expect(reconnectText(v({ attempt: 0, nextAt: null }), 0)).toBe('Connection lost — reconnecting (attempt 1)…');
    expect(reconnectText(v({ attempt: 3, nextAt: 900 }), 1000)).toBe('Connection lost — reconnecting (attempt 3)…');
  });

  it('uses the offline copy while offline, with no spoken seconds', () => {
    expect(reconnectParts(v({ offline: true, nextAt: 99_000 }), 0)).toEqual({ head: "You're offline. We'll reconnect when you're back online.", tail: '' });
  });

  it('keeps the seconds out of the spoken head', () => {
    const p = reconnectParts(v({ attempt: 2, nextAt: 3000 }), 0);
    expect(p.head).toBe('Connection lost — reconnecting (attempt 2)');
    expect(p.tail).toBe(', next try in 3 s');
  });
});

describe('failure actions follow the flags (9.6)', () => {
  const labels = (f: Failure): string[] => failureActions(f).map((a) => a.label);

  it.each([
    ['invalid-code', {}, ['Home']],
    ['room-not-found', {}, ['Quick Play', 'Home']],
    ['room-full', { retryable: true }, ['Try again', 'Quick Play', 'Home']],
    ['room-closing', {}, ['Quick Play', 'Home']],
    ['server-full', { retryable: true }, ['Try again', 'Home']],
    ['session-busy', { retryable: true, canJoinAsNew: true }, ['Keep waiting', 'Join as new player', 'Home']],
    ['unreachable', { retryable: true, autoRetryOnOnline: true }, ['Try again', 'Home']],
    ['room-lost', {}, ['Quick Play', 'Home']],
    ['room-lost', { retryable: true }, ['Try again', 'Quick Play', 'Home']],
    ['seat-taken', {}, ['Quick Play', 'Home']],
    ['protocol', { retryable: true }, ['Try again', 'Home']],
    ['unknown', { retryable: true }, ['Try again', 'Home']],
  ] as const)('%s with %j', (code, flags, expected) => {
    expect(labels(failure(code, flags))).toEqual(expected);
  });

  it('derives from the flags, not from a fixed list per code', () => {
    expect(labels(failure('session-busy'))).toEqual(['Home']);
    expect(labels(failure('unknown', { canJoinAsNew: true }))).toEqual(['Join as new player', 'Home']);
    expect(failureActions(failure('session-busy', { retryable: true, canJoinAsNew: true })).map((a) => a.id)).toEqual(['retry', 'joinAsNew', 'home']);
  });

  it('titles name the room when the code is known, and show the server reason as secondary text', () => {
    expect(failureText(failure('room-not-found'), CODE)).toEqual({ title: "Room ABC123 doesn't exist", body: 'It may have finished, or the code is wrong.', serverSaid: null });
    expect(failureText(failure('room-full', { serverReason: 'Room is full' }), null)).toEqual({ title: 'That room is full', body: 'All four seats are taken.', serverSaid: 'Server said: Room is full' });
    expect(failureText(failure('protocol', { serverReason: '   ' }), CODE).serverSaid).toBeNull();
  });
});

describe('lobbyStatus (C99)', () => {
  const seat = (index: Seat, conn: SeatConn, ready = false): SeatView =>
    ({ ...initialAppState().seats[index], conn, ready, score: 0 });

  it('waits for players while nobody is ready', () => {
    expect(lobbyStatus([seat(0, SeatConn.Connected), seat(1, SeatConn.Connected), seat(2, SeatConn.Empty), seat(3, SeatConn.Empty)]))
      .toBe('Waiting for players — press Ready when you are');
    expect(lobbyStatus(initialAppState().seats)).toBe('Waiting for players — press Ready when you are');
  });

  it('counts how many connected players still have to ready up', () => {
    expect(lobbyStatus([seat(0, SeatConn.Connected, true), seat(1, SeatConn.Connected), seat(2, SeatConn.Connected), seat(3, SeatConn.Empty)]))
      .toBe('Waiting for 2 more to ready up');
  });

  it('is "Everyone\'s ready!" when every connected seat is ready; a Grace seat does not block it', () => {
    expect(lobbyStatus([seat(0, SeatConn.Connected, true), seat(1, SeatConn.Connected, true), seat(2, SeatConn.Grace), seat(3, SeatConn.Empty)]))
      .toBe("Everyone's ready!");
  });
});

describe('live announcements (9.6)', () => {
  const snap = (p: Partial<SessionView>, extra: Partial<AnnounceSnapshot> = {}): AnnounceSnapshot => ({ session: sv(p), results: null, notices: [], ...extra });
  const notice = (id: number, kind: Notice['kind'], text: string): Notice => ({ id, kind, text, tone: 'warn', expiresAt: 1e9 });
  const results = (winner: ResultsView['winner']): ResultsView => ({ winner, rows: [], reason: '', derived: false });

  function run(seq: readonly AnnounceSnapshot[], memory: AnnounceMemory = INITIAL_ANNOUNCE_MEMORY): Announcements[] {
    const out: Announcements[] = [];
    for (let i = 1; i < seq.length; i++) {
      const r = announcements(seq[i - 1], seq[i], memory);
      memory = r.memory;
      out.push(r);
    }
    return out;
  }

  const idle = snap({ s: 'idle', code: null, myIndex: null });
  const requesting = snap({ s: 'requesting', myIndex: null, intent: { kind: 'join', code: CODE } });

  it('joins, counts down, starts, drops and reconnects', () => {
    const out = run([
      idle, requesting,
      snap({ s: 'lobby', myIndex: 1 }),
      snap({ s: 'countdown', myIndex: 1 }),
      snap({ s: 'playing', myIndex: 1 }),
      snap({ s: 'reconnecting', myIndex: 1 }),
      snap({ s: 'connecting', myIndex: 1 }),
      snap({ s: 'playing', myIndex: 1 }),
    ]);
    expect(out.map((r) => [r.polite, r.assertive])).toEqual([
      [[], []],
      [['Joined room ABC123 as Green.'], []],
      [[], ['Countdown started.']],
      [['Game started.'], []],
      [['Connection lost, reconnecting.'], []],
      [[], []],
      [['Reconnected.'], []],
    ]);
  });

  it('a force start from the lobby also announces the game start', () => {
    const [, start] = run([requesting, snap({ s: 'lobby' }), snap({ s: 'playing' })]);
    expect(start.polite).toEqual(['Game started.']);
  });

  it('a rejoin that lost the seat announces the notice instead of "Reconnected."', () => {
    const released = notice(4, 'seat-released', "Your seat was released — you're back as a new player.");
    const out = run([
      requesting, snap({ s: 'playing' }), snap({ s: 'reconnecting' }),
      snap({ s: 'playing', myIndex: 2 }, { notices: [released] }),
    ]);
    expect(out[2].polite).toEqual(["Your seat was released — you're back as a new player."]);
  });

  it('announces each notice once', () => {
    const cancelled = notice(1, 'countdown-cancelled', 'Countdown cancelled — a player left or changed their ready state.');
    const lobby = snap({ s: 'lobby' }, { notices: [cancelled] });
    const out = run([snap({ s: 'lobby' }), lobby, { ...lobby, notices: [cancelled] }]);
    expect(out[0].polite).toEqual([cancelled.text]);
    expect(out[1].polite).toEqual([]);
  });

  it('announces the winner or a tie when results arrive', () => {
    expect(run([snap({ s: 'playing' }), snap({ s: 'finished' }, { results: results(0) })])[0].polite).toEqual(['Game over. Blue wins.']);
    expect(run([snap({ s: 'playing' }), snap({ s: 'finished' }, { results: results(-1) })])[0].polite).toEqual(["Game over. It's a tie."]);
  });

  it('forgets the room on idle, so joining it again is a join, not a reconnect', () => {
    const out = run([requesting, snap({ s: 'lobby' }), idle, requesting, snap({ s: 'lobby', myIndex: 3 })]);
    expect(out[3].polite).toEqual([`Joined room ABC123 as ${SEATS[3].name}.`]);
  });

  it('forgets the room after a failure or the results, which a new start leaves without passing through idle', () => {
    const ends: readonly AnnounceSnapshot[] = [
      snap({ s: 'failed', failure: failure('seat-taken') }),
      snap({ s: 'finished' }, { results: results(1) }),
    ];
    for (const end of ends) {
      const out = run([requesting, snap({ s: 'lobby' }), end, requesting, snap({ s: 'lobby', myIndex: 2 })]);
      expect(out[3].polite, end.session.s).toEqual([`Joined room ABC123 as ${SEATS[2].name}.`]);
    }
  });
});

// ---- the "Sound off" chip (9.5, amended) ----

describe('selectSoundOff', () => {
  const st = (s: SessionStateName, audio: AudioState): AppState => ({
    ...initialAppState(), session: sv({ s }), audio: { state: audio, musicReady: false },
  });

  it('shows during play while audio is not running, including before the first gesture (a reload into play)', () => {
    for (const a of ['uninitialized', 'locked', 'suspended', 'interrupted'] as const) expect(selectSoundOff(st('playing', a)), a).toBe(true);
  });

  it('hides once audio runs, and where a tap cannot help', () => {
    for (const a of ['running', 'unsupported', 'closed'] as const) expect(selectSoundOff(st('playing', a)), a).toBe(false);
  });

  it('never shows outside play', () => {
    for (const s of ['lobby', 'countdown', 'reconnecting', 'finished', 'idle'] as const) {
      expect(selectSoundOff(st(s, 'uninitialized')), s).toBe(false);
      expect(selectSoundOff(st(s, 'locked')), s).toBe(false);
    }
  });
});
