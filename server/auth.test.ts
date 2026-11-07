import { expect, test } from 'bun:test';

import { secretFrom, syntheticEmail } from './auth.ts';

test('production refuses to start without a secret; dev has a fixed one', () => {
  expect(secretFrom({ BETTER_AUTH_SECRET: 's3cret' })).toBe('s3cret');
  expect(secretFrom({ BETTER_AUTH_SECRET: 's3cret', NODE_ENV: 'production' })).toBe('s3cret');
  expect(secretFrom({})).toBe(secretFrom({ NODE_ENV: 'development' }));
  expect(() => secretFrom({ NODE_ENV: 'production' })).toThrow(/BETTER_AUTH_SECRET/);
});

test('each player is filed under an address that can never get mail', () => {
  expect(syntheticEmail('Marie.Claire')).toBe('marie.claire@players.invalid');
});
