import { expect, test } from 'bun:test';

import { TAP_MS, TAP_SLOP, isTap } from './tap.ts';

test('a short press that barely moves is a tap; a pan or a long press is not', () => {
  expect(isTap(0, 0, 80)).toBe(true);
  expect(isTap(5, -5, TAP_MS - 1)).toBe(true);
  expect(isTap(TAP_SLOP, 0, 80)).toBe(false);
  expect(isTap(-6, 6, 80)).toBe(false);
  expect(isTap(0, 0, TAP_MS)).toBe(false);
});
