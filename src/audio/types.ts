// Audio engine types (4.10). Implemented by P4 (src/audio/*).

import type { IngestListener } from '../game/events';
import type { AudioPort } from '../session/types';
import type { AppStore } from '../state/appStore';
import type { Settings } from '../lib/settings';
import type { Now } from '../lib/clock';
import type { Rand } from '../lib/random';
import type { Tuning } from '../config/tuning';

export type AudioState = 'uninitialized' | 'locked' | 'running' | 'suspended' | 'interrupted' | 'closed' | 'unsupported';
export type MusicScene = 'off' | 'landing' | 'lobby' | 'countdown' | 'playing' | 'finished';
export type CueId = 'paddle' | 'paddleMine' | 'wall' | 'goalAgainst' | 'goalFor' | 'goalOther' | 'absorb'
  | 'brickCrack' | 'brickShatter' | 'gained' | 'lost' | 'phaseOn' | 'phaseOff' | 'spawn' | 'expire'
  | 'powerUp' | 'grow' | 'join' | 'leave' | 'countTick' | 'go' | 'win' | 'lose' | 'touch' | 'uiTap';
export interface AudioEngine extends AudioPort {
  init(win: Window): () => void;      // arms the gesture listeners; creates no context until a gesture
  readonly state: AudioState;
  readonly context: AudioContext | null;   // the only AudioContext in the app
  readonly onEvents: IngestListener;       // subscribed to GameRuntime.onIngestEvents by the composition root
  playUi(cue: 'uiTap'): void;
  setIntensity(v: number): void;           // 0..1 music intensity while playing
  setMix(s: Settings): void;
  setSuppressed(on: boolean): void;   // App's crash mute (12.3): while on, sfx, cues and music stay silent whatever setHidden says
  dispose(): Promise<void>;
}
export interface AudioDeps {
  store: AppStore; now?: Now; rand?: Rand; tuning?: Tuning;
  createContext?: () => AudioContext;
  loadTone?: () => Promise<typeof import('tone')>;
  fetchBytes?: (url: string, signal: AbortSignal) => Promise<ArrayBuffer>;
}
