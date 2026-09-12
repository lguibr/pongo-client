// Routes and shell (9.1, D22, D23, 12.3; C35, C36, C39, C44). The root error boundary sits inside the router
// because it reads the location: a new location key clears a shown error. That key is a prop, never a React key,
// so navigation never remounts the shell. The landing and not-found screens render in StrictMode; the room screen
// puts only its foreground there, never the canvas (D22). The room route is lazy, so three, fiber,
// postprocessing and the effects load only in a room. Every pathname change is reported to the PWA apply
// policy (5.14).

import { StrictMode, Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import type { ComponentType } from 'react';
import { Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { Analytics } from '@vercel/analytics/react';
import { SpeedInsights } from '@vercel/speed-insights/react';
import { useApp } from './app/AppContext';
import { log } from './lib/log';
import { RootErrorBoundary } from './ui/RootErrorBoundary';
import { AppShell } from './ui/layout/AppShell';
import LandingScreen from './ui/landing/LandingScreen';
import NotFound from './ui/NotFound';
import { ConnectingView } from './ui/room/ConnectingView';
import { IDLE_CONNECTING } from './ui/room/roomView';

const RoomScreen = lazy(() => import('./ui/room/RoomScreen'));
// The overlay renders outside the root error boundary, so a chunk that fails to load (a deploy since the page
// loaded) or to evaluate becomes an absent overlay rather than an unmounted root.
const DebugOverlay = lazy((): Promise<{ default: ComponentType }> =>
  import('./dev/DebugOverlay').catch((err: unknown) => {
    log.warn('debug overlay failed to load', err);
    return { default: (): null => null };
  }),
);

/** Legacy links (C35). react-router resolves `to` literally, so the param is substituted here. The code is passed
 *  through unvalidated: useRoomBinding validates it, so a bad legacy code still ends in FailureView{invalid-code}. */
function LegacyRoomRedirect(): JSX.Element {
  const { code = '' } = useParams();
  return <Navigate replace to={'/room/' + encodeURIComponent(code)} />;
}

const debugRequested = (search: string): boolean => new URLSearchParams(search).get('debug') === '1';

export default function App(): JSX.Element {
  const app = useApp();
  const location = useLocation();
  // Read once: the flag stays on after the first navigation drops the query string.
  const [debug] = useState(() => debugRequested(location.search));
  // The key of the render that crashed, while the error screen shows. RootErrorBoundary clears its error when the
  // key moves on, and so does the crash mute below.
  const crashedAt = useRef<string | null>(null);

  useEffect(() => {
    app.pwa.notifyRoute(location.pathname);
  }, [app, location.pathname]);

  // On a crash the session is left, so a reset never rebinds a finished room (T2), and the sound goes quiet. The
  // mute is the engine's own suppression flag, not setHidden, so a visibility change while the error screen shows
  // cannot bring the sound back. The key comes from this closure: componentDidCatch calls the boundary's committed
  // onError, so it is the key of the render that committed, never that of a transition render that was discarded.
  const onError = useCallback(() => {
    crashedAt.current = location.key;
    app.session.leave({ explicit: false });
    app.audio.setSuppressed(true);
  }, [app, location.key]);

  // The navigation that clears the error screen lifts the crash mute. The lifecycle's hidden state, which App never
  // touches, then applies again, so a page hidden meanwhile stays quiet.
  useEffect(() => {
    if (crashedAt.current === null || crashedAt.current === location.key) return;
    crashedAt.current = null;
    app.audio.setSuppressed(false);
  }, [app, location.key]);

  return (
    <>
      <RootErrorBoundary resetKey={location.key} onError={onError}>
        <AppShell>
          <Suspense fallback={<ConnectingView view={IDLE_CONNECTING} />}>
            <Routes>
              <Route path="/" element={<StrictMode><LandingScreen /></StrictMode>} />
              <Route path="/room/:code?" element={<RoomScreen />} />
              <Route path="/lobby/create" element={<Navigate replace to="/" />} />
              <Route path="/lobby/quickplay" element={<Navigate replace to="/" />} />
              <Route path="/lobby/:code" element={<LegacyRoomRedirect />} />
              <Route path="/game/:code" element={<LegacyRoomRedirect />} />
              <Route path="*" element={<StrictMode><NotFound /></StrictMode>} />
            </Routes>
          </Suspense>
        </AppShell>
      </RootErrorBoundary>
      {debug && (
        <Suspense fallback={null}>
          <DebugOverlay />
        </Suspense>
      )}
      <Analytics />
      <SpeedInsights />
    </>
  );
}
