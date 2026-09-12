/** @vitest-environment jsdom */
// RoomScreen (9.3, D33) and the routes around it (9.1, 12.3). The stage is the real GameStage: in jsdom its Canvas
// measures 0x0, so fiber never creates a renderer, but the <canvas> element exists, and its identity shows whether
// the stage was remounted.

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import type { NavigateFunction } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppProvider } from '../../app/AppContext';
import type { App as AppApi } from '../../app/types';
import { createSessionRuntime } from '../../session/runtime';
import type { CloseCode, IdentityApi, SessionApi, TransportLike, TransportSink } from '../../session/types';
import type { GameRuntime } from '../../game/types';
import { createStore } from '../../lib/store';
import { initialAppState } from '../../state/appStore';
import type { SessionView } from '../../state/appStore';
import type { RoomCode } from '../../session/types';
import { T } from '../../config/tuning';
import { FakeClock } from '../../test/fakes/FakeClock';
import { createFakeApp, fakeAudio, fakeGame, fakeInput, fakePwa, fakeSession } from '../../test/fakes/fakeApp';

const h = vi.hoisted(() => ({ notFoundThrows: false }));

vi.mock('@vercel/analytics/react', () => ({ Analytics: () => null }));
vi.mock('@vercel/speed-insights/react', () => ({ SpeedInsights: () => null }));
// A NotFound that can be told to crash, to reach the root error boundary through a real route.
vi.mock('../NotFound', async () => {
  const { createElement } = await import('react');
  return {
    default: function NotFound(): JSX.Element {
      if (h.notFoundThrows) throw new Error('not-found exploded');
      return createElement('h1', null, 'Page not found');
    },
  };
});

import App from '../../App';
import RoomScreen from './RoomScreen';

const CODE = 'ABC123' as RoomCode;

// ---- a real session runtime over a scripted transport ----

class ScriptedTransport implements TransportLike {
  sink: TransportSink | null = null;
  readonly opens: number[] = [];
  readonly closes: Array<{ gen: number; code: CloseCode }> = [];
  currentGen = 0;
  isOpen = false;

  setSink(sink: TransportSink): void {
    this.sink = sink;
  }

  open(gen: number): void {
    this.opens.push(gen);
    this.currentGen = gen;
    this.isOpen = false;
  }

  send(gen: number): boolean {
    return gen === this.currentGen && this.isOpen;
  }

  close(gen: number, code: CloseCode): void {
    this.closes.push({ gen, code });
    if (gen === this.currentGen) this.isOpen = false;
  }

  accept(): void {
    this.isOpen = true;
    this.sink?.open(this.currentGen);
  }

  deliver(msg: object): void {
    this.sink?.frame(this.currentGen, JSON.stringify(msg), 0);
  }

  drop(): void {
    this.isOpen = false;
    this.sink?.closed(this.currentGen, { code: 1006, reason: '', wasClean: false });
  }
}

const identity: IdentityApi = {
  ready: Promise.resolve(), current: () => 'sid-test', rotate: () => {}, hasPrevious: () => false,
  restorePrevious: () => false, onPageHide: () => {}, onPageShow: () => Promise.resolve(),
};

interface Live { clock: FakeClock; transport: ScriptedTransport; session: SessionApi; app: AppApi }

async function liveSession(game: GameRuntime = fakeGame()): Promise<Live> {
  const clock = new FakeClock(10_000);
  const transport = new ScriptedTransport();
  const store = createStore(initialAppState());
  const session = createSessionRuntime({
    transport, game, input: fakeInput(), audio: fakeAudio(), identity, store,
    wsUrl: () => 'ws://test.invalid/subscribe', timers: clock, now: clock.now, rand: () => 0.5,
  });
  await Promise.resolve(); // identity.ready settles, so opens reach the transport synchronously
  await Promise.resolve();
  return { clock, transport, session, app: createFakeApp({ store, session, game }) };
}

const JOINED = { messageType: 'roomJoined', success: true, roomPID: 'pid', code: CODE, phase: 'playing', reason: '' };
const ASSIGNED = { messageType: 'playerAssignment', playerIndex: 0, phase: 'playing' };
const INITIAL = { messageType: 'initialPlayersAndBallsState', players: [], paddles: [], balls: [] };

// ---- rendering ----

function sv(p: Partial<SessionView>): SessionView {
  return { ...initialAppState().session, code: CODE, myIndex: 0, roomKnown: true, gen: 1, epoch: 1, ...p };
}

function renderRoom(app: AppApi, path = '/room/ABC123'): ReturnType<typeof render> {
  return render(
    <AppProvider app={app}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/room/:code?" element={<RoomScreen />} />
        </Routes>
      </MemoryRouter>
    </AppProvider>,
  );
}

interface Where { path: string; nav: NavigateFunction | null }

function Probe({ out }: { out: Where }): null {
  const location = useLocation();
  const nav = useNavigate();
  out.path = location.pathname;
  out.nav = nav;
  return null;
}

function renderApp(path: string, app: AppApi): Where {
  const where: Where = { path: '', nav: null };
  render(
    <AppProvider app={app}>
      <MemoryRouter initialEntries={[path]}>
        <App />
        <Probe out={where} />
      </MemoryRouter>
    </AppProvider>,
  );
  return where;
}

afterEach(() => {
  cleanup();
  h.notFoundThrows = false;
  vi.restoreAllMocks();
});

describe('RoomScreen keeps one canvas per room (D33)', () => {
  it('through every stage mode of a drop and rejoin, and drops it only when the mode becomes none', () => {
    const app = createFakeApp({ state: { session: sv({ s: 'playing', worldReady: true, stageRetained: true }) } });
    const { container } = renderRoom(app);
    const canvas = container.querySelector('canvas');
    expect(canvas).not.toBeNull();
    const frozen = (): boolean => container.querySelector('[data-frozen]') !== null;
    expect(frozen()).toBe(false);

    const steps: Array<[Partial<SessionView>, boolean]> = [
      [{ s: 'reconnecting', worldReady: true, attempt: 0, nextAt: 1_000_000, cause: 'closed' }, true],
      [{ s: 'connecting', worldReady: true, attempt: 1 }, true],
      [{ s: 'requesting', worldReady: true, attempt: 1 }, true],
      [{ s: 'playing', worldReady: false, epoch: 2 }, true],   // admitted again, the new board not ready yet
      [{ s: 'playing', worldReady: true, epoch: 2 }, false],
    ];
    for (const [p, isFrozen] of steps) {
      act(() => app.store.patch({ session: sv({ stageRetained: true, ...p }) }));
      expect(container.querySelector('canvas')).toBe(canvas);
      expect(canvas?.isConnected).toBe(true);
      expect(frozen()).toBe(isFrozen);
    }

    const failure = { code: 'room-lost' as const, serverReason: null, retryable: true, canJoinAsNew: false, autoRetryOnOnline: false };
    act(() => app.store.patch({ session: sv({ s: 'failed', failure, worldReady: false, stageRetained: false }) }));
    expect(container.querySelector('canvas')).toBeNull();
  });

  it('from the lobby through the countdown and play to the end, and drops it when the end has no board', () => {
    const app = createFakeApp({ state: { session: sv({ s: 'lobby', worldReady: true, stageRetained: true }) } });
    const { container } = renderRoom(app);
    const canvas = container.querySelector('canvas');
    expect(canvas).not.toBeNull();

    for (const s of ['countdown', 'playing', 'finished'] as const) {
      act(() => app.store.patch({ session: sv({ s, worldReady: true, stageRetained: true }) }));
      expect(container.querySelector('canvas')).toBe(canvas);
      expect(canvas?.isConnected).toBe(true);
      expect(container.querySelector('[data-frozen]')).toBeNull();
    }

    act(() => app.store.patch({ session: sv({ s: 'finished', worldReady: false, stageRetained: false }) }));
    expect(container.querySelector('canvas')).toBeNull();
  });

  it('through a real drop and rejoin driven by the session runtime', async () => {
    const game: GameRuntime = { ...fakeGame(), ingest: () => ({ controls: [], ticks: 0, boardReady: true }) };
    const { clock, transport, session, app } = await liveSession(game);
    const { container } = renderRoom(app);
    const admit = (): void => {
      act(() => transport.accept());
      act(() => transport.deliver(JOINED));
      act(() => transport.deliver(ASSIGNED));
    };

    expect(transport.opens).toEqual([1]);
    admit();
    expect(session.getModel().state.s).toBe('playing');
    expect(container.querySelector('canvas')).toBeNull(); // no board yet, nothing retained: stage mode none
    act(() => transport.deliver(INITIAL));
    const canvas = container.querySelector('canvas');
    expect(canvas).not.toBeNull();

    act(() => transport.drop());
    expect(session.getModel().state.s).toBe('reconnecting');
    expect(app.store.get().session.stageRetained).toBe(true);
    expect(container.querySelector('canvas')).toBe(canvas);

    act(() => clock.advance(T.session.firstRetryMaxMs));
    expect(transport.opens).toEqual([1, 2]);
    expect(container.querySelector('canvas')).toBe(canvas);

    admit();
    expect(session.getModel().state.s).toBe('playing');
    expect(app.store.get().session.worldReady).toBe(false);
    expect(screen.getByText('Rejoining room ABC123…')).toBeTruthy();
    expect(container.querySelector('canvas')).toBe(canvas);

    act(() => transport.deliver(INITIAL));
    expect(app.store.get().session.worldReady).toBe(true);
    expect(container.querySelector('canvas')).toBe(canvas);
    expect(container.querySelectorAll('canvas')).toHaveLength(1);
    expect(container.querySelector('[data-frozen]')).toBeNull();
  });

  it('an invalid code renders FailureView{invalid-code} and opens no socket', async () => {
    const { transport, session, app } = await liveSession();
    const { container } = renderRoom(app, '/room/zzz');
    expect(screen.getByRole('heading', { name: "That code doesn't look right" })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Home' })).toBeTruthy();
    expect(container.querySelector('canvas')).toBeNull();
    expect(transport.opens).toEqual([]);
    expect(session.getModel().state.s).toBe('idle');
  });
});

describe('App routes (9.1)', () => {
  it.each(['/game/ABC123', '/lobby/ABC123'])('%s redirects to /room/ABC123 and binds that room', async (path) => {
    const bindRoute = vi.fn<SessionApi['bindRoute']>(() => () => {});
    const notifyRoute = vi.fn();
    const app = createFakeApp({ session: { ...fakeSession(), bindRoute }, pwa: { ...fakePwa(), notifyRoute } });
    const where = renderApp(path, app);
    expect(where.path).toBe('/room/ABC123');
    await waitFor(() => expect(bindRoute).toHaveBeenCalledWith(CODE, expect.any(String)));
    expect(notifyRoute).toHaveBeenLastCalledWith('/room/ABC123');
  });

  it('/game/zzz ends in FailureView{invalid-code} and opens no socket', async () => {
    const { transport, session, app } = await liveSession();
    const where = renderApp('/game/zzz', app);
    expect(await screen.findByRole('heading', { name: "That code doesn't look right" })).toBeTruthy();
    expect(where.path).toBe('/room/zzz');
    expect(transport.opens).toEqual([]);
    expect(session.getModel().state.s).toBe('idle');
  });

  it.each(['/lobby/create', '/lobby/quickplay'])('%s goes home and starts nothing', (path) => {
    const start = vi.fn();
    const bindRoute = vi.fn<SessionApi['bindRoute']>(() => () => {});
    const app = createFakeApp({ session: { ...fakeSession(), start, bindRoute } });
    const where = renderApp(path, app);
    expect(where.path).toBe('/');
    expect(start).not.toHaveBeenCalled();
    expect(bindRoute).not.toHaveBeenCalled();
  });

  it('reports every pathname change to the PWA apply policy, once each', () => {
    const notifyRoute = vi.fn();
    const app = createFakeApp({ pwa: { ...fakePwa(), notifyRoute } });
    const where = renderApp('/', app);
    expect(notifyRoute.mock.calls).toEqual([['/']]);
    act(() => where.nav?.('/nowhere'));
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeTruthy();
    act(() => where.nav?.('/nowhere?again=1')); // same pathname: not reported again
    act(() => where.nav?.('/'));
    expect(notifyRoute.mock.calls).toEqual([['/'], ['/nowhere'], ['/']]);
  });

  it('a crash leaves the session and suppresses the sound; the navigation that clears it lifts the suppression', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const leave = vi.fn();
    const setSuppressed = vi.fn();
    const setHidden = vi.fn();
    const app = createFakeApp({ session: { ...fakeSession(), leave }, audio: { ...fakeAudio(), setSuppressed, setHidden } });
    const where = renderApp('/', app);

    h.notFoundThrows = true;
    act(() => where.nav?.('/boom'));
    expect(screen.getByRole('heading', { name: 'Something went wrong' })).toBeTruthy();
    expect(leave).toHaveBeenCalledWith({ explicit: false });
    expect(setSuppressed.mock.calls).toEqual([[true]]);

    h.notFoundThrows = false;
    act(() => where.nav?.('/elsewhere'));
    expect(screen.queryByRole('heading', { name: 'Something went wrong' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeTruthy();
    expect(setSuppressed.mock.calls).toEqual([[true], [false]]);
    expect(setHidden).not.toHaveBeenCalled(); // the page's hidden state is the lifecycle's alone
  });

  it('?debug=1 lazy-loads the debug overlay, and its lead toggle drives game.setOwnLead', async () => {
    const setOwnLead = vi.fn();
    const app = createFakeApp({ game: { ...fakeGame(), setOwnLead } });
    renderApp('/?debug=1', app);
    const lead = await screen.findByRole('checkbox', { name: /own-paddle lead/i });
    expect(screen.getByRole('region', { name: 'Debug overlay' })).toBeTruthy();
    expect((lead as HTMLInputElement).checked).toBe(T.ownLead.enabled);
    fireEvent.click(lead);
    expect(setOwnLead).toHaveBeenLastCalledWith(!T.ownLead.enabled);
    fireEvent.click(lead);
    expect(setOwnLead).toHaveBeenLastCalledWith(T.ownLead.enabled);
  });

  it('without ?debug=1 there is no debug overlay', async () => {
    renderApp('/', createFakeApp());
    expect(screen.getByRole('heading', { name: 'Create room' })).toBeTruthy();
    // A lazy load requested by mistake gets time to resolve and render before its absence is asserted.
    await act(async () => {
      await import('../../dev/DebugOverlay');
      await new Promise((done) => setTimeout(done, 0));
    });
    expect(screen.queryByRole('region', { name: 'Debug overlay' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Create room' })).toBeTruthy();
  });
});

// Last in the file: it swaps the module registry for a fresh App whose overlay chunk cannot load.
describe('debug overlay containment', () => {
  it('an overlay chunk that fails to load is logged, and the app keeps running', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.resetModules();
    vi.doMock('../../dev/DebugOverlay', () => {
      throw new Error('chunk gone');
    });
    try {
      const { default: FreshApp } = await import('../../App');
      const { AppProvider: FreshProvider } = await import('../../app/AppContext');
      render(
        <FreshProvider app={createFakeApp()}>
          <MemoryRouter initialEntries={['/?debug=1']}>
            <FreshApp />
          </MemoryRouter>
        </FreshProvider>,
      );
      await waitFor(() => expect(warn).toHaveBeenCalledWith('[pongo]', 'debug overlay failed to load', expect.anything()));
      await act(async () => {
        await new Promise((done) => setTimeout(done, 0));
      });
      expect(screen.getByRole('heading', { name: 'Create room' })).toBeTruthy();
      expect(screen.queryByRole('region', { name: 'Debug overlay' })).toBeNull();
      expect(screen.queryByRole('heading', { name: 'Something went wrong' })).toBeNull();
    } finally {
      vi.doUnmock('../../dev/DebugOverlay');
    }
  });
});
