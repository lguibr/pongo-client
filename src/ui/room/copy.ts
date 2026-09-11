// Every user-facing room string (9.6). Notice texts live in NOTICE_TEXT in src/session/runtime.ts.

import type { FailCode } from '../../session/types';

export const CONNECTING = {
  creating: 'Creating room…',
  finding: 'Finding a match…',
  generic: 'Connecting…',
  joining: (code: string) => `Joining room ${code}…`,
  rejoining: (code: string) => `Rejoining room ${code}…`,
  retrying: (n: number) => `Retrying (${n})…`,
  cancel: 'Cancel',
} as const;

// "Connection lost — reconnecting (attempt n), next try in s s" is built from a head, which the status region
// speaks, and a seconds tail, which it does not, so the banner is not re-announced every second.
export const RECONNECT = {
  head: (attempt: number) => `Connection lost — reconnecting (attempt ${attempt})`,
  nextTry: (seconds: number) => `, next try in ${seconds} s`,
  trying: '…',
  offline: "You're offline. We'll reconnect when you're back online.",
  title: 'Reconnecting',
  retryNow: 'Retry now',
  leave: 'Leave',
} as const;

export type FailureExtra = 'quick';
export interface FailureCopy {
  title: (code: string | null) => string;
  body: string | null;
  extras: readonly FailureExtra[];
}

export const FAILURE: Readonly<Record<FailCode, FailureCopy>> = {
  'invalid-code': {
    title: () => "That code doesn't look right",
    body: 'Room codes are 6 characters: digits 0–9 and letters A–F.',
    extras: [],
  },
  'room-not-found': {
    title: (code) => (code === null ? "That room doesn't exist" : `Room ${code} doesn't exist`),
    body: 'It may have finished, or the code is wrong.',
    extras: ['quick'],
  },
  'room-full': {
    title: (code) => (code === null ? 'That room is full' : `Room ${code} is full`),
    body: 'All four seats are taken.',
    extras: ['quick'],
  },
  'room-closing': {
    title: () => 'That match just ended',
    body: null,
    extras: ['quick'],
  },
  'server-full': {
    title: () => 'The server is busy',
    body: 'Too many rooms are open right now. Try again in a minute.',
    extras: [],
  },
  'session-busy': {
    title: () => 'Your previous connection is still open',
    body: "The server hasn't noticed it closed yet. Keep waiting, or join as a new player (your score starts from the room average).",
    extras: [],
  },
  unreachable: {
    title: () => "Can't reach the server",
    body: "Check your connection. We'll try again when you're back online.",
    extras: [],
  },
  'room-lost': {
    title: () => 'The room closed while you were away',
    body: null,
    extras: ['quick'],
  },
  'seat-taken': {
    title: () => 'Your seat was given to another player',
    body: 'The room is still running, but all four seats are taken.',
    extras: ['quick'],
  },
  protocol: {
    title: () => 'Something went wrong talking to the server',
    body: null,
    extras: [],
  },
  unknown: {
    title: () => "Couldn't join the room",
    body: null,
    extras: [],
  },
};

export const FAILURE_ACTION = {
  keepWaiting: 'Keep waiting',
  tryAgain: 'Try again',
  joinAsNew: 'Join as new player',
  quick: 'Quick Play',
  home: 'Home',
  serverSaid: (reason: string) => `Server said: ${reason}`,
} as const;

export const LOBBY = {
  title: 'Lobby',
  waitingForPlayers: 'Waiting for players — press Ready when you are',
  waitingForMore: (n: number) => `Waiting for ${n} more to ready up`,
  everyoneReady: "Everyone's ready!",
  roomCode: 'Room code',
  copy: 'Copy',
  copied: 'Copied',
  copyFailed: "Couldn't copy the code",
  share: 'Share',
  shareTitle: 'Join my PonGo match',
  ready: 'Ready!',
  notReady: 'Click to Ready',
  connecting: 'Connecting…',
  you: '(You)',
  seatReady: 'READY',
  seatWaiting: 'WAITING',
  seatReconnecting: 'RECONNECTING…',
  emptySeat: 'Waiting for player…',
  seats: 'Players',
  leave: 'Leave',
} as const;

export const COUNTDOWN = {
  label: 'Countdown',
  startingIn: 'Starting in',
  starting: 'Starting…',
  notReady: 'Not ready',
} as const;

export const HUD = {
  title: 'Game',
  scores: 'Scores',
  you: 'You',
  roomPill: (code: string) => `Room ${code}`,
  copyCode: 'Copy room code',
  unstable: 'Connection unstable',
  soundOff: 'Sound off — tap to enable',
  graceLeft: (seconds: number) => `${seconds} s to reconnect`,
  unknownScore: '–',
} as const;

export const RESULTS = {
  title: 'Game over',
  wins: (name: string) => `${name} wins!`,
  tie: "It's a tie!",
  derived: "Final results reconstructed — the server's final message didn't arrive.",
  unavailable: 'Final scores are not available.',
  quickAgain: 'Quick play again',
  backToMenu: 'Back to menu',
  you: '(You)',
  left: '(left)',
  winner: 'Winner',
  scores: 'Final scores',
} as const;

export const LEAVE_CONFIRM = {
  title: 'Leave the match?',
  body: 'Your seat is held for 30 seconds. You can rejoin from the home screen.',
  leave: 'Leave',
  stay: 'Stay',
} as const;

export const GRAPHICS = {
  paused: 'Graphics paused — restoring…',
  body: 'Graphics stopped responding. Your game continues; scores are still shown.',
  reload: 'Reload',
} as const;

export const ANNOUNCE = {
  joined: (code: string, name: string) => `Joined room ${code} as ${name}.`,
  countdownStarted: 'Countdown started.',
  gameStarted: 'Game started.',
  connectionLost: 'Connection lost, reconnecting.',
  reconnected: 'Reconnected.',
  gameOverWins: (name: string) => `Game over. ${name} wins.`,
  gameOverTie: "Game over. It's a tie.",
} as const;
