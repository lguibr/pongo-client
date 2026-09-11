// Render and effects contracts (4.11). The frame loop and GameStage are P5; the effects director is P7.

import type * as THREE from 'three';
import type { Seat, Owner, Wall, GameEvent } from '../game/events';
import type { RenderState, World } from '../game/types';
import type { SessionStateName } from '../session/types';

export type Tier = 'high' | 'medium' | 'low';
export type StageMode = 'lobby' | 'live' | 'frozen' | 'ended';
export interface FrameCtx {
  nowMs: number; dtMs: number; dtS: number;
  fxTimeS: number; fxDtS: number;     // presentation time; stands still during hit-stop
  displayMs: number;
  reducedMotion: boolean; tier: Tier; myIndex: Seat | null;
  hitStopActive: boolean; session: SessionStateName; mode: StageMode;
}
export interface FrameSystem { readonly name: string; update(ctx: FrameCtx): void; reset(): void; dispose(): void }

export interface CameraFx {
  addTrauma(amount: number): void;                       // 0..1; amplitude = trauma^2
  impulse(dirX: number, dirY: number, strength: number): void;   // screen-space push, spring return
  kick(amount: number): void;                            // short dolly-in (0..0.05 of distance)
}
export interface PostFx {
  readonly enabled: boolean;                             // false on the low tier (no-ops)
  readonly lowBit: boolean;   // true when the composer runs on 8-bit buffers; FX HDR constants then scale by HDR.lowBitScale (6.4)
  flash(color: string, amount: number, seconds: number): void;
  aberration(amount: number, seconds: number): void;
  saturation(target: number, seconds: number): void;
  vignettePulse(color: string, amount: number, seconds: number): void;
  bloomBoost(amount: number, seconds: number): void;
}
export interface EntityFx {
  flashPaddle(seat: Seat, u: number, strength: number): void;     // u = 0..1 along the paddle
  squashPaddle(seat: Seat, amount: number): void;
  materialisePaddle(seat: Seat, mode: 'in' | 'out' | 'solidify'): void;
  flashWall(wall: Wall, u: number, strength: number, kind: 'bounce' | 'goal' | 'absorb' | 'phase'): void;
  pulseBall(ballId: number, strength: number): void;
  spawnBall(ballId: number): void;
  dissolveBall(ballId: number, seconds: number): void;
  resizeBall(ballId: number, radius: number): void;
  flashBrick(cell: number, strength: number): void;
  brickRise(mode: 'wave' | 'instant' | 'lower', seconds: number): void;
  ripple(x: number, y: number, strength: number): void;           // canvas px; floor shader, 8 slots
  winnerSweep(winner: Owner, seconds: number): void;
  setDim(target: number, seconds: number): void;                  // 0.35 lobby, 1 play, 0.4 frozen
  wallBreathe(seconds: number): void;
}
export interface FxHost {
  readonly scene: THREE.Scene;
  readonly board: THREE.Group;           // rotated board root; FX objects are added as its children
  readonly camera: CameraFx;
  readonly post: PostFx;
  readonly entities: EntityFx;
  readonly render: Readonly<RenderState>;
  readonly world: Readonly<World>;
  readonly popLayer: HTMLElement;        // absolutely positioned over the canvas, aria-hidden
  toBoard(x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3;  // canvas px -> board-local
  project(boardLocal: THREE.Vector3, out: { sx: number; sy: number; visible: boolean }): void; // CSS px in popLayer
  hitStop(ms: number, reason: 'goalConceded' | 'lastBrick'): void;
  slotOf(ballId: number): number;
  brickColor(life: number, out: THREE.Color): THREE.Color;
}
export interface FxStats { sparks: number; shards: number; rings: number; decals: number; trails: number; droppedP2: number; staleSkipped: number }
export interface FxDirector {
  consume(e: GameEvent, ctx: FrameCtx): void;   // stale events: state only, no presentation
  update(ctx: FrameCtx): void;
  lateUpdate(ctx: FrameCtx): void;              // after the camera: DOM pop projection
  reset(): void;                                // epoch change, visible again, stage remount
  setTier(t: Tier): void;
  dispose(): void;
  readonly stats: Readonly<FxStats>;
}
export type FxFactory = (host: FxHost) => FxDirector;
export const noopFxFactory: FxFactory = () => ({
  consume() {}, update() {}, lateUpdate() {}, reset() {}, setTier() {}, dispose() {},
  stats: { sparks: 0, shards: 0, rings: 0, decals: 0, trails: 0, droppedP2: 0, staleSkipped: 0 },
});
