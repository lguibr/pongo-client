// CueMixer (7.3, 7.4; C11, C50, C78, C80, C81). Called at ingest with each batch's new events (2.4), and
// once from GameSink.ended with the gameOver event. It maps events to cues, resolves per-ball per-tick
// priority, dedupes bricks, applies the retrigger interval and the caps, and schedules each survivor on the
// display timeline: when = currentTime + clamp(lead, 0, maxLeadS). Nothing is ever queued: while the
// context is not running, or the batch is headless, every cue is dropped (C78).
//
// Voices: 16 pooled slots, each with its own StereoPannerNode into sfxBus. A voice is one per-play gain
// into a slot; its sample and procedural sources all feed that gain, so stealing fades one gain over
// 15 ms and stops every source of the voice. The `win` and `lose` stings and the goal duck belong to the
// music, so they leave through `onCue`, which the engine routes to Music.
//
// Goal repeats (C47, `repeat > 0`) still win their ball's tick, so they suppress its wall and touch and
// absorb the gained or lost the goal carries, and then they are dropped: one goal, one boom, one duck.
// brickBounce plays touch; no GameEvent carries an unexplained collided edge (4.5), so that row of 7.3 has
// no source.

import type { CueId } from './types';
import type { SampleBank, SampleName } from './samples';
import type { GameEvent, IngestEventCtx, IngestListener, Seat } from '../game/events';
import { IMMEDIATE, SeatConn } from '../game/events';
import { T } from '../config/tuning';
import type { Tuning } from '../config/tuning';
import type { Rand } from '../lib/random';
import { CANVAS, TICK_MS } from '../config/constants';
import { canvasToBoard, boardToView } from '../game/orientation';
import { clamp } from '../lib/math';
import { stats } from '../state/stats';
import { playSynth, playThump, synthLength, PENTATONIC, WALL_HZ } from './synth';

/** Voices per cue (7.3). Cues the table leaves open get 2; the stings use no voice. */
export const CUE_CAPS: Readonly<Record<CueId, number>> = {
  paddle: 4, paddleMine: 4, gained: 2, lost: 2, wall: 3, goalAgainst: 2, goalFor: 2, goalOther: 2, absorb: 2,
  brickCrack: 6, brickShatter: 6, phaseOn: 2, phaseOff: 2, spawn: 2, expire: 2, powerUp: 1, grow: 1,
  join: 1, leave: 1, countTick: 1, go: 1, win: 1, lose: 1, touch: 2, uiTap: 2,
};
/** Per ball per tick, only the highest rank plays: goal, shatter, paddle, crack, wall, touch (7.4). */
const RANK: Readonly<Partial<Record<CueId, number>>> = {
  goalAgainst: 6, goalFor: 6, goalOther: 6, brickShatter: 5, paddle: 4, paddleMine: 4, brickCrack: 3, wall: 2, touch: 1,
};
const CUE_GAIN: Readonly<Partial<Record<CueId, number>>> = { paddle: 0.85, wall: 0.7, gained: 0.8, lost: 0.8 };
const POSITIONAL = new Set<GameEvent['k']>([
  'paddleHit', 'ownerChanged', 'wallBounce', 'goal', 'absorbed', 'brickBounce', 'brickDamaged', 'brickDestroyed',
  'ballSpawned', 'ballRemoved', 'phaseStart', 'phaseEnd', 'powerUp', 'ballResized',
]);
const CUE_KINDS = new Set<GameEvent['k']>([
  'paddleHit', 'ownerChanged', 'wallBounce', 'goal', 'absorbed', 'brickBounce', 'brickDamaged', 'brickDestroyed',
  'ballSpawned', 'ballRemoved', 'phaseStart', 'phaseEnd', 'powerUp', 'ballResized', 'seat', 'countdown', 'go', 'gameOver',
]);
/** Counts in stats.audio.dropped every event of a batch that would map to a cue, for a batch dropped whole. */
export function countDropped(events: readonly GameEvent[]): void {
  for (const e of events) if (CUE_KINDS.has(e.k)) stats.audio.dropped++;
}
export const STEAL_FADE_S = 0.015;
const FAR_HALF_GAIN = Math.pow(10, -3 / 20);
const RATE_JITTER = 0.03;
const SHATTER_SUB = { hz: 55, s: 0.09, gain: 0.8, minFrom: 4 } as const;
const PAN_MAX = 0.8;

type SampleKind = 'hit' | 'gained' | 'lost';

interface Cand {
  cue: CueId; when: number; ball: number; tick: number; cell: number; entity: number; repeat: number;
  rate: number; semitone: number; gain: number; pan: number;
  sample: SampleKind | null; layers: SampleKind[]; thump: boolean; alive: boolean;
}

interface Voice {
  cue: CueId; slot: number; gain: GainNode; sources: AudioScheduledSourceNode[];
  pending: number; startAt: number; endsAt: number; released: boolean;
}

export class CueMixer {
  /** Fired for every cue that is scheduled, and for the stings (which have no voice). The engine routes
   *  goalAgainst to Music.duck and win/lose to Music.sting. */
  onCue: ((cue: CueId, when: number) => void) | null = null;

  private readonly ctx: AudioContext;
  private readonly bank: SampleBank;
  private readonly t: Tuning['audio'];
  private readonly rand: Rand;
  private readonly powerUpConfMin: number;
  private readonly panners: StereoPannerNode[] = [];
  private readonly slotVoice: (Voice | null)[] = [];
  private readonly slotBusyUntil: number[] = [];
  private readonly active: Voice[] = [];
  private readonly lastAt = new Map<string, number>();
  private readonly scratch = { x: 0, y: 0 };
  private lastHit = -1;
  private lastGained = -1;
  private lastLost = -1;

  /** `powerUpConfMin` is the FX confidence gate (2.1 principle 3, 7.3: powerUp plays only with conf >= it). */
  constructor(
    ctx: AudioContext, sfxBus: GainNode, bank: SampleBank, tuning: Tuning['audio'], rand: Rand,
    powerUpConfMin: number = T.fx.confidenceMin,
  ) {
    this.ctx = ctx;
    this.bank = bank;
    this.t = tuning;
    this.rand = rand;
    this.powerUpConfMin = powerUpConfMin;
    for (let i = 0; i < tuning.voicesTotal; i++) {
      const p = ctx.createStereoPanner();
      p.connect(sfxBus);
      this.panners.push(p);
      this.slotVoice.push(null);
      this.slotBusyUntil.push(0);
    }
  }

  /** Voices currently playing (debug and tests). */
  get voices(): number {
    return this.active.length;
  }

  readonly onEvents: IngestListener = (events: readonly GameEvent[], c: IngestEventCtx): void => {
    if (events.length === 0) return;
    if (c.headless || this.ctx.state !== 'running') {
      countDropped(events);
      return;
    }
    const cands: Cand[] = [];
    for (const e of events) {
      if (e.stale) continue;
      const cd = this.candidate(e, c);
      if (cd !== null) cands.push(cd);
    }
    this.resolve(cands);
    for (const cd of cands) if (cd.alive) this.schedule(cd);
  };

  playUi(cue: 'uiTap'): void {
    if (this.ctx.state !== 'running') {
      stats.audio.dropped++;
      return;
    }
    const cd = this.blank(cue, this.ctx.currentTime, -1, IMMEDIATE, 0);
    this.schedule(cd);
  }

  /** Fades every voice out over `fadeS` (0 = at once) and stops its sources. */
  stopAll(fadeS: number): void {
    const now = this.ctx.currentTime;
    for (const v of this.active.slice()) this.fadeOut(v, now, fadeS);
    stats.audio.voices = 0;
  }

  // ---- mapping ----

  private blank(cue: CueId, when: number, ball: number, tick: number, entity: number): Cand {
    return {
      cue, when, ball, tick, cell: -1, entity, repeat: 0, rate: 1, semitone: 0, gain: CUE_GAIN[cue] ?? 1, pan: 0,
      sample: null, layers: [], thump: false, alive: true,
    };
  }

  private candidate(e: GameEvent, c: IngestEventCtx): Cand | null {
    const me: Seat | null = c.myIndex;
    let cue: CueId;
    let ball = -1;
    let entity = 0;
    switch (e.k) {
      case 'paddleHit':
        cue = me !== null && e.seat === me ? 'paddleMine' : 'paddle';
        ball = e.ball;
        entity = e.ball;
        break;
      case 'ownerChanged':
        if (me === null || e.from === e.to) return null;
        if (e.to === me) cue = 'gained';
        else if (e.from === me) cue = 'lost';
        else return null;              // other players' changes are silent
        ball = e.ball;
        entity = e.ball;
        break;
      case 'wallBounce':
        cue = 'wall';
        ball = e.ball;
        entity = e.wall;               // retrigger per wall
        break;
      case 'goal':
        cue = me !== null && e.wall === me ? 'goalAgainst' : me !== null && e.scorer === me ? 'goalFor' : 'goalOther';
        ball = e.ball;
        entity = e.wall;
        break;
      case 'absorbed':
        cue = 'absorb';
        entity = e.ball;
        break;
      case 'brickBounce':
        cue = 'touch';
        ball = e.ball;
        entity = e.ball;
        break;
      case 'brickDamaged':
        cue = 'brickCrack';
        ball = e.ball;
        entity = e.cell;
        break;
      case 'brickDestroyed':
        cue = 'brickShatter';
        ball = e.ball;
        entity = e.cell;
        break;
      case 'ballSpawned':
        if (e.cause !== 'powerUp') return null;
        cue = 'spawn';
        entity = e.ball;
        break;
      case 'ballRemoved':
        if (e.cause === 'absorbed') return null;   // the absorbed event carries that sound
        cue = 'expire';
        entity = e.ball;
        break;
      case 'phaseStart':
        cue = 'phaseOn';
        entity = e.ball;
        break;
      case 'phaseEnd':
        cue = 'phaseOff';
        entity = e.ball;
        break;
      case 'powerUp':
        if (e.conf < this.powerUpConfMin) return null;
        cue = 'powerUp';
        entity = e.ball;
        break;
      case 'ballResized':
        cue = 'grow';
        entity = e.ball;
        break;
      case 'seat':
        if (e.to === e.from) return null;
        cue = e.to === SeatConn.Connected ? 'join' : 'leave';
        entity = e.seat;
        break;
      case 'countdown':
        cue = 'countTick';
        break;
      case 'go':
        cue = 'go';
        break;
      case 'gameOver':
        cue = me !== null && e.winner === me ? 'win' : 'lose';
        break;
      default:
        return null;
    }

    const lead = e.tick === IMMEDIATE ? 0 : (e.tick * TICK_MS - c.displayMs) / 1000;
    if (lead < -this.t.staleS) {
      stats.audio.dropped++;
      return null;
    }
    const cd = this.blank(cue, this.ctx.currentTime + clamp(lead, 0, this.t.maxLeadS), ball, e.tick, entity);

    switch (e.k) {
      case 'paddleHit':
        cd.sample = 'hit';
        cd.rate = (0.9 + (0.25 * e.speed) / 12) * this.jitter() * (cue === 'paddleMine' ? 1.05 : 1);
        break;
      case 'ownerChanged':
        cd.sample = cue === 'gained' ? 'gained' : 'lost';
        break;
      case 'wallBounce':
        cd.rate = WALL_HZ[e.wall] / WALL_HZ[0];
        break;
      case 'goal':
        if (cue === 'goalAgainst') cd.layers.push('lost');
        else if (cue === 'goalFor') cd.layers.push('gained');
        cd.repeat = e.repeat;
        break;
      case 'brickDamaged':
        cd.cell = e.cell;
        cd.semitone = PENTATONIC[clamp(e.level - e.to, 0, PENTATONIC.length - 1)];
        break;
      case 'brickDestroyed':
        cd.cell = e.cell;
        cd.semitone = PENTATONIC[clamp(e.level, 0, PENTATONIC.length - 1)] + clamp(e.chain - 1, 0, 7);
        cd.thump = e.from >= SHATTER_SUB.minFrom;
        break;
      default:
        break;
    }

    if (POSITIONAL.has(e.k)) {
      canvasToBoard(e.x, e.y, CANVAS, this.scratch);
      boardToView(me, this.scratch.x, this.scratch.y, this.scratch);
      cd.pan = clamp(this.scratch.x / (CANVAS / 2), -PAN_MAX, PAN_MAX);
      if (this.scratch.y > 0) cd.gain *= FAR_HALF_GAIN;
    }
    return cd;
  }

  /** Brick dedupe, per-ball per-tick priority, gained/lost layering (C80), then goal repeats (C47). */
  private resolve(cands: Cand[]): void {
    const shatterCells = new Set<number>();
    for (const cd of cands) if (cd.cue === 'brickShatter') shatterCells.add(cd.cell);
    const crackSeen = new Set<string>();
    for (const cd of cands) {
      if (cd.cue !== 'brickCrack') continue;
      const key = `${cd.cell}:${cd.tick}`;
      if (shatterCells.has(cd.cell) || crackSeen.has(key)) cd.alive = false;
      else crackSeen.add(key);
    }

    for (let i = 0; i < cands.length; i++) {
      const a = cands[i];
      const ra = RANK[a.cue] ?? 0;
      if (!a.alive || ra === 0 || a.ball < 0) continue;
      for (let j = 0; j < cands.length; j++) {
        const b = cands[j];
        if (j === i || !b.alive || b.ball !== a.ball || b.tick !== a.tick) continue;
        const rb = RANK[b.cue] ?? 0;
        if (rb > ra || (rb === ra && j < i)) {
          a.alive = false;
          break;
        }
      }
    }

    for (const cd of cands) {
      if (!cd.alive || (cd.cue !== 'gained' && cd.cue !== 'lost')) continue;
      let winner: Cand | null = null;
      for (const w of cands) {
        if (w.alive && (RANK[w.cue] ?? 0) > 0 && w.ball === cd.ball && w.tick === cd.tick) {
          winner = w;
          break;
        }
      }
      if (winner === null) continue;                   // standalone
      const kind: SampleKind = cd.cue === 'gained' ? 'gained' : 'lost';
      if ((winner.cue === 'goalAgainst' && kind === 'lost') || (winner.cue === 'goalFor' && kind === 'gained')) {
        cd.alive = false;                              // the goal already carries that sample
      } else if (winner.repeat === 0) {
        winner.layers.push(kind);                      // one voice, not a stacked sample
        cd.alive = false;
      }                                                // a silent goal repeat leaves it standalone
    }

    for (const cd of cands) {
      if (cd.alive && cd.repeat > 0) {
        cd.alive = false;
        stats.audio.dropped++;
      }
    }
  }

  // ---- scheduling ----

  private schedule(cd: Cand): void {
    const now = this.ctx.currentTime;
    const key = `${cd.cue}:${cd.entity}`;
    const last = this.lastAt.get(key);
    if (last !== undefined && Math.abs(cd.when - last) < this.t.retriggerMs / 1000) {
      stats.audio.dropped++;
      return;
    }
    this.lastAt.set(key, cd.when);
    if (this.lastAt.size > 512) {
      for (const [k, at] of this.lastAt) if (at < now - 1) this.lastAt.delete(k);
    }

    if (cd.cue === 'win' || cd.cue === 'lose') {
      this.onCue?.(cd.cue, cd.when);
      return;
    }

    this.reclaim(now);
    const sameCue = this.active.filter((v) => v.cue === cd.cue);
    if (sameCue.length >= CUE_CAPS[cd.cue]) this.fadeOut(sameCue[0], now, STEAL_FADE_S);
    if (this.active.length >= this.t.voicesTotal) this.fadeOut(this.active[0], now, STEAL_FADE_S);
    const slot = this.freeSlot(now);
    const when = Math.max(cd.when, this.slotBusyUntil[slot]);

    const gain = this.ctx.createGain();
    gain.gain.value = cd.gain;
    gain.connect(this.panners[slot]);
    // A voice stolen before it started leaves its pan event on the slot's timeline; clear it first.
    this.panners[slot].pan.cancelScheduledValues(now);
    this.panners[slot].pan.setValueAtTime(cd.pan, when);

    const sources: AudioScheduledSourceNode[] = [];
    let end = when;
    const addSample = (kind: SampleKind, rate: number): void => {
      const buf = this.bank.get(this.pick(kind));
      if (buf === null) return;
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = rate;
      src.connect(gain);
      src.start(when);
      sources.push(src);
      end = Math.max(end, when + buf.duration / rate);
    };
    if (cd.sample !== null) addSample(cd.sample, clamp(cd.rate, 0.5, 2));
    for (const layer of cd.layers) addSample(layer, 1);
    const synth = playSynth(this.ctx, gain, cd.cue, when, { rate: cd.rate, pan: 0, gain: 1, semitone: cd.semitone });
    if (synth !== null) {
      sources.push(synth);
      end = Math.max(end, when + synthLength(cd.cue));
    }
    if (cd.thump) {
      sources.push(playThump(this.ctx, gain, when, SHATTER_SUB.hz, SHATTER_SUB.s, SHATTER_SUB.gain));
      end = Math.max(end, when + SHATTER_SUB.s);
    }
    if (sources.length === 0) {                        // a sample-only cue before the samples arrive
      gain.disconnect();
      stats.audio.dropped++;
      return;
    }

    const voice: Voice = { cue: cd.cue, slot, gain, sources, pending: sources.length, startAt: when, endsAt: end, released: false };
    for (const src of sources) src.addEventListener('ended', () => this.onEnded(voice));
    this.active.push(voice);
    this.slotVoice[slot] = voice;
    stats.audio.voices = this.active.length;
    this.onCue?.(cd.cue, when);
  }

  private freeSlot(now: number): number {
    let best = -1;
    for (let i = 0; i < this.slotVoice.length; i++) {
      if (this.slotVoice[i] !== null) continue;
      if (this.slotBusyUntil[i] <= now) return i;
      if (best < 0 || this.slotBusyUntil[i] < this.slotBusyUntil[best]) best = i;
    }
    return best;   // never -1: the steal above freed at least one slot
  }

  /** Voices past their end time are freed even if `ended` never arrives. */
  private reclaim(now: number): void {
    for (const v of this.active.slice()) if (v.endsAt <= now) this.release(v, true);
  }

  private onEnded(v: Voice): void {
    v.pending--;
    if (v.pending <= 0) this.release(v, true);
  }

  private release(v: Voice, disconnect: boolean): void {
    if (!v.released) {
      v.released = true;
      const i = this.active.indexOf(v);
      if (i >= 0) this.active.splice(i, 1);
      if (this.slotVoice[v.slot] === v) this.slotVoice[v.slot] = null;
      stats.audio.voices = this.active.length;
    }
    if (disconnect && v.pending <= 0) v.gain.disconnect();
    else if (disconnect && v.endsAt <= this.ctx.currentTime) v.gain.disconnect();
  }

  private fadeOut(v: Voice, now: number, fadeS: number): void {
    const g = v.gain.gain;
    g.cancelScheduledValues(now);
    if (fadeS > 0) {
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(0, now + fadeS);
    } else {
      g.setValueAtTime(0, now);
    }
    for (const src of v.sources) {
      try {
        src.stop(now + fadeS);
      } catch {
        // already stopped
      }
    }
    this.slotBusyUntil[v.slot] = Math.max(this.slotBusyUntil[v.slot], now + fadeS);
    this.release(v, false);
  }

  private jitter(): number {
    return 1 + (this.rand() * 2 - 1) * RATE_JITTER;
  }

  /** hit_n never repeats its index twice in a row; gained_n and lost_n alternate. */
  private pick(kind: SampleKind): SampleName {
    if (kind === 'hit') {
      let r: number;
      if (this.lastHit < 0) r = Math.min(4, Math.floor(this.rand() * 5));
      else {
        r = Math.min(3, Math.floor(this.rand() * 4));
        if (r >= this.lastHit) r++;
      }
      this.lastHit = r;
      return `hit${r}` as SampleName;
    }
    if (kind === 'gained') {
      this.lastGained = this.lastGained < 0 ? Math.min(1, Math.floor(this.rand() * 2)) : 1 - this.lastGained;
      return `gained${this.lastGained}` as SampleName;
    }
    this.lastLost = this.lastLost < 0 ? Math.min(1, Math.floor(this.rand() * 2)) : 1 - this.lastLost;
    return `lost${this.lastLost}` as SampleName;
  }
}
