import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSafeStorage, randomId } from './storage';

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k: string) => m.get(k) ?? null,
    key: (i: number) => Array.from(m.keys())[i] ?? null,
    removeItem: (k: string) => {
      m.delete(k);
    },
    setItem: (k: string, v: string) => {
      m.set(k, String(v));
    },
  };
}

function throwingStorage(): Storage {
  const fail = (): never => {
    throw new DOMException('The operation is insecure.', 'SecurityError');
  };
  return { length: 0, clear: fail, getItem: fail, key: fail, removeItem: fail, setItem: fail };
}

describe('createSafeStorage', () => {
  it('falls back to memory when localStorage throws', () => {
    const s = createSafeStorage(() => throwingStorage());
    expect(s.persistent).toBe(false);
    expect(s.get('k')).toBeNull();
    expect(s.set('k', 'v')).toBe(false);
    expect(s.get('k')).toBe('v');
    s.remove('k');
    expect(s.get('k')).toBeNull();
  });

  it('falls back to memory when reading the storage object itself throws', () => {
    const s = createSafeStorage(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    expect(s.persistent).toBe(false);
    expect(s.set('k', 'v')).toBe(false);
    expect(s.get('k')).toBe('v');
  });

  it('falls back to memory when there is no storage', () => {
    const s = createSafeStorage(() => undefined);
    expect(s.persistent).toBe(false);
    s.set('k', 'v');
    expect(s.get('k')).toBe('v');
  });

  it('persists when storage works', () => {
    const backing = memoryStorage();
    const s = createSafeStorage(() => backing);
    expect(s.persistent).toBe(true);
    expect(s.set('k', 'v')).toBe(true);
    expect(backing.getItem('k')).toBe('v');
    expect(s.get('k')).toBe('v');
    s.remove('k');
    expect(backing.getItem('k')).toBeNull();
  });

  it('keeps a value in memory when a write fails, and reads it back over the stale stored value', () => {
    const backing = memoryStorage();
    backing.setItem('k', 'old');
    let full = false;
    const quota: Storage = {
      ...backing,
      getItem: (k: string) => backing.getItem(k),
      removeItem: (k: string) => backing.removeItem(k),
      setItem: (k: string, v: string) => {
        if (full) throw new DOMException('full', 'QuotaExceededError');
        backing.setItem(k, v);
      },
    };
    const s = createSafeStorage(() => quota);
    full = true;
    expect(s.set('k', 'new')).toBe(false);
    expect(s.get('k')).toBe('new');
    full = false;
    expect(s.set('k', 'newer')).toBe(true);
    expect(s.get('k')).toBe('newer');
  });
});

describe('randomId', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('gives 32 hex characters from crypto.randomUUID', () => {
    vi.stubGlobal('crypto', { randomUUID: () => '123e4567-e89b-12d3-a456-426614174000', getRandomValues: () => { throw new Error('unused'); } });
    expect(randomId()).toBe('123e4567e89b12d3a456426614174000');
  });

  it('uses getRandomValues without crypto.randomUUID', () => {
    vi.stubGlobal('crypto', {
      getRandomValues: (a: Uint8Array) => {
        a.fill(0xab);
        return a;
      },
    });
    expect(randomId()).toBe('ab'.repeat(16));
  });

  it('uses Math.random without crypto', () => {
    vi.stubGlobal('crypto', undefined);
    const id = randomId();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(randomId()).not.toBe(id);
  });

  it('is 32 lower-case hex with the real crypto', () => {
    expect(randomId()).toMatch(/^[0-9a-f]{32}$/);
  });
});
