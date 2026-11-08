import { expect, test } from 'bun:test';

import { MAX_VIEW_AREA, buildReach, minZoomFor } from './zoom-limit.ts';

const VIEW = 560;

test('a 1280×800 window zooms out to the old limit of 0.5', () => {
  expect(minZoomFor(1.6, VIEW)).toBeCloseTo(0.5, 2);
});

test('a phone upright zooms out further; a wide window less far', () => {
  const phone = minZoomFor(390 / 844, VIEW);
  expect(phone).toBeGreaterThan(0.2);
  expect(phone).toBeLessThan(0.3);
  expect(minZoomFor(2.4, VIEW)).toBeGreaterThan(0.5);
});

test('every window sees the same most ground, within the limits', () => {
  for (const aspect of [0.46, 0.75, 1, 1.6]) {
    const zoom = minZoomFor(aspect, VIEW);
    const height = VIEW / zoom;
    expect(height * height * aspect).toBeCloseTo(MAX_VIEW_AREA, -4);
  }
});

test('stays between the first view and the farthest', () => {
  expect(minZoomFor(100, VIEW)).toBe(1);
  expect(minZoomFor(0.01, VIEW)).toBe(0.2);
});

test('cells are built as far as the farthest view of this window reaches, plus a ring', () => {
  // About 1.7 km by 1.1 km at 1280×800: half its diagonal is about a kilometre.
  expect(buildReach(1.6, 0)).toBeCloseTo(Math.hypot(1789, 1118) / 2, -1);
  expect(buildReach(1.6, 500)).toBeCloseTo(buildReach(1.6, 0) + 500);
  // A phone upright reaches further along its long side, for the same ground.
  expect(buildReach(390 / 844, 0)).toBeGreaterThan(buildReach(1.6, 0));
  expect(Number.isFinite(buildReach(0, 0))).toBe(true);
});
