// UnlockMachine (5.9; D19, C14, C78, C79, C83). Capture-phase passive listeners for pointerdown, keydown,
// touchend and click. Inside the gesture, synchronously: create the one AudioContext if there is none, then
// resume it unless it is running. Every state the context reaches is reported: `running` disarms, while
// `suspended` and `interrupted` re-arm, however many times they happen (C14).
//
// The context's `statechange` is watched with addEventListener, never through `onstatechange`: Tone's
// Context assigns `onstatechange` on the raw context it wraps (tone/build/esm/core/context/Context.js:68),
// which would silently remove a handler installed that way once the music loads.

import type { AudioState } from './types';
import { log } from '../lib/log';

export const GESTURE_EVENTS = ['pointerdown', 'keydown', 'touchend', 'click'] as const;
const LISTEN: AddEventListenerOptions = { capture: true, passive: true };

/** The app-level state of a context. `locked` is a context that has never run (autoplay policy). */
export function toAudioState(raw: string, everRan: boolean): AudioState {
  switch (raw) {
    case 'running': return 'running';
    case 'interrupted': return 'interrupted';
    case 'closed': return 'closed';
    case 'suspended': return everRan ? 'suspended' : 'locked';
    default: return 'locked';
  }
}

export class UnlockMachine {
  private readonly win: Window;
  private readonly getCtx: () => AudioContext | null;
  private readonly create: () => AudioContext;
  private readonly onState: (s: AudioState) => void;
  private armed = false;
  private disposed = false;
  private everRan = false;
  private last: AudioState | null = null;
  private watched: AudioContext | null = null;

  constructor(win: Window, getCtx: () => AudioContext | null, create: () => AudioContext, onState: (s: AudioState) => void) {
    this.win = win;
    this.getCtx = getCtx;
    this.create = create;
    this.onState = onState;
  }

  /** Installs the gesture listeners (idempotent). If a context already exists, starts watching it. */
  arm(): void {
    if (this.disposed) return;
    const ctx = this.getCtx();
    if (ctx !== null) this.watch(ctx);
    if (this.armed) return;
    this.armed = true;
    for (const type of GESTURE_EVENTS) this.win.addEventListener(type, this.onGesture, LISTEN);
  }

  disarm(): void {
    if (!this.armed) return;
    this.armed = false;
    for (const type of GESTURE_EVENTS) this.win.removeEventListener(type, this.onGesture, LISTEN);
  }

  /** Removes every listener, including the context's statechange listener. */
  dispose(): void {
    this.disarm();
    this.watched?.removeEventListener('statechange', this.onStateChange);
    this.watched = null;
    this.disposed = true;
  }

  get isArmed(): boolean {
    return this.armed;
  }

  private readonly onGesture = (): void => {
    if (this.disposed) return;
    let ctx = this.getCtx();
    if (ctx === null) {
      try {
        ctx = this.create();
      } catch (err) {
        log.warn('audio: AudioContext creation failed', err);
        return;
      }
    }
    this.watch(ctx);
    if (ctx.state !== 'running' && ctx.state !== 'closed') {
      const report = (): void => this.report();
      ctx.resume().then(report, report);
    }
    this.report();
  };

  private readonly onStateChange = (): void => this.report();

  private watch(ctx: AudioContext): void {
    if (this.watched === ctx) return;
    this.watched?.removeEventListener('statechange', this.onStateChange);
    this.watched = ctx;
    ctx.addEventListener('statechange', this.onStateChange);
  }

  private report(): void {
    if (this.disposed || this.watched === null) return;
    const s = toAudioState(this.watched.state as string, this.everRan);
    if (s === 'running') {
      this.everRan = true;
      this.disarm();
    } else if (s === 'closed') {
      this.disarm();
    } else {
      this.arm();
    }
    if (s !== this.last) {
      this.last = s;
      this.onState(s);
    }
  }
}
