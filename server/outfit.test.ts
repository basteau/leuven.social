import { expect, test } from 'bun:test';

import { isOutfit } from '../src/net/protocol.ts';
import { randomOutfit } from './outfit.ts';

test('a new account gets colours from the palettes', () => {
  expect(isOutfit(randomOutfit())).toBe(true);
  expect(randomOutfit(() => 0)).toEqual({
    skin: 0xf0c49c,
    hair: 0x2b2420,
    shirt: 0xfa8064,
    shorts: 0xe9dcbf,
  });
  // A random() of exactly 1 would be out of range without the wrap.
  expect(isOutfit(randomOutfit(() => 1))).toBe(true);
});
