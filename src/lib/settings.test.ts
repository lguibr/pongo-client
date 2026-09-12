import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, LEGACY_KEYS, SETTINGS_KEY, createSettingsStore, parseSettings, watchReducedMotion } from './settings';
import type { SafeStorage } from './storage';

function memSafe(initial: Record<string, string> = {}): SafeStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get: (k) => data.get(k) ?? null,
    set: (k, v) => {
      data.set(k, v);
      return true;
    },
    remove: (k) => {
      data.delete(k);
    },
    persistent: true,
  };
}

function fakeMql(initial: boolean) {
  const listeners = new Set<() => void>();
  const mql = {
    matches: initial,
    media: '(prefers-reduced-motion: reduce)',
    onchange: null,
    addEventListener: (_t: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_t: string, fn: () => void) => listeners.delete(fn),
    addListener: (fn: () => void) => listeners.add(fn),
    removeListener: (fn: () => void) => listeners.delete(fn),
    dispatchEvent: () => false,
  };
  return {
    mql: mql as unknown as MediaQueryList,
    listeners,
    set(v: boolean) {
      mql.matches = v;
      for (const fn of Array.from(listeners)) fn();
    },
  };
}

describe('parseSettings', () => {
  it('falls back to the defaults for NaN, strings and out-of-range values', () => {
    expect(parseSettings({ sfxVolume: NaN, musicVolume: '0.4' })).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings({ sfxVolume: 1.5, musicVolume: -0.1 })).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings({ sfxVolume: Infinity, musicVolume: null })).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings({ sfxMuted: 'yes', musicMuted: 1, motion: 'fast', quality: 'ultra' })).toEqual(DEFAULT_SETTINGS);
  });

  it('gives the defaults for anything that is not an object', () => {
    for (const raw of [null, undefined, 42, 'x', [], true]) expect(parseSettings(raw)).toEqual(DEFAULT_SETTINGS);
  });

  it('keeps valid values', () => {
    const valid = { sfxVolume: 0, musicVolume: 1, sfxMuted: true, musicMuted: true, motion: 'reduced', quality: 'low' };
    expect(parseSettings(valid)).toEqual(valid);
  });
});

describe('createSettingsStore', () => {
  it('starts from the defaults with empty storage and writes nothing', () => {
    const storage = memSafe();
    const store = createSettingsStore(storage);
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
    expect(storage.data.size).toBe(0);
  });

  it('clamps updates to 0..1 and ignores invalid values', () => {
    const storage = memSafe();
    const store = createSettingsStore(storage);
    store.update({ sfxVolume: 1.5, musicVolume: -0.2 });
    expect(store.get().sfxVolume).toBe(1);
    expect(store.get().musicVolume).toBe(0);
    store.update({ sfxVolume: NaN, motion: 'bogus' as never });
    expect(store.get().sfxVolume).toBe(1);
    expect(store.get().motion).toBe('system');
    expect(JSON.parse(storage.data.get(SETTINGS_KEY) ?? 'null')).toEqual(store.get());
  });

  it('notifies only on a real change', () => {
    const store = createSettingsStore(memSafe());
    let calls = 0;
    store.subscribe(() => calls++);
    store.update({ sfxVolume: DEFAULT_SETTINGS.sfxVolume });
    expect(calls).toBe(0);
    store.update({ sfxMuted: true });
    expect(calls).toBe(1);
  });

  it('reads corrupted stored JSON as the defaults', () => {
    const store = createSettingsStore(memSafe({ [SETTINGS_KEY]: '{not json' }));
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
  });

  it('migrates a legacy 0 as muted at the default volume, and 0.4 as volume 0.4 unmuted', () => {
    const storage = memSafe({ [LEGACY_KEYS.sfx]: '0', [LEGACY_KEYS.music]: '0.4' });
    const store = createSettingsStore(storage);
    expect(store.get()).toMatchObject({ sfxMuted: true, sfxVolume: 0.7, musicMuted: false, musicVolume: 0.4 });
    expect(storage.data.has(LEGACY_KEYS.sfx)).toBe(false);
    expect(storage.data.has(LEGACY_KEYS.music)).toBe(false);
    expect(JSON.parse(storage.data.get(SETTINGS_KEY) ?? 'null')).toEqual(store.get());
  });

  it('migrates the music key the same way', () => {
    const store = createSettingsStore(memSafe({ [LEGACY_KEYS.sfx]: '0.4', [LEGACY_KEYS.music]: '0' }));
    expect(store.get()).toMatchObject({ sfxMuted: false, sfxVolume: 0.4, musicMuted: true, musicVolume: 0.5 });
  });

  it('migrates once: a v2 record wins and reappearing legacy keys are only deleted', () => {
    const storage = memSafe({ [LEGACY_KEYS.sfx]: '0.3' });
    expect(createSettingsStore(storage).get().sfxVolume).toBe(0.3);
    storage.data.set(LEGACY_KEYS.sfx, '0');
    const again = createSettingsStore(storage);
    expect(again.get().sfxVolume).toBe(0.3);
    expect(again.get().sfxMuted).toBe(false);
    expect(storage.data.has(LEGACY_KEYS.sfx)).toBe(false);
  });

  it('keeps the legacy keys when the migrated record cannot be persisted, and migrates again later', () => {
    const storage = memSafe({ [LEGACY_KEYS.sfx]: '0', [LEGACY_KEYS.music]: '0.4' });
    const persist = storage.set;
    storage.set = () => false;   // quota or a revoked permission: nothing reaches the backing storage
    const first = createSettingsStore(storage);
    expect(first.get()).toMatchObject({ sfxMuted: true, sfxVolume: 0.7, musicMuted: false, musicVolume: 0.4 });
    expect(storage.data.get(LEGACY_KEYS.sfx)).toBe('0');
    expect(storage.data.get(LEGACY_KEYS.music)).toBe('0.4');
    expect(storage.data.has(SETTINGS_KEY)).toBe(false);

    storage.set = persist;
    const second = createSettingsStore(storage);
    expect(second.get()).toEqual(first.get());
    expect(storage.data.has(LEGACY_KEYS.sfx)).toBe(false);
    expect(storage.data.has(LEGACY_KEYS.music)).toBe(false);
    expect(JSON.parse(storage.data.get(SETTINGS_KEY) ?? 'null')).toEqual(second.get());
  });

  it('turns unreadable legacy values into the defaults', () => {
    const store = createSettingsStore(memSafe({ [LEGACY_KEYS.sfx]: 'abc', [LEGACY_KEYS.music]: '2' }));
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
  });
});

describe('watchReducedMotion', () => {
  it("follows the system query under 'system'", () => {
    const store = createSettingsStore(memSafe());
    const q = fakeMql(false);
    const seen: boolean[] = [];
    const stop = watchReducedMotion(store, (r) => seen.push(r), q.mql);
    expect(seen).toEqual([false]);
    q.set(true);
    expect(seen).toEqual([false, true]);
    stop();
    expect(q.listeners.size).toBe(0);
    q.set(false);
    expect(seen).toEqual([false, true]);
  });

  it("'reduced' and 'full' override the system query", () => {
    const store = createSettingsStore(memSafe());
    const q = fakeMql(false);
    const seen: boolean[] = [];
    watchReducedMotion(store, (r) => seen.push(r), q.mql);
    store.update({ motion: 'reduced' });
    expect(seen).toEqual([false, true]);
    q.set(false);
    store.update({ motion: 'full' });
    expect(seen).toEqual([false, true, false]);
    q.set(true);
    expect(seen).toEqual([false, true, false]);
    store.update({ motion: 'system' });
    expect(seen).toEqual([false, true, false, true]);
  });
});
