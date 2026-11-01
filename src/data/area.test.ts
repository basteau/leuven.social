import { expect, test } from 'bun:test';

import { LANDMARKS } from './area.ts';

test('every label is a well-formed id, listed once, with a zoom it can reach', () => {
  for (const l of LANDMARKS) {
    if ('wikidata' in l) expect(l.wikidata).toMatch(/^Q\d+$/);
    else if ('osm' in l) expect(l.osm).toMatch(/^(node|way|relation)\/\d+$/);
    else expect(Number.isInteger(l.grb)).toBe(true);
    expect(l.minZoom ?? 0).toBeGreaterThanOrEqual(0);
  }
  const keys = LANDMARKS.map((l) => JSON.stringify({ ...l, minZoom: undefined }));
  expect(new Set(keys).size).toBe(keys.length);
});
