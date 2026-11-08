/**
 * A tiny external store: the viewer's callbacks fire often (the arrow's direction while panning),
 * and the shell must not re-render for them. The few components that show such a value subscribe
 * with `useSyncExternalStore`; the shell only calls `set`.
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
