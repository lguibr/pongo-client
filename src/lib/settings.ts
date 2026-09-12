// Validated persisted settings (C40), the one-time migration of the legacy volume keys, and the
// reduced-motion watcher.

import { createStore } from './store';
import type { Store } from './store';
import type { SafeStorage } from './storage';

export type MotionPref = 'system' | 'reduced' | 'full';
export type QualityPref = 'auto' | 'high' | 'medium' | 'low';
export interface Settings { sfxVolume: number; musicVolume: number; sfxMuted: boolean; musicMuted: boolean; motion: MotionPref; quality: QualityPref }
export const DEFAULT_SETTINGS: Settings = Object.freeze({
  sfxVolume: 0.7, musicVolume: 0.5, sfxMuted: false, musicMuted: false, motion: 'system', quality: 'auto',
});
export const SETTINGS_KEY = 'pongo.settings.v2';
export const LEGACY_KEYS = { sfx: 'pongo-volume', music: 'pongo-soundtrack-volume' } as const;
export interface SettingsStore extends Store<Settings> { update(patch: Partial<Settings>): void }

const MOTION: readonly MotionPref[] = ['system', 'reduced', 'full'];
const QUALITY: readonly QualityPref[] = ['auto', 'high', 'medium', 'low'];

type Rec = Record<string, unknown>;
const isRecord = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const isVolume = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Stored data: any field that is missing, of the wrong type, NaN or outside 0..1 takes its default.
 *  (Every in-app write is clamped, so an out-of-range stored value means corruption.) */
export function parseSettings(raw: unknown): Settings {
  const o: Rec = isRecord(raw) ? raw : {};
  const d = DEFAULT_SETTINGS;
  return {
    sfxVolume: isVolume(o.sfxVolume) ? clamp01(o.sfxVolume) : d.sfxVolume,
    musicVolume: isVolume(o.musicVolume) ? clamp01(o.musicVolume) : d.musicVolume,
    sfxMuted: typeof o.sfxMuted === 'boolean' ? o.sfxMuted : d.sfxMuted,
    musicMuted: typeof o.musicMuted === 'boolean' ? o.musicMuted : d.musicMuted,
    motion: MOTION.includes(o.motion as MotionPref) ? (o.motion as MotionPref) : d.motion,
    quality: QUALITY.includes(o.quality as QualityPref) ? (o.quality as QualityPref) : d.quality,
  };
}

/** A UI patch: finite volumes are clamped to 0..1; anything invalid keeps the current value. */
function applyPatch(cur: Settings, p: Partial<Settings>): Settings {
  const next: Settings = { ...cur };
  if (typeof p.sfxVolume === 'number' && Number.isFinite(p.sfxVolume)) next.sfxVolume = clamp01(p.sfxVolume);
  if (typeof p.musicVolume === 'number' && Number.isFinite(p.musicVolume)) next.musicVolume = clamp01(p.musicVolume);
  if (typeof p.sfxMuted === 'boolean') next.sfxMuted = p.sfxMuted;
  if (typeof p.musicMuted === 'boolean') next.musicMuted = p.musicMuted;
  if (p.motion !== undefined && MOTION.includes(p.motion)) next.motion = p.motion;
  if (p.quality !== undefined && QUALITY.includes(p.quality)) next.quality = p.quality;
  return next;
}

function sameSettings(a: Settings, b: Settings): boolean {
  return a.sfxVolume === b.sfxVolume && a.musicVolume === b.musicVolume && a.sfxMuted === b.sfxMuted
    && a.musicMuted === b.musicMuted && a.motion === b.motion && a.quality === b.quality;
}

/** Legacy mute icons wrote volume 0 (main:src/App.tsx:189-207), so 0 means muted at the default volume. */
function legacyChannel(raw: string | null, fallbackVolume: number): { volume: number; muted: boolean } {
  const n = raw === null || raw.trim() === '' ? NaN : Number(raw);
  if (n === 0) return { volume: fallbackVolume, muted: true };
  if (Number.isFinite(n) && n > 0 && n <= 1) return { volume: n, muted: false };
  return { volume: fallbackVolume, muted: false };
}

function load(storage: SafeStorage): Settings {
  const stored = storage.get(SETTINGS_KEY);
  let settings: Settings;
  if (stored !== null) {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(stored);
    } catch {
      parsed = null;
    }
    settings = parseSettings(parsed);
  } else {
    settings = { ...DEFAULT_SETTINGS };
  }

  const legacySfx = storage.get(LEGACY_KEYS.sfx);
  const legacyMusic = storage.get(LEGACY_KEYS.music);
  if (legacySfx !== null || legacyMusic !== null) {
    // Migrate once: only when no v2 record exists yet. The legacy keys are deleted once a v2 record is in
    // storage; when the migrated record stays in memory only, they are kept so the next load migrates again.
    if (stored === null) {
      const sfx = legacyChannel(legacySfx, DEFAULT_SETTINGS.sfxVolume);
      const music = legacyChannel(legacyMusic, DEFAULT_SETTINGS.musicVolume);
      settings = { ...settings, sfxVolume: sfx.volume, sfxMuted: sfx.muted, musicVolume: music.volume, musicMuted: music.muted };
      if (!storage.set(SETTINGS_KEY, JSON.stringify(settings))) return settings;
    }
    storage.remove(LEGACY_KEYS.sfx);
    storage.remove(LEGACY_KEYS.music);
  }
  return settings;
}

/** Migrates the legacy keys once, then deletes them. Today's mute icons write volume 0 to those keys
 *  (main:src/App.tsx:189-207), so a legacy 0 means muted: 0 -> { xMuted: true, xVolume: default (sfx 0.7,
 *  music 0.5) }; a finite value in (0, 1] -> { xMuted: false, xVolume: value }; anything else -> defaults. */
export function createSettingsStore(storage: SafeStorage): SettingsStore {
  const inner = createStore<Settings>(load(storage));
  const commit = (next: Settings): void => {
    if (sameSettings(inner.get(), next)) return;
    inner.set(next);
    storage.set(SETTINGS_KEY, JSON.stringify(next));
  };
  return {
    get: inner.get,
    subscribe: inner.subscribe,
    set: (next: Settings) => commit(applyPatch(inner.get(), next)),
    patch: (p: Partial<Settings>) => commit(applyPatch(inner.get(), p)),
    update: (p: Partial<Settings>) => commit(applyPatch(inner.get(), p)),
  };
}

function systemReducedQuery(): MediaQueryList | null {
  try {
    return typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  } catch {
    return null;
  }
}

/** Calls onChange at once with the effective value, then whenever it changes: 'reduced' and 'full' force it;
 *  'system' follows `mql` (default: the prefers-reduced-motion query). */
export function watchReducedMotion(settings: SettingsStore, onChange: (reduced: boolean) => void, mql?: MediaQueryList): () => void {
  const query = mql ?? systemReducedQuery();
  let last: boolean | null = null;
  const evaluate = (): void => {
    const pref = settings.get().motion;
    const reduced = pref === 'reduced' ? true : pref === 'full' ? false : query !== null && query.matches;
    if (reduced === last) return;
    last = reduced;
    onChange(reduced);
  };
  const onQuery = (): void => evaluate();
  if (query !== null) {
    if (typeof query.addEventListener === 'function') query.addEventListener('change', onQuery);
    else query.addListener(onQuery);
  }
  const unsubscribe = settings.subscribe(evaluate);
  evaluate();
  return () => {
    unsubscribe();
    if (query === null) return;
    if (typeof query.removeEventListener === 'function') query.removeEventListener('change', onQuery);
    else query.removeListener(onQuery);
  };
}
