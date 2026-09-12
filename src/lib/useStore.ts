import { useRef, useSyncExternalStore } from 'react';
import type { Store } from './store';

interface Memo<T, U> { state: T; select: (s: T) => U; value: U }

/** Subscribes to `store` and returns `select(state)`. The previous value is kept while `equal` says the
 *  new selection is the same, so a component re-renders only when its selection changes. */
export function useStore<T extends object, U>(store: Store<T>, select: (s: T) => U, equal: (a: U, b: U) => boolean = Object.is): U {
  const memo = useRef<Memo<T, U> | null>(null);
  const getSnapshot = (): U => {
    const state = store.get();
    const m = memo.current;
    if (m !== null && m.state === state && m.select === select) return m.value;
    const next = select(state);
    if (m !== null && equal(m.value, next)) {
      m.state = state;
      m.select = select;
      return m.value;
    }
    memo.current = { state, select, value: next };
    return next;
  };
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}

/** Object.is on each own key (one level deep), for objects and arrays. */
export function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(rb, k) || !Object.is(ra[k], rb[k])) return false;
  }
  return true;
}
