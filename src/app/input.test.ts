import { describe, expect, test } from 'bun:test';

import { SETTLE_MS, strayPress } from './input.ts';

describe('strayPress', () => {
  test('ignores the rest of a double-click', () => {
    expect(strayPress(2, 5_000)).toBe(true);
    expect(strayPress(3, 5_000)).toBe(true);
  });

  test('ignores a pointer press while the button is settling', () => {
    expect(strayPress(1, 0)).toBe(true);
    expect(strayPress(1, SETTLE_MS - 1)).toBe(true);
    expect(strayPress(1, SETTLE_MS)).toBe(false);
  });

  test('always lets the keyboard press', () => {
    expect(strayPress(0, 0)).toBe(false);
    expect(strayPress(0, 5_000)).toBe(false);
  });
});
