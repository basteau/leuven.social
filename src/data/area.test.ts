import { expect, test } from 'bun:test';

import { LANDMARKS, LANDMARK_ITEMS, placeLandmarks } from './area.ts';
import { ORIGIN } from './projection.ts';

test('every label names a Wikidata item, or says where its own position comes from', () => {
  for (const l of LANDMARKS) {
    if ('wikidata' in l) expect(l.wikidata).toMatch(/^Q\d+$/);
    else expect(l.source.length).toBeGreaterThan(10);
  }
  expect(LANDMARK_ITEMS).toEqual([...new Set(LANDMARK_ITEMS)].toSorted());
  expect(LANDMARK_ITEMS).toContain('Q940882');
});

const none = () => undefined;

test('placeLandmarks puts labels on their footprint, at their item, or where they say', () => {
  const placed = placeLandmarks(
    [
      { name: 'Grote Markt', wikidata: 'Q4766627' },
      { name: 'Station', wikidata: 'Q801090', footprint: 7 },
      { name: 'Park', lon: ORIGIN.lon, lat: ORIGIN.lat, source: 'Read off the orthophoto' },
    ],
    { Q4766627: { lon: ORIGIN.lon, lat: ORIGIN.lat } },
    (id) => (id === 7 ? [10, 20] : undefined),
  );
  expect(placed).toEqual([
    { name: 'Grote Markt', x: 0, z: 0 },
    { name: 'Station', x: 10, z: 20 },
    { name: 'Park', x: 0, z: 0 },
  ]);
  expect(() => placeLandmarks([{ name: 'Fonske', wikidata: 'Q2107804' }], {}, none)).toThrow(
    'Q2107804',
  );
  expect(() =>
    placeLandmarks([{ name: 'Station', wikidata: 'Q801090', footprint: 7 }], {}, none),
  ).toThrow('footprint 7');
});
