// Builders for the five client messages (4.1, 4.4). Keys follow the order of the ClientMessage type, which is
// also the order the previous client sent. The three direction messages are serialised once, at module load,
// because the input controller sends them at up to 30 per second.

import type { ClientMessage, WireDirection } from '../protocol/messages';
import type { RoomCode } from '../session/types';

const serialise = (msg: ClientMessage): string => JSON.stringify(msg);

const DIRECTION: Readonly<Record<WireDirection, string>> = {
  ArrowLeft: serialise({ messageType: 'direction', direction: 'ArrowLeft' }),
  ArrowRight: serialise({ messageType: 'direction', direction: 'ArrowRight' }),
  Stop: serialise({ messageType: 'direction', direction: 'Stop' }),
};

export const encode: {
  createRoom(isPublic: boolean, sessionId: string): string;
  joinRoom(code: RoomCode, sessionId: string): string;
  quickPlay(sessionId: string): string;
  playerReady(isReady: boolean): string;
  direction(d: WireDirection): string; // returns one of 3 pre-serialised constants
} = {
  createRoom: (isPublic, sessionId) => serialise({ messageType: 'createRoom', isPublic, sessionId }),
  joinRoom: (code, sessionId) => serialise({ messageType: 'joinRoom', code, sessionId }),
  quickPlay: (sessionId) => serialise({ messageType: 'quickPlay', sessionId }),
  playerReady: (isReady) => serialise({ messageType: 'playerReady', isReady }),
  direction: (d) => DIRECTION[d],
};
