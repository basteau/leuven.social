import { expect, test } from 'bun:test';

import { DOT_VERTICES, passedVertices, routeMarker } from './route-marker.ts';

test('dots run along every leg, clear of both ends, then the target', () => {
  const marker = routeMarker(Float32Array.of(0, 0, 10, 0, 10, 10));
  const dots = Array.from(marker.dots);
  expect(dots[0]).toBeCloseTo(1.4);
  expect(dots.at(-1)!).toBeLessThanOrEqual(20 - 1.4);
  expect(dots.length).toBe(8);
  const position = marker.geometry.getAttribute('position');
  expect(position.count).toBe(dots.length * DOT_VERTICES + 18);
  // A dot on the second leg lies on it.
  const onSecond = dots.findIndex((d) => d > 12);
  expect(position.getX(onSecond * DOT_VERTICES)).toBeCloseTo(10 - 0.45);
  // The target is the last thing drawn, centred on the end.
  let [x, z] = [0, 0];
  for (let i = position.count - 6; i < position.count; i++) {
    [x, z] = [x + position.getX(i) / 6, z + position.getZ(i) / 6];
  }
  expect([x, z]).toEqual([expect.closeTo(10), expect.closeTo(10)]);
});

test('a short walk has a target and no dots', () => {
  const marker = routeMarker(Float32Array.of(0, 0, 2, 0));
  expect(marker.dots).toHaveLength(0);
  expect(marker.geometry.getAttribute('position').count).toBe(18);
});

test('dots drop off as the walker passes them', () => {
  const marker = routeMarker(Float32Array.of(0, 0, 20, 0));
  expect(passedVertices(marker, 0)).toBe(0);
  expect(passedVertices(marker, 1.2)).toBe(DOT_VERTICES);
  expect(passedVertices(marker, 100)).toBe(marker.dots.length * DOT_VERTICES);
});
