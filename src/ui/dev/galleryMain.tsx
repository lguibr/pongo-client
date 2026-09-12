// UI gallery for ui.html (dev only, not in the build input). Every screen and room view rendered from
// createFakeApp states, so layouts can be checked without a server or the render core.
//
//   ui.html                      index: pick a scenario, see it at 320x568, 390x844, 844x390 and 1440x900
//   ui.html?view=<id>            one scenario, full page (what each index frame loads)
//   &motion=reduced              reduced motion (data-motion and the motion slice)
//
// The index uses iframes because media queries follow the frame's viewport, not a container's size. The
// stage is a flat stand-in for the board: this package must not import the render core.
//
// This is an entry module: it renders and exports nothing, so fast refresh reloads the page instead.
/* eslint-disable react-refresh/only-export-components */

import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import styled from 'styled-components';
import { AppProvider } from '../../app/AppContext';
import type { App } from '../../app/types';
import { createFakeApp, fakeSession } from '../../test/fakes/fakeApp';
import { initialAppState } from '../../state/appStore';
import type { AppState, ResultRow, SeatView, SessionView } from '../../state/appStore';
import { useSession } from '../../state/hooks';
import { SeatConn } from '../../game/events';
import type { Seat } from '../../game/events';
import type { FailCode, Failure, RoomCode, SessionApi } from '../../session/types';
import type { StageMode } from '../../render/contracts';
import { SEATS } from '../../game/orientation';
import { GlobalStyle } from '../GlobalStyle';
import { AppShell } from '../layout/AppShell';
import LandingScreen from '../landing/LandingScreen';
import NotFound from '../NotFound';
import { RoomForeground, RoomLayout } from '../room/RoomLayout';
import { GraphicsFallback } from '../room/GraphicsFallback';
import { stageMode, toRoomView } from '../room/roomView';

const VIEWPORTS: readonly (readonly [number, number])[] = [[320, 568], [390, 844], [844, 390], [1440, 900]];
const CODE = 'A1B2C3' as RoomCode;

// ---- state builders ----

function session(p: Partial<SessionView>): SessionView {
  return {
    ...initialAppState().session,
    code: CODE, myIndex: 0, phase: 'lobby', roomKnown: true, worldReady: true, stageRetained: true, canReady: true,
    gen: 1, epoch: 1, ...p,
  };
}

function seat(index: Seat, conn: SeatConn, p: Partial<SeatView> = {}): SeatView {
  const info = SEATS[index];
  return {
    index, conn, score: conn === SeatConn.Empty ? null : 0, ready: false, isMe: index === 0, graceEndsAt: NaN,
    name: info.name, color: info.color, glyph: info.glyph, ...p,
  };
}

function seats(p: Partial<Record<Seat, SeatView>> = {}): AppState['seats'] {
  return [
    p[0] ?? seat(0, SeatConn.Connected, { ready: true, score: 12 }),
    p[1] ?? seat(1, SeatConn.Connected, { score: 7 }),
    p[2] ?? seat(2, SeatConn.Grace, { score: 3, graceEndsAt: performance.now() + 21_000 }),
    p[3] ?? seat(3, SeatConn.Empty),
  ];
}

function failure(code: FailCode, p: Partial<Failure> = {}): Failure {
  const flags: Partial<Record<FailCode, Partial<Failure>>> = {
    'room-full': { retryable: true }, 'server-full': { retryable: true }, 'session-busy': { retryable: true, canJoinAsNew: true },
    unreachable: { retryable: true, autoRetryOnOnline: true }, 'room-lost': { retryable: true }, protocol: { retryable: true }, unknown: { retryable: true },
  };
  return { code, serverReason: null, retryable: false, canJoinAsNew: false, autoRetryOnOnline: false, ...flags[code], ...p };
}

const RESULT_ROWS: readonly ResultRow[] = [
  { index: 0, score: 18, left: false, isMe: true, winner: true },
  { index: 1, score: 11, left: false, isMe: false, winner: false },
  { index: 2, score: 4, left: true, isMe: false, winner: false },
];

interface Scenario { id: string; title: string; path: string; kind: 'landing' | 'notFound' | 'room'; state: () => Partial<AppState>; graphicsFailed?: boolean }

const FAIL_CODES: readonly FailCode[] = ['invalid-code', 'room-not-found', 'room-full', 'room-closing', 'server-full', 'session-busy',
  'unreachable', 'room-lost', 'seat-taken', 'protocol', 'unknown'];

const SCENARIOS: readonly Scenario[] = [
  { id: 'landing', title: 'Landing', path: '/', kind: 'landing', state: () => ({}) },
  {
    id: 'landing-rejoin', title: 'Landing with rejoin banner', path: '/', kind: 'landing',
    state: () => ({ lastLeft: { code: CODE, at: performance.now(), canRejoin: true }, notices: [{ id: 1, kind: 'placed-in-left-room', text: "You're back in the match you just left, as a new player.", tone: 'info', expiresAt: Infinity }] }),
  },
  { id: 'not-found', title: 'Not found', path: '/nope', kind: 'notFound', state: () => ({}) },
  { id: 'connecting-create', title: 'Connecting: create', path: '/room', kind: 'room', state: () => ({ session: session({ s: 'connecting', intent: { kind: 'create', isPublic: true }, code: null, roomKnown: false, worldReady: false, stageRetained: false, myIndex: null }) }) },
  { id: 'connecting-quick', title: 'Connecting: quick, retrying', path: '/room', kind: 'room', state: () => ({ session: session({ s: 'requesting', intent: { kind: 'quick' }, code: null, roomKnown: false, worldReady: false, stageRetained: false, attempt: 2, myIndex: null }) }) },
  { id: 'connecting-join', title: 'Connecting: join', path: `/room/${CODE}`, kind: 'room', state: () => ({ session: session({ s: 'connecting', intent: { kind: 'join', code: CODE }, roomKnown: false, worldReady: false, stageRetained: false, myIndex: null }) }) },
  { id: 'rejoin', title: 'Rejoining over the frozen board', path: `/room/${CODE}`, kind: 'room', state: () => ({ session: session({ s: 'lobby', worldReady: false, stageRetained: true }), seats: seats() }) },
  { id: 'lobby', title: 'Lobby', path: `/room/${CODE}`, kind: 'room', state: () => ({ session: session({ s: 'lobby' }), seats: seats() }) },
  { id: 'lobby-connecting', title: 'Lobby, Ready disabled', path: `/room/${CODE}`, kind: 'room', state: () => ({ session: session({ s: 'lobby', canReady: false }), seats: seats({ 0: seat(0, SeatConn.Connected) }) }) },
  { id: 'countdown', title: 'Countdown', path: `/room/${CODE}`, kind: 'room', state: () => ({ session: session({ s: 'countdown', phase: 'countingDown' }), seats: seats(), countdown: { seconds: 3, endsAt: performance.now() + 3000 } }) },
  {
    id: 'playing', title: 'Playing HUD (unstable, sound off)', path: `/room/${CODE}`, kind: 'room',
    state: () => ({ session: session({ s: 'playing', phase: 'playing' }), seats: seats(), net: { unstable: true }, audio: { state: 'locked', musicReady: false } }),
  },
  { id: 'playing-update', title: 'Playing with update ready', path: `/room/${CODE}`, kind: 'room', state: () => ({ session: session({ s: 'playing', phase: 'playing' }), seats: seats(), pwa: { updateReady: true } }) },
  {
    id: 'playing-update-sound-off', title: 'Playing: update ready, sound off, a notice', path: `/room/${CODE}`, kind: 'room',
    state: () => ({
      session: session({ s: 'playing', phase: 'playing' }), seats: seats(), pwa: { updateReady: true }, audio: { state: 'locked', musicReady: false },
      notices: [{ id: 1, kind: 'seat-released', text: "Your seat was released — you're back as a new player.", tone: 'warn', expiresAt: Infinity }],
    }),
  },
  {
    id: 'graphics-failed', title: 'Graphics failed: fallback and Reload', path: `/room/${CODE}`, kind: 'room', graphicsFailed: true,
    state: () => ({ session: session({ s: 'playing', phase: 'playing' }), seats: seats(), gfx: { health: 'failed', tier: 'high', stageKey: 0 } }),
  },
  {
    id: 'graphics-paused', title: 'Graphics paused (context lost)', path: `/room/${CODE}`, kind: 'room',
    state: () => ({ session: session({ s: 'playing', phase: 'playing' }), seats: seats(), gfx: { health: 'lost', tier: 'high', stageKey: 0 } }),
  },
  { id: 'reconnecting-frozen', title: 'Reconnecting over the board', path: `/room/${CODE}`, kind: 'room', state: () => ({ session: session({ s: 'reconnecting', attempt: 2, nextAt: performance.now() + 4500, cause: 'closed' }), seats: seats() }) },
  { id: 'reconnecting-attempt', title: 'Reconnecting: attempt in flight (Retry now disabled)', path: `/room/${CODE}`, kind: 'room', state: () => ({ session: session({ s: 'connecting', attempt: 3, cause: 'closed' }), seats: seats() }) },
  { id: 'reconnecting-offline', title: 'Reconnecting, offline, no board', path: `/room/${CODE}`, kind: 'room', state: () => ({ session: session({ s: 'reconnecting', attempt: 1, offline: true, worldReady: false, stageRetained: false }) }) },
  ...FAIL_CODES.map((code): Scenario => ({
    id: `failed-${code}`, title: `Failed: ${code}`, path: `/room/${CODE}`, kind: 'room',
    state: () => ({ session: session({ s: 'failed', worldReady: false, stageRetained: false, failure: failure(code, code === 'room-full' ? { serverReason: 'Room is full' } : {}) }) }),
  })),
  { id: 'finished', title: 'Finished over the board', path: `/room/${CODE}`, kind: 'room', state: () => ({ session: session({ s: 'finished' }), seats: seats(), results: { winner: 0, rows: RESULT_ROWS, reason: 'All bricks destroyed', derived: false } }) },
  { id: 'finished-derived', title: 'Finished, derived tie, no board', path: `/room/${CODE}`, kind: 'room', state: () => ({ session: session({ s: 'finished', worldReady: false }), results: { winner: -1, rows: RESULT_ROWS.map((r) => ({ ...r, winner: false, score: 9 })), reason: '', derived: true } }) },
];

// ---- the fake app ----

function loggingSession(): SessionApi {
  const base = fakeSession();
  const log = (name: string) => (...args: unknown[]): void => console.info(`[gallery] session.${name}`, ...args);
  return {
    ...base,
    start: log('start'), leave: log('leave'), retry: log('retry'), joinAsNew: log('joinAsNew'),
    rejoinPrevious: log('rejoinPrevious'), dismissNotice: log('dismissNotice'),
    setReady: (r) => {
      console.info('[gallery] session.setReady', r);
      return true;
    },
  };
}

function buildApp(sc: Scenario, reduced: boolean): App {
  return createFakeApp({ session: loggingSession(), state: { ...sc.state(), motion: { reduced } } });
}

// ---- stand-in stage ----

const Board = styled.div<{ $dim: number }>`
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: ${({ $dim }) => $dim};

  &::before {
    content: '';
    width: min(86%, 86vh);
    aspect-ratio: 1;
    background-color: #0b0b10;
    background-image: linear-gradient(#1c1c24 1px, transparent 1px), linear-gradient(90deg, #1c1c24 1px, transparent 1px);
    background-size: calc(100% / 18) calc(100% / 18);
    border-style: solid;
    border-width: 6px;
    border-color: #22c55e #3b82f6 #ef4444 #eab308;
  }
`;

function FakeStage({ mode }: { mode: StageMode }): JSX.Element {
  return <Board $dim={mode === 'lobby' ? 0.35 : mode === 'frozen' ? 0.4 : 1} />;
}

function GalleryRoom({ sc }: { sc: Scenario }): JSX.Element {
  const s = useSession();
  const view = toRoomView(s);
  const mode = stageMode(s);
  const stage = mode === 'none' ? null : sc.graphicsFailed ? <GraphicsFallback /> : <FakeStage mode={mode} />;
  return (
    <RoomLayout frozen={mode === 'frozen'} stage={stage}>
      <StrictMode>
        <RoomForeground view={view} mode={mode} />
      </StrictMode>
    </RoomLayout>
  );
}

/** Keeps the countdown cycling 3, 2, 1 so the digit animation can be watched. */
function useCyclingCountdown(app: App): void {
  useEffect(() => {
    if (app.store.get().countdown === null) return;
    const h = window.setInterval(() => app.store.patch({ countdown: { seconds: 3, endsAt: performance.now() + 3000 } }), 3000);
    return () => window.clearInterval(h);
  }, [app]);
}

function ScenarioPage({ sc, reduced }: { sc: Scenario; reduced: boolean }): JSX.Element {
  const [app] = useState(() => buildApp(sc, reduced));
  useCyclingCountdown(app);
  return (
    <AppProvider app={app}>
      <MemoryRouter initialEntries={[sc.path]}>
        <GlobalStyle />
        <AppShell>
          {sc.kind === 'landing' && <StrictMode><LandingScreen /></StrictMode>}
          {sc.kind === 'notFound' && <NotFound />}
          {sc.kind === 'room' && <GalleryRoom sc={sc} />}
        </AppShell>
      </MemoryRouter>
    </AppProvider>
  );
}

// ---- index ----

const Index = styled.div`
  height: 100%;
  overflow: auto;
  padding: 16px;
  font-family: var(--font);
  color: var(--fg);
  background: #111114;

  & header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
    margin-bottom: 16px;
  }
  & select, & label {
    font-size: 1.2rem;
  }
  & select {
    background: #18181b;
    border: 1px solid #27272a;
    padding: 6px;
  }
`;

const Frames = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  align-items: flex-start;
`;

const Frame = styled.figure`
  & figcaption {
    color: #a1a1aa;
    margin-bottom: 4px;
  }
  & > div {
    overflow: hidden;
    border: 1px solid #3f3f46;
  }
  & iframe {
    border: 0;
    transform-origin: top left;
    background: #09090b;
  }
`;

function GalleryIndex(): JSX.Element {
  const params = new URLSearchParams(location.search);
  const [id, setId] = useState(params.get('pick') ?? SCENARIOS[0].id);
  const [reduced, setReduced] = useState(params.get('motion') === 'reduced');
  const query = `?view=${encodeURIComponent(id)}${reduced ? '&motion=reduced' : ''}`;
  return (
    <Index>
      <header>
        <h1 style={{ fontSize: '1.8rem', fontWeight: 400 }}>PonGo UI gallery</h1>
        <select aria-label="Scenario" value={id} onChange={(e) => setId(e.target.value)}>
          {SCENARIOS.map((s) => (
            <option key={s.id} value={s.id}>{s.title}</option>
          ))}
        </select>
        <label>
          <input type="checkbox" checked={reduced} onChange={(e) => setReduced(e.target.checked)} /> Reduced motion
        </label>
        <a href={query} style={{ color: '#60a5fa' }}>Open full page</a>
      </header>
      <Frames>
        {VIEWPORTS.map(([w, h]) => {
          const k = Math.min(1, 420 / w);
          return (
            <Frame key={`${w}x${h}`}>
              <figcaption>{w}×{h}</figcaption>
              <div style={{ width: w * k, height: h * k }}>
                <iframe key={query} title={`${id} at ${w}×${h}`} src={query} width={w} height={h} style={{ transform: `scale(${k})` }} />
              </div>
            </Frame>
          );
        })}
      </Frames>
    </Index>
  );
}

// ---- boot ----

function boot(): void {
  const params = new URLSearchParams(location.search);
  const reduced = params.get('motion') === 'reduced';
  document.documentElement.dataset.motion = reduced ? 'reduced' : 'full';
  const root = document.getElementById('root');
  if (root === null) throw new Error('ui.html has no #root');
  const id = params.get('view');
  const sc = id === null ? null : SCENARIOS.find((s) => s.id === id) ?? null;
  createRoot(root).render(
    sc === null ? (
      <>
        <GlobalStyle />
        <GalleryIndex />
      </>
    ) : (
      <ScenarioPage sc={sc} reduced={reduced} />
    ),
  );
}

boot();
