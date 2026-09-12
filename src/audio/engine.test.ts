import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAudioEngine, MIX, musicGain, sfxGain } from './engine';
import { SAMPLE_URLS } from './samples';
import type { AudioEngine } from './types';
import type { GameEvent, IngestEventCtx, Seat } from '../game/events';
import { IMMEDIATE } from '../game/events';
import { createStore } from '../lib/store';
import { initialAppState } from '../state/appStore';
import type { AppStore } from '../state/appStore';
import { DEFAULT_SETTINGS } from '../lib/settings';
import type { Settings } from '../lib/settings';
import { TUNING } from '../config/tuning';
import { seeded } from '../lib/random';
import { stats } from '../state/stats';
import { FakeAudioContext, FakeCompressor, FakeGainNode } from '../test/fakes/FakeAudioContext';
import type { FakeAudioOptions } from '../test/fakes/FakeAudioContext';

// ---- A Proxy-wrapped fake of the 'tone' module (same model as music.test.ts) -----------------------------
interface Call { name: string; args: unknown[] }
interface FakeToneNode { kind: string; calls: Call[]; disposed: boolean }
type Rec = Record<string, unknown>;
const FORBIDDEN = new Set(['Transport', 'Destination', 'Master', 'context', 'Listener', 'Draw']);
const PARAMS = new Set(['frequency', 'gain', 'bpm', 'volume', 'Q', 'detune', 'wet']);

function makeParam(): Rec {
  const t: Rec = { value: 0 };
  return new Proxy(t, {
    get(target, p) {
      if (p in target) return target[p as string];
      if (typeof p !== 'string' || p === 'then') return undefined;
      return (...args: unknown[]) => {
        if (typeof args[0] === 'number') target.value = args[0];
      };
    },
  });
}

/** One instance per test file run, like the ES module cache: a second engine (HMR) gets the same module. */
function createFakeTone() {
  const created: FakeToneNode[] = [];
  const forbidden: string[] = [];
  const setContextCalls: unknown[] = [];
  const importCtx = new FakeAudioContext();
  let current: { rawContext: unknown; lookAhead: number; dispose(): void } = {
    rawContext: importCtx, lookAhead: 0.1, dispose: () => void importCtx.close(),
  };
  const transport = {
    state: 'stopped', bpm: makeParam(), calls: [] as string[],
    start() { this.state = 'started'; this.calls.push('start'); },
    pause() { this.state = 'paused'; this.calls.push('pause'); },
    stop() { this.state = 'stopped'; this.calls.push('stop'); },
    cancel() { this.calls.push('cancel'); },
  };
  const klass = (kind: string) => function FakeClass(): unknown {
    const target: FakeToneNode = { kind, calls: [], disposed: false };
    const params = new Map<string, Rec>();
    const proxy: unknown = new Proxy(target as unknown as Rec, {
      get(t, p) {
        if (p in t) return t[p as string];
        if (typeof p !== 'string' || p === 'then') return undefined;
        if (PARAMS.has(p)) {
          if (!params.has(p)) params.set(p, makeParam());
          return params.get(p);
        }
        return (...a: unknown[]) => {
          target.calls.push({ name: p, args: a });
          if (p === 'dispose') target.disposed = true;
          return proxy;
        };
      },
    });
    created.push(target);
    return proxy;
  };
  const mod: Rec = {
    setContext(ctx: unknown, disposeOld = false) {
      setContextCalls.push(ctx);
      if (disposeOld) current.dispose();
      current = { rawContext: ctx, lookAhead: 0.1, dispose: () => {} };
    },
    getContext: () => current,
    getTransport: () => transport,
    getDestination: () => ({}),
    connect: () => {},
    Reverb: klass('Reverb'), PingPongDelay: klass('PingPongDelay'), Filter: klass('Filter'),
    PolySynth: klass('PolySynth'), FMSynth: klass('FMSynth'), MetalSynth: klass('MetalSynth'),
    Noise: klass('Noise'), Gain: klass('Gain'), Loop: klass('Loop'), Sequence: klass('Sequence'),
    Transport: transport, Destination: {}, Master: {}, context: current, Listener: {}, Draw: {},
  };
  const module = new Proxy(mod, {
    get(t, p) {
      if (typeof p === 'string' && FORBIDDEN.has(p)) forbidden.push(p);
      return t[p as string];
    },
  }) as unknown as typeof import('tone');
  return { module, created, forbidden, setContextCalls, transport, importCtx, current: () => current };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
};

interface Setup {
  engine: AudioEngine; store: AppStore; win: EventTarget; detach: () => void;
  fire(type: string): void; ctx(): FakeAudioContext; fetched: string[]; signals: AbortSignal[];
  tone: ReturnType<typeof createFakeTone> | null; loads: number;
}

function setup(o: {
  ctxOpts?: FakeAudioOptions; settings?: Partial<Settings>; shared?: { tone: ReturnType<typeof createFakeTone> | null };
  failFirst?: readonly string[];
} = {}): Setup {
  const store = createStore(initialAppState());
  const win = new EventTarget();
  const shared = o.shared ?? { tone: null };
  const failing = new Set(o.failFirst ?? []);
  const s: Setup = {
    engine: null as unknown as AudioEngine, store, win, detach: () => {},
    fire: (type) => void win.dispatchEvent(new Event(type)),
    ctx: () => s.engine.context as unknown as FakeAudioContext,
    fetched: [], signals: [], tone: null, loads: 0,
  };
  s.engine = createAudioEngine({
    store, rand: seeded(3), tuning: TUNING,
    createContext: FakeAudioContext.factory(o.ctxOpts),
    loadTone: async () => {
      s.loads++;
      shared.tone ??= createFakeTone();
      s.tone = shared.tone;
      return shared.tone.module;
    },
    fetchBytes: async (url, signal) => {
      s.fetched.push(url);
      s.signals.push(signal);
      if (failing.delete(url)) throw new Error(`HTTP 503 for ${url}`);
      return new ArrayBuffer(8);
    },
  });
  s.engine.setMix({ ...DEFAULT_SETTINGS, ...o.settings });
  s.detach = s.engine.init(win as unknown as Window);
  return s;
}

const buses = (ctx: FakeAudioContext) => {
  const [master, sfxBus, musicBus] = ctx.nodesOf('gain') as FakeGainNode[];
  return { master, sfxBus, musicBus, limiter: ctx.nodesOf('compressor')[0] as FakeCompressor };
};
const lastEvent = (g: FakeGainNode) => g.gain.events[g.gain.events.length - 1];
const ic = (myIndex: Seat | null = 3, headless = false): IngestEventCtx => ({ nowMs: 0, displayMs: 1000, myIndex, headless });
let seq = 0;
const ev = (e: { k: GameEvent['k']; tick: number } & Record<string, unknown>): GameEvent =>
  ({ seq: seq++, x: 450, y: 450, conf: 1, stale: false, ...e }) as unknown as GameEvent;

beforeEach(() => {
  FakeAudioContext.reset();
  stats.audio.dropped = 0;
});

describe('AudioEngine unlock', () => {
  it('creates no context before a gesture; keydown creates the one context and resumes it', async () => {
    const t = setup();
    expect(t.engine.context).toBeNull();
    expect(t.store.get().audio).toEqual({ state: 'uninitialized', musicReady: false });
    expect(FakeAudioContext.instances).toHaveLength(0);
    t.fire('keydown');
    // The fake Tone "import" makes its own context as the real module does; the engine made exactly one.
    const engineMade = () => FakeAudioContext.instances.filter((c) => c !== t.tone?.importCtx);
    expect(engineMade()).toEqual([t.ctx()]);
    expect(t.ctx().calls.resume).toBe(1);
    await flush();
    expect(t.engine.state).toBe('running');
    expect(t.store.get().audio.state).toBe('running');
    t.fire('pointerdown');
    expect(engineMade()).toHaveLength(1);
    expect(FakeAudioContext.instances.filter((c) => c.state !== 'closed')).toEqual([t.ctx()]);
  });

  it('builds master -> limiter -> destination with the sfx and music buses on the perceptual curve', () => {
    const t = setup({ settings: { sfxVolume: 0.5, musicVolume: 1 } });
    t.fire('click');
    const ctx = t.ctx();
    const b = buses(ctx);
    expect(b.limiter.threshold.value).toBe(TUNING.audio.limiterThresholdDb);
    expect(b.limiter.ratio.value).toBe(TUNING.audio.limiterRatio);
    expect(b.limiter.attack.value).toBe(0.003);
    expect(b.limiter.release.value).toBe(0.15);
    expect(b.limiter.outputs).toEqual([ctx.destination]);
    expect(b.master.outputs).toEqual([b.limiter]);
    expect(b.sfxBus.outputs).toEqual([b.master]);
    expect(b.musicBus.outputs).toEqual([b.master]);
    expect(b.sfxBus.gain.value).toBeCloseTo(0.25 * TUNING.audio.sfxGainScale, 9);
    expect(b.musicBus.gain.value).toBeCloseTo(MIX.musicGainScale, 9);
  });

  it('re-arms on suspended and interrupted, and a gesture resumes the same context', async () => {
    const t = setup();
    t.fire('touchend');
    await flush();
    const ctx = t.ctx();
    for (const s of ['interrupted', 'suspended'] as const) {
      ctx.setState(s);
      expect(t.store.get().audio.state).toBe(s);
      const before = ctx.calls.resume;
      t.fire('keydown');
      expect(ctx.calls.resume).toBe(before + 1);
      await flush();
      expect(t.store.get().audio.state).toBe('running');
    }
    expect(FakeAudioContext.instances.filter((c) => c !== t.tone?.importCtx)).toHaveLength(1);
  });

  it('fetches the 9 samples once, after the first running state', async () => {
    const t = setup({ ctxOpts: { resume: 'pending' } });
    t.fire('click');
    await flush();
    expect(t.store.get().audio.state).toBe('locked');
    expect(t.fetched).toEqual([]);
    t.ctx().setState('running');
    await flush();
    expect(t.fetched.slice().sort()).toEqual(Object.values(SAMPLE_URLS).sort());
    t.ctx().setState('suspended');
    t.fire('keydown');
    t.ctx().setState('running');
    await flush();
    expect(t.fetched).toHaveLength(9);
  });

  it('retries only the samples that failed, on the next running state', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = setup({ failFirst: [SAMPLE_URLS.hit0, SAMPLE_URLS.lost1] });
    t.fire('click');
    await flush();
    expect(t.fetched).toHaveLength(9);
    t.ctx().setState('suspended');
    t.fire('keydown');
    await flush();
    expect(t.store.get().audio.state).toBe('running');
    expect(t.fetched.slice(9).sort()).toEqual([SAMPLE_URLS.hit0, SAMPLE_URLS.lost1].sort());
    t.ctx().setState('suspended');
    t.fire('keydown');
    await flush();
    expect(t.fetched).toHaveLength(11);
    warn.mockRestore();
  });

  it('drops cues while locked and loads no music', async () => {
    const t = setup({ ctxOpts: { resume: 'pending' } });
    t.fire('pointerdown');
    await flush();
    expect(t.engine.state).toBe('locked');
    t.engine.onEvents([ev({ k: 'go', tick: IMMEDIATE }), ev({ k: 'ballResized', ball: 1, from: 8, to: 12, tick: 40 })], ic());
    t.engine.playUi('uiTap');
    expect(t.ctx().started).toEqual([]);
    expect(stats.audio.dropped).toBe(3);
    expect(t.loads).toBe(0);
    expect(t.store.get().audio.musicReady).toBe(false);
  });

  it('drops cues before any context exists', () => {
    const t = setup();
    t.engine.onEvents([ev({ k: 'go', tick: IMMEDIATE })], ic());
    expect(stats.audio.dropped).toBe(1);
    expect(FakeAudioContext.instances).toHaveLength(0);
  });

  it('reports unsupported without an AudioContext constructor', () => {
    const store = createStore(initialAppState());
    const win = new EventTarget();
    const engine = createAudioEngine({ store });
    engine.init(win as unknown as Window);
    win.dispatchEvent(new Event('keydown'));
    expect(engine.state).toBe('unsupported');
    expect(engine.context).toBeNull();
    expect(store.get().audio.state).toBe('unsupported');
  });

  it('reports unsupported when only the prefixed webkitAudioContext exists, and uses AudioContext when present', async () => {
    const quiet = { loadTone: () => new Promise<never>(() => {}), fetchBytes: async () => new ArrayBuffer(8) };
    const prefixed = Object.assign(new EventTarget(), { webkitAudioContext: FakeAudioContext });
    const a = createAudioEngine({ store: createStore(initialAppState()), ...quiet });
    a.init(prefixed as unknown as Window);
    prefixed.dispatchEvent(new Event('pointerdown'));
    expect(a.state).toBe('unsupported');
    expect(a.context).toBeNull();
    expect(FakeAudioContext.instances).toHaveLength(0);

    const plain = Object.assign(new EventTarget(), { AudioContext: FakeAudioContext });
    const b = createAudioEngine({ store: createStore(initialAppState()), ...quiet });
    b.init(plain as unknown as Window);
    plain.dispatchEvent(new Event('pointerdown'));
    expect(FakeAudioContext.instances).toHaveLength(1);
    expect(b.context).toBe(FakeAudioContext.instances[0]);
    await b.dispose();
  });

  it('a context that fails to build is closed, kept by nobody, and the engine reports unsupported for good', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = createStore(initialAppState());
    const win = new EventTarget();
    const made: FakeAudioContext[] = [];
    const engine = createAudioEngine({
      store,
      createContext: () => {
        const c = new FakeAudioContext();
        (c as unknown as Record<string, unknown>).createStereoPanner = undefined;   // as in Safari before 14.1
        made.push(c);
        return c.asAudioContext();
      },
      loadTone: () => new Promise<never>(() => {}),
      fetchBytes: async () => new ArrayBuffer(8),
    });
    engine.init(win as unknown as Window);
    const remove = vi.spyOn(win, 'removeEventListener');
    win.dispatchEvent(new Event('pointerdown'));
    expect(made).toHaveLength(1);
    expect(made[0].calls.close).toBe(1);
    expect(made[0].state).toBe('closed');
    expect(made[0].calls.resume).toBe(0);
    expect(engine.context).toBeNull();
    expect(engine.state).toBe('unsupported');
    expect(store.get().audio.state).toBe('unsupported');
    expect(remove).toHaveBeenCalledTimes(4);

    win.dispatchEvent(new Event('keydown'));
    expect(made).toHaveLength(1);
    expect(engine.state).toBe('unsupported');
    engine.onEvents([ev({ k: 'go', tick: IMMEDIATE })], ic());
    expect(stats.audio.dropped).toBe(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('AudioEngine music', () => {
  it('a context created running still starts the music', async () => {
    const t = setup({ ctxOpts: { state: 'running' } });
    t.engine.setScene('landing');
    t.fire('pointerdown');
    expect(t.ctx().calls.resume).toBe(0);
    await flush();
    expect(t.loads).toBe(1);
    expect(t.store.get().audio).toEqual({ state: 'running', musicReady: true });
    expect(t.tone!.transport.state).toBe('started');
  });

  it('keeps one AudioContext after Tone loads and never reads the Tone module constants', async () => {
    const t = setup();
    t.engine.setScene('playing');
    t.fire('click');
    await flush();
    const tone = t.tone!;
    expect(tone.current().rawContext).toBe(t.engine.context);
    expect(tone.setContextCalls).toEqual([t.engine.context]);
    expect(FakeAudioContext.instances.filter((c) => c.state !== 'closed')).toEqual([t.ctx()]);
    t.engine.setHidden(true);
    t.engine.setHidden(false);
    t.engine.setIntensity(0.7);
    t.engine.onEvents([ev({ k: 'gameOver', winner: 3, derived: false, tick: IMMEDIATE })], ic(3));
    await t.engine.dispose();
    expect(tone.forbidden).toEqual([]);
  });

  it('keeps one live context across an HMR-style dispose and re-create', async () => {
    const shared = { tone: null as ReturnType<typeof createFakeTone> | null };
    const a = setup({ shared });
    a.fire('click');
    await flush();
    await a.engine.dispose();
    const b = setup({ shared });
    b.fire('click');
    await flush();
    expect(FakeAudioContext.instances.filter((c) => c.state !== 'closed')).toEqual([b.ctx()]);
    expect(shared.tone!.current().rawContext).toBe(b.engine.context);
  });

  it('plays the win sting when the gameOver event names me, and ducks the music on a goal against me', async () => {
    const t = setup();
    t.engine.setScene('finished');
    t.fire('click');
    await flush();
    t.engine.onEvents([ev({ k: 'gameOver', winner: 2, derived: false, tick: IMMEDIATE })], ic(2));
    const sting = t.tone!.created.filter((n) => n.kind === 'PolySynth')[2];
    expect(sting.calls.filter((c) => c.name === 'triggerAttackRelease').map((c) => c.args[0])).toEqual(['C5', 'E5', 'G5', 'C6']);

    const ctx = t.ctx();
    t.engine.onEvents([ev({ k: 'goal', ball: 1, wall: 3, scorer: -1, repeat: 0, u: 0.5, tick: 42 })], ic(3));
    const ducker = (ctx.nodesOf('gain') as FakeGainNode[]).find((g) => g.outputs.includes(buses(ctx).musicBus))!;
    const targets = ducker.gain.events.filter((e) => e.type === 'target');
    expect(targets[0].value).toBeCloseTo(Math.pow(10, TUNING.audio.goalDuckDb / 20), 9);
    expect(targets[0].time).toBeCloseTo(ctx.currentTime + 0.05, 9);
    expect(targets[1].time).toBeCloseTo(ctx.currentTime + 0.05 + TUNING.audio.goalDuckS, 9);
  });

  it('a gameOver while hidden is dropped by the engine, even in a batch that is not headless', async () => {
    const t = setup();
    t.engine.setScene('finished');
    t.fire('click');
    await flush();
    t.engine.setHidden(true);
    t.engine.onEvents([ev({ k: 'gameOver', winner: 3, derived: false, tick: IMMEDIATE })], ic(3, false));
    const sting = t.tone!.created.filter((n) => n.kind === 'PolySynth')[2];
    expect(sting.calls.some((c) => c.name === 'triggerAttackRelease')).toBe(false);
    // Counted as a drop: the event never reached the mixer (which would have handed `win` to the music).
    expect(stats.audio.dropped).toBe(1);
  });

  it('a headless gameOver plays nothing while visible (the headless ended() call)', async () => {
    const t = setup();
    t.engine.setScene('finished');
    t.fire('click');
    await flush();
    const sting = t.tone!.created.filter((n) => n.kind === 'PolySynth')[2];
    const notes = () => sting.calls.filter((c) => c.name === 'triggerAttackRelease').map((c) => c.args[0]);
    t.engine.onEvents([ev({ k: 'gameOver', winner: 3, derived: false, tick: IMMEDIATE })], ic(3, true));
    expect(notes()).toEqual([]);
    expect(stats.audio.dropped).toBe(1);
    t.engine.onEvents([ev({ k: 'gameOver', winner: 3, derived: false, tick: IMMEDIATE })], ic(3, false));
    expect(notes()).toEqual(['C5', 'E5', 'G5', 'C6']);
  });
});

describe('AudioEngine mix and lifecycle', () => {
  it('setMix follows the perceptual curve and mutes pause the music', async () => {
    const t = setup();
    t.engine.setScene('lobby');
    t.fire('click');
    await flush();
    const b = buses(t.ctx());
    const s: Settings = { ...DEFAULT_SETTINGS, sfxVolume: 0.5, musicVolume: 0.8 };
    t.engine.setMix(s);
    expect(lastEvent(b.sfxBus)).toMatchObject({ type: 'target', extra: MIX.gainTcS });
    expect(lastEvent(b.sfxBus).value).toBeCloseTo(sfxGain(s, TUNING.audio.sfxGainScale), 9);
    expect(lastEvent(b.musicBus).value).toBeCloseTo(musicGain(s), 9);
    expect(musicGain(s)).toBeCloseTo(0.64 * 0.6, 9);
    expect(t.tone!.transport.state).toBe('started');
    t.engine.setMix({ ...s, musicMuted: true, sfxMuted: true });
    expect(lastEvent(b.musicBus).value).toBe(0);
    expect(lastEvent(b.sfxBus).value).toBe(0);
    expect(t.tone!.transport.state).toBe('paused');
  });

  it('setHidden(true) fades sfxBus to 0 over hiddenFadeS, stops voices and pauses the music', async () => {
    const t = setup();
    t.engine.setScene('playing');
    t.fire('click');
    await flush();
    const ctx = t.ctx();
    ctx.currentTime = 3;
    t.engine.onEvents([ev({ k: 'ballResized', ball: 1, from: 8, to: 12, tick: 40 })], ic());
    const voiceSrc = ctx.started[ctx.started.length - 1].node;
    const b = buses(ctx);
    t.engine.setHidden(true);
    const fade = lastEvent(b.sfxBus);
    expect(fade).toMatchObject({ type: 'linear', value: 0 });
    expect(fade.time).toBeCloseTo(3 + TUNING.audio.hiddenFadeS, 9);
    expect(voiceSrc.stoppedAt).toBeCloseTo(3 + TUNING.audio.hiddenFadeS, 9);
    expect(t.tone!.transport.state).toBe('paused');
    const before = ctx.started.length;
    t.engine.onEvents([ev({ k: 'go', tick: IMMEDIATE })], ic());
    t.engine.playUi('uiTap');
    expect(ctx.started.length).toBe(before);

    t.engine.setHidden(false);
    expect(lastEvent(b.sfxBus)).toMatchObject({ type: 'target', extra: MIX.gainTcS });
    expect(lastEvent(b.sfxBus).value).toBeCloseTo(sfxGain(DEFAULT_SETTINGS, TUNING.audio.sfxGainScale), 9);
    expect(t.tone!.transport.state).toBe('started');
  });

  it('visible resumes a context the OS suspended while hidden, without a gesture', async () => {
    const t = setup();
    t.fire('click');
    await flush();
    const ctx = t.ctx();
    t.engine.setHidden(true);
    ctx.setState('suspended');
    const before = ctx.calls.resume;
    t.engine.setHidden(false);
    expect(ctx.calls.resume).toBe(before + 1);
    await flush();
    expect(t.store.get().audio.state).toBe('running');
  });

  it('dispose stops everything, closes the context, aborts fetches and removes the listeners', async () => {
    const t = setup();
    t.engine.setScene('playing');
    t.fire('click');
    await flush();
    const ctx = t.ctx();
    t.engine.onEvents([ev({ k: 'ballResized', ball: 1, from: 8, to: 12, tick: 40 })], ic());
    const src = ctx.started[ctx.started.length - 1].node;
    const p1 = t.engine.dispose();
    const p2 = t.engine.dispose();
    expect(p2).toBe(p1);
    await p1;
    expect(src.stoppedAt).not.toBeNull();
    expect(ctx.calls.close).toBe(1);
    expect(t.signals.every((sg) => sg.aborted)).toBe(true);
    expect(t.tone!.transport.calls.slice(-2)).toEqual(['stop', 'cancel']);
    expect(t.tone!.created.every((n) => n.disposed)).toBe(true);
    expect(t.store.get().audio).toEqual({ state: 'closed', musicReady: false });
    t.fire('keydown');
    expect(FakeAudioContext.instances.filter((c) => c !== t.tone!.importCtx)).toHaveLength(1);
    expect(t.engine.init(t.win as unknown as Window)).toBeTypeOf('function');
    t.fire('keydown');
    expect(ctx.calls.resume).toBe(1);
  });

  describe('crash mute (setSuppressed)', () => {
    const musicGate = (ctx: FakeAudioContext): FakeGainNode => {
      const gains = ctx.nodesOf('gain') as FakeGainNode[];
      const ducker = gains.find((g) => g.outputs.includes(buses(ctx).musicBus))!;
      return gains.find((g) => g.outputs.includes(ducker))!;
    };
    const lastGateTarget = (ctx: FakeAudioContext): number => {
      const e = musicGate(ctx).gain.events.filter((x) => x.type === 'target');
      return e[e.length - 1].value;
    };
    const resized = () => [ev({ k: 'ballResized', ball: 1, from: 8, to: 12, tick: 40 })];

    async function live() {
      const t = setup();
      t.engine.setScene('playing');
      t.fire('click');
      await flush();
      const ctx = t.ctx();
      ctx.currentTime = 2;
      return { t, ctx, b: buses(ctx), tr: t.tone!.transport };
    }

    it('a lifecycle setHidden(false) cannot lift it: sfx, cues and music stay silent', async () => {
      const { t, ctx, b, tr } = await live();
      expect(tr.state).toBe('started');
      const mark = b.sfxBus.gain.events.length;
      t.engine.setSuppressed(true);
      expect(lastEvent(b.sfxBus)).toMatchObject({ type: 'linear', value: 0 });
      expect(lastEvent(b.sfxBus).time).toBeCloseTo(2 + TUNING.audio.hiddenFadeS, 9);
      expect(tr.state).toBe('paused');

      ctx.setState('suspended');
      const resumes = ctx.calls.resume;
      t.engine.setHidden(false);   // goLive, pageshow or resume
      expect(lastEvent(b.sfxBus)).toMatchObject({ type: 'linear', value: 0 });
      expect(b.sfxBus.gain.events.slice(mark).some((e) => e.type === 'target')).toBe(false);
      expect(tr.state).toBe('paused');
      expect(lastGateTarget(ctx)).toBe(0);
      expect(ctx.calls.resume).toBe(resumes);

      const started = ctx.started.length;
      t.engine.onEvents(resized(), ic());
      t.engine.playUi('uiTap');
      expect(ctx.started.length).toBe(started);
      expect(stats.audio.dropped).toBe(1);
    });

    it('setSuppressed(false) while visible restores the sfx mix, unhides the music and resumes the context', async () => {
      const { t, ctx, b, tr } = await live();
      t.engine.setSuppressed(true);
      t.engine.setHidden(false);
      ctx.setState('suspended');
      const resumes = ctx.calls.resume;
      t.engine.setSuppressed(false);
      expect(lastEvent(b.sfxBus)).toMatchObject({ type: 'target', extra: MIX.gainTcS });
      expect(lastEvent(b.sfxBus).value).toBeCloseTo(sfxGain(DEFAULT_SETTINGS, TUNING.audio.sfxGainScale), 9);
      expect(tr.state).toBe('started');
      expect(lastGateTarget(ctx)).toBe(1);
      expect(ctx.calls.resume).toBe(resumes + 1);
      await flush();
      const started = ctx.started.length;
      t.engine.onEvents(resized(), ic());
      expect(ctx.started.length).toBeGreaterThan(started);
    });

    it('setSuppressed(false) while hidden stays silent until the page is visible', async () => {
      const { t, ctx, b, tr } = await live();
      t.engine.setHidden(true);
      t.engine.setSuppressed(true);
      const mark = b.sfxBus.gain.events.length;
      t.engine.setSuppressed(false);
      expect(lastEvent(b.sfxBus)).toMatchObject({ type: 'linear', value: 0 });
      expect(b.sfxBus.gain.events.slice(mark).some((e) => e.type === 'target')).toBe(false);
      expect(tr.state).toBe('paused');
      const started = ctx.started.length;
      t.engine.onEvents(resized(), ic());
      expect(ctx.started.length).toBe(started);

      t.engine.setHidden(false);
      expect(lastEvent(b.sfxBus)).toMatchObject({ type: 'target', extra: MIX.gainTcS });
      expect(tr.state).toBe('started');
    });

    it('setMix while suppressed leaves the sfx bus at 0', async () => {
      const { t, b } = await live();
      t.engine.setSuppressed(true);
      const mark = b.sfxBus.gain.events.length;
      t.engine.setMix({ ...DEFAULT_SETTINGS, sfxVolume: 0.9 });
      expect(b.sfxBus.gain.events.slice(mark)).toEqual([]);
      expect(b.sfxBus.gain.value).toBe(0);
    });

    it('a context created while suppressed starts with the sfx bus at 0 and the music hidden', async () => {
      const t = setup();
      t.engine.setScene('playing');
      t.engine.setSuppressed(true);
      t.fire('click');
      await flush();
      expect(buses(t.ctx()).sfxBus.gain.value).toBe(0);
      expect(t.store.get().audio.musicReady).toBe(true);
      expect(t.tone!.transport.state).not.toBe('started');
      expect(lastGateTarget(t.ctx())).toBe(0);
    });
  });

  it('the init detach removes the gesture listeners', () => {
    const t = setup();
    const remove = vi.spyOn(t.win, 'removeEventListener');
    t.detach();
    expect(remove).toHaveBeenCalledTimes(4);
    t.fire('keydown');
    expect(t.engine.context).toBeNull();
  });
});
