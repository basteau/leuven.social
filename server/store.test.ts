import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';

import type { Outfit, PlayerState } from '../src/net/protocol.ts';
import { createStore } from './store.ts';

const outfit: Outfit = { skin: 1, hair: 2, shirt: 3, shorts: 4 };
const state: PlayerState = {
  x: 1.5,
  z: -2.5,
  heading: 3,
  speed: 4,
  mode: 'bike',
  place: 'stadhuis',
  floor: 1,
};

test('a player is made on first sight, with no position yet', () => {
  const store = createStore(new Database(':memory:'));
  let made = 0;
  const fresh = () => (made++, outfit);
  expect(store.player('u1', fresh)).toEqual({ outfit, at: null });
  expect(store.player('u1', fresh)).toEqual({ outfit, at: null });
  expect(made).toBe(1);
});

test('keeps the outfit and the last position, standing on foot', () => {
  const db = new Database(':memory:');
  const store = createStore(db, () => 42);
  store.player('u1', () => outfit);
  store.saveOutfit('u1', { ...outfit, shirt: 9 });
  store.savePosition('u1', state);
  // A second store on the same file sees the same rows: the table is created only once.
  const again = createStore(db);
  expect(again.player('u1', () => outfit)).toEqual({
    outfit: { ...outfit, shirt: 9 },
    at: { ...state, speed: 0, mode: 'foot' },
  });
  expect(db.query('SELECT updated_at FROM players').get()).toEqual({ updated_at: 42 });
});

test('a mangled outfit is replaced by a fresh one rather than failing', () => {
  const db = new Database(':memory:');
  const store = createStore(db);
  store.player('u1', () => outfit);
  db.run("UPDATE players SET outfit = 'not json'");
  expect(store.player('u1', () => outfit).outfit).toEqual(outfit);
  db.run(`UPDATE players SET outfit = '{"skin":1}'`);
  expect(store.player('u1', () => outfit).outfit).toEqual(outfit);
});

test('a position with missing parts falls back to the street', () => {
  const db = new Database(':memory:');
  const store = createStore(db);
  store.player('u1', () => outfit);
  db.run('UPDATE players SET x = 1, z = 2');
  expect(store.player('u1', () => outfit).at).toEqual({
    x: 1,
    z: 2,
    heading: 0,
    speed: 0,
    mode: 'foot',
    place: '',
    floor: 0,
  });
});
