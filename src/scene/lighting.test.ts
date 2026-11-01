import { expect, test } from 'bun:test';

import { deltaE, toOklab } from '../data/colour.ts';
import { groundOnScreen } from './lighting.ts';
import { CARRIAGEWAYS, GROUND } from './palette.ts';

/** About twice a just-noticeable difference: two surfaces you can tell apart at a glance. */
const DISTINCT = 0.05;

test('every ground in shade stays distinguishable from asphalt in the sun', () => {
  const road = groundOnScreen(CARRIAGEWAYS.street, true);
  for (const [name, colour] of Object.entries(GROUND)) {
    expect([name, deltaE(groundOnScreen(colour, false), road) > DISTINCT]).toEqual([name, true]);
  }
});

test('shade keeps the hue of its own colour', () => {
  const [, sa, sb] = toOklab(groundOnScreen(GROUND.plaza, false));
  const [, a, b] = toOklab(GROUND.plaza);
  // Same hue direction, and most of its colour (plain sky light greys it out).
  expect(sa * a + sb * b).toBeGreaterThan(0);
  expect(Math.hypot(sa, sb)).toBeGreaterThan(Math.hypot(a, b) * 0.7);
});

test('sun is lighter than shade', () => {
  for (const colour of Object.values(GROUND)) {
    expect(toOklab(groundOnScreen(colour, true))[0]).toBeGreaterThan(
      toOklab(groundOnScreen(colour, false))[0],
    );
  }
});
