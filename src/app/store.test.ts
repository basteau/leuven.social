import { expect, test } from 'bun:test';

import { createStore } from './store.ts';

test('tells subscribers only about changes, until they unsubscribe', () => {
  const store = createStore<number | null>(null);
  let told = 0;
  const off = store.subscribe(() => told++);
  store.set(null);
  expect(told).toBe(0);
  store.set(1);
  store.set(1);
  expect(told).toBe(1);
  expect(store.get()).toBe(1);
  off();
  store.set(2);
  expect(told).toBe(1);
});
