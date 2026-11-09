import { expect, test } from 'bun:test';

import {
  BAYS_PER_PAGE,
  BAY_MAX,
  BAY_MIN,
  LANCET_BAY,
  NICHE_BAY,
  bayBytes,
  bayPage,
  bayTarget,
  bayTargetFor,
  fitBays,
  fitRun,
} from './facade-bays.ts';

test('a house aims for its own bay width, kept across a reload', () => {
  for (const top of [3, 5.2, 7.77, 9.13, 12.4]) {
    expect(bayTarget(top)).toBeGreaterThanOrEqual(BAY_MIN);
    expect(bayTarget(top)).toBeLessThan(BAY_MAX);
    expect(bayTarget(top)).toBe(bayTarget(top));
  }
  expect(new Set([3.1, 3.3, 4.7, 8.9].map(bayTarget)).size).toBe(4);
});

test('the width a wall aims for depends on what it is', () => {
  expect(bayTargetFor('lancet', 9)).toBe(LANCET_BAY);
  expect(bayTargetFor('ornate', 9)).toBe(NICHE_BAY);
  expect(bayTargetFor(true, 9)).toBe(bayTarget(9));
});

test('a wall takes the whole number of bays nearest its aim, none if it is too short', () => {
  expect(fitBays(9, 3)).toBe(3);
  expect(fitBays(10, 3)).toBe(3);
  expect(fitBays(11, 3)).toBe(4);
  // A pier is no place for a window, whatever the aim.
  expect(fitBays(1.2, 2.2)).toBe(0);
  expect(fitBays(1.7, 2.2)).toBe(1);
  // A church's bays are wider, so a short stretch of its wall has no lancet.
  expect(fitBays(2.5, LANCET_BAY)).toBe(0);
  expect(fitBays(3.2, LANCET_BAY)).toBe(1);
  // The byte has only so much room.
  expect(fitBays(1000, 2.2)).toBe(127);
});

test('a curved run spreads its bays over its facets, in whole bays on each', () => {
  const facets = Array.from({ length: 6 }, () => 2);
  const fit = fitRun(facets, 3);
  expect(fit.every((b) => Number.isInteger(b))).toBe(true);
  expect(fit.reduce((a, b) => a + b, 0)).toBe(Math.round(12 / 3));
  expect(fit.length).toBe(6);
  // A lone wall is just `fitBays`.
  expect(fitRun([9], 3)).toEqual([3]);
});

test('a facet too short for a window carries its share on to the next', () => {
  // Facets 1 m long, 3 m aim: none would get a window on their own, yet a long enough one
  // after them picks up what they owed.
  expect(fitRun([1, 1, 1, 3.5], 3)).toEqual([0, 0, 0, 2]);
});

test('a page mixes wall and building, and always fits the byte', () => {
  const pages = Array.from({ length: 16 }, (_, i) => bayPage(1234, i));
  expect(new Set(pages).size).toBeGreaterThan(4);
  expect(pages.every((p) => p >= 0 && p < 16)).toBe(true);
});

test('a wall packs its bays and whether it starts a join into its corner bytes', () => {
  // Page 2: bay numbers 16 to 16 + 3.
  expect(bayBytes(3, 2, false)).toEqual([2 * 16, 2 * 19]);
  expect(bayBytes(3, 2, true)).toEqual([2 * 16 + 1, 2 * 19]);
  // Whether a wall is joined only shows where there are bays to join.
  expect(bayBytes(0, 2, true)).toEqual([2 * 16, 2 * 16]);
  // A long wall's page is brought down until its bays fit the byte.
  const [start, end] = bayBytes(120, 15, false);
  expect(end).toBeLessThanOrEqual(255);
  expect((end - start) / 2).toBe(120);
  expect(BAYS_PER_PAGE).toBe(8);
});
