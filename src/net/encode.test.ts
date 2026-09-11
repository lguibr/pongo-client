import { afterEach, describe, expect, it, vi } from 'vitest';
import { encode } from './encode';
import type { RoomCode } from '../session/types';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('encode', () => {
  it('builds the exact wire strings the server reads', () => {
    expect(encode.createRoom(true, 'sid-1')).toBe('{"messageType":"createRoom","isPublic":true,"sessionId":"sid-1"}');
    expect(encode.createRoom(false, 'sid-1')).toBe('{"messageType":"createRoom","isPublic":false,"sessionId":"sid-1"}');
    expect(encode.joinRoom('AB12CD' as RoomCode, 'sid-2')).toBe('{"messageType":"joinRoom","code":"AB12CD","sessionId":"sid-2"}');
    expect(encode.quickPlay('sid-3')).toBe('{"messageType":"quickPlay","sessionId":"sid-3"}');
    expect(encode.playerReady(true)).toBe('{"messageType":"playerReady","isReady":true}');
    expect(encode.playerReady(false)).toBe('{"messageType":"playerReady","isReady":false}');
  });

  it('matches the byte format recorded from the previous client', () => {
    // Taken from src/test/fixtures/rejections.jsonl (client C's first frame).
    const recorded = '{"messageType":"joinRoom","code":"FFFFFF","sessionId":"bc58bf56f44e435e9499ae0c93947837"}';
    expect(encode.joinRoom('FFFFFF' as RoomCode, 'bc58bf56f44e435e9499ae0c93947837')).toBe(recorded);
  });

  it('escapes a session id that needs it', () => {
    expect(JSON.parse(encode.quickPlay('a"b\\c'))).toEqual({ messageType: 'quickPlay', sessionId: 'a"b\\c' });
  });

  it('returns the three direction messages without serialising at call time', () => {
    const stringify = vi.spyOn(JSON, 'stringify');
    expect(encode.direction('ArrowLeft')).toBe('{"messageType":"direction","direction":"ArrowLeft"}');
    expect(encode.direction('ArrowRight')).toBe('{"messageType":"direction","direction":"ArrowRight"}');
    expect(encode.direction('Stop')).toBe('{"messageType":"direction","direction":"Stop"}');
    expect(stringify).not.toHaveBeenCalled();
  });
});
