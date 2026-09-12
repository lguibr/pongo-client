// The audio engine (5.9, 7.1; D19, C14, C15, C78, C79, C83, C84): one AudioContext, created inside the
// first gesture, the bus graph with a limiter, the sample bank, the cue mixer and the lazy Tone music.
//
//   destination <- limiter <- master <- sfxBus   (sfxMuted ? 0 : sfxVolume^2 * sfxGainScale)
//                                     <- musicBus (musicMuted ? 0 : musicVolume^2 * 0.6) <- ducker <- Tone
//
// The only writer of the `audio` slice of appStore.

import type { AudioDeps, AudioEngine, AudioState, MusicScene, CueId } from './types';
import type { GameEvent, IngestEventCtx, IngestListener } from '../game/events';
import type { Settings } from '../lib/settings';
import { DEFAULT_SETTINGS } from '../lib/settings';
import { T as TUNING_DEFAULT } from '../config/tuning';
import type { Tuning } from '../config/tuning';
import { rand as randDefault } from '../lib/random';
import type { Rand } from '../lib/random';
import { clamp } from '../lib/math';
import { log } from '../lib/log';
import { UnlockMachine } from './unlock';
import { SampleBank } from './samples';
import { CueMixer, countDropped } from './cues';
import { Music } from './music';

export const MIX = { musicGainScale: 0.6, gainTcS: 0.05, limiterAttackS: 0.003, limiterReleaseS: 0.15, limiterKneeDb: 0 } as const;

const noop = (): void => {};

type Ctor = new (opts?: AudioContextOptions) => AudioContext;

/** Closes a context without surfacing a rejection or a synchronous throw. */
function closeQuietly(ctx: AudioContext): void {
  try {
    ctx.close().catch(noop);
  } catch {
    // a context that cannot even start closing is already unusable
  }
}

/** Cancels automation at `t`, holding the current value where the browser supports it. */
function holdAt(p: AudioParam, t: number): void {
  if (typeof p.cancelAndHoldAtTime === 'function') p.cancelAndHoldAtTime(t);
  else p.cancelScheduledValues(t);
}

export function sfxGain(s: Settings, scale: number): number {
  return s.sfxMuted ? 0 : s.sfxVolume * s.sfxVolume * scale;
}
export function musicGain(s: Settings): number {
  return s.musicMuted ? 0 : s.musicVolume * s.musicVolume * MIX.musicGainScale;
}

interface Graph { limiter: DynamicsCompressorNode; master: GainNode; sfxBus: GainNode; musicBus: GainNode }

class Engine implements AudioEngine {
  private readonly deps: AudioDeps;
  private readonly rand: Rand;
  private readonly t: Tuning['audio'];
  private readonly confMin: number;
  private stateValue: AudioState = 'uninitialized';
  private musicReady = false;
  private ctx: AudioContext | null = null;
  private graph: Graph | null = null;
  private bank: SampleBank | null = null;
  private mixer: CueMixer | null = null;
  private music: Music | null = null;
  private unlock: UnlockMachine | null = null;
  private factory: (() => AudioContext) | null = null;
  private settings: Settings = DEFAULT_SETTINGS;
  private scene: MusicScene = 'off';
  private hidden = false;
  /** App's crash mute (12.3), ORed with `hidden`: a lifecycle setHidden(false) cannot lift it. */
  private suppressed = false;
  private intensity = 0;
  private disposed = false;
  private disposing: Promise<void> | null = null;

  constructor(deps: AudioDeps) {
    this.deps = deps;
    this.rand = deps.rand ?? randDefault;
    const tuning = deps.tuning ?? TUNING_DEFAULT;
    this.t = tuning.audio;
    this.confMin = tuning.fx.confidenceMin;
  }

  get state(): AudioState {
    return this.stateValue;
  }

  get context(): AudioContext | null {
    return this.ctx;
  }

  init(win: Window): () => void {
    if (this.disposed) return noop;
    if (this.unlock !== null) return this.detach;
    this.factory = this.resolveFactory(win);
    if (this.factory === null) {
      this.setState('unsupported');
      return noop;
    }
    if (this.ctx === null) this.setState('uninitialized');
    this.unlock = new UnlockMachine(win, () => this.ctx, () => this.create(), (s) => this.onState(s));
    this.unlock.arm();
    return this.detach;
  }

  private readonly detach = (): void => {
    this.unlock?.dispose();
    this.unlock = null;
  };

  readonly onEvents: IngestListener = (events: readonly GameEvent[], c: IngestEventCtx): void => {
    if (this.silent() || this.mixer === null || this.disposed) {
      countDropped(events);
      return;
    }
    this.mixer.onEvents(events, c);
  };

  playUi(cue: 'uiTap'): void {
    if (this.silent() || this.mixer === null || this.disposed) return;
    this.mixer.playUi(cue);
  }

  setIntensity(v: number): void {
    this.intensity = clamp(Number.isFinite(v) ? v : 0, 0, 1);
    this.music?.setIntensity(this.intensity);
  }

  setMix(s: Settings): void {
    this.settings = s;
    this.applyMix();
  }

  setScene(scene: MusicScene): void {
    this.scene = scene;
    this.music?.setScene(scene);
  }

  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    this.applyHidden(hidden || this.suppressed);
  }

  setSuppressed(on: boolean): void {
    this.suppressed = on;
    this.applyHidden(this.hidden || on);
  }

  dispose(): Promise<void> {
    if (this.disposing !== null) return this.disposing;
    this.disposed = true;
    this.disposing = this.close();
    return this.disposing;
  }

  private async close(): Promise<void> {
    this.unlock?.dispose();
    this.unlock = null;
    this.mixer?.stopAll(0);
    this.music?.dispose();
    this.bank?.dispose();
    this.mixer = null;
    this.music = null;
    this.bank = null;
    const ctx = this.ctx;
    if (this.graph !== null) {
      this.graph.sfxBus.disconnect();
      this.graph.musicBus.disconnect();
      this.graph.master.disconnect();
      this.graph.limiter.disconnect();
      this.graph = null;
    }
    if (ctx !== null && ctx.state !== 'closed') {
      try {
        await ctx.close();
      } catch (err) {
        log.warn('audio: AudioContext.close failed', err);
      }
    }
    this.stateValue = 'closed';
    this.musicReady = false;
    this.publish();
  }

  // ---- internals ----

  /** The effective hidden state: the page is hidden, or App's crash mute is on. */
  private silent(): boolean {
    return this.hidden || this.suppressed;
  }

  /** Applies the effective hidden state (`hidden || suppressed`) to the sfx bus, the voices and the music. */
  private applyHidden(effective: boolean): void {
    const ctx = this.ctx;
    const g = this.graph;
    if (ctx !== null && g !== null && !this.disposed) {
      const now = ctx.currentTime;
      const p = g.sfxBus.gain;
      holdAt(p, now);
      if (effective) {
        p.setValueAtTime(p.value, now);
        p.linearRampToValueAtTime(0, now + this.t.hiddenFadeS);
        this.mixer?.stopAll(this.t.hiddenFadeS);
      } else {
        p.setTargetAtTime(sfxGain(this.settings, this.t.sfxGainScale), now, MIX.gainTcS);
      }
    }
    this.music?.setHidden(effective);
    // 5.9 visible: resume a context that is not running and re-arm the gestures.
    if (!effective && ctx !== null && !this.disposed && ctx.state !== 'running' && ctx.state !== 'closed') {
      ctx.resume().catch(noop);
      this.unlock?.arm();
    }
  }

  /** 5.9: only the unprefixed constructor. Prefixed-only browsers (Safari before 14.1) lack
   *  createStereoPanner and the promise form of decodeAudioData, so they are `unsupported`. */
  private resolveFactory(win: Window): (() => AudioContext) | null {
    if (this.deps.createContext !== undefined) return this.deps.createContext;
    const C = (win as Window & { AudioContext?: Ctor }).AudioContext;
    if (typeof C !== 'function') return null;
    return () => new C({ latencyHint: 'interactive' });
  }

  /** Runs inside the first gesture (UnlockMachine): the context, the bus graph and the players. Atomic: the
   *  engine keeps nothing unless every part is built. On a failure the context is closed, the gestures are
   *  disarmed, the state is `unsupported`, and the error is rethrown to the UnlockMachine. */
  private create(): AudioContext {
    if (this.factory === null) throw new Error('audio: init() was not called');
    const ctx = this.factory();
    let bank: SampleBank | null = null;
    let music: Music | null = null;
    try {
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = this.t.limiterThresholdDb;
      limiter.ratio.value = this.t.limiterRatio;
      limiter.knee.value = MIX.limiterKneeDb;
      limiter.attack.value = MIX.limiterAttackS;
      limiter.release.value = MIX.limiterReleaseS;
      limiter.connect(ctx.destination);
      const master = ctx.createGain();
      master.gain.value = 1;
      master.connect(limiter);
      const sfxBus = ctx.createGain();
      sfxBus.gain.value = this.silent() ? 0 : sfxGain(this.settings, this.t.sfxGainScale);
      sfxBus.connect(master);
      const musicBus = ctx.createGain();
      musicBus.gain.value = musicGain(this.settings);
      musicBus.connect(master);

      bank = new SampleBank(ctx, this.deps.fetchBytes);
      const mixer = new CueMixer(ctx, sfxBus, bank, this.t, this.rand, this.confMin);
      music = new Music(ctx, musicBus, this.deps.loadTone ?? (() => import('tone')));
      music.setHidden(this.silent());
      music.setMuted(this.musicMuted());
      music.setIntensity(this.intensity);
      music.setScene(this.scene);

      mixer.onCue = this.onCue;
      this.ctx = ctx;
      this.graph = { limiter, master, sfxBus, musicBus };
      this.bank = bank;
      this.mixer = mixer;
      this.music = music;
      return ctx;
    } catch (err) {
      music?.dispose();
      bank?.dispose();
      closeQuietly(ctx);
      this.factory = null;
      this.unlock?.disarm();
      this.setState('unsupported');
      throw err;
    }
  }

  private readonly onCue = (cue: CueId, when: number): void => {
    if (cue === 'goalAgainst') this.music?.duck(this.t.goalDuckDb, this.t.goalDuckS, when);
    else if (cue === 'win' || cue === 'lose') this.music?.sting(cue);
  };

  private onState(s: AudioState): void {
    if (this.disposed) return;
    this.stateValue = s;
    if (s === 'running') {
      void this.bank?.load();
      this.startMusic();
    }
    this.publish();
  }

  /** Music starts on every running state however the context got there (C79); ensure() is idempotent. */
  private startMusic(): void {
    const m = this.music;
    if (m === null) return;
    m.ensure().then(() => {
      if (this.disposed || this.music !== m) return;
      m.setScene(this.scene);
      if (this.musicReady !== m.ready) {
        this.musicReady = m.ready;
        this.publish();
      }
    }, (err: unknown) => log.warn('audio: music unavailable', err));
  }

  private musicMuted(): boolean {
    return this.settings.musicMuted || this.settings.musicVolume <= 0;
  }

  private applyMix(): void {
    const ctx = this.ctx;
    const g = this.graph;
    if (ctx === null || g === null || this.disposed) return;
    const now = ctx.currentTime;
    if (!this.silent()) {
      holdAt(g.sfxBus.gain, now);
      g.sfxBus.gain.setTargetAtTime(sfxGain(this.settings, this.t.sfxGainScale), now, MIX.gainTcS);
    }
    holdAt(g.musicBus.gain, now);
    g.musicBus.gain.setTargetAtTime(musicGain(this.settings), now, MIX.gainTcS);
    this.music?.setMuted(this.musicMuted());
  }

  private setState(s: AudioState): void {
    this.stateValue = s;
    this.publish();
  }

  private publish(): void {
    const cur = this.deps.store.get().audio;
    if (cur.state === this.stateValue && cur.musicReady === this.musicReady) return;
    this.deps.store.patch({ audio: { state: this.stateValue, musicReady: this.musicReady } });
  }
}

export function createAudioEngine(deps: AudioDeps): AudioEngine {
  return new Engine(deps);
}
