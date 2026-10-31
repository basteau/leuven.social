import { expect, test } from 'bun:test';

import { LANDMARKS, LANDMARK_ITEMS, placeLandmarks } from './area.ts';

test('every label names a Wikidata item, or says where its own position comes from', () => {
  for (const l of LANDMARKS) {
    if ('wikidata' in l) expect(l.wikidata).toMatch(/^Q\d+$/);
    else expect(l.source.length).toBeGreaterThan(10);
  }
  expect(LANDMARK_ITEMS).toEqual([...new Set(LANDMARK_ITEMS)].toSorted());
  expect(LANDMARK_ITEMS).toContain('Q940882');
});

test('placeLandmarks puts labels at their item, or where they say', () => {
  const placed = placeLandmarks(
    [
      { name: 'Stadhuis', wikidata: 'Q940882' },
      { name: 'Park', lon: 4.6, lat: 50.8, source: 'Read off the orthophoto' },
    ],
    { Q940882: { lon: 4.70111, lat: 50.87889 } },
  );
  expect(placed).toEqual([
    { name: 'Stadhuis', lon: 4.70111, lat: 50.87889 },
    { name: 'Park', lon: 4.6, lat: 50.8 },
  ]);
  expect(() => placeLandmarks([{ name: 'Fonske', wikidata: 'Q2107804' }], {})).toThrow('Q2107804');
});
