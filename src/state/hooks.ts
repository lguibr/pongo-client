// UI hooks and selectors (4.14). Every hook reads through useApp(), so components need an AppProvider.

import { useCallback } from 'react';
import { useApp } from '../app/AppContext';
import { useStore } from '../lib/useStore';
import type { AppState } from './appStore';
import type { Seat } from '../game/events';
import type { Settings } from '../lib/settings';

export function useAppState<U>(select: (s: AppState) => U, equal?: (a: U, b: U) => boolean): U {
  return useStore(useApp().store, select, equal);
}
export const useSession = () => useAppState(s => s.session);
export const useSeats = () => useAppState(s => s.seats);
export const useSeat = (i: Seat) => useAppState(s => s.seats[i]);        // SeatView objects are reused when unchanged
export const useScore = (i: Seat) => useAppState(s => s.seats[i].score);  // per-row subscription
export const useCountdown = () => useAppState(s => s.countdown);
export const useResults = () => useAppState(s => s.results);
export const useNotices = () => useAppState(s => s.notices);
export const useNet = () => useAppState(s => s.net);
export const usePage = () => useAppState(s => s.page);
export const useGfx = () => useAppState(s => s.gfx);
export const useAudioStatus = () => useAppState(s => s.audio);
export const useUpdateReady = () => useAppState(s => s.pwa.updateReady);
export const useLastLeft = () => useAppState(s => s.lastLeft);
export const useReducedMotion = () => useAppState(s => s.motion.reduced);
export const useMyReady = () => useAppState(s => (s.session.myIndex === null ? false : s.seats[s.session.myIndex].ready));

const selectAll = (s: Settings): Settings => s;

export function useSettings(): [Settings, (patch: Partial<Settings>) => void] {
  const { settings } = useApp();
  const value = useStore(settings, selectAll);
  const update = useCallback((patch: Partial<Settings>) => settings.update(patch), [settings]);
  return [value, update];
}
