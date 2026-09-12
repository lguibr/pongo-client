/** @vitest-environment jsdom */
import type { ReactNode } from 'react';
import { Profiler } from 'react';
import { renderToString } from 'react-dom/server';
import { ServerStyleSheet } from 'styled-components';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import type { UseEmblaCarouselType } from 'embla-carousel-react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider } from '../../app/AppContext';
import type { App, PwaApi } from '../../app/types';
import { createFakeApp, fakeAudio, fakeInput, fakePwa, fakeSession } from '../../test/fakes/fakeApp';
import type { FakeAppOverrides } from '../../test/fakes/fakeApp';
import { FakeClock } from '../../test/fakes/FakeClock';
import { initialAppState } from '../../state/appStore';
import type { AppState, GfxHealth, ResultRow, SeatView, SessionView } from '../../state/appStore';
import { Dialog } from '../common/Dialog';
import { LiveAnnouncer } from '../common/LiveAnnouncer';
import { GraphicsFallback } from './GraphicsFallback';
import { useSession } from '../../state/hooks';
import { SeatConn } from '../../game/events';
import type { Seat } from '../../game/events';
import { SEATS } from '../../game/orientation';
import type { AudioEngine } from '../../audio/types';
import type { InputController, JoystickModel } from '../../input/types';
import type { FailCode, Failure, RoomCode, SessionApi } from '../../session/types';
import { GlobalStyle } from '../GlobalStyle';
import { AppShell } from '../layout/AppShell';
import { Header } from '../layout/Header';
import { VolumeControl } from '../layout/VolumeControl';
import LandingScreen from '../landing/LandingScreen';
import { JoinForm } from '../landing/JoinForm';
import { RejoinBanner } from '../landing/RejoinBanner';
import NotFound from '../NotFound';
import { RootErrorBoundary } from '../RootErrorBoundary';
import { UpdateChip } from '../pwa/UpdateChip';
import { AUTOPLAY_MS } from '../common/Carousel';
import { NoticeToasts } from '../common/NoticeToasts';
import { announce } from '../common/LiveAnnouncer';
import { GraceRing } from '../common/SeatBadge';
import { GRAPHICS, HUD } from './copy';
import { CountdownOverlay } from './CountdownOverlay';
import { ConnectingView } from './ConnectingView';
import { FailureView } from './FailureView';
import { COPIED_MS, GameHud } from './GameHud';
import { JoystickZone } from './JoystickZone';
import { LobbyView } from './LobbyView';
import { ReconnectBanner } from './ReconnectBanner';
import { RESULTS_DELAY_MS, ResultsDialog } from './ResultsDialog';
import { RoomForeground, RoomLayout } from './RoomLayout';
import { ScoreBoard } from './ScoreBoard';
import { stageMode, toRoomView } from './roomView';

const CODE = 'ABC123' as RoomCode;

// ---- the autoplay plugin ----

type EmblaApi = NonNullable<UseEmblaCarouselType[1]>;
interface AutoplayProbe {
  options: Record<string, unknown>;
  api: EmblaApi | null;
  play: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  isPlaying(): boolean;
}

const autoplay = vi.hoisted(() => ({ made: [] as AutoplayProbe[] }));

// jsdom has no layout, so embla's own plugin would see a single snap and never initialise. This stand-in
// registers like it, records what the carousel asks of it, and exposes the embla api so tests can emit
// embla's own events (pointerDown and pointerUp are what a swipe emits).
vi.mock('embla-carousel-autoplay', () => ({
  default: (options: Record<string, unknown>) => {
    let playing = false;
    const probe = {
      name: 'autoplay',
      options,
      api: null as EmblaApi | null,
      init(api: EmblaApi): void {
        probe.api = api;
      },
      destroy(): void {
        playing = false;
      },
      play: vi.fn(() => {
        playing = true;
      }),
      stop: vi.fn(() => {
        playing = false;
      }),
      reset: (): void => {},
      isPlaying: (): boolean => playing,
      timeUntilNext: (): null => null,
    };
    autoplay.made.push(probe);
    return probe;
  },
}));

function lastAutoplay(): AutoplayProbe {
  const probe = autoplay.made[autoplay.made.length - 1];
  if (probe === undefined) throw new Error('no autoplay plugin was created');
  return probe;
}

// ---- fixtures ----

function sv(p: Partial<SessionView> = {}): SessionView {
  return { ...initialAppState().session, code: CODE, myIndex: 0, roomKnown: true, gen: 1, epoch: 1, canReady: true, ...p };
}

function seat(index: Seat, conn: SeatConn, p: Partial<SeatView> = {}): SeatView {
  const info = SEATS[index];
  return { index, conn, score: conn === SeatConn.Empty ? null : 0, ready: false, isMe: index === 0, graceEndsAt: NaN, name: info.name, color: info.color, glyph: info.glyph, ...p };
}

function table(p: Partial<Record<Seat, SeatView>> = {}): AppState['seats'] {
  return [
    p[0] ?? seat(0, SeatConn.Connected, { score: 5 }),
    p[1] ?? seat(1, SeatConn.Connected, { score: 3 }),
    p[2] ?? seat(2, SeatConn.Grace, { score: 1, graceEndsAt: performance.now() + 20_000 }),
    p[3] ?? seat(3, SeatConn.Empty),
  ];
}

function failure(code: FailCode, p: Partial<Failure> = {}): Failure {
  return { code, serverReason: null, retryable: false, canJoinAsNew: false, autoRetryOnOnline: false, ...p };
}

function spySession(): SessionApi {
  return {
    ...fakeSession(),
    start: vi.fn(), leave: vi.fn(), retry: vi.fn(), joinAsNew: vi.fn(), rejoinPrevious: vi.fn(),
    setReady: vi.fn(() => true), dismissNotice: vi.fn(),
  };
}

function LocationProbe(): JSX.Element {
  // A plain span: <output> has the implicit role "status", which would collide with the views' status regions.
  return <span data-testid="path">{useLocation().pathname}</span>;
}

interface Setup { app: App; session: SessionApi; path(): string | null; rerender(ui: ReactNode): void; unmount(): void }

function setup(ui: ReactNode, opts: { state?: Partial<AppState>; path?: string } & Omit<FakeAppOverrides, 'state'> = {}): Setup {
  const { state, path = `/room/${CODE}`, ...overrides } = opts;
  const session = overrides.session ?? spySession();
  const app = createFakeApp({ ...overrides, session, state });
  const wrap = (node: ReactNode): JSX.Element => (
    <AppProvider app={app}>
      <MemoryRouter initialEntries={[path]}>
        {node}
        <LocationProbe />
      </MemoryRouter>
    </AppProvider>
  );
  const utils = render(wrap(ui));
  return {
    app, session,
    path: () => screen.getByTestId('path').textContent,
    rerender: (node) => utils.rerender(wrap(node)),
    unmount: utils.unmount,
  };
}

/** The foreground column of 9.3 for whatever the store's session is. */
function StoreForeground(): JSX.Element {
  const s = useSession();
  return <RoomForeground view={toRoomView(s)} mode={stageMode(s)} />;
}

const dialogOpen = (): boolean => document.querySelector('dialog')?.hasAttribute('open') ?? false;
const scoresShown = (): boolean => screen.queryByRole('list', { name: 'Scores' }) !== null;
const buttonLabels = (): string[] => screen.getAllByRole('button').map((b) => b.textContent ?? '');
const h1s = (): (string | null)[] => screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent);

/** Fake timeouts and a fake performance.now (lib/clock reads it), so time-driven views can be stepped. */
function fakeTime(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
}

/** A browser activates a focused button on an Enter keydown unless the keydown is prevented; jsdom does
 *  not, so this does it the same way. */
function pressEnter(el: HTMLElement, repeat: boolean): void {
  if (fireEvent.keyDown(el, { key: 'Enter', repeat })) fireEvent.click(el);
}

const originalMatchMedia = window.matchMedia;
function setViewportWidth(width: number): void {
  window.matchMedia = ((query: string): MediaQueryList => {
    const min = /min-width:\s*(\d+)px/.exec(query);
    return {
      matches: min !== null && width >= Number(min[1]), media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    } as MediaQueryList;
  });
}

beforeEach(() => {
  window.matchMedia = originalMatchMedia;
  autoplay.made.length = 0;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.matchMedia = originalMatchMedia;
});

// ---- 9.3 ----

describe('9.3: every row renders its foreground', () => {
  it('connecting without a room: the intent line and Cancel', () => {
    setup(<StoreForeground />, { state: { session: sv({ s: 'connecting', roomKnown: false, code: null, myIndex: null, intent: { kind: 'create', isPublic: true } }) } });
    expect(screen.getByRole('heading', { name: 'Creating room…' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
    expect(scoresShown()).toBe(false);
  });

  it('requesting a known room with no board: "Joining room ABC123…"', () => {
    setup(<StoreForeground />, { state: { session: sv({ s: 'requesting', intent: { kind: 'join', code: CODE } }) } });
    expect(screen.getByRole('heading', { name: 'Joining room ABC123…' })).toBeTruthy();
  });

  it('connecting with a room and a board: HUD plus the reconnect banner', () => {
    setup(<StoreForeground />, { state: { session: sv({ s: 'connecting', worldReady: true, attempt: 1 }), seats: table() } });
    expect(scoresShown()).toBe(true);
    expect(screen.getByRole('status').textContent).toContain('Connection lost — reconnecting (attempt 1)');
  });

  it('requesting with only a retained stage is the same frozen reconnect', () => {
    setup(<StoreForeground />, { state: { session: sv({ s: 'requesting', stageRetained: true, attempt: 2 }), seats: table() } });
    expect(scoresShown()).toBe(true);
    expect(screen.getByRole('status').textContent).toContain('(attempt 2)');
  });

  it('admitted without a board or retained stage: "Joining room ABC123…"', () => {
    setup(<StoreForeground />, { state: { session: sv({ s: 'lobby' }) } });
    expect(screen.getByRole('heading', { name: 'Joining room ABC123…' })).toBeTruthy();
  });

  it('admitted without a board but with the stage retained: the compact "Rejoining room ABC123…"', () => {
    setup(<StoreForeground />, { state: { session: sv({ s: 'playing', stageRetained: true }) } });
    expect(screen.getByRole('heading', { name: 'Rejoining room ABC123…' })).toBeTruthy();
  });

  it('lobby with a board: the lobby card', () => {
    setup(<StoreForeground />, { state: { session: sv({ s: 'lobby', worldReady: true }), seats: table() } });
    expect(screen.getByRole('heading', { name: 'Lobby' })).toBeTruthy();
    expect(screen.queryByText('Starting in')).toBeNull();
  });

  it('countdown with a board: the lobby card, inert, under the countdown overlay', () => {
    setup(<StoreForeground />, {
      state: { session: sv({ s: 'countdown', worldReady: true }), seats: table(), countdown: { seconds: 3, endsAt: performance.now() + 2500 } },
    });
    expect(screen.getByRole('heading', { name: 'Lobby' }).closest('[inert]')).not.toBeNull();
    expect(screen.getByText('Starting in')).toBeTruthy();
  });

  it('playing with a board: HUD plus the joystick zone', () => {
    setup(<StoreForeground />, { state: { session: sv({ s: 'playing', worldReady: true }), seats: table() } });
    expect(scoresShown()).toBe(true);
    expect(screen.getByTestId('joystick-zone').getAttribute('aria-hidden')).toBe('true');
  });

  it('reconnecting over a board: HUD plus the banner; without one: the banner alone', () => {
    const r = setup(<StoreForeground />, { state: { session: sv({ s: 'reconnecting', worldReady: true, attempt: 1 }), seats: table() } });
    expect(scoresShown()).toBe(true);
    expect(screen.getByRole('status').textContent).toContain('Connection lost');
    act(() => r.app.store.patch({ session: sv({ s: 'reconnecting', attempt: 1 }) }));
    expect(scoresShown()).toBe(false);
    expect(screen.getByRole('status').textContent).toContain('Connection lost');
  });

  it('failed: the failure card', () => {
    setup(<StoreForeground />, { state: { session: sv({ s: 'failed', failure: failure('room-not-found') }) } });
    expect(screen.getByRole('heading', { name: "Room ABC123 doesn't exist" })).toBeTruthy();
  });

  it('finished over a board: HUD, and the results open after 1.2 s', () => {
    vi.useFakeTimers();
    setup(<StoreForeground />, { state: { session: sv({ s: 'finished', worldReady: true }), seats: table(), results: { winner: 0, rows: [], reason: '', derived: false } } });
    expect(scoresShown()).toBe(true);
    expect(dialogOpen()).toBe(false);
    act(() => vi.advanceTimersByTime(RESULTS_DELAY_MS - 1));
    expect(dialogOpen()).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(dialogOpen()).toBe(true);
  });

  it('finished without a board: the results alone, at once', () => {
    setup(<StoreForeground />, { state: { session: sv({ s: 'finished' }), results: { winner: -1, rows: [], reason: '', derived: true } } });
    expect(scoresShown()).toBe(false);
    expect(dialogOpen()).toBe(true);
  });

  it('idle: a neutral connecting card while the binding redirects', () => {
    setup(<StoreForeground />);
    expect(screen.getByRole('heading', { name: 'Connecting…' })).toBeTruthy();
  });

  it('keeps the lobby card mounted into the countdown and makes it inert, and restores it on cancel', () => {
    const r = setup(<StoreForeground />, { state: { session: sv({ s: 'lobby', worldReady: true }), seats: table() } });
    const heading = screen.getByRole('heading', { name: 'Lobby' });
    expect(heading.closest('[inert]')).toBeNull();
    act(() => r.app.store.patch({ session: sv({ s: 'countdown', worldReady: true }), countdown: { seconds: 3, endsAt: performance.now() + 3000 } }));
    expect(screen.getByRole('heading', { name: 'Lobby' })).toBe(heading);
    expect(heading.closest('[inert]')).not.toBeNull();
    expect(document.activeElement?.tagName).not.toBe('BUTTON');
    act(() => r.app.store.patch({ session: sv({ s: 'lobby', worldReady: true }), countdown: null }));
    expect(heading.closest('[inert]')).toBeNull();
  });

  it('every room screen has one h1: the room pill in play and over the frozen board, the bar on its own', () => {
    const r = setup(<StoreForeground />, { state: { session: sv({ s: 'playing', worldReady: true }), seats: table() } });
    expect(h1s()).toEqual(['Room ABC123']);
    act(() => r.app.store.patch({ session: sv({ s: 'reconnecting', worldReady: true, attempt: 1 }) }));
    expect(h1s()).toEqual(['Room ABC123']);
    act(() => r.app.store.patch({ session: sv({ s: 'connecting', stageRetained: true, attempt: 2 }) }));
    expect(h1s()).toEqual(['Room ABC123']);
    act(() => r.app.store.patch({ session: sv({ s: 'reconnecting', attempt: 1 }) }));
    expect(h1s()).toEqual(['Reconnecting']);
  });

  it('RoomLayout desaturates the frozen stage with CSS only on the low tier', () => {
    const r = setup(<RoomLayout frozen stage={<div data-testid="stage" />}><p>fg</p></RoomLayout>, { state: { gfx: { health: 'ok', tier: 'high', stageKey: 0 } } });
    const layer = screen.getByTestId('stage').parentElement as HTMLElement;
    expect(getComputedStyle(layer).filter).toBe('none');
    act(() => r.app.store.patch({ gfx: { health: 'ok', tier: 'low', stageKey: 0 } }));
    expect(getComputedStyle(layer).filter).toContain('grayscale');
  });
});

// ---- pass-through foreground, graphics notice, dialogs, announcements, touch targets ----

/** The rules styled-components injected for `el`'s classes: "@media <query> { <rule> }" inside a media rule,
 *  else the rule's text. jsdom does not evaluate media queries, so tests read the queries from here. */
function rulesFor(el: Element): string[] {
  const classes = Array.from(el.classList);
  const matches = (r: CSSRule): boolean =>
    'selectorText' in r && classes.some((c) => String((r as CSSStyleRule).selectorText).includes(`.${c}`));
  const out: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    for (const rule of Array.from(sheet.cssRules)) {
      if ('media' in rule && 'cssRules' in rule) {
        const media = rule as CSSMediaRule;
        for (const inner of Array.from(media.cssRules)) if (matches(inner)) out.push(`@media ${media.media.mediaText} { ${inner.cssText} }`);
      } else if (matches(rule)) {
        out.push(rule.cssText);
      }
    }
  }
  return out;
}

describe('ResultsDialog inside the pass-through foreground', () => {
  it('takes pointer events: the dialog opts back in from the foreground layer it inherits none from', () => {
    vi.useFakeTimers();
    setup(
      <RoomLayout stage={null} frozen={false}>
        <RoomForeground view={{ kind: 'finished' }} mode="ended" />
      </RoomLayout>,
      { state: { session: sv({ s: 'finished', worldReady: true }), seats: table(), results: { winner: 0, rows: [], reason: '', derived: false } } },
    );
    act(() => vi.advanceTimersByTime(RESULTS_DELAY_MS));
    expect(dialogOpen()).toBe(true);
    const dialog = document.querySelector('dialog') as HTMLDialogElement;
    expect(getComputedStyle(dialog).pointerEvents).toBe('auto');
    expect(getComputedStyle(screen.getByRole('button', { name: 'Back to menu' })).pointerEvents).toBe('auto');
  });
});

describe('graphics notice (5.8, 9.3, 9.5, amended)', () => {
  const gfx = (health: GfxHealth): AppState['gfx'] => ({ health, tier: 'high', stageKey: 0 });
  const layout = (stage: ReactNode): JSX.Element => (
    <RoomLayout frozen={false} stage={stage}>
      <p>fg</p>
    </RoomLayout>
  );

  it('while the context is lost or restoring: "Graphics paused — restoring…", pass-through, and gone once restored', () => {
    const r = setup(layout(<div data-testid="stage" />), { state: { gfx: gfx('lost') } });
    const notice = screen.getByRole('status');
    expect(notice.textContent).toBe('Graphics paused — restoring…');
    expect(getComputedStyle(notice).pointerEvents).toBe('none');
    expect(within(notice).queryByRole('button')).toBeNull();
    act(() => r.app.store.patch({ gfx: gfx('restoring') }));
    expect(screen.getByRole('status')).toBe(notice);
    expect(notice.textContent).toBe(GRAPHICS.paused);
    act(() => r.app.store.patch({ gfx: gfx('ok') }));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows nothing without a mounted stage', () => {
    setup(layout(null), { state: { gfx: gfx('lost') } });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('sits above the HUD (2) and the joystick (1), clear of the bottom rows', () => {
    setup(layout(<div />), { state: { gfx: gfx('lost') } });
    const notice = screen.getByRole('status');
    expect(getComputedStyle(notice).zIndex).toBe('3');
    expect(rulesFor(notice).join('\n')).toMatch(/bottom:\s*calc\(var\(--safe-b\)\s*\+\s*116px\)/);
  });

  it('when graphics fail: the failed text and a Reload that takes pointer events and reloads the page', () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    try {
      const r = setup(layout(<div data-testid="stage" />), { state: { gfx: gfx('failed') } });
      const notice = screen.getByRole('status');
      expect(notice.textContent).toContain(GRAPHICS.body);
      expect(getComputedStyle(notice).pointerEvents).toBe('auto');
      fireEvent.click(within(notice).getByRole('button', { name: 'Reload' }));
      expect(reload).toHaveBeenCalledTimes(1);
      act(() => r.app.store.patch({ gfx: gfx('unsupported') }));
      expect(screen.getByRole('status').textContent).toContain(GRAPHICS.body);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('while StageBoundary shows the fallback: a passive backdrop, with the failed notice over it', () => {
    const r = setup(layout(<GraphicsFallback />), { state: { gfx: gfx('ok') } });
    const fallback = screen.getByTestId('graphics-fallback');
    expect(fallback.getAttribute('aria-hidden')).toBe('true');
    expect(fallback.getAttribute('role')).toBeNull();
    expect(fallback.querySelector('button')).toBeNull();
    expect(fallback.textContent).toBe('');
    const notice = screen.getByRole('status');
    expect(notice.textContent).toContain(GRAPHICS.body);
    expect(within(notice).getByRole('button', { name: 'Reload' })).toBeTruthy();
    expect(getComputedStyle(notice).pointerEvents).toBe('auto');
    r.rerender(layout(<div data-testid="stage" />)); // a new stageKey remounts the stage
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('Header confirm when the room fails', () => {
  it('closes the stale confirm in the commit the room fails, so focus ends on the failure title', () => {
    const r = setup(
      <>
        <Header />
        <StoreForeground />
      </>,
      { state: { session: sv({ s: 'reconnecting', worldReady: true, attempt: 1 }), seats: table() } },
    );
    const home = screen.getByRole('button', { name: 'Home' });
    home.focus();
    fireEvent.click(home);
    expect(dialogOpen()).toBe(true);
    act(() => r.app.store.patch({ session: sv({ s: 'failed', failure: failure('room-lost') }) }));
    expect(dialogOpen()).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1, name: 'The room closed while you were away' }));
  });
});

describe('announcements while a modal dialog is open (C107)', () => {
  function Modal({ id, open }: { id: string; open: boolean }): JSX.Element {
    return (
      <Dialog open={open} labelledBy={id} onCancel={() => {}}>
        <h2 id={id}>{id}</h2>
      </Dialog>
    );
  }
  const regions = (name: string): { polite: HTMLElement; assertive: HTMLElement } => {
    const dialog = screen.getByRole('heading', { name }).closest('dialog') as HTMLElement;
    return { polite: within(dialog).getByTestId('dialog-live-polite'), assertive: within(dialog).getByTestId('dialog-live-assertive') };
  };
  const countingDown = (): Partial<AppState> => ({
    session: sv({ s: 'countdown', worldReady: true }), seats: table(), countdown: { seconds: 3, endsAt: performance.now() + 2500 },
  });

  it('store-driven and direct announcements go into the open dialog, and back to the shell once it closes', () => {
    const tree = (open: boolean): JSX.Element => (
      <>
        <LiveAnnouncer />
        <Modal id="Confirm" open={open} />
      </>
    );
    const r = setup(tree(true), { state: { session: sv({ s: 'lobby', worldReady: true }) } });
    const modal = regions('Confirm');
    expect(modal.polite.getAttribute('aria-live')).toBe('polite');
    expect(modal.assertive.getAttribute('aria-live')).toBe('assertive');
    act(() => r.app.store.patch({ session: sv({ s: 'countdown', worldReady: true }) }));
    expect(modal.assertive.textContent).toBe('Countdown started.');
    expect(screen.getByTestId('live-assertive').textContent).toBe('');
    act(() => announce('Copied'));
    expect(modal.polite.textContent).toBe('Copied');
    expect(screen.getByTestId('live-polite').textContent).toBe('');

    r.rerender(tree(false));
    expect(document.querySelector('dialog [aria-live]')).toBeNull();
    act(() => announce('Copied'));
    expect(screen.getByTestId('live-polite').textContent).toBe('Copied');
  });

  it('the top-most dialog takes them, and the one beneath takes them back when it closes', () => {
    const tree = (second: boolean): JSX.Element => (
      <>
        <LiveAnnouncer />
        <Modal id="First" open />
        <Modal id="Second" open={second} />
      </>
    );
    const r = setup(tree(true));
    act(() => announce('one'));
    expect(regions('Second').polite.textContent).toBe('one');
    expect(regions('First').polite.textContent).toBe('');
    r.rerender(tree(false));
    act(() => announce('two'));
    expect(regions('First').polite.textContent).toBe('two');
    expect(screen.getByTestId('live-polite').textContent).toBe('');
  });

  it('the countdown mirrors each new digit into the open dialog, but not the one shown with "Countdown started."', () => {
    fakeTime();
    setup(
      <>
        <Modal id="Confirm" open />
        <CountdownOverlay />
      </>,
      { state: countingDown() },
    );
    const { assertive } = regions('Confirm');
    expect(assertive.textContent).toBe('');
    act(() => vi.advanceTimersByTime(500));
    expect(assertive.textContent).toBe('2');
    act(() => vi.advanceTimersByTime(1000));
    expect(assertive.textContent).toBe('1');
  });

  it('without a dialog the countdown keeps to its own region', () => {
    fakeTime();
    setup(
      <>
        <LiveAnnouncer />
        <CountdownOverlay />
      </>,
      { state: countingDown() },
    );
    act(() => vi.advanceTimersByTime(500));
    expect(screen.getByTestId('live-assertive').textContent).toBe('');
  });
});

describe('touch pointers (8.2, amended)', () => {
  it('JoystickZone shows on devices with any coarse pointer, not only a coarse primary one', () => {
    setup(<JoystickZone />, { state: { session: sv({ s: 'playing', worldReady: true }) } });
    const css = rulesFor(screen.getByTestId('joystick-zone')).join('\n');
    expect(css).toMatch(/@media\s*\(any-pointer:\s*coarse\)/);
    expect(css).not.toMatch(/@media\s*\(pointer:\s*coarse\)/);
  });

  it('the toasts over the joystick follow the same query', () => {
    const text = 'Rejoined as a new player — your previous connection was still open.';
    setup(<NoticeToasts />, {
      state: { session: sv({ s: 'playing', worldReady: true }), notices: [{ id: 1, kind: 'joined-as-new', text, tone: 'warn', expiresAt: 1e12 }] },
    });
    const css = rulesFor(screen.getByText(text).parentElement as HTMLElement).join('\n');
    expect(css).toMatch(/@media\s*\(any-pointer:\s*coarse\)/);
    expect(css).not.toMatch(/@media\s*\(pointer:\s*coarse\)/);
  });
});

describe('VolumeControl touch target (9.8)', () => {
  it('the slider is a 44 px target in the popover and inline', () => {
    setViewportWidth(390);
    setup(<VolumeControl channel="music" />, { path: '/' });
    fireEvent.click(screen.getByRole('button', { name: 'Music volume' }));
    expect(getComputedStyle(screen.getByRole('slider', { name: 'Music volume' })).height).toBe('44px');
    cleanup();
    setViewportWidth(1024);
    setup(<VolumeControl channel="music" />, { path: '/' });
    expect(getComputedStyle(screen.getByRole('slider', { name: 'Music volume' })).height).toBe('44px');
  });
});

describe('AppShell grid (9.7)', () => {
  it('has one column that cannot grow past the viewport', () => {
    setup(<AppShell><p>content</p></AppShell>);
    const shell = screen.getByRole('main').parentElement as HTMLElement;
    expect(rulesFor(shell).join('\n')).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  });
});

// ---- landing ----

describe('JoinForm (C100)', () => {
  function form(): { onJoin: ReturnType<typeof vi.fn>; input: HTMLInputElement } {
    const onJoin = vi.fn();
    setup(<JoinForm onJoin={onJoin} />, { path: '/' });
    return { onJoin, input: screen.getByLabelText('Room code') as HTMLInputElement };
  }

  it('is a labelled field that upper-cases as the user types', () => {
    const { input } = form();
    expect(input.maxLength).toBe(6);
    expect(input.getAttribute('autocomplete')).toBe('off');
    expect(input.getAttribute('autocapitalize')).toBe('characters');
    expect(input.getAttribute('spellcheck')).toBe('false');
    fireEvent.change(input, { target: { value: 'ab12cd' } });
    expect(input.value).toBe('AB12CD');
  });

  it('submits on Enter: the field sits in a form with a submit button, and submitting joins the normalised code', () => {
    const { input, onJoin } = form();
    const f = input.form;
    expect(f).not.toBeNull();
    expect(f?.querySelector('button[type="submit"]')).not.toBeNull();
    fireEvent.change(input, { target: { value: 'ab12cd' } });
    act(() => f?.requestSubmit());
    expect(onJoin).toHaveBeenCalledTimes(1);
    expect(onJoin).toHaveBeenCalledWith('AB12CD');
  });

  it('cleans a pasted code before maxLength can cut it: spaces go, letters go upper case, the paste lands at the caret', () => {
    const { input, onJoin } = form();
    const paste = (text: string): void => {
      fireEvent.paste(input, { clipboardData: { getData: () => text } });
    };
    paste(' ab12cd ');
    expect(input.value).toBe('AB12CD');
    act(() => input.form?.requestSubmit());
    expect(onJoin).toHaveBeenLastCalledWith('AB12CD');

    fireEvent.change(input, { target: { value: 'AB' } });
    input.setSelectionRange(2, 2);
    paste(' 12 cd99');
    expect(input.value).toBe('AB12CD');
  });

  it('shows an inline error linked by aria-describedby for an invalid code, and clears it on edit', () => {
    const { input, onJoin } = form();
    fireEvent.change(input, { target: { value: 'GGGGGG' } });
    act(() => input.form?.requestSubmit());
    expect(onJoin).not.toHaveBeenCalled();
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const errorId = input.getAttribute('aria-describedby');
    expect(errorId).not.toBeNull();
    expect(document.getElementById(errorId ?? '')?.textContent).toBe('Room codes are 6 characters: digits 0–9 and letters A–F.');
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: 'GGGGG' } });
    expect(input.getAttribute('aria-invalid')).toBe('false');
    expect(input.getAttribute('aria-describedby')).toBeNull();
  });

  it('asks for a code when submitted empty', () => {
    const { input, onJoin } = form();
    act(() => input.form?.requestSubmit());
    expect(onJoin).not.toHaveBeenCalled();
    expect(screen.getByText('Enter the 6-character room code.')).toBeTruthy();
  });
});

describe('LandingScreen', () => {
  it('opens no socket by itself; Create, Quick Play and Join start or route only when pressed', () => {
    const r = setup(<LandingScreen />, { path: '/' });
    expect(r.session.start).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { level: 1 }).querySelector('img')?.getAttribute('alt')).toBe('PonGo');
    expect(screen.getByRole('heading', { name: 'Multiplayer Arcade Action' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(r.session.start).toHaveBeenLastCalledWith({ kind: 'create', isPublic: true });
    expect(r.path()).toBe('/room');
  });

  it('the Public switch is a real switch and feeds the create intent', () => {
    const r = setup(<LandingScreen />, { path: '/' });
    const sw = screen.getByRole('switch', { name: 'Public room' });
    expect(sw.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByText('Public room'));
    expect(sw.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(r.session.start).toHaveBeenLastCalledWith({ kind: 'create', isPublic: false });
  });

  it('QUICK PLAY starts a quick match; Join routes to the room path', () => {
    const r = setup(<LandingScreen />, { path: '/' });
    fireEvent.click(screen.getByRole('button', { name: 'QUICK PLAY' }));
    expect(r.session.start).toHaveBeenLastCalledWith({ kind: 'quick' });
    expect(r.path()).toBe('/room');
  });

  it('Join navigates to /room/CODE without starting the session itself', () => {
    const r = setup(<LandingScreen />, { path: '/' });
    const input = screen.getByLabelText('Room code') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'ab12cd' } });
    act(() => input.form?.requestSubmit());
    expect(r.path()).toBe('/room/AB12CD');
    expect(r.session.start).not.toHaveBeenCalled();
  });

  it('the rules carousel is labelled, with labelled controls and a pause button', () => {
    setup(<LandingScreen />, { path: '/' });
    expect(screen.getByRole('region', { name: 'How to play' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Previous rule' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Next rule' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Go to rule 1' }).getAttribute('aria-current')).toBe('true');
    expect(screen.getByRole('button', { name: 'Go to rule 2' }).getAttribute('aria-current')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Pause slideshow' }));
    expect(screen.getByRole('button', { name: 'Play slideshow' })).toBeTruthy();
    for (const img of screen.getByRole('region', { name: 'How to play' }).querySelectorAll('img')) {
      expect(img.getAttribute('alt')?.length ?? 0).toBeGreaterThan(20);
    }
  });
});

describe('rules carousel autoplay (E52, C106)', () => {
  it('never plays under reduced motion, not even after a swipe, until the viewer presses play', () => {
    setup(<LandingScreen />, { path: '/', state: { motion: { reduced: true } } });
    const p = lastAutoplay();
    expect(p.api).not.toBeNull();
    // With stopOnInteraction off, embla would restart autoplay on every pointerUp by itself.
    expect(p.options).toMatchObject({ delay: AUTOPLAY_MS, playOnInit: false, stopOnInteraction: true });
    expect(p.play).not.toHaveBeenCalled();
    act(() => {
      p.api?.emit('pointerDown');
      p.api?.emit('pointerUp');
    });
    expect(p.play).not.toHaveBeenCalled();
    expect(p.isPlaying()).toBe(false);
    expect(screen.getByRole('button', { name: 'Play slideshow' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Play slideshow' }));
    expect(p.isPlaying()).toBe(true);
    // A drag stops the plugin (stopOnInteraction); the carousel resumes it because the viewer chose to play.
    act(() => {
      p.stop();
      p.api?.emit('pointerUp');
    });
    expect(p.isPlaying()).toBe(true);
  });

  it('plays with full motion, and Pause followed by a swipe stays paused', () => {
    setup(<LandingScreen />, { path: '/' });
    const p = lastAutoplay();
    expect(p.play).toHaveBeenCalled();
    expect(p.isPlaying()).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Pause slideshow' }));
    expect(p.isPlaying()).toBe(false);
    const plays = p.play.mock.calls.length;
    act(() => {
      p.api?.emit('pointerDown');
      p.api?.emit('pointerUp');
    });
    expect(p.play).toHaveBeenCalledTimes(plays);
    expect(p.isPlaying()).toBe(false);
    expect(screen.getByRole('button', { name: 'Play slideshow' })).toBeTruthy();
  });
});

describe('RejoinBanner (C17)', () => {
  const lastLeft = (at: number, canRejoin = true): AppState['lastLeft'] => ({ code: CODE, at, canRejoin });

  it('counts down each second and hides at zero', () => {
    const clock = new FakeClock(100_000);
    setup(<RejoinBanner now={clock.now} timers={clock} />, { path: '/', state: { lastLeft: lastLeft(93_000) } });
    expect(screen.getByRole('button', { name: 'Rejoin match ABC123 (23 s)' })).toBeTruthy();
    act(() => clock.advance(1000));
    expect(screen.getByRole('button', { name: 'Rejoin match ABC123 (22 s)' })).toBeTruthy();
    act(() => clock.advance(21_000));
    expect(screen.getByRole('button', { name: 'Rejoin match ABC123 (1 s)' })).toBeTruthy();
    act(() => clock.advance(1000));
    expect(screen.queryByText(/Rejoin match/)).toBeNull();
    expect(clock.pending).toBe(0);
  });

  it('is not shown when the previous identity cannot be restored or the window has passed', () => {
    const clock = new FakeClock(100_000);
    const r = setup(<RejoinBanner now={clock.now} timers={clock} />, { path: '/', state: { lastLeft: lastLeft(99_000, false) } });
    expect(screen.queryByText(/Rejoin match/)).toBeNull();
    act(() => r.app.store.patch({ lastLeft: lastLeft(70_000) }));
    expect(screen.queryByText(/Rejoin match/)).toBeNull();
  });

  it('rejoins the previous seat and routes to the room; dismiss hides it', () => {
    const clock = new FakeClock(50_000);
    const r = setup(<RejoinBanner now={clock.now} timers={clock} />, { path: '/', state: { lastLeft: lastLeft(45_000) } });
    fireEvent.click(screen.getByRole('button', { name: /Rejoin match ABC123/ }));
    expect(r.session.rejoinPrevious).toHaveBeenCalledWith(CODE);
    expect(r.path()).toBe('/room/ABC123');

    cleanup();
    const r2 = setup(<RejoinBanner now={clock.now} timers={clock} />, { path: '/', state: { lastLeft: lastLeft(45_000) } });
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss rejoin' }));
    expect(screen.queryByText(/Rejoin match/)).toBeNull();
    expect(r2.session.rejoinPrevious).not.toHaveBeenCalled();
  });
});

// ---- lobby and countdown ----

describe('LobbyView (9.4)', () => {
  it('disables Ready with the reason "Connecting…" while !canReady', () => {
    setup(<LobbyView />, { state: { session: sv({ s: 'lobby', worldReady: true, canReady: false }), seats: table() } });
    const ready = screen.getByRole('button', { name: 'Click to Ready' }) as HTMLButtonElement;
    expect(ready.disabled).toBe(true);
    const reason = document.getElementById(ready.getAttribute('aria-describedby') ?? '');
    expect(reason?.textContent).toBe('Connecting…');
  });

  it('toggles Ready through setReady with aria-pressed, and a held Enter does not toggle it again', () => {
    const r = setup(<LobbyView />, { state: { session: sv({ s: 'lobby', worldReady: true }), seats: table() } });
    const ready = screen.getByRole('button', { name: 'Click to Ready' });
    expect(ready.getAttribute('aria-pressed')).toBe('false');
    expect(ready.hasAttribute('aria-describedby')).toBe(false);
    pressEnter(ready, false);
    expect(r.session.setReady).toHaveBeenCalledTimes(1);
    expect(r.session.setReady).toHaveBeenLastCalledWith(true);
    pressEnter(ready, true);
    pressEnter(ready, true);
    expect(r.session.setReady).toHaveBeenCalledTimes(1);

    act(() => r.app.store.patch({ seats: table({ 0: seat(0, SeatConn.Connected, { ready: true }) }) }));
    const pressed = screen.getByRole('button', { name: 'Ready!' });
    expect(pressed.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(pressed);
    expect(r.session.setReady).toHaveBeenLastCalledWith(false);
  });

  it('brings focus back to Ready when the countdown is cancelled under it', () => {
    const r = setup(<StoreForeground />, {
      state: { session: sv({ s: 'countdown', worldReady: true }), seats: table({ 0: seat(0, SeatConn.Connected, { ready: true }) }), countdown: { seconds: 3, endsAt: performance.now() + 3000 } },
    });
    expect(document.activeElement).toBe(screen.getByRole('group', { name: 'Countdown' }));
    fireEvent.click(screen.getByRole('button', { name: 'Not ready' }));
    expect(r.session.setReady).toHaveBeenCalledWith(false);
    act(() => r.app.store.patch({ session: sv({ s: 'lobby', worldReady: true }), seats: table(), countdown: null }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Click to Ready' }));
  });

  it('shows the derived status, the seat rows and the room code', () => {
    setup(<LobbyView />, {
      state: { session: sv({ s: 'lobby', worldReady: true }), seats: table({ 0: seat(0, SeatConn.Connected, { ready: true }) }) },
    });
    expect(screen.getByText('Waiting for 1 more to ready up')).toBeTruthy();
    expect(screen.getByText('ABC123')).toBeTruthy();
    const rows = screen.getByRole('list', { name: 'Players' }).querySelectorAll('li');
    expect(rows).toHaveLength(4);
    expect(rows[0].textContent).toContain('Blue');
    expect(rows[0].textContent).toContain('(You)');
    expect(rows[0].textContent).toContain('READY');
    expect(rows[1].textContent).toContain('WAITING');
    expect(rows[2].textContent).toContain('RECONNECTING…');
    expect(rows[2].textContent).toMatch(/\d+ s to reconnect/);
    expect(rows[3].textContent).toBe('Waiting for player…');
  });

  it('copies the code and says so; Leave is an explicit leave to /', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const r = setup(<LobbyView />, { state: { session: sv({ s: 'lobby', worldReady: true }), seats: table() } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    });
    expect(writeText).toHaveBeenCalledWith('ABC123');
    expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Leave' }));
    expect(r.session.leave).toHaveBeenCalledWith({ explicit: true });
    expect(r.path()).toBe('/');
    Reflect.deleteProperty(navigator, 'clipboard');
  });
});

describe('CountdownOverlay (9.5)', () => {
  it('focuses the overlay container, never a button, and shows the digit in an assertive region', () => {
    const r = setup(<CountdownOverlay />, {
      state: { session: sv({ s: 'countdown', worldReady: true }), seats: table({ 0: seat(0, SeatConn.Connected, { ready: true }) }), countdown: { seconds: 3, endsAt: performance.now() + 2500 } },
    });
    const overlay = screen.getByRole('group', { name: 'Countdown' });
    expect(document.activeElement).toBe(overlay);
    expect(document.activeElement?.tagName).not.toBe('BUTTON');
    const live = overlay.querySelector('[aria-live="assertive"]');
    expect(live?.textContent).toBe('Starting in3');
    fireEvent.click(screen.getByRole('button', { name: 'Not ready' }));
    expect(r.session.setReady).toHaveBeenCalledWith(false);
  });

  it('ticks the digit down on each second boundary and holds at 1', () => {
    fakeTime();
    setup(<CountdownOverlay />, { state: { session: sv({ s: 'countdown', worldReady: true }), seats: table(), countdown: { seconds: 3, endsAt: performance.now() + 2500 } } });
    const digit = (): string | null | undefined =>
      screen.getByRole('group', { name: 'Countdown' }).querySelector('[aria-live="assertive"]')?.lastElementChild?.textContent;
    expect(digit()).toBe('3');
    act(() => vi.advanceTimersByTime(499));
    expect(digit()).toBe('3');
    act(() => vi.advanceTimersByTime(1));
    expect(digit()).toBe('2');
    act(() => vi.advanceTimersByTime(1000));
    expect(digit()).toBe('1');
    act(() => vi.advanceTimersByTime(5000));
    expect(digit()).toBe('1');
  });

  it('never shows less than 1, and offers "Not ready" only to a ready player', () => {
    setup(<CountdownOverlay />, { state: { session: sv({ s: 'countdown', worldReady: true }), seats: table(), countdown: { seconds: 3, endsAt: performance.now() - 500 } } });
    expect(screen.getByText('1')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Not ready' })).toBeNull();
  });
});

// ---- in game ----

describe('ScoreBoard (E50)', () => {
  it('lists Connected and Grace seats, and a score change re-renders only that row', () => {
    const renders: Seat[] = [];
    const r = setup(<ScoreBoard onRowRender={(s) => renders.push(s)} />, { state: { seats: table() } });
    const rows = screen.getAllByRole('listitem');
    expect(rows.map((el) => el.getAttribute('data-seat'))).toEqual(['0', '1', '2']);
    expect(rows[0].textContent).toContain('You');

    renders.length = 0;
    const cur = r.app.store.get().seats;
    act(() => r.app.store.patch({ seats: [cur[0], { ...cur[1], score: 4 }, cur[2], cur[3]] }));
    expect(renders).toEqual([1]);
    expect(rows[1].textContent).toContain('4');
    expect(rows[1].classList.contains('bump-up')).toBe(true);

    renders.length = 0;
    const next = r.app.store.get().seats;
    act(() => r.app.store.patch({ seats: [{ ...next[0], score: 4 }, next[1], next[2], next[3]] }));
    expect(renders).toEqual([0]);
    expect(rows[0].classList.contains('bump-down')).toBe(true);
  });

  it('shows an unknown score as a dash', () => {
    setup(<ScoreBoard />, { state: { seats: table({ 1: seat(1, SeatConn.Connected, { score: null }) }) } });
    expect(screen.getAllByRole('listitem')[1].textContent).toContain('–');
  });
});

describe('GraceRing (E51)', () => {
  it('drops its seconds by one on each second boundary and disappears at zero', () => {
    fakeTime();
    setup(<GraceRing endsAt={performance.now() + 2500} label={HUD.graceLeft} />, { path: '/' });
    expect(screen.getByText('3 s to reconnect')).toBeTruthy();
    act(() => vi.advanceTimersByTime(500));
    expect(screen.getByText('2 s to reconnect')).toBeTruthy();
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByText('1 s to reconnect')).toBeTruthy();
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.queryByText(/s to reconnect/)).toBeNull();
  });
});

describe('GameHud (9.5)', () => {
  it('shows the room pill, the unstable dot and the "Sound off" chip only in play', () => {
    const playUi = vi.fn();
    const audio: AudioEngine = { ...fakeAudio(), playUi };
    const r = setup(<GameHud />, {
      audio,
      state: { session: sv({ s: 'playing', worldReady: true }), seats: table(), net: { unstable: true }, audio: { state: 'locked', musicReady: false } },
    });
    expect(screen.getByText('Room ABC123')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Connection unstable' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Sound off — tap to enable' }));
    expect(playUi).toHaveBeenCalledWith('uiTap');

    act(() => r.app.store.patch({ session: sv({ s: 'reconnecting', worldReady: true }) }));
    expect(screen.queryByRole('img', { name: 'Connection unstable' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sound off — tap to enable' })).toBeNull();
    expect(scoresShown()).toBe(true);
  });

  it('hides the chip once audio runs', () => {
    setup(<GameHud />, { state: { session: sv({ s: 'playing', worldReady: true }), audio: { state: 'running', musicReady: true } } });
    expect(screen.queryByRole('button', { name: 'Sound off — tap to enable' })).toBeNull();
  });

  it('says Copied for 1.5 s after the latest copy, and leaves no timer behind on unmount', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    try {
      const r = setup(<GameHud />, { state: { session: sv({ s: 'playing', worldReady: true }), seats: table() } });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Copy room code' }));
      });
      expect(writeText).toHaveBeenCalledWith('ABC123');
      expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy();
      act(() => vi.advanceTimersByTime(1000));
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Copied' }));
      });
      act(() => vi.advanceTimersByTime(COPIED_MS - 1000));
      expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy(); // the first copy's period is over
      act(() => vi.advanceTimersByTime(1000));
      expect(screen.getByRole('button', { name: 'Copy room code' })).toBeTruthy();

      // The Grace seat's ring keeps its own per-second timer, so count relative to it.
      const others = vi.getTimerCount();
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Copy room code' }));
      });
      expect(vi.getTimerCount()).toBe(others + 1);
      r.unmount();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      Reflect.deleteProperty(navigator, 'clipboard');
    }
  });
});

describe('JoystickZone (8.2)', () => {
  function pointer(type: string, pointerId: number, pointerType: string, clientX: number, clientY: number): MouseEvent {
    const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY });
    Object.defineProperties(e, { pointerId: { value: pointerId }, pointerType: { value: pointerType } });
    return e;
  }

  it('forwards pointers to the joystick model, captures the pointer, paints in my colour and never re-renders', () => {
    const joystick: JoystickModel = {
      down: vi.fn(() => true), move: vi.fn(), up: vi.fn(), cancelAll: vi.fn(), axis: null, knob: new Float32Array(4),
    };
    const input: InputController = { ...fakeInput(), joystick };
    const commits = vi.fn();
    const r = setup(<Profiler id="joy" onRender={commits}><JoystickZone /></Profiler>, {
      input, state: { session: sv({ s: 'playing', worldReady: true, myIndex: 1 }) },
    });
    const zone = screen.getByTestId('joystick-zone');
    expect(zone.style.getPropertyValue('--joy')).toBe(SEATS[1].color);

    act(() => {
      zone.dispatchEvent(pointer('pointerdown', 7, 'touch', 120, 300));
    });
    expect(joystick.down).toHaveBeenCalledWith(7, 120, 300, 'touch', expect.objectContaining({ left: 0, top: 0 }));
    expect(zone.hasPointerCapture(7)).toBe(true);
    zone.dispatchEvent(pointer('pointermove', 7, 'touch', 150, 300));
    expect(joystick.move).toHaveBeenCalledWith(7, 150, 300);
    zone.dispatchEvent(pointer('pointerup', 7, 'touch', 150, 300));
    expect(joystick.up).toHaveBeenCalledWith(7);

    commits.mockClear();
    act(() => r.app.store.patch({ session: sv({ s: 'playing', worldReady: true, myIndex: 3 }), net: { unstable: true } }));
    expect(commits).not.toHaveBeenCalled();
    expect(zone.style.getPropertyValue('--joy')).toBe(SEATS[3].color);

    r.unmount();
    expect(joystick.cancelAll).toHaveBeenCalled();
  });
});

describe('ReconnectBanner (9.5)', () => {
  const view = (p: Partial<Extract<ReturnType<typeof toRoomView>, { kind: 'reconnecting' }>>) =>
    ({ kind: 'reconnecting' as const, attempt: 2, nextAt: performance.now() + 3200, offline: false, suspended: false, showActions: true, ...p });

  it('speaks the attempt, shows the seconds, and offers Retry now and Leave', () => {
    const r = setup(<ReconnectBanner view={view({})} />, { state: { session: sv({ s: 'reconnecting', attempt: 2 }) } });
    const status = screen.getByRole('status');
    expect(status.textContent).toBe('Connection lost — reconnecting (attempt 2), next try in 4 s');
    expect(status.querySelector('[aria-hidden="true"]')?.textContent).toBe(', next try in 4 s');
    fireEvent.click(screen.getByRole('button', { name: 'Retry now' }));
    expect(r.session.retry).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Leave' }));
    expect(r.session.leave).toHaveBeenCalledWith({ explicit: true });
    expect(r.path()).toBe('/');
  });

  it('counts the seconds to the next try down, then shows the attempt in flight', () => {
    fakeTime();
    setup(<ReconnectBanner view={view({ nextAt: performance.now() + 3200 })} />, { state: { session: sv({ s: 'reconnecting', attempt: 2 }) } });
    const status = (): string | null => screen.getByRole('status').textContent;
    expect(status()).toBe('Connection lost — reconnecting (attempt 2), next try in 4 s');
    act(() => vi.advanceTimersByTime(200));
    expect(status()).toBe('Connection lost — reconnecting (attempt 2), next try in 3 s');
    act(() => vi.advanceTimersByTime(1000));
    expect(status()).toBe('Connection lost — reconnecting (attempt 2), next try in 2 s');
    act(() => vi.advanceTimersByTime(2000));
    expect(status()).toBe('Connection lost — reconnecting (attempt 2)…');
  });

  it('hides the actions before the first failed attempt, and shows the offline copy', () => {
    setup(<ReconnectBanner view={view({ attempt: 0, nextAt: null, showActions: false })} />);
    expect(screen.queryByRole('button')).toBeNull();
    cleanup();
    setup(<ReconnectBanner view={view({ offline: true, attempt: 0, showActions: true })} />);
    expect(screen.getByRole('status').textContent).toBe("You're offline. We'll reconnect when you're back online.");
    expect(screen.getByRole('button', { name: 'Retry now' })).toBeTruthy();
  });

  it('Retry now acts only between attempts: while one is in flight it is aria-disabled and does nothing', () => {
    const r = setup(<StoreForeground />, { state: { session: sv({ s: 'connecting', worldReady: true, attempt: 1 }), seats: table() } });
    const retry = screen.getByRole('button', { name: 'Retry now' });
    expect(retry.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(retry);
    expect(r.session.retry).not.toHaveBeenCalled();

    act(() => r.app.store.patch({ session: sv({ s: 'reconnecting', worldReady: true, attempt: 1, nextAt: performance.now() + 2000 }) }));
    expect(screen.getByRole('button', { name: 'Retry now' })).toBe(retry);
    expect(retry.getAttribute('aria-disabled')).toBe('false');
    fireEvent.click(retry);
    expect(r.session.retry).toHaveBeenCalledTimes(1);

    act(() => r.app.store.patch({ session: sv({ s: 'requesting', worldReady: true, attempt: 2 }) }));
    fireEvent.click(retry);
    expect(r.session.retry).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Leave' }));
    expect(r.session.leave).toHaveBeenCalledWith({ explicit: true });
  });

  it('over the frozen HUD, publishes its height as --banner-h so the HUD sits below it, and clears it when it goes', () => {
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(96);
    const r = setup(<StoreForeground />, { state: { session: sv({ s: 'reconnecting', worldReady: true, attempt: 1 }), seats: table() } });
    const host = screen.getByRole('status').parentElement?.parentElement as HTMLElement;
    expect(host.style.getPropertyValue('--banner-h')).toBe('104px');
    act(() => r.app.store.patch({ session: sv({ s: 'playing', worldReady: true }) }));
    expect(scoresShown()).toBe(true);
    expect(host.style.getPropertyValue('--banner-h')).toBe('');
  });
});

describe('FailureView actions follow the flags (9.6)', () => {
  const show = (f: Failure) => setup(<FailureView view={{ kind: 'failed', failure: f, code: CODE }} />);

  it('session-busy: Keep waiting, Join as new player, Home', () => {
    const r = show(failure('session-busy', { retryable: true, canJoinAsNew: true }));
    expect(buttonLabels()).toEqual(['Keep waiting', 'Join as new player', 'Home']);
    fireEvent.click(screen.getByRole('button', { name: 'Keep waiting' }));
    expect(r.session.retry).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Join as new player' }));
    expect(r.session.joinAsNew).toHaveBeenCalledTimes(1);
  });

  it('room-full (retryable): Try again, Quick Play, Home, with the server reason', () => {
    const r = show(failure('room-full', { retryable: true, serverReason: 'Room is full' }));
    expect(screen.getByRole('heading', { level: 1, name: 'Room ABC123 is full' })).toBeTruthy();
    expect(screen.getByText('Server said: Room is full')).toBeTruthy();
    expect(buttonLabels()).toEqual(['Try again', 'Quick Play', 'Home']);
    fireEvent.click(screen.getByRole('button', { name: 'Quick Play' }));
    expect(r.session.start).toHaveBeenCalledWith({ kind: 'quick' });
    expect(r.path()).toBe('/room');
  });

  it('room-lost follows retryable; invalid-code has only Home, which leaves to /', () => {
    show(failure('room-lost'));
    expect(buttonLabels()).toEqual(['Quick Play', 'Home']);
    cleanup();
    show(failure('room-lost', { retryable: true }));
    expect(buttonLabels()).toEqual(['Try again', 'Quick Play', 'Home']);
    cleanup();
    const r = show(failure('invalid-code'));
    expect(buttonLabels()).toEqual(['Home']);
    fireEvent.click(screen.getByRole('button', { name: 'Home' }));
    expect(r.session.leave).toHaveBeenCalledWith({ explicit: false });
    expect(r.path()).toBe('/');
  });

  it('moves focus to the failure title', () => {
    show(failure('seat-taken'));
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1, name: 'Your seat was given to another player' }));
  });
});

describe('ConnectingView', () => {
  it('Cancel leaves explicitly and goes home', () => {
    const r = setup(<ConnectingView view={{ kind: 'connecting', intent: { kind: 'quick' }, code: null, attempt: 0, rejoin: false }} />);
    expect(screen.getByRole('heading', { name: 'Finding a match…' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(r.session.leave).toHaveBeenCalledWith({ explicit: true });
    expect(r.path()).toBe('/');
  });
});

describe('ResultsDialog (9.5)', () => {
  const rows: readonly ResultRow[] = [
    { index: 0, score: 18, left: false, isMe: true, winner: true },
    { index: 1, score: 11, left: false, isMe: false, winner: false },
    { index: 2, score: 4, left: true, isMe: false, winner: false },
  ];

  it('opens as a modal with focus on its h1, lists seated players, and cannot be dismissed with Escape', () => {
    setup(<ResultsDialog />, { state: { session: sv({ s: 'finished' }), results: { winner: 0, rows, reason: '', derived: true } } });
    expect(dialogOpen()).toBe(true);
    const title = screen.getByRole('heading', { level: 1, name: 'Game over' });
    expect(document.activeElement).toBe(title);
    expect(screen.getByText('Blue wins!')).toBeTruthy();
    const items = screen.getByRole('list', { name: 'Final scores' }).querySelectorAll('li');
    expect(items).toHaveLength(3);
    expect(items[0].textContent).toContain('(You)');
    expect(items[2].textContent).toContain('(left)');
    expect(screen.getByText("Final results reconstructed — the server's final message didn't arrive.")).toBeTruthy();

    const dialog = document.querySelector('dialog') as HTMLDialogElement;
    const cancel = new Event('cancel', { cancelable: true });
    act(() => {
      dialog.dispatchEvent(cancel);
    });
    expect(cancel.defaultPrevented).toBe(true);
    expect(dialogOpen()).toBe(true);
  });

  it('opts out of browser light dismiss, and re-opens with focus on its h1 if the browser closes it anyway', () => {
    setup(<ResultsDialog />, { state: { session: sv({ s: 'finished' }), results: { winner: 0, rows, reason: '', derived: false } } });
    const dialog = document.querySelector('dialog') as HTMLDialogElement;
    expect(dialog.getAttribute('closedby')).toBe('none');
    screen.getByRole('button', { name: 'Back to menu' }).focus();
    act(() => dialog.close());
    expect(dialogOpen()).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1, name: 'Game over' }));
    expect(screen.getByRole('button', { name: 'Quick play again' })).toBeTruthy();
  });

  it('reads a tie, and its buttons play again or go back to the menu', () => {
    const r = setup(<ResultsDialog />, { state: { session: sv({ s: 'finished' }), results: { winner: -1, rows, reason: '', derived: false } } });
    expect(screen.getByText("It's a tie!")).toBeTruthy();
    expect(screen.queryByText(/reconstructed/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Back to menu' }));
    expect(r.session.leave).toHaveBeenCalledWith({ explicit: false });
    expect(r.path()).toBe('/');
    fireEvent.click(screen.getByRole('button', { name: 'Quick play again' }));
    expect(r.session.start).toHaveBeenCalledWith({ kind: 'quick' });
    expect(r.path()).toBe('/room');
  });
});

// ---- header and shell ----

describe('Header (C25, 9.5)', () => {
  it('in a live room, Home asks first with Stay focused; Stay returns focus to Home', () => {
    const r = setup(<Header />, { state: { session: sv({ s: 'playing', worldReady: true }) } });
    const home = screen.getByRole('button', { name: 'Home' });
    home.focus();
    fireEvent.click(home);
    expect(dialogOpen()).toBe(true);
    expect(screen.getByText('Leave the match?')).toBeTruthy();
    expect(screen.getByText('Your seat is held for 30 seconds. You can rejoin from the home screen.')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Stay' }));
    fireEvent.click(screen.getByRole('button', { name: 'Stay' }));
    expect(dialogOpen()).toBe(false);
    expect(document.activeElement).toBe(home);
    expect(r.session.leave).not.toHaveBeenCalled();

    fireEvent.click(home);
    fireEvent.click(screen.getByRole('button', { name: 'Leave' }));
    expect(r.session.leave).toHaveBeenCalledWith({ explicit: true });
    expect(r.path()).toBe('/');
  });

  it('a confirm opened while reconnecting survives the retry cycle through connecting and requesting', () => {
    const r = setup(<Header />, { state: { session: sv({ s: 'reconnecting', worldReady: true, attempt: 1 }) } });
    fireEvent.click(screen.getByRole('button', { name: 'Home' }));
    expect(dialogOpen()).toBe(true);
    act(() => r.app.store.patch({ session: sv({ s: 'connecting', worldReady: true, attempt: 2 }) }));
    expect(dialogOpen()).toBe(true);
    act(() => r.app.store.patch({ session: sv({ s: 'requesting', worldReady: true, attempt: 2 }) }));
    expect(dialogOpen()).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Leave' }));
    expect(r.session.leave).toHaveBeenCalledWith({ explicit: true });
    expect(r.path()).toBe('/');
  });

  it('Home asks during a retry over the frozen board, and the confirm closes once the match fails', () => {
    const r = setup(<Header />, { state: { session: sv({ s: 'connecting', stageRetained: true, attempt: 1 }) } });
    fireEvent.click(screen.getByRole('button', { name: 'Home' }));
    expect(dialogOpen()).toBe(true);
    expect(r.session.leave).not.toHaveBeenCalled();
    act(() => r.app.store.patch({ session: sv({ s: 'failed', failure: failure('room-lost') }) }));
    expect(dialogOpen()).toBe(false);
  });

  it('follows a close the browser makes itself: the confirm reports a cancel, and Home opens it again', () => {
    setup(<Header />, { state: { session: sv({ s: 'playing', worldReady: true }) } });
    const home = screen.getByRole('button', { name: 'Home' });
    home.focus();
    fireEvent.click(home);
    const dialog = document.querySelector('dialog') as HTMLDialogElement;
    expect(dialog.hasAttribute('closedby')).toBe(false);
    act(() => dialog.close());
    expect(dialogOpen()).toBe(false);
    expect(document.activeElement).toBe(home);
    fireEvent.click(home);
    expect(dialogOpen()).toBe(true);
  });

  it('elsewhere Home leaves at once: explicitly while joining, not after a failure', () => {
    const r = setup(<Header />, { state: { session: sv({ s: 'connecting', roomKnown: false, code: null }) } });
    fireEvent.click(screen.getByRole('button', { name: 'Home' }));
    expect(dialogOpen()).toBe(false);
    expect(r.session.leave).toHaveBeenLastCalledWith({ explicit: true });
    expect(r.path()).toBe('/');
    cleanup();
    const r2 = setup(<Header />, { state: { session: sv({ s: 'failed', failure: failure('unknown') }) } });
    fireEvent.click(screen.getByRole('button', { name: 'Home' }));
    expect(r2.session.leave).toHaveBeenLastCalledWith({ explicit: false });
    cleanup();
    const r3 = setup(<Header />, { path: '/nowhere' });
    fireEvent.click(screen.getByRole('button', { name: 'Home' }));
    expect(r3.session.leave).not.toHaveBeenCalled();
    expect(r3.path()).toBe('/');
  });
});

describe('VolumeControl (9.8)', () => {
  it('at 390 px: one tap on the icon mutes; a separate chevron opens the slider, and Escape returns focus to it', () => {
    setViewportWidth(390);
    const r = setup(<VolumeControl channel="music" />, { path: '/' });
    const mute = screen.getByRole('button', { name: 'Mute music' });
    expect(mute.getAttribute('aria-pressed')).toBe('false');
    expect(screen.queryByRole('slider')).toBeNull();

    fireEvent.click(mute);
    expect(r.app.settings.get().musicMuted).toBe(true);
    expect(mute.getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByRole('slider')).toBeNull();

    const chevron = screen.getByRole('button', { name: 'Music volume' });
    expect(chevron.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(chevron);
    expect(chevron.getAttribute('aria-expanded')).toBe('true');
    const slider = screen.getByRole('slider', { name: 'Music volume' }) as HTMLInputElement;
    expect(chevron.getAttribute('aria-controls')).toBe(slider.closest('[role="group"]')?.id);
    fireEvent.change(slider, { target: { value: '0.3' } });
    expect(r.app.settings.get()).toMatchObject({ musicVolume: 0.3, musicMuted: false });

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('slider')).toBeNull();
    expect(chevron.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(chevron);
  });

  it('closes the popover on an outside press', () => {
    setViewportWidth(390);
    setup(<VolumeControl channel="sfx" />, { path: '/' });
    fireEvent.click(screen.getByRole('button', { name: 'Sound effects volume' }));
    expect(screen.getByRole('slider', { name: 'Sound effects volume' })).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('slider')).toBeNull();
  });

  it('at 1024 px the slider is inline and there is no chevron', () => {
    setViewportWidth(1024);
    setup(<VolumeControl channel="sfx" />, { path: '/' });
    expect(screen.getByRole('slider', { name: 'Sound effects volume' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Sound effects volume' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Mute sound effects' })).toBeTruthy();
  });

  it('unmuting at volume 0 restores the default level', () => {
    setViewportWidth(390);
    const r = setup(<VolumeControl channel="music" />, { path: '/' });
    act(() => r.app.settings.update({ musicVolume: 0, musicMuted: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Mute music' }));
    expect(r.app.settings.get()).toMatchObject({ musicMuted: false, musicVolume: 0.5 });
  });
});

describe('AppShell, LiveAnnouncer, notices and the update chip', () => {
  it('renders the header and main, and announces session transitions politely', () => {
    const r = setup(<AppShell><p>content</p></AppShell>);
    expect(screen.getByRole('main').id).toBe('main');
    expect(screen.getByRole('button', { name: 'Home' })).toBeTruthy();
    act(() => r.app.store.patch({ session: sv({ s: 'requesting', myIndex: null }) }));
    act(() => r.app.store.patch({ session: sv({ s: 'lobby', myIndex: 0 }) }));
    expect(screen.getByTestId('live-polite').textContent).toBe('Joined room ABC123 as Blue.');
    act(() => r.app.store.patch({ session: sv({ s: 'countdown', myIndex: 0 }) }));
    expect(screen.getByTestId('live-assertive').textContent).toBe('Countdown started.');
    act(() => announce('Copied'));
    expect(screen.getByTestId('live-polite').textContent).toBe('Copied');
  });

  it('shows notices and dismisses one early', () => {
    const r = setup(<NoticeToasts />, { state: { notices: [{ id: 3, kind: 'joined-as-new', text: 'Rejoined as a new player — your previous connection was still open.', tone: 'warn', expiresAt: 1e12 }] } });
    expect(screen.getByText('Rejoined as a new player — your previous connection was still open.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }));
    expect(r.session.dismissNotice).toHaveBeenCalledWith(3);
  });

  it('the update chip is pass-through with no button during a match and under the results, and Reload now after a failure in a room leaves and goes home', () => {
    const applyUpdate = vi.fn();
    const pwa: PwaApi = { ...fakePwa(), applyUpdate };
    const r = setup(<UpdateChip />, { pwa, state: { pwa: { updateReady: true }, session: sv({ s: 'playing', worldReady: true }) } });
    const chip = screen.getByText('Update ready: applies after this match').parentElement as HTMLElement;
    expect(screen.queryByRole('button', { name: 'Reload now' })).toBeNull();
    expect(getComputedStyle(chip).pointerEvents).toBe('none');

    // In `finished` the chip is passive text under the modal results dialog; "Back to menu" leads to the apply.
    act(() => r.app.store.patch({ session: sv({ s: 'finished', worldReady: true }) }));
    expect(screen.getByText('Update ready: applies after this match')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Reload now' })).toBeNull();
    expect(getComputedStyle(chip).pointerEvents).toBe('none');

    act(() => r.app.store.patch({ session: sv({ s: 'failed', failure: failure('room-lost') }) }));
    expect(getComputedStyle(chip).pointerEvents).toBe('auto');
    fireEvent.click(screen.getByRole('button', { name: 'Reload now' }));
    // Never a reload on /room/CODE (D24): the apply policy reloads once the session is idle at `/`.
    expect(applyUpdate).not.toHaveBeenCalled();
    expect(r.session.leave).toHaveBeenCalledWith({ explicit: false });
    expect(r.path()).toBe('/');
  });

  it('outside a room path Reload now applies at once, and the chip goes when the update does', () => {
    const applyUpdate = vi.fn();
    const pwa: PwaApi = { ...fakePwa(), applyUpdate };
    const r = setup(<UpdateChip />, { pwa, path: '/', state: { pwa: { updateReady: true } } });
    expect(screen.getByText('Update ready: applies after this match')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reload now' }));
    expect(applyUpdate).toHaveBeenCalledTimes(1);
    expect(r.session.leave).not.toHaveBeenCalled();
    expect(r.path()).toBe('/');
    act(() => r.app.store.patch({ pwa: { updateReady: false } }));
    expect(screen.queryByText(/Update ready/)).toBeNull();
  });
});

describe('RootErrorBoundary (C39)', () => {
  function Bomb(): JSX.Element {
    if (useLocation().pathname !== '/') throw new Error('boom');
    return <p>home page</p>;
  }
  function Routed({ onError }: { onError: (e: Error) => void }): JSX.Element {
    const location = useLocation();
    return (
      <RootErrorBoundary resetKey={location.key} onError={onError}>
        <Bomb />
      </RootErrorBoundary>
    );
  }

  it('shows Home and Reload, and navigating Home clears the error through resetKey without remounting', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const onError = vi.fn();
    setup(<Routed onError={onError} />, { path: '/room/ABC123' });
    expect(screen.getByRole('heading', { name: 'Something went wrong' })).toBeTruthy();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'boom' }));
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Home' }));
    expect(screen.getByText('home page')).toBeTruthy();
  });

  it('keeps the error while resetKey is unchanged', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let explode = true;
    function Fragile(): JSX.Element {
      if (explode) throw new Error('boom');
      return <p>recovered</p>;
    }
    const tree = (key: string): JSX.Element => (
      <RootErrorBoundary resetKey={key}>
        <Fragile />
      </RootErrorBoundary>
    );
    const r = setup(tree('a'), { path: '/' });
    explode = false;
    r.rerender(tree('a'));
    expect(screen.getByRole('heading', { name: 'Something went wrong' })).toBeTruthy();
    r.rerender(tree('b'));
    expect(screen.getByText('recovered')).toBeTruthy();
  });

  it('reports an error thrown by the render that changes resetKey once, and keeps its screen until the key moves on', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const onError = vi.fn();
    function Child({ k }: { k: string }): JSX.Element {
      if (k === 'bad') throw new Error('boom');
      return <p>ok {k}</p>;
    }
    const tree = (k: string): JSX.Element => (
      <RootErrorBoundary resetKey={k} onError={onError}>
        <Child k={k} />
      </RootErrorBoundary>
    );
    const r = setup(tree('a'), { path: '/' });
    expect(screen.getByText('ok a')).toBeTruthy();
    r.rerender(tree('bad'));
    expect(screen.getByRole('heading', { name: 'Something went wrong' })).toBeTruthy();
    expect(onError).toHaveBeenCalledTimes(1);
    r.rerender(tree('c'));
    expect(screen.getByText('ok c')).toBeTruthy();
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe('GlobalStyle (9.7, 9.9)', () => {
  // Vitest resolves styled-components' Node build, whose createGlobalStyle injects on the server path only, so
  // the emitted CSS is collected through a ServerStyleSheet: the same stylis output the browser build injects.
  it('defines the tokens and the 100% roots, and zeroes durations under reduced motion unless forced to full', () => {
    const sheet = new ServerStyleSheet();
    let css = '';
    try {
      renderToString(sheet.collectStyles(<GlobalStyle />));
      css = sheet.getStyleTags().replace(/\s+/g, '');
    } finally {
      sheet.seal();
    }
    for (const token of ['--bg:#09090b', '--fg:#fafafa', '--muted:#a1a1aa', '--border:#27272a', '--primary:#2563eb', '--primary-fg:#ffffff',
      '--header-h:60px', '--radius:4px', '--safe-t:env(safe-area-inset-top,0px)', '--dur:200ms', '--z-dialog:40', '--z-header:60', 'color-scheme:dark']) {
      expect(css, token).toContain(token);
    }
    expect(css).toContain("--font:'VT323',ui-monospace,Menlo,monospace");
    expect(css).toMatch(/html,body,#root\{[^}]*height:100%/);
    expect(css).toContain("@media(prefers-reduced-motion:reduce){:root:not([data-motion='full']){--dur-fast:0ms;--dur:0ms;--dur-slow:0ms;--motion:0;}");
    expect(css).toContain(":root[data-motion='reduced']{--dur-fast:0ms;--dur:0ms;--dur-slow:0ms;--motion:0;}");
    expect(css).toContain('@property--grace-p');
  });
});

describe('NotFound (C36)', () => {
  it('never starts a session and links home', () => {
    const r = setup(<NotFound />, { path: '/nope' });
    expect(screen.getByRole('heading', { level: 1, name: 'Page not found' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Home' }));
    expect(r.path()).toBe('/');
    expect(r.session.start).not.toHaveBeenCalled();
  });
});
