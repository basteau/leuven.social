/**
 * A tiny external store, for a value only a few components show (the marks on the full map), so
 * the shell needn't re-render for it. They subscribe with `useSyncExternalStore`; the shell only
 * calls `set`.
 */

export interface Store<T> {
  get(): T;
  /** Replaces the value; nothing is told when it is the same one. */
  set(value: T): void;
  subscribe(listener: () => void): () => void;
}

export function createStore<T>(initial: T): Store<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next) {
      if (Object.is(next, value)) return;
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
