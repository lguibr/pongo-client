// Input controller and joystick types (4.9). Implemented by P3 (src/input/*).

import type { WireDirection } from '../protocol/messages';
import type { Seat } from '../game/events';
import type { SessionStateName, InputPort } from '../session/types';
import type { TimerHost } from '../lib/timers';
import type { Now } from '../lib/clock';
import type { Tuning } from '../config/tuning';

export type Visual = -1 | 0 | 1;     // screen left, stop, screen right
export interface JoystickModel {
  /** Accepts only pointerType 'touch' or 'pen'. Returns true when it captured the pointer. */
  down(pointerId: number, clientX: number, clientY: number, pointerType: string, zone: DOMRectReadOnly): boolean;
  move(pointerId: number, clientX: number, clientY: number): void;
  up(pointerId: number): void;
  cancelAll(): void;
  readonly axis: Visual | null;      // null = no active touch
  readonly knob: Float32Array;       // [active 0|1, baseX, baseY, dx], zone-local CSS px, for the DOM painter
}
export interface InputSessionView { s: SessionStateName; gen: number; epoch: number; me: Seat | null }
export interface InputController extends InputPort {
  attach(win: Window): () => void;   // keydown, keyup, blur, visibilitychange, pagehide; installed once at boot
  setSink(send: ((d: WireDirection) => boolean) | null): void;
  onSession(v: InputSessionView): void;
  readonly joystick: JoystickModel;
  readonly desired: Visual;          // current visual intent (chevrons, own-paddle lead)
  readonly lastSent: WireDirection | null;
  readonly stats: { sent: number; coalesced: number; refused: number };
}
export interface InputDeps { now?: Now; timers?: TimerHost; tuning?: Tuning }
