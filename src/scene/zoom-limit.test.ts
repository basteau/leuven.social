import { expect, test } from 'bun:test';

import { MAX_VIEW_AREA, minZoomFor } from './zoom-limit.ts';

const VIEW = 560;

test('a 1280×800 window zooms out to about 0.71', () => {
  expect(minZoomFor(1.6, VIEW)).toBeCloseTo(0.708, 2);
});

test('a phone upright zooms out further; a wide window less far', () => {
  const phone = minZoomFor(390 / 844, VIEW);
  expect(phone).toBeGreaterThan(0.3);
  expect(phone).toBeLessThan(0.45);
  expect(minZoomFor(2.4, VIEW)).toBeGreaterThan(0.8);
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
