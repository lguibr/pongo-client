// Storage that never throws (C39). Blocked or full storage falls back to an in-memory map, which acts as an
// overlay: a value that could not be persisted is still readable for the life of the page.

export interface SafeStorage { get(key: string): string | null; set(key: string, value: string): boolean; remove(key: string): void; readonly persistent: boolean }

const PROBE_KEY = '__pongo_probe__';

/** `resolve` returns the backing Storage, and may throw or return null (then memory only). `set` returns true
 *  when the value reached the backing storage, false when it is kept in memory only. */
export function createSafeStorage(resolve: () => Storage | null | undefined): SafeStorage {
  const memory = new Map<string, string>();
  let backing: Storage | null | undefined;   // undefined until probed

  const backend = (): Storage | null => {
    if (backing !== undefined) return backing;
    try {
      const s = resolve() ?? null;
      // A read proves access (a blocked storage throws here) without needing quota; a full storage still
      // serves reads, and each set() handles its own failure.
      if (s !== null) s.getItem(PROBE_KEY);
      backing = s;
    } catch {
      backing = null;
    }
    return backing;
  };

  return {
    get(key: string): string | null {
      const own = memory.get(key);
      if (own !== undefined) return own;
      const s = backend();
      if (s === null) return null;
      try {
        return s.getItem(key);
      } catch {
        return null;
      }
    },
    set(key: string, value: string): boolean {
      const s = backend();
      if (s !== null) {
        try {
          s.setItem(key, value);
          memory.delete(key);
          return true;
        } catch {
          // Quota or a revoked permission: keep it in memory below.
        }
      }
      memory.set(key, value);
      return false;
    },
    remove(key: string): void {
      memory.delete(key);
      const s = backend();
      if (s === null) return;
      try {
        s.removeItem(key);
      } catch {
        // Nothing to recover.
      }
    },
    get persistent(): boolean {
      return backend() !== null;
    },
  };
}

export const safeLocal: SafeStorage = createSafeStorage(() => globalThis.localStorage);
export const safeSession: SafeStorage = createSafeStorage(() => globalThis.sessionStorage);

function toHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

/** 32 hex; crypto.randomUUID, then getRandomValues, then Math.random. */
export function randomId(): string {
  let c: Crypto | undefined;
  try {
    c = typeof crypto !== 'undefined' ? crypto : undefined;
  } catch {
    c = undefined;
  }
  if (c && typeof c.randomUUID === 'function') {
    try {
      return c.randomUUID().replace(/-/g, '');
    } catch {
      // randomUUID exists only in secure contexts; fall through.
    }
  }
  if (c && typeof c.getRandomValues === 'function') {
    try {
      const bytes = new Uint8Array(16);
      c.getRandomValues(bytes);
      return toHex(bytes);
    } catch {
      // Fall through.
    }
  }
  let s = '';
  for (let i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}
