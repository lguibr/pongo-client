// The composed app (4.16). Built once by createApp in src/app/runtime.ts (P8).

import type { AppStore } from '../state/appStore';
import type { SettingsStore } from '../lib/settings';
import type { SessionApi } from '../session/types';
import type { GameRuntime } from '../game/types';
import type { InputController } from '../input/types';
import type { AudioEngine } from '../audio/types';

export interface PwaApi {
  readonly supported: boolean; applyUpdate(): void; start(): void; dispose(): void;
  notifyRoute(pathname: string): void;   // called by App.tsx on every location change (5.14 apply policy)
}
export interface App {
  readonly store: AppStore;
  readonly settings: SettingsStore;
  readonly session: SessionApi;
  readonly game: GameRuntime;
  readonly input: InputController;
  readonly audio: AudioEngine;
  readonly pwa: PwaApi;
  dispose(): void;
}
