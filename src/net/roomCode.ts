// Room code validation and room paths (C100, C101). Codes are 3 random bytes in upper-case hex
// (pongo/game/room_manager.go:42-48), and the server matches them exactly, so a lower-case code is upper-cased
// here rather than rejected there.

import { ROOM_CODE_RE } from '../config/constants';
import type { RoomCode } from '../session/types';

/** trim, upper-case, then ROOM_CODE_RE; null when invalid. */
export function normalizeRoomCode(raw: string | null | undefined): RoomCode | null {
  if (typeof raw !== 'string') return null;
  const code = raw.trim().toUpperCase();
  return ROOM_CODE_RE.test(code) ? (code as RoomCode) : null;
}

/** '/room' or '/room/' + encodeURIComponent(code). */
export function roomPath(code: RoomCode | null): string {
  return code === null ? '/room' : '/room/' + encodeURIComponent(code);
}
