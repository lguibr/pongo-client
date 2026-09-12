// Music (7.5; D19, C15, C79, C82, C84). Tone is loaded lazily and bound to the engine's one AudioContext with
// Tone.setContext(ctx, true), which disposes the context Tone created at import. Of Tone's global singletons
// only getTransport() and getContext() (for lookAhead) are used; the module constants Transport, Destination,
// Master, context, Listener and Draw are never read, because they stay bound to the disposed import-time
// context. Every Tone node is kept in a field and disposed.
//
// Routing: Tone graph -> gate (hidden, muted, off) -> ducker (goal ducks) -> musicBus. The gate and the
// ducker are plain Web Audio gains made on construction, so duck() works before Tone arrives.
//
// The score ports today's (main:src/audio/SoundtrackManager.ts) into layered scenes: an FM pad on the
// melody's chords, the metallic FM bass sequence, the glass FM arpeggio through a ping-pong delay, the
// MetalSynth ticks, a 4 s reverb, plus a noise riser for the countdown and win and lose stings.

import type * as ToneNS from 'tone';
import type { MusicScene } from './types';
import type { AudioDeps } from './types';
import { seeded } from '../lib/random';
import { clamp } from '../lib/math';
import { log } from '../lib/log';

type ToneModule = typeof import('tone');
type LoadTone = NonNullable<AudioDeps['loadTone']>;
interface Disposable { dispose(): unknown }

/** The AudioContext each Tone module instance was last bound to, kept on globalThis so it survives HMR of
 *  this file (a new Music class, the same Tone module). */
const BOUND_KEY = Symbol.for('pongo.audio.toneBound');
function boundContexts(): WeakMap<object, AudioContext> {
  const g = globalThis as unknown as Record<symbol, WeakMap<object, AudioContext> | undefined>;
  return (g[BOUND_KEY] ??= new WeakMap<object, AudioContext>());
}

export const MUSIC = {
  lookAheadS: 0.05, gainTcS: 0.05, landingBpm: 72, gameBpm: 85, bpmRampS: 1,
  lobbyFilterHz: 900, openMinHz: 1200, openMaxHz: 12000, intensityRampS: 1.5,
  riserS: 3, riserFromHz: 400, riserToHz: 4000, riserGain: 0.25, riserOffS: 0.3,
  stingReturnS: 3, duckAttackTcS: 0.02, duckReleaseTcS: 0.08,
} as const;

/** The melody's chords from today's score (Cmaj7, Am7, Fmaj7, G7). */
const CHORDS: readonly (readonly string[])[] = [
  ['C5', 'E5', 'G5', 'B5'], ['A4', 'C5', 'E5', 'G5'], ['F4', 'A4', 'C5', 'E5'], ['G4', 'B4', 'D5', 'F5'],
];
const PAD_CHORDS: readonly (readonly string[])[] = [
  ['C3', 'G3', 'E4', 'B4'], ['A2', 'E3', 'C4', 'G4'], ['F2', 'C3', 'A3', 'E4'], ['G2', 'D3', 'B3', 'F4'],
];
const BASS_LINE: (string | null | (string | null)[])[] = [
  ['C2', null], 'C2', [null, 'G2'], null, ['F2', null], 'F2', [null, 'G1'], null,
];
const STINGS = {
  win: { notes: ['C5', 'E5', 'G5', 'C6'], stepS: 0.11, dur: '4n' },
  lose: { notes: ['G4', 'D#4', 'C4', 'G3'], stepS: 0.22, dur: '2n' },
} as const;

interface Layers { pad: boolean; bass: boolean; arp: boolean; arpNotes: number; ting: boolean; riser: boolean }

function layersFor(scene: MusicScene, padBack: boolean): Layers {
  switch (scene) {
    case 'landing': return { pad: true, bass: false, arp: false, arpNotes: 0, ting: false, riser: false };
    case 'lobby': return { pad: false, bass: true, arp: true, arpNotes: 2, ting: false, riser: false };
    case 'countdown': return { pad: false, bass: true, arp: true, arpNotes: 2, ting: false, riser: true };
    case 'playing': return { pad: false, bass: true, arp: true, arpNotes: 4, ting: true, riser: false };
    case 'finished': return { pad: padBack, bass: false, arp: false, arpNotes: 0, ting: false, riser: false };
    case 'off': return { pad: false, bass: false, arp: false, arpNotes: 0, ting: false, riser: false };
  }
}

interface Graph {
  filter: ToneNS.Filter;
  pad: ToneNS.PolySynth<ToneNS.FMSynth>; lead: ToneNS.PolySynth<ToneNS.FMSynth>; sting: ToneNS.PolySynth<ToneNS.FMSynth>;
  riserNoise: ToneNS.Noise; riserFilter: ToneNS.Filter; riserGain: ToneNS.Gain;
  padLoop: ToneNS.Loop; bassSeq: ToneNS.Sequence<string | null>; arpLoop: ToneNS.Loop; tingLoop: ToneNS.Loop;
}

export class Music {
  private readonly ctx: AudioContext;
  private readonly loadTone: LoadTone;
  private readonly gate: GainNode;
  private readonly ducker: GainNode;
  private readonly rng = seeded(0x70e5);
  private tone: ToneModule | null = null;
  private graph: Graph | null = null;
  private nodes: Disposable[] = [];
  private loading: Promise<void> | null = null;
  private disposed = false;
  private scene: MusicScene = 'off';
  private hidden = false;
  private muted = false;
  private intensity = 0;
  private arpNotes = 0;
  private arpStep = 0;
  private padStep = 0;
  private padBack = false;
  private riserOn = false;
  private padTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(ctx: AudioContext, musicBus: GainNode, loadTone: LoadTone) {
    this.ctx = ctx;
    this.loadTone = loadTone;
    this.gate = ctx.createGain();
    this.gate.gain.value = 0;
    this.ducker = ctx.createGain();
    this.gate.connect(this.ducker);
    this.ducker.connect(musicBus);
  }

  get ready(): boolean {
    return this.graph !== null;
  }

  /** Loads Tone once, binds it to the shared context and builds the score. Rejects when Tone fails to load;
   *  a later call then tries again. */
  ensure(): Promise<void> {
    if (this.loading !== null) return this.loading;
    this.loading = this.load().catch((err: unknown) => {
      this.loading = null;
      throw err;
    });
    return this.loading;
  }

  private async load(): Promise<void> {
    const T = await this.loadTone();
    const bound = boundContexts();
    if (this.disposed) {
      // Disposed while loading: still rebind so the import-time context is closed (one context), but only
      // while no live context holds Tone, because setContext(x, true) closes the context Tone is bound to.
      const prev = bound.get(T);
      if (prev !== undefined && prev.state !== 'closed') return;
      try {
        T.setContext(this.ctx, true);
        bound.set(T, this.ctx);
      } catch (err) {
        log.warn('audio: Tone.setContext failed', err);
      }
      return;
    }
    // A retry after a failed build finds Tone already on this context. setContext(x, true) disposes the
    // current global Context, and Context.dispose closes its raw context: rebinding would close our own.
    if (bound.get(T) !== this.ctx) {
      try {
        T.setContext(this.ctx, true);
      } catch (err) {
        log.warn('audio: Tone.setContext failed', err);
        throw err;
      }
      bound.set(T, this.ctx);
    }
    T.getContext().lookAhead = MUSIC.lookAheadS;
    this.tone = T;
    try {
      this.graph = this.build(T);
      this.apply(true);
    } catch (err) {
      this.discardFailedBuild(T);
      throw err;
    }
  }

  /** Undoes a build or first apply that threw, so a retried ensure() rebuilds from scratch on the same open
   *  context: the partial nodes are disposed, the Transport is stopped and the gate is closed. */
  private discardFailedBuild(T: ToneModule): void {
    for (const n of this.nodes.splice(0).reverse()) {
      try {
        n.dispose();
      } catch (err) {
        log.warn('audio: Tone node dispose failed', err);
      }
    }
    this.graph = null;
    this.tone = null;
    this.riserOn = false;
    try {
      const transport = T.getTransport();
      transport.stop();
      transport.cancel();
    } catch (err) {
      log.warn('audio: Tone Transport stop failed', err);
    }
    this.apply(false);
  }

  private keep<N extends Disposable>(n: N): N {
    this.nodes.push(n);
    return n;
  }

  private build(T: ToneModule): Graph {
    const reverb = this.keep(new T.Reverb({ decay: 4, wet: 0.3 }));
    T.connect(reverb, this.gate);
    const delay = this.keep(new T.PingPongDelay({ delayTime: '8n', feedback: 0.2, wet: 0.2 }));
    const filter = this.keep(new T.Filter({ type: 'lowpass', frequency: MUSIC.lobbyFilterHz, Q: 0.7 }));
    delay.connect(filter);
    filter.connect(reverb);

    const pad = this.keep(new T.PolySynth(T.FMSynth, {
      harmonicity: 2, modulationIndex: 1.5,
      oscillator: { type: 'sine' }, modulation: { type: 'triangle' },
      envelope: { attack: 1.2, decay: 0.8, sustain: 0.7, release: 3 },
      modulationEnvelope: { attack: 1.5, decay: 1, sustain: 0.5, release: 3 },
      volume: -20,
    }));
    pad.connect(reverb);
    const bass = this.keep(new T.FMSynth({
      harmonicity: 1.5, modulationIndex: 10,
      oscillator: { type: 'sine' }, modulation: { type: 'sine' },
      envelope: { attack: 0.005, decay: 0.3, sustain: 1, release: 0.2 },
      modulationEnvelope: { attack: 0.001, decay: 0.2, sustain: 0, release: 0.1 },
      volume: -12,
    }));
    bass.connect(filter);
    const lead = this.keep(new T.PolySynth(T.FMSynth, {
      harmonicity: 3.01, modulationIndex: 3,
      oscillator: { type: 'sine' },
      envelope: { attack: 0.01, decay: 0.2, sustain: 0, release: 1 },
      modulationEnvelope: { attack: 0.01, decay: 0.2, sustain: 0, release: 0.2 },
      volume: -10,
    }));
    lead.connect(delay);
    const ting = this.keep(new T.MetalSynth({
      envelope: { attack: 0.001, decay: 0.05, release: 0.01 },
      harmonicity: 5.1, modulationIndex: 32, resonance: 4000, octaves: 1.5, volume: -30,
    }));
    ting.connect(reverb);
    const sting = this.keep(new T.PolySynth(T.FMSynth, {
      harmonicity: 3.01, modulationIndex: 3,
      envelope: { attack: 0.01, decay: 0.3, sustain: 0.2, release: 1.2 },
      volume: -8,
    }));
    sting.connect(reverb);

    const riserNoise = this.keep(new T.Noise({ type: 'pink', volume: -12 }));
    const riserFilter = this.keep(new T.Filter({ type: 'bandpass', frequency: MUSIC.riserFromHz, Q: 2 }));
    const riserGain = this.keep(new T.Gain(0));
    riserNoise.connect(riserFilter);
    riserFilter.connect(riserGain);
    riserGain.connect(reverb);

    const padLoop = this.keep(new T.Loop((time) => {
      pad.triggerAttackRelease(PAD_CHORDS[this.padStep++ % PAD_CHORDS.length].slice(), '1m', time);
    }, '1m'));
    const bassSeq = this.keep(new T.Sequence<string | null>((time, note) => {
      if (note) bass.triggerAttackRelease(note, '16n', time);
    }, BASS_LINE, '4n'));
    const arpLoop = this.keep(new T.Loop((time) => {
      const chord = CHORDS[this.arpStep++ % CHORDS.length];
      for (let i = 0; i < this.arpNotes; i++) lead.triggerAttackRelease(chord[i], '8n', time + i * 0.1);
    }, '1m'));
    const tingLoop = this.keep(new T.Loop((time) => {
      if (this.rng() > 0.5) ting.triggerAttackRelease(200, '32n', time + this.rng() * 0.5);
    }, '4n'));
    for (const part of [padLoop, bassSeq, arpLoop, tingLoop]) {
      part.mute = true;
      part.start(0);
    }
    return { filter, pad, lead, sting, riserNoise, riserFilter, riserGain, padLoop, bassSeq, arpLoop, tingLoop };
  }

  setScene(s: MusicScene): void {
    if (s === this.scene) return;
    this.scene = s;
    if (this.padTimer !== null) clearTimeout(this.padTimer);
    this.padTimer = null;
    this.padBack = false;
    if (s === 'finished') {
      this.padTimer = setTimeout(() => {
        this.padTimer = null;
        this.padBack = true;
        this.apply(false);
      }, MUSIC.stingReturnS * 1000);
    }
    this.apply(false);
  }

  setIntensity(v: number): void {
    this.intensity = clamp(Number.isFinite(v) ? v : 0, 0, 1);
    if (this.graph !== null && this.scene === 'playing') {
      this.graph.filter.frequency.rampTo(this.openHz(), MUSIC.intensityRampS);
    }
  }

  setHidden(h: boolean): void {
    if (h === this.hidden) return;
    this.hidden = h;
    this.apply(false);
  }

  setMuted(m: boolean): void {
    if (m === this.muted) return;
    this.muted = m;
    this.apply(false);
  }

  /** Ducks the music by `db` at `at` (default now) and recovers after `seconds`. */
  duck(db: number, seconds: number, at: number = this.ctx.currentTime): void {
    const g = this.ducker.gain;
    const t = Math.max(at, this.ctx.currentTime);
    g.cancelScheduledValues(t);
    g.setTargetAtTime(Math.pow(10, db / 20), t, MUSIC.duckAttackTcS);
    g.setTargetAtTime(1, t + seconds, MUSIC.duckReleaseTcS);
  }

  /** The game-over sting on the music bus (7.3 `win`, `lose`). Silent while hidden, muted or not loaded. */
  sting(kind: 'win' | 'lose'): void {
    if (this.graph === null || this.disposed || this.hidden || this.muted) return;
    const s = STINGS[kind];
    const t0 = this.ctx.currentTime + 0.03;
    for (let i = 0; i < s.notes.length; i++) {
      this.graph.sting.triggerAttackRelease(s.notes[i], i === s.notes.length - 1 ? s.dur : '8n', t0 + i * s.stepS);
    }
  }

  /** Stops and cancels the Transport and disposes every node. The context itself is the engine's. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.padTimer !== null) clearTimeout(this.padTimer);
    this.padTimer = null;
    if (this.tone !== null) {
      const transport = this.tone.getTransport();
      transport.stop();
      transport.cancel();
    }
    for (const n of this.nodes.reverse()) {
      try {
        n.dispose();
      } catch (err) {
        log.warn('audio: Tone node dispose failed', err);
      }
    }
    this.nodes = [];
    this.graph = null;
    this.gate.disconnect();
    this.ducker.disconnect();
  }

  private openHz(): number {
    return MUSIC.openMinHz * Math.pow(MUSIC.openMaxHz / MUSIC.openMinHz, this.intensity);
  }

  /** Applies scene, hidden and muted to the layers, the gate and the Transport. */
  private apply(first: boolean): void {
    const T = this.tone;
    const g = this.graph;
    const now = this.ctx.currentTime;
    const audible = this.scene !== 'off' && !this.hidden && !this.muted && !this.disposed;
    this.gate.gain.cancelScheduledValues(now);
    this.gate.gain.setTargetAtTime(audible && g !== null ? 1 : 0, now, MUSIC.gainTcS);
    if (T === null || g === null) return;

    const L = layersFor(this.scene, this.padBack);
    g.padLoop.mute = !L.pad;
    g.bassSeq.mute = !L.bass;
    g.arpLoop.mute = !L.arp;
    g.tingLoop.mute = !L.ting;
    this.arpNotes = L.arpNotes;

    const hz = this.scene === 'playing' ? this.openHz() : MUSIC.lobbyFilterHz;
    if (first) g.filter.frequency.value = hz;
    else g.filter.frequency.rampTo(hz, this.scene === 'playing' ? MUSIC.intensityRampS : 0.5);

    if (L.riser && !this.riserOn) {
      this.riserOn = true;
      g.riserFilter.frequency.value = MUSIC.riserFromHz;
      g.riserFilter.frequency.exponentialRampTo(MUSIC.riserToHz, MUSIC.riserS);
      g.riserGain.gain.value = 0;
      g.riserGain.gain.rampTo(MUSIC.riserGain, MUSIC.riserS);
      g.riserNoise.start(now);
    } else if (!L.riser && this.riserOn) {
      this.riserOn = false;
      g.riserGain.gain.rampTo(0, MUSIC.riserOffS);
      g.riserNoise.stop(now + MUSIC.riserOffS);
    }

    const transport = T.getTransport();
    const bpm = this.scene === 'landing' || this.scene === 'finished' ? MUSIC.landingBpm : MUSIC.gameBpm;
    if (transport.state === 'started') transport.bpm.rampTo(bpm, MUSIC.bpmRampS);
    else transport.bpm.value = bpm;
    if (audible) {
      if (transport.state !== 'started') transport.start();
    } else if (transport.state === 'started') {
      transport.pause();
    }
  }
}
