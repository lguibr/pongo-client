// A minimal external store. Writers replace values; readers subscribe (see useStore.ts).

export interface Store<T extends object> {
  get(): T;
  set(next: T): void;
  patch(p: Partial<T>): void;       // shallow merge; notifies only when some key's value identity changed
  subscribe(fn: () => void): () => void;
}

export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial;
  const listeners = new Set<() => void>();

  const notify = (): void => {
    // Snapshot, so a listener that subscribes or unsubscribes during the notification is safe.
    for (const fn of Array.from(listeners)) fn();
  };

  return {
    get: () => state,
    set(next: T): void {
      if (Object.is(next, state)) return;
      state = next;
      notify();
    },
    patch(p: Partial<T>): void {
      let changed = false;
      for (const key in p) {
        if (Object.prototype.hasOwnProperty.call(p, key) && !Object.is(p[key], state[key])) {
          changed = true;
          break;
        }
      }
      if (!changed) return;
      state = { ...state, ...p };
      notify();
    },
    subscribe(fn: () => void): () => void {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}
