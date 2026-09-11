// Procedural voices (7.2, 7.3). Every cue is built from one shared 1 s white-noise buffer, oscillators,
// BiquadFilterNodes and gain envelopes. A call builds one short-lived graph that ends in its own output
// gain connected to `dest` (the mixer passes a per-voice gain that feeds a pooled slot panner).
//
// Pitch: every tonal frequency is multiplied by `rate * 2^(semitone / 12)`. The mixer uses `rate` for the
// wall centre (600, 750, 900, 1050 Hz = rate 1, 1.25, 1.5, 1.75) and `semitone` for the brick scale.
// `pan` is applied with a panner of its own only when it is non-zero; the mixer pans through its slot and
// passes 0. The returned node is the source that stops last, so its `ended` event marks the voice's end.

import type { CueId } from './types';
import { seeded } from '../lib/random';

export interface SynthParams { rate: number; pan: number; gain: number; semitone: number }

const SILENT = 0.0001;               // exponential ramps cannot reach 0
const A4 = 440;
/** A minor pentatonic from A4, then up an octave: A4 C5 D5 E5 G5 A5 C6 D6 E6 G6 (semitones above A4). */
export const PENTATONIC: readonly number[] = [0, 3, 5, 7, 10, 12, 15, 17, 19, 22];
/** Band-pass centres of the wall cue for walls 0..3; the mixer passes `rate = WALL_HZ[w] / WALL_HZ[0]`. */
export const WALL_HZ: readonly number[] = [600, 750, 900, 1050];

const db = (v: number): number => Math.pow(10, v / 20);

/** Seconds from `when` to the end of each cue's procedural layer; 0 when the cue has none. */
const LENGTH_S: Readonly<Record<CueId, number>> = {
  paddle: 0, gained: 0, lost: 0, win: 0, lose: 0,
  paddleMine: 0.04, wall: 0.04, goalAgainst: 0.45, goalOther: 0.45, goalFor: 0.55, absorb: 0.15,
  brickCrack: 0.12, brickShatter: 0.18, phaseOn: 0.3, phaseOff: 0.3, spawn: 0.08, expire: 0.12,
  powerUp: 0.15, grow: 0.12, join: 0.16, leave: 0.16, countTick: 0.06, go: 0.3, touch: 0.01, uiTap: 0.015,
};

export function synthLength(cue: CueId): number {
  return LENGTH_S[cue];
}

const noiseBuffers = new WeakMap<BaseAudioContext, AudioBuffer>();

/** The shared 1 s mono white-noise buffer of `ctx`, made once per context (deterministic content). */
export function noiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  let buf = noiseBuffers.get(ctx);
  if (buf === undefined) {
    const length = Math.max(1, Math.round(ctx.sampleRate));
    buf = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buf.getChannelData(0);
    const r = seeded(0x5eed);
    for (let i = 0; i < length; i++) data[i] = r() * 2 - 1;
    noiseBuffers.set(ctx, buf);
  }
  return buf;
}

/** Collects the sources of one voice and remembers the one that stops last. */
class Build {
  last: AudioScheduledSourceNode | null = null;
  private lastEnd = -Infinity;
  constructor(readonly ctx: AudioContext, readonly out: AudioNode, readonly t: number, readonly m: number) {}

  private track(src: AudioScheduledSourceNode, start: number, end: number): void {
    src.start(start);
    src.stop(end);
    if (end >= this.lastEnd) {
      this.last = src;
      this.lastEnd = end;
    }
  }

  /** A gain envelope: silent, up to `peak` in `attack`, exponential decay to silence at start + dur. */
  private env(start: number, dur: number, peak: number, attack: number): GainNode {
    const g = this.ctx.createGain();
    const a = Math.min(attack, dur * 0.5);
    g.gain.setValueAtTime(SILENT, start);
    g.gain.linearRampToValueAtTime(peak, start + a);
    g.gain.exponentialRampToValueAtTime(SILENT, start + dur);
    g.connect(this.out);
    return g;
  }

  /** An oscillator at `hz` (optionally gliding to `hzEnd`), `dur` seconds after `offset`. */
  tone(type: OscillatorType, hz: number, offset: number, dur: number, peak: number, hzEnd?: number, attack = 0.002): void {
    const start = this.t + offset;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(hz, start);
    if (hzEnd !== undefined) o.frequency.exponentialRampToValueAtTime(hzEnd, start + dur);
    o.connect(this.env(start, dur, peak, attack));
    this.track(o, start, start + dur);
  }

  /** Filtered noise. `hzEnd` sweeps the filter; `swell` ramps up linearly and cuts hard at the end. */
  noise(filter: BiquadFilterType, hz: number, q: number, offset: number, dur: number, peak: number,
    opts: { hzEnd?: number; swell?: boolean; attack?: number } = {}): void {
    const start = this.t + offset;
    const src = this.ctx.createBufferSource();
    src.buffer = noiseBuffer(this.ctx);
    src.loop = true;
    const f = this.ctx.createBiquadFilter();
    f.type = filter;
    f.frequency.setValueAtTime(hz, start);
    if (opts.hzEnd !== undefined) f.frequency.exponentialRampToValueAtTime(opts.hzEnd, start + dur);
    f.Q.value = q;
    let g: GainNode;
    if (opts.swell) {
      g = this.ctx.createGain();
      g.gain.setValueAtTime(SILENT, start);
      g.gain.linearRampToValueAtTime(peak, start + dur);
      g.gain.setValueAtTime(0, start + dur);
      g.connect(this.out);
    } else {
      g = this.env(start, dur, peak, opts.attack ?? 0.001);
    }
    src.connect(f);
    f.connect(g);
    this.track(src, start, start + dur);
  }

  /** A glass ping: sine plus a quieter triangle an octave up. */
  ping(hz: number, dur: number, peak: number): void {
    this.tone('sine', hz, 0, dur, peak);
    this.tone('triangle', hz * 2, 0, dur * 0.8, peak * 0.35);
  }
}

function build(b: Build, cue: CueId): boolean {
  const m = b.m;
  switch (cue) {
    case 'paddleMine':
      b.tone('sine', 60, 0, LENGTH_S.paddleMine, 0.9, undefined, 0.003);
      return true;
    case 'wall':
      b.noise('highpass', 2000, 0.7, 0, 0.003, 0.5);
      b.noise('bandpass', WALL_HZ[0] * m, 6, 0, LENGTH_S.wall, 0.8);
      return true;
    case 'goalAgainst':
    case 'goalOther': {
      const k = cue === 'goalOther' ? db(-8) : 1;
      b.tone('sine', 80, 0, 0.25, 1.0 * k, 40, 0.005);
      b.noise('lowpass', 400, 0.7, 0.05, LENGTH_S[cue] - 0.05, 0.35 * k, { attack: 0.02 });
      return true;
    }
    case 'goalFor':
      b.tone('sine', 880 * m, 0, LENGTH_S.goalFor, 0.35, undefined, 0.004);
      b.tone('sine', 1320 * m, 0, LENGTH_S.goalFor, 0.3, undefined, 0.004);
      return true;
    case 'absorb':
      b.noise('bandpass', 1200 * m, 1.5, 0, LENGTH_S.absorb, 0.6, { swell: true });
      return true;
    case 'brickCrack':
      b.ping(A4 * m, LENGTH_S.brickCrack, 0.5);
      return true;
    case 'brickShatter':
      b.ping(A4 * m, 0.15, 0.5);
      b.noise('bandpass', 2500, 1.2, 0, LENGTH_S.brickShatter, 0.55);
      return true;
    case 'phaseOn':
    case 'phaseOff': {
      const up = cue === 'phaseOn';
      b.noise('bandpass', up ? 400 : 3000, 4, 0, LENGTH_S[cue], 0.45, { hzEnd: up ? 3000 : 400, attack: 0.03 });
      return true;
    }
    case 'spawn':
      b.tone('sine', 300 * m, 0, LENGTH_S.spawn, 0.4, 900 * m, 0.004);
      return true;
    case 'expire':
      b.noise('highpass', 5000, 0.9, 0, LENGTH_S.expire, 0.35);
      return true;
    case 'powerUp': {
      const notes = [880, 1108.73, 1318.51];
      for (let i = 0; i < notes.length; i++) b.tone('triangle', notes[i] * m, i * 0.04, LENGTH_S.powerUp - 0.08, 0.3);
      return true;
    }
    case 'grow':
      b.tone('sine', 90 * m, 0, LENGTH_S.grow, 0.7, undefined, 0.005);
      return true;
    case 'join':
    case 'leave': {
      const [a, c] = cue === 'join' ? [659.26, 880] : [880, 659.26];
      b.tone('triangle', a * m, 0, 0.08, 0.3);
      b.tone('triangle', c * m, 0.08, 0.08, 0.3);
      return true;
    }
    case 'countTick':
      b.tone('triangle', A4 * m, 0, LENGTH_S.countTick, 0.4);
      return true;
    case 'go':
      for (const hz of [A4, 554.37, 659.26]) b.tone('triangle', hz * m, 0, LENGTH_S.go, 0.25, undefined, 0.005);
      return true;
    case 'touch':
      b.noise('highpass', 3000, 0.7, 0, LENGTH_S.touch, db(-18));
      return true;
    case 'uiTap':
      b.noise('bandpass', 2500, 2, 0, LENGTH_S.uiTap, 0.35);
      return true;
    case 'paddle':
    case 'gained':
    case 'lost':
    case 'win':
    case 'lose':
      return false;
  }
}

/** Builds the procedural layer of `cue` at `when` into `dest`. Null when the cue has no procedural layer
 *  (sample-only cues and the Tone stings). */
export function playSynth(ctx: AudioContext, dest: AudioNode, cue: CueId, when: number, p: SynthParams): AudioScheduledSourceNode | null {
  if (LENGTH_S[cue] <= 0) return null;
  const out = ctx.createGain();
  out.gain.value = p.gain;
  let panner: StereoPannerNode | null = null;
  if (p.pan !== 0) {
    panner = ctx.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, p.pan));
    out.connect(panner);
    panner.connect(dest);
  } else {
    out.connect(dest);
  }
  const b = new Build(ctx, out, when, p.rate * Math.pow(2, p.semitone / 12));
  if (!build(b, cue) || b.last === null) {
    out.disconnect();
    panner?.disconnect();
    return null;
  }
  b.last.addEventListener('ended', () => {
    out.disconnect();
    panner?.disconnect();
  });
  return b.last;
}

/** A sine thump that drops half an octave (the brick-shatter sub and similar weight layers). */
export function playThump(ctx: AudioContext, dest: AudioNode, when: number, hz: number, durS: number, gain: number): OscillatorNode {
  const o = ctx.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(hz, when);
  o.frequency.exponentialRampToValueAtTime(hz * 0.7, when + durS);
  const g = ctx.createGain();
  g.gain.setValueAtTime(SILENT, when);
  g.gain.linearRampToValueAtTime(gain, when + 0.004);
  g.gain.exponentialRampToValueAtTime(SILENT, when + durS);
  o.connect(g);
  g.connect(dest);
  o.start(when);
  o.stop(when + durS);
  o.addEventListener('ended', () => g.disconnect());
  return o;
}
