import { expect, test } from 'bun:test';

import { WALKER } from '../scene/palette.ts';
import { FIRST_OUTFIT, PARTS, css, surprise } from './outfits.ts';

test('the first look is the avatar’s own, and every part has a few named colours', () => {
  expect(FIRST_OUTFIT).toEqual({
    shirt: WALKER.shirt,
    shorts: WALKER.shorts,
    skin: WALKER.skin,
    hair: WALKER.hair,
  });
  for (const { swatches } of PARTS) {
    expect(swatches.length).toBeGreaterThanOrEqual(5);
    expect(new Set(swatches.map((s) => s.colour)).size).toBe(swatches.length);
    expect(new Set(swatches.map((s) => s.name)).size).toBe(swatches.length);
  }
});

test('a surprise is a look from the swatches, different from the one worn', () => {
  let n = 0;
  // A random that first repeats the look worn, then moves on.
  const sequence = [0, 0, 0, 0, 0.5, 0.5, 0.5, 0.5];
  const random = () => sequence[n++ % sequence.length]!;
  const next = surprise(random, FIRST_OUTFIT);
  expect(next).not.toEqual(FIRST_OUTFIT);
  for (const { part, swatches } of PARTS) {
    expect(swatches.some((s) => s.colour === next[part])).toBe(true);
  }
  // Even a random that returns 1 stays in the list.
  expect(surprise(() => 0.9999999).shirt).toBe(PARTS[0]!.swatches.at(-1)!.colour);
  expect(css(0x0a0b0c)).toBe('#0a0b0c');
});
