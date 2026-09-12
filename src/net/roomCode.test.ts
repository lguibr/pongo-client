import { describe, expect, it } from 'vitest';
import { normalizeRoomCode, roomPath } from './roomCode';
import type { RoomCode } from '../session/types';

describe('normalizeRoomCode', () => {
  it('upper-cases and trims a valid code', () => {
    expect(normalizeRoomCode('ab12cd')).toBe('AB12CD');
    expect(normalizeRoomCode('  7d8e8f \n')).toBe('7D8E8F');
    expect(normalizeRoomCode('FFFFFF')).toBe('FFFFFF');
  });

  it('rejects anything that is not six hex characters', () => {
    expect(normalizeRoomCode('AB/123')).toBeNull();
    expect(normalizeRoomCode('ABC1234')).toBeNull(); // 7 characters
    expect(normalizeRoomCode('ABC12')).toBeNull(); // 5 characters
    expect(normalizeRoomCode('GGGGGG')).toBeNull(); // not hex
    expect(normalizeRoomCode('AB 123')).toBeNull(); // inner space
    expect(normalizeRoomCode('')).toBeNull();
    expect(normalizeRoomCode('   ')).toBeNull();
  });

  it('rejects null and undefined', () => {
    expect(normalizeRoomCode(null)).toBeNull();
    expect(normalizeRoomCode(undefined)).toBeNull();
  });
});

describe('roomPath', () => {
  it('gives /room without a code', () => {
    expect(roomPath(null)).toBe('/room');
  });

  it('appends a code', () => {
    expect(roomPath('AB12CD' as RoomCode)).toBe('/room/AB12CD');
  });

  it('encodes characters that are not safe in a path segment', () => {
    expect(roomPath('A B/?#' as RoomCode)).toBe('/room/A%20B%2F%3F%23');
  });
});
