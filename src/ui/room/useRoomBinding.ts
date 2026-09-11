// Idempotent route binding (9.3, D22, C44, C100, C101). The URL is the room's address and the session is the
// truth; this hook keeps them agreeing without ever opening a second socket.
//
// - An invalid code in the URL is reported as `invalid`, and the caller renders FailureView{invalid-code}.
//   Nothing is bound, so no socket opens.
// - A valid code binds with session.bindRoute(code, ROUTE_KEY). The key is a module constant, not useId: exactly
//   one `/room/:code?` route element exists, and a useId key changes whenever the screen remounts. With one
//   key, StrictMode's simulated unmount and remount, a change of the route param, and a remounted screen (Fast
//   Refresh, a new React key) all re-bind with the same key and cancel the deferred leave that the unbind
//   scheduled. Only a real unmount leaves, one macrotask later.
// - No code while idle (a reload of /room) goes home. No code otherwise binds null, which keeps the create or
//   quick play in flight.
// - URL sync: once the session knows its room code and it differs from the URL, the URL is replaced with it.

import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../../app/AppContext';
import { useAppState } from '../../state/hooks';
import type { AppState } from '../../state/appStore';
import { normalizeRoomCode, roomPath } from '../../net/roomCode';

/** The binding key of the one room route (9.3, amended): shared by every RoomScreen instance, so a remount's
 *  bind cancels the previous instance's deferred leave. */
const ROUTE_KEY = 'room-route';

const selectIdle = (s: AppState): boolean => s.session.s === 'idle';
const selectCode = (s: AppState): string | null => s.session.code;

export function useRoomBinding(codeParam: string | undefined): { invalid: boolean } {
  const { session, store } = useApp();
  const navigate = useNavigate();
  const idle = useAppState(selectIdle);
  const sessionCode = useAppState(selectCode);
  const hasParam = codeParam !== undefined && codeParam !== '';
  const code = hasParam ? normalizeRoomCode(codeParam) : null;
  const invalid = hasParam && code === null;

  useEffect(() => (code === null ? undefined : session.bindRoute(code, ROUTE_KEY)), [session, code]);

  useEffect(() => {
    // Read when binding, not when rendering: a start dispatched just before navigating to /room is already in
    // the model, while an idle session is sent home by the effect below and binds nothing.
    if (hasParam || store.get().session.s === 'idle') return undefined;
    return session.bindRoute(null, ROUTE_KEY);
  }, [session, store, hasParam]);

  useEffect(() => {
    if (!hasParam && idle) navigate('/', { replace: true });
  }, [hasParam, idle, navigate]);

  useEffect(() => {
    if (invalid || sessionCode === null) return;
    // The live view, not the rendered one: a bind earlier in this same commit may already have moved the session
    // to the URL's code, and syncing to the stale code would bounce the URL back.
    const live = store.get().session;
    if (live.s === 'idle' || live.code === null || live.code === codeParam) return;
    navigate(roomPath(live.code), { replace: true });
  }, [invalid, sessionCode, codeParam, store, navigate]);

  return { invalid };
}
