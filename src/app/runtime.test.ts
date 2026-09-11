/** @vitest-environment jsdom */
// The composition root (12.3) with every port factory replaced by a recording fake: which instances meet, what
// each wire forwards, the 2 s music intensity, the settings and motion mirrors, and a dispose that undoes it all
// in reverse, also when construction fails halfway.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Visual, InputController } from '../input/types';
import type { AudioEngine } from '../audio/types';
import type { GameRuntime } from '../game/types';
import type { IdentityApi, Model, RoomCode, SessionApi, WorldSummary } from '../session/types';
import type { PwaApi } from './types';
import { fakeAudio, fakeGame, fakeInput, fakeModel, fakePwa, fakeSession } from '../test/fakes/fakeApp';
import { safeLocal, safeSession } from '../lib/storage';
import { wsUrl } from '../config/env';

const h = vi.hoisted(() => ({ transports: [] as object[] }));

vi.mock('../session/identity', () => ({ createIdentity: vi.fn() }));
vi.mock('../game/runtime', () => ({ createGameRuntime: vi.fn() }));
vi.mock('../input/controller', () => ({ createInputController: vi.fn() }));
vi.mock('../audio/engine', () => ({ createAudioEngine: vi.fn() }));
vi.mock('../session/runtime', () => ({ createSessionRuntime: vi.fn() }));
vi.mock('../session/lifecycle', () => ({ attachLifecycle: vi.fn() }));
vi.mock('../ui/pwa/registerSW', () => ({ createPwa: vi.fn() }));
vi.mock('../net/transport', () => ({
  Transport: class FakeTransport {
    constructor() {
      h.transports.push(this);
    }
  },
}));

import { createIdentity } from '../session/identity';
import { createGameRuntime } from '../game/runtime';
import { createInputController } from '../input/controller';
import { createAudioEngine } from '../audio/engine';
import { createSessionRuntime } from '../session/runtime';
import { attachLifecycle } from '../session/lifecycle';
import { createPwa } from '../ui/pwa/registerSW';
import { INTENSITY_INTERVAL_MS, createApp } from './runtime';

const CODE = 'ABC123' as RoomCode;

interface Rig {
  calls: string[];
  identity: IdentityApi;
  game: GameRuntime;
  input: InputController & { desired: Visual };
  audio: AudioEngine;
  session: SessionApi;
  pwa: PwaApi;
  setModel(m: Model): void;
  emitSession(): void;
  setSummary(p: Partial<WorldSummary>): void;
  intentSource(): (() => Visual) | null;
  sink(): ((d: 'ArrowLeft' | 'ArrowRight' | 'Stop') => boolean) | null;
}

/** Every factory returns a fake; the calls that undo something are recorded by name, in order. */
function rig(): Rig {
  const calls: string[] = [];
  const mark = (name: string) => vi.fn(() => {
    calls.push(name);
  });

  const identity: IdentityApi = {
    ready: Promise.resolve(), current: () => 'sid', rotate: vi.fn(), hasPrevious: () => false, restorePrevious: () => false,
    onPageHide: vi.fn((persisted: boolean) => {
      calls.push(`identity.onPageHide(${persisted})`);
    }),
    onPageShow: vi.fn(() => Promise.resolve()),
  };

  let summary: WorldSummary = { ready: true, bricksAlive: null, bricksAtStart: null, tick: 0, graceSeats: 0 };
  let intentSource: (() => Visual) | null = null;
  const game: GameRuntime = {
    ...fakeGame(),
    summary: () => summary,
    setIntentSource: vi.fn((src: (() => Visual) | null) => {
      calls.push(src === null ? 'game.setIntentSource(null)' : 'game.setIntentSource');
      intentSource = src;
    }),
    onIngestEvents: vi.fn(() => mark('game.stopAudioFeed')),
    setUnstable: vi.fn(),
    setOwnLead: vi.fn(),
  };

  let sink: ((d: 'ArrowLeft' | 'ArrowRight' | 'Stop') => boolean) | null = null;
  const input: InputController & { desired: Visual } = {
    ...fakeInput(),
    desired: 0,
    attach: vi.fn(() => mark('input.detach')),
    setSink: vi.fn((s: ((d: 'ArrowLeft' | 'ArrowRight' | 'Stop') => boolean) | null) => {
      calls.push(s === null ? 'input.setSink(null)' : 'input.setSink');
      sink = s;
    }),
    onSession: vi.fn(),
  };

  const audio: AudioEngine = {
    ...fakeAudio(),
    init: vi.fn(() => mark('audio.detach')),
    setMix: vi.fn(),
    setScene: vi.fn(),
    setIntensity: vi.fn(),
    onEvents: vi.fn(),
    dispose: vi.fn(() => {
      calls.push('audio.dispose');
      return Promise.resolve();
    }),
  };

  let model = fakeModel();
  const listeners = new Set<() => void>();
  const session: SessionApi = {
    ...fakeSession(),
    getModel: () => model,
    subscribe: vi.fn((cb: () => void) => {
      listeners.add(cb);
      return () => {
        calls.push('session.unsubscribe');
        listeners.delete(cb);
      };
    }),
    sendDirection: vi.fn(() => true),
    dispose: mark('session.dispose'),
  };

  const pwa: PwaApi = { ...fakePwa(), start: mark('pwa.start'), dispose: mark('pwa.dispose') };

  vi.mocked(createIdentity).mockReturnValue(identity);
  vi.mocked(createGameRuntime).mockReturnValue(game);
  vi.mocked(createInputController).mockReturnValue(input);
  vi.mocked(createAudioEngine).mockReturnValue(audio);
  vi.mocked(createSessionRuntime).mockReturnValue(session);
  vi.mocked(attachLifecycle).mockImplementation(() => mark('lifecycle.detach'));
  vi.mocked(createPwa).mockReturnValue(pwa);

  return {
    calls, identity, game, input, audio, session, pwa,
    setModel: (m) => {
      model = m;
    },
    emitSession: () => {
      for (const cb of Array.from(listeners)) cb();
    },
    setSummary: (p) => {
      summary = { ...summary, ...p };
    },
    intentSource: () => intentSource,
    sink: () => sink,
  };
}

function playing(app: ReturnType<typeof createApp>): void {
  app.store.patch({ session: { ...app.store.get().session, s: 'playing' } });
}

let r: Rig;

/** A reduced-motion query that records its change listener. */
function fakeQuery(matches: boolean): MediaQueryList & { change: (() => void) | null } {
  const q = {
    matches, media: '(prefers-reduced-motion: reduce)', onchange: null, change: null as (() => void) | null,
    addEventListener: vi.fn((_t: string, fn: () => void) => {
      q.change = fn;
    }),
    removeEventListener: vi.fn(() => {
      q.change = null;
    }),
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  };
  return q as unknown as MediaQueryList & { change: (() => void) | null };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.transports.length = 0;
  localStorage.clear();
  sessionStorage.clear();
  delete document.documentElement.dataset.motion;
  r = rig();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('createApp wiring (12.3)', () => {
  it('builds each singleton once, and every consumer receives the same instances', () => {
    const app = createApp({ win: window, doc: document });

    for (const f of [createIdentity, createGameRuntime, createInputController, createAudioEngine, createSessionRuntime, createPwa]) {
      expect(vi.mocked(f)).toHaveBeenCalledTimes(1);
    }
    expect(h.transports).toHaveLength(1);
    expect(createIdentity).toHaveBeenCalledWith({ locks: window.navigator.locks ?? null, local: safeLocal, session: safeSession });
    expect(createGameRuntime).toHaveBeenCalledWith({ store: app.store });
    expect(createAudioEngine).toHaveBeenCalledWith({ store: app.store });
    expect(createSessionRuntime).toHaveBeenCalledWith({
      transport: h.transports[0], game: r.game, input: r.input, audio: r.audio, identity: r.identity, store: app.store, wsUrl,
    });
    expect(attachLifecycle).toHaveBeenCalledWith(window, document, {
      session: r.session, game: r.game, audio: r.audio, input: r.input, identity: r.identity, store: app.store,
    });
    expect(r.input.attach).toHaveBeenCalledWith(window);
    expect(r.audio.init).toHaveBeenCalledWith(window);
    expect(createPwa).toHaveBeenCalledWith({ store: app.store, session: r.session });
    expect(r.calls).toContain('pwa.start');

    expect(app.session).toBe(r.session);
    expect(app.game).toBe(r.game);
    expect(app.input).toBe(r.input);
    expect(app.audio).toBe(r.audio);
    expect(app.pwa).toBe(r.pwa);
    expect(app.store.get().session.s).toBe('idle');
    app.dispose();
  });

  it('input sends through the session, and hears every session change with its gen, epoch and seat', () => {
    const app = createApp();
    const sink = r.sink();
    expect(sink).not.toBeNull();
    expect(sink?.('ArrowLeft')).toBe(true);
    expect(r.session.sendDirection).toHaveBeenLastCalledWith('ArrowLeft');
    vi.mocked(r.session.sendDirection).mockReturnValueOnce(false);
    expect(sink?.('Stop')).toBe(false);

    r.setModel({ ...fakeModel(), lastGen: 3, epoch: 4, state: { s: 'lobby', room: { code: CODE, myIndex: 2, lastPhase: 'lobby' }, gen: 3 } });
    r.emitSession();
    expect(r.input.onSession).toHaveBeenLastCalledWith({ s: 'lobby', gen: 3, epoch: 4, me: 2 });

    r.setModel({
      ...fakeModel(), lastGen: 5, epoch: 4,
      state: { s: 'connecting', intent: { kind: 'quick' }, room: null, attempt: 0, gen: 5, retry: { preAdmit: 0, busy: 0, pending: 0, serverFull: 0, transient: 0 } },
    });
    r.emitSession();
    expect(r.input.onSession).toHaveBeenLastCalledWith({ s: 'connecting', gen: 5, epoch: 4, me: null });
    app.dispose();
  });

  it('the own-paddle lead reads the live input intent, audio hears ingest events, and net.unstable reaches the game', () => {
    const app = createApp();
    const src = r.intentSource();
    expect(src).not.toBeNull();
    r.input.desired = 1;
    expect(src?.()).toBe(1);
    r.input.desired = -1;
    expect(src?.()).toBe(-1);

    expect(r.game.onIngestEvents).toHaveBeenCalledWith(r.audio.onEvents);

    app.store.patch({ net: { unstable: true } });
    expect(r.game.setUnstable).toHaveBeenLastCalledWith(true);
    app.store.patch({ page: { visible: false, online: true } });
    expect(r.game.setUnstable).toHaveBeenCalledTimes(1);
    app.store.patch({ net: { unstable: false } });
    expect(r.game.setUnstable).toHaveBeenLastCalledWith(false);
    expect(r.game.setUnstable).toHaveBeenCalledTimes(2);
    app.dispose();
  });

  it('every 2 s while playing, the music intensity is the share of bricks destroyed', () => {
    vi.useFakeTimers();
    const app = createApp();
    r.setSummary({ bricksAtStart: 200, bricksAlive: 50 });

    vi.advanceTimersByTime(INTENSITY_INTERVAL_MS); // lobby: no intensity
    expect(r.audio.setIntensity).not.toHaveBeenCalled();

    playing(app);
    vi.advanceTimersByTime(INTENSITY_INTERVAL_MS - 1);
    expect(r.audio.setIntensity).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(r.audio.setIntensity).toHaveBeenLastCalledWith(0.75);

    r.setSummary({ bricksAlive: null });
    vi.advanceTimersByTime(INTENSITY_INTERVAL_MS);
    expect(r.audio.setIntensity).toHaveBeenLastCalledWith(1);

    r.setSummary({ bricksAtStart: null }); // no grid yet: nothing to measure
    vi.advanceTimersByTime(INTENSITY_INTERVAL_MS * 3);
    expect(r.audio.setIntensity).toHaveBeenCalledTimes(2);
    app.dispose();
  });

  it('the audio mix follows the settings from boot on', () => {
    const app = createApp();
    expect(r.audio.setMix).toHaveBeenCalledWith(app.settings.get());
    app.settings.update({ sfxVolume: 0.2 });
    expect(r.audio.setMix).toHaveBeenLastCalledWith(expect.objectContaining({ sfxVolume: 0.2 }));
    app.dispose();
  });

  it('the landing music scene is set once at boot, before the session exists to set any other', () => {
    const app = createApp();
    expect(vi.mocked(r.audio.setScene).mock.calls).toEqual([['landing']]);
    const [sceneAt] = vi.mocked(r.audio.setScene).mock.invocationCallOrder;
    const [sessionAt] = vi.mocked(createSessionRuntime).mock.invocationCallOrder;
    expect(sceneAt).toBeLessThan(sessionAt);
    expect(vi.mocked(r.audio.setMix).mock.invocationCallOrder[0]).toBeLessThan(sceneAt);
    app.dispose();
  });

  it('the motion slice and the root data-motion follow the setting and the system query', () => {
    const query: { change: (() => void) | null } = { change: null };
    const mql = {
      matches: true, media: '(prefers-reduced-motion: reduce)', onchange: null,
      addEventListener: (_t: string, fn: () => void) => {
        query.change = fn;
      },
      removeEventListener: () => {
        query.change = null;
      },
      addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    } as unknown as MediaQueryList;
    vi.spyOn(window, 'matchMedia').mockReturnValue(mql);

    const app = createApp();
    expect(window.matchMedia).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)');
    expect(app.store.get().motion.reduced).toBe(true);
    expect(document.documentElement.dataset.motion).toBe('reduced');

    (mql as { matches: boolean }).matches = false;
    query.change?.();
    expect(app.store.get().motion.reduced).toBe(false);
    expect(document.documentElement.dataset.motion).toBe('full');

    app.settings.update({ motion: 'reduced' });
    expect(app.store.get().motion.reduced).toBe(true);
    expect(document.documentElement.dataset.motion).toBe('reduced');
    app.dispose();
    expect(query.change).toBeNull();
  });

  it('an injected window and document receive every attachment, and the globals none', () => {
    const query = fakeQuery(true);
    const matchMedia = vi.fn(() => query);
    const globalMatchMedia = vi.spyOn(window, 'matchMedia');
    const win = { matchMedia, navigator: { locks: undefined } } as unknown as Window;
    const doc = document.implementation.createHTMLDocument('');

    const app = createApp({ win, doc });
    expect(createIdentity).toHaveBeenCalledWith({ locks: null, local: safeLocal, session: safeSession });
    expect(r.input.attach).toHaveBeenCalledWith(win);
    expect(r.audio.init).toHaveBeenCalledWith(win);
    expect(attachLifecycle).toHaveBeenCalledWith(win, doc, {
      session: r.session, game: r.game, audio: r.audio, input: r.input, identity: r.identity, store: app.store,
    });

    expect(matchMedia).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)');
    expect(globalMatchMedia).not.toHaveBeenCalled();
    expect(app.store.get().motion.reduced).toBe(true);
    expect(doc.documentElement.dataset.motion).toBe('reduced');
    expect(document.documentElement.dataset.motion).toBeUndefined();

    (query as { matches: boolean }).matches = false;
    query.change?.();
    expect(doc.documentElement.dataset.motion).toBe('full');
    expect(document.documentElement.dataset.motion).toBeUndefined();
    app.dispose();
    expect(query.removeEventListener).toHaveBeenCalled();
  });
});

describe('createApp dispose', () => {
  it('a boot lock granted after dispose is released once the identity settles', async () => {
    const actual = await vi.importActual<typeof import('../session/identity')>('../session/identity');
    vi.mocked(createIdentity).mockImplementation(actual.createIdentity);
    const grants: Array<() => void> = [];
    const released: string[] = [];
    const locks = {
      request: vi.fn((name: string, _opts: LockOptions, cb: (lock: Lock | null) => Promise<void> | null) =>
        new Promise<void>((done) => {
          grants.push(() => {
            void Promise.resolve(cb({ name, mode: 'exclusive' } as Lock)).then(() => {
              released.push(name);
              done();
            });
          });
        })),
      query: vi.fn(),
    } as unknown as LockManager;
    const win = { matchMedia: () => fakeQuery(false), navigator: { locks } } as unknown as Window;

    const app = createApp({ win, doc: document });
    expect(locks.request).toHaveBeenCalledTimes(1); // the boot lock, still pending
    app.dispose();
    expect(released).toEqual([]);

    grants[0]();
    await vi.waitFor(() => expect(released).toHaveLength(1));
    expect(released[0]).toMatch(/^pongo-sid:/);
    expect(locks.request).toHaveBeenCalledTimes(1);
  });

  it('undoes every step in reverse, once', () => {
    vi.useFakeTimers();
    const app = createApp();
    r.calls.length = 0;
    app.dispose();
    expect(r.calls).toEqual([
      'pwa.dispose', 'lifecycle.detach', 'audio.detach', 'input.detach', 'game.stopAudioFeed',
      'game.setIntentSource(null)', 'session.unsubscribe', 'input.setSink(null)', 'session.dispose', 'audio.dispose',
      'identity.onPageHide(true)',
    ]);

    // The unrecorded steps are gone too: the interval, the store and settings subscriptions, the motion watcher.
    vi.mocked(r.audio.setMix).mockClear();
    playing(app);
    r.setSummary({ bricksAtStart: 10, bricksAlive: 5 });
    vi.advanceTimersByTime(INTENSITY_INTERVAL_MS * 2);
    expect(r.audio.setIntensity).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    app.store.patch({ net: { unstable: true } });
    expect(r.game.setUnstable).not.toHaveBeenCalled();
    app.settings.update({ musicVolume: 0.1, motion: 'reduced' });
    expect(r.audio.setMix).not.toHaveBeenCalled();
    expect(app.store.get().motion.reduced).toBe(false);
    expect(document.documentElement.dataset.motion).toBe('full');

    app.dispose();
    expect(r.calls).toHaveLength(11);
  });

  it('a failing dispose step is logged and the remaining steps still run', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = createApp();
    vi.mocked(r.pwa.dispose).mockImplementation(() => {
      throw new Error('pwa broke');
    });
    r.calls.length = 0;
    app.dispose();
    expect(r.calls).toContain('session.dispose');
    expect(r.calls[r.calls.length - 1]).toBe('identity.onPageHide(true)');
    expect(error).toHaveBeenCalled();
  });

  it('a construction step that throws undoes the steps already taken and rethrows', () => {
    vi.useFakeTimers();
    vi.mocked(createPwa).mockImplementation(() => {
      throw new Error('no service worker for you');
    });
    expect(() => createApp()).toThrow('no service worker for you');
    expect(r.calls).toEqual([
      'input.setSink', 'game.setIntentSource', // the wiring, before the failure
      'lifecycle.detach', 'audio.detach', 'input.detach', 'game.stopAudioFeed', 'game.setIntentSource(null)',
      'session.unsubscribe', 'input.setSink(null)', 'session.dispose', 'audio.dispose', 'identity.onPageHide(true)',
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a failure before the session exists attaches nothing and still releases the identity', () => {
    vi.mocked(createAudioEngine).mockImplementation(() => {
      throw new Error('no audio');
    });
    expect(() => createApp()).toThrow('no audio');
    expect(createSessionRuntime).not.toHaveBeenCalled();
    expect(attachLifecycle).not.toHaveBeenCalled();
    expect(r.input.attach).not.toHaveBeenCalled();
    expect(r.calls).toEqual(['identity.onPageHide(true)']);
  });
});
