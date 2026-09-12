import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Music, MUSIC } from './music';
import { FakeAudioContext, FakeGainNode } from '../test/fakes/FakeAudioContext';

// ---- A Proxy-wrapped fake of the 'tone' module ----------------------------------------------------------
// Every class records its construction and every call; reading a module constant (Transport, Destination,
// Master, context, Listener, Draw) is recorded as a violation, because those stay bound to the context Tone
// made at import. "Importing" the fake creates that import-time context, as the real module does.

interface Call { name: string; args: unknown[] }
interface FakeToneNode { kind: string; args: unknown[]; calls: Call[]; disposed: boolean; mute: boolean }
interface FakeParam { value: number; calls: Call[] }
type Rec = Record<string, unknown>;
const PARAMS = new Set(['frequency', 'gain', 'bpm', 'volume', 'Q', 'detune', 'wet']);
const FORBIDDEN = new Set(['Transport', 'Destination', 'Master', 'context', 'Listener', 'Draw']);

function makeParam(): FakeParam {
  const t = { value: 0, calls: [] as Call[] };
  return new Proxy(t, {
    get(target, p) {
      if (p in target) return (target as unknown as Rec)[p as string];
      if (typeof p !== 'string' || p === 'then') return undefined;
      return (...args: unknown[]) => {
        target.calls.push({ name: p, args });
        if (typeof args[0] === 'number') target.value = args[0];
      };
    },
  });
}

function createFakeTone() {
  const created: FakeToneNode[] = [];
  const proxies = new WeakMap<FakeToneNode, Rec>();
  const forbidden: string[] = [];
  const setContextCalls: { ctx: unknown; disposeOld: boolean }[] = [];
  const connects: { src: unknown; dst: unknown }[] = [];
  const importCtx = new FakeAudioContext();
  const wrap = (raw: unknown, onDispose: () => void) => ({ rawContext: raw, lookAhead: 0.1, dispose: onDispose });
  let current = wrap(importCtx, () => void importCtx.close());
  const transport = {
    state: 'stopped' as 'started' | 'stopped' | 'paused', bpm: makeParam(), calls: [] as string[],
    start() { this.state = 'started'; this.calls.push('start'); },
    pause() { this.state = 'paused'; this.calls.push('pause'); },
    stop() { this.state = 'stopped'; this.calls.push('stop'); },
    cancel() { this.calls.push('cancel'); },
  };
  const destination = { kind: 'Destination' };
  const klass = (kind: string) => function FakeClass(...args: unknown[]): unknown {
    const target = { kind, args, calls: [] as Call[], disposed: false, mute: false };
    const params = new Map<string, FakeParam>();
    const proxy: unknown = new Proxy(target, {
      get(t, p) {
        if (p in t) return (t as unknown as Rec)[p as string];
        if (typeof p !== 'string' || p === 'then') return undefined;
        if (PARAMS.has(p)) {
          if (!params.has(p)) params.set(p, makeParam());
          return params.get(p);
        }
        return (...a: unknown[]) => {
          t.calls.push({ name: p, args: a });
          if (p === 'dispose') t.disposed = true;
          return proxy;
        };
      },
    });
    created.push(target);
    proxies.set(target, proxy as Rec);
    return proxy;
  };
  const mod: Rec = {
    setContext(ctx: unknown, disposeOld = false) {
      setContextCalls.push({ ctx, disposeOld });
      if (disposeOld) current.dispose();
      // As in Tone, disposing the global Context later closes the raw context it wraps.
      current = wrap(ctx, () => void (ctx as FakeAudioContext).close());
    },
    getContext: () => current,
    getTransport: () => transport,
    getDestination: () => destination,
    connect: (src: unknown, dst: unknown) => void connects.push({ src, dst }),
    Reverb: klass('Reverb'), PingPongDelay: klass('PingPongDelay'), Filter: klass('Filter'),
    PolySynth: klass('PolySynth'), FMSynth: klass('FMSynth'), MetalSynth: klass('MetalSynth'),
    Noise: klass('Noise'), Gain: klass('Gain'), Loop: klass('Loop'), Sequence: klass('Sequence'),
    Transport: transport, Destination: destination, Master: destination, context: current, Listener: {}, Draw: {},
  };
  const module = new Proxy(mod, {
    get(t, p) {
      if (typeof p === 'string' && FORBIDDEN.has(p)) forbidden.push(p);
      return t[p as string];
    },
  }) as unknown as typeof import('tone');
  const of = (kind: string) => created.filter((n) => n.kind === kind);
  const param = (n: FakeToneNode, name: string): FakeParam => proxies.get(n)![name] as FakeParam;
  return { module, created, forbidden, setContextCalls, connects, transport, importCtx, of, param, current: () => current };
}
type FakeTone = ReturnType<typeof createFakeTone>;

function setup() {
  FakeAudioContext.reset();
  const ctx = new FakeAudioContext({ state: 'running' });
  const musicBus = ctx.createGain();
  let fake: FakeTone | null = null;
  const loadTone = vi.fn(async () => {
    fake ??= createFakeTone();
    return fake.module;
  });
  const music = new Music(ctx.asAudioContext(), musicBus as unknown as GainNode, loadTone);
  const gains = () => ctx.nodesOf('gain') as FakeGainNode[];
  const ducker = () => gains().find((g) => g.outputs.includes(musicBus))!;
  const gate = () => gains().find((g) => g.outputs.includes(ducker()))!;
  const lastGateTarget = () => {
    const e = gate().gain.events.filter((x) => x.type === 'target');
    return e[e.length - 1].value;
  };
  return { ctx, musicBus, music, loadTone, tone: () => fake!, ducker, gate, lastGateTarget };
}

describe('Music: Tone on the shared context', () => {
  it('rebinds Tone with setContext(ctx, true), leaving one live context, and never reads module constants', async () => {
    const t = setup();
    await t.music.ensure();
    const tone = t.tone();
    expect(tone.setContextCalls).toEqual([{ ctx: t.ctx, disposeOld: true }]);
    expect(tone.current().rawContext).toBe(t.ctx);
    expect(tone.current().lookAhead).toBe(MUSIC.lookAheadS);
    expect(tone.importCtx.state).toBe('closed');
    expect(FakeAudioContext.instances.filter((c) => c.state !== 'closed')).toEqual([t.ctx]);
    t.music.setScene('playing');
    t.music.setIntensity(0.5);
    t.music.setHidden(true);
    t.music.setHidden(false);
    t.music.sting('win');
    t.music.dispose();
    expect(tone.forbidden).toEqual([]);
    expect(t.music.ready).toBe(false);
  });

  it('loads Tone once, including for concurrent calls', async () => {
    const t = setup();
    const a = t.music.ensure();
    const b = t.music.ensure();
    await Promise.all([a, b]);
    await t.music.ensure();
    expect(t.loadTone).toHaveBeenCalledTimes(1);
    expect(t.music.ready).toBe(true);
  });

  it('retries after a failed load', async () => {
    const t = setup();
    t.loadTone.mockRejectedValueOnce(new Error('chunk failed'));
    await expect(t.music.ensure()).rejects.toThrow('chunk failed');
    expect(t.music.ready).toBe(false);
    await t.music.ensure();
    expect(t.loadTone).toHaveBeenCalledTimes(2);
    expect(t.music.ready).toBe(true);
  });

  it('a build that throws disposes its partial nodes, and the retry rebuilds without rebinding or closing the context', async () => {
    const t = setup();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fake = createFakeTone();
    const mod = fake.module as unknown as Rec;
    const MetalSynth = mod.MetalSynth as (...a: unknown[]) => unknown;
    let throwsLeft = 1;
    mod.MetalSynth = function FlakyMetalSynth(...a: unknown[]): unknown {
      if (throwsLeft-- > 0) throw new Error('MetalSynth failed');
      return MetalSynth(...a);
    };
    t.loadTone.mockImplementation(async () => fake.module);

    await expect(t.music.ensure()).rejects.toThrow('MetalSynth failed');
    const partial = fake.created.slice();
    expect(partial.map((n) => n.kind)).toEqual(['Reverb', 'PingPongDelay', 'Filter', 'PolySynth', 'FMSynth', 'PolySynth']);
    for (const n of partial) expect(n.disposed).toBe(true);
    expect(t.music.ready).toBe(false);

    await t.music.ensure();
    expect(t.music.ready).toBe(true);
    expect(t.loadTone).toHaveBeenCalledTimes(2);
    expect(fake.setContextCalls).toEqual([{ ctx: t.ctx, disposeOld: true }]);
    expect(fake.current().rawContext).toBe(t.ctx);
    expect(t.ctx.calls.close).toBe(0);
    expect(t.ctx.state).toBe('running');
    const rebuilt = fake.created.slice(partial.length);
    expect(rebuilt.length).toBeGreaterThan(10);
    for (const n of rebuilt) expect(n.disposed).toBe(false);
    warn.mockRestore();
  });

  it('a first apply that throws also discards the build, and the retry starts the riser again', async () => {
    const t = setup();
    const fake = createFakeTone();
    t.loadTone.mockImplementation(async () => fake.module);
    const start = fake.transport.start;
    let throwsLeft = 1;
    fake.transport.start = function flakyStart(this: typeof fake.transport) {
      if (throwsLeft-- > 0) throw new Error('Transport.start failed');
      start.call(this);
    };
    t.music.setScene('countdown');

    await expect(t.music.ensure()).rejects.toThrow('Transport.start failed');
    for (const n of fake.created) expect(n.disposed).toBe(true);
    expect(fake.transport.calls.slice(-2)).toEqual(['stop', 'cancel']);
    expect(t.lastGateTarget()).toBe(0);

    const before = fake.created.length;
    await t.music.ensure();
    const [noise] = fake.created.slice(before).filter((n) => n.kind === 'Noise');
    expect(noise.calls.some((c) => c.name === 'start')).toBe(true);
    expect(fake.transport.state).toBe('started');
    expect(t.lastGateTarget()).toBe(1);
    expect(fake.setContextCalls).toHaveLength(1);
    expect(t.ctx.calls.close).toBe(0);
  });

  it('routes the Tone graph into the ducker and musicBus, never to the Tone destination', async () => {
    const t = setup();
    await t.music.ensure();
    const tone = t.tone();
    expect(tone.connects).toHaveLength(1);
    expect(tone.connects[0].dst).toBe(t.gate());
    expect(t.ctx.reaches(t.gate(), t.musicBus)).toBe(true);
    for (const n of tone.created) expect(n.calls.some((c) => c.name === 'toDestination')).toBe(false);
  });

  it('still closes the import-time context when disposed while Tone is loading, and builds nothing', async () => {
    const t = setup();
    let release: () => void = () => {};
    const gateP = new Promise<void>((r) => { release = r; });
    t.loadTone.mockImplementationOnce(async () => {
      await gateP;
      const fake = createFakeTone();
      (t as unknown as { fake: FakeTone }).fake = fake;
      return fake.module;
    });
    const p = t.music.ensure();
    t.music.dispose();
    release();
    await p;
    const fake = (t as unknown as { fake: FakeTone }).fake;
    expect(fake.setContextCalls).toHaveLength(1);
    expect(fake.importCtx.state).toBe('closed');
    expect(fake.created).toHaveLength(0);
    expect(t.music.ready).toBe(false);
  });

  it('a load that resumes after dispose leaves Tone on a newer live context (HMR during the first load)', async () => {
    FakeAudioContext.reset();
    const fake = createFakeTone();
    let release: () => void = () => {};
    const gateP = new Promise<void>((r) => { release = r; });
    const ctxA = new FakeAudioContext({ state: 'running' });
    const a = new Music(ctxA.asAudioContext(), ctxA.createGain() as unknown as GainNode, async () => {
      await gateP;
      return fake.module;
    });
    const pa = a.ensure();
    a.dispose();
    await ctxA.close();

    const ctxB = new FakeAudioContext({ state: 'running' });
    const b = new Music(ctxB.asAudioContext(), ctxB.createGain() as unknown as GainNode, async () => fake.module);
    await b.ensure();
    expect(fake.importCtx.state).toBe('closed');
    release();
    await pa;
    expect(fake.setContextCalls.map((c) => c.ctx)).toEqual([ctxB]);
    expect(fake.current().rawContext).toBe(ctxB);
    expect(ctxB.state).toBe('running');
    b.dispose();
  });
});

describe('Music: scenes', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('plays layered scenes on the Transport', async () => {
    const t = setup();
    t.music.setScene('landing');
    expect(t.lastGateTarget()).toBe(0);           // nothing audible before Tone arrives
    await t.music.ensure();
    const tone = t.tone();
    const [padLoop, arpLoop, tingLoop] = tone.of('Loop');
    const [bassSeq] = tone.of('Sequence');
    const [filter, riserFilter] = tone.of('Filter');
    const [noise] = tone.of('Noise');
    for (const part of [padLoop, arpLoop, tingLoop, bassSeq]) expect(part.calls[0]).toEqual({ name: 'start', args: [0] });

    expect(tone.transport.state).toBe('started');
    expect(tone.transport.bpm.value).toBe(MUSIC.landingBpm);
    expect([padLoop.mute, bassSeq.mute, arpLoop.mute, tingLoop.mute]).toEqual([false, true, true, true]);
    expect(t.lastGateTarget()).toBe(1);

    t.music.setScene('lobby');
    expect([padLoop.mute, bassSeq.mute, arpLoop.mute, tingLoop.mute]).toEqual([true, false, false, true]);
    expect(tone.transport.bpm.value).toBe(MUSIC.gameBpm);
    expect(tone.param(filter, 'frequency').value).toBe(MUSIC.lobbyFilterHz);

    t.music.setScene('countdown');
    expect(noise.calls.some((c) => c.name === 'start')).toBe(true);
    expect(tone.param(riserFilter, 'frequency').calls).toContainEqual({ name: 'exponentialRampTo', args: [MUSIC.riserToHz, MUSIC.riserS] });

    t.music.setScene('playing');
    expect(noise.calls.some((c) => c.name === 'stop')).toBe(true);
    expect([padLoop.mute, bassSeq.mute, arpLoop.mute, tingLoop.mute]).toEqual([true, false, false, false]);
    t.music.setIntensity(0.5);
    const ramp = tone.param(filter, 'frequency').calls.filter((c) => c.name === 'rampTo');
    expect(ramp[ramp.length - 1].args[0]).toBeCloseTo(MUSIC.openMinHz * Math.sqrt(MUSIC.openMaxHz / MUSIC.openMinHz), 6);

    t.music.setScene('off');
    expect(tone.transport.state).toBe('paused');
    expect(t.lastGateTarget()).toBe(0);
  });

  it('pauses the Transport while hidden or muted and resumes after', async () => {
    const t = setup();
    await t.music.ensure();
    const tr = t.tone().transport;
    t.music.setScene('playing');
    expect(tr.state).toBe('started');
    t.music.setHidden(true);
    expect(tr.state).toBe('paused');
    expect(t.lastGateTarget()).toBe(0);
    t.music.setHidden(false);
    expect(tr.state).toBe('started');
    expect(t.lastGateTarget()).toBe(1);
    t.music.setMuted(true);
    expect(tr.state).toBe('paused');
    t.music.setMuted(false);
    expect(tr.state).toBe('started');
  });

  it('finished stops the loop, plays the sting, then returns to the pad', async () => {
    const t = setup();
    await t.music.ensure();
    vi.useFakeTimers();
    const tone = t.tone();
    const [padLoop, arpLoop] = tone.of('Loop');
    t.music.setScene('playing');
    t.music.setScene('finished');
    expect([padLoop.mute, arpLoop.mute]).toEqual([true, true]);
    t.music.sting('win');
    const sting = tone.of('PolySynth')[2];
    expect(sting.calls.filter((c) => c.name === 'triggerAttackRelease').map((c) => c.args[0])).toEqual(['C5', 'E5', 'G5', 'C6']);
    vi.advanceTimersByTime(MUSIC.stingReturnS * 1000);
    expect(padLoop.mute).toBe(false);
    expect(tone.transport.bpm.calls[tone.transport.bpm.calls.length - 1]).toEqual({ name: 'rampTo', args: [MUSIC.landingBpm, MUSIC.bpmRampS] });
  });

  it('keeps the sting silent while hidden', async () => {
    const t = setup();
    await t.music.ensure();
    t.music.setScene('finished');
    t.music.setHidden(true);
    t.music.sting('lose');
    expect(t.tone().of('PolySynth')[2].calls.some((c) => c.name === 'triggerAttackRelease')).toBe(false);
  });

  it('ducks by dB at the given time and recovers', () => {
    const t = setup();
    t.ctx.currentTime = 2;
    t.music.duck(-6, 0.3, 2.1);
    expect(t.ducker().gain.events).toEqual([
      { type: 'cancel', value: 1, time: 2.1 },
      { type: 'target', value: Math.pow(10, -6 / 20), time: 2.1, extra: MUSIC.duckAttackTcS },
      { type: 'target', value: 1, time: 2.1 + 0.3, extra: MUSIC.duckReleaseTcS },
    ]);
  });
});

describe('Music: dispose', () => {
  beforeEach(() => FakeAudioContext.reset());

  it('stops and cancels the Transport, disposes every node, and leaves the context alone', async () => {
    const t = setup();
    await t.music.ensure();
    t.music.setScene('playing');
    const tone = t.tone();
    t.music.dispose();
    expect(tone.transport.calls.slice(-2)).toEqual(['stop', 'cancel']);
    expect(tone.created.length).toBeGreaterThan(10);
    for (const n of tone.created) expect(n.disposed).toBe(true);
    expect(t.ctx.calls.close).toBe(0);
    expect(t.ctx.reaches(t.gate(), t.musicBus)).toBe(false);
    t.music.setScene('lobby');
    t.music.sting('win');
    expect(tone.transport.calls.slice(-2)).toEqual(['stop', 'cancel']);
  });
});
