import { expect, test } from 'bun:test';

import { elementCentre, findElement, labelName } from './labels.ts';
import type { OsmElement } from './labels.ts';

test("a label reads OSM's short name, else its name, without the city's own", () => {
  expect(labelName({ name: 'Rector De Somerplein', short_name: 'De Somerplein' })).toBe(
    'De Somerplein',
  );
  expect(labelName({ name: 'Stadhuis van Leuven' })).toBe('Stadhuis');
  expect(labelName({ name: 'M - Leuven' })).toBe('M');
  expect(labelName({ name: 'Leuven' })).toBe('Leuven'); // only a suffix goes
  expect(labelName({ amenity: 'bench' })).toBeNull();
});

test('a node sits at its point, a way or relation at the middle of its outline', () => {
  expect(elementCentre({ type: 'node', id: 1, lon: 4.7, lat: 50.88 })).toEqual([4.7, 50.88]);
  expect(elementCentre({ type: 'way', id: 2, center: { lon: 4.71, lat: 50.87 } })).toEqual([
    4.71, 50.87,
  ]);
  expect(
    elementCentre({
      type: 'way',
      id: 3,
      bounds: { minlat: 50, minlon: 4, maxlat: 51, maxlon: 5 },
    }),
  ).toEqual([4.5, 50.5]);
  expect(elementCentre({ type: 'relation', id: 4 })).toBeNull();
});

const square: OsmElement = {
  type: 'way',
  id: 10,
  tags: { name: 'Martelarenplein', wikidata: 'Q2658903' },
  bounds: { minlat: 50.88, minlon: 4.714, maxlat: 50.882, maxlon: 4.716 },
};
const street: OsmElement = {
  type: 'way',
  id: 11,
  tags: { name: 'Martelarenplein', wikidata: 'Q2658903' },
  bounds: { minlat: 50.881, minlon: 4.714, maxlat: 50.8812, maxlon: 4.715 },
};
const fountain: OsmElement = { type: 'node', id: 12, tags: { wikidata: 'Q2107804' } };

test('a Wikidata id finds the widest element that carries it; an OSM id finds that element', () => {
  expect(findElement({ wikidata: 'Q2658903' }, [street, square, fountain])).toBe(square);
  expect(findElement({ wikidata: 'Q2658903' }, [square, street])).toBe(square);
  expect(findElement({ wikidata: 'Q2107804' }, [street, fountain])).toBe(fountain);
  expect(findElement({ osm: 'way/11' }, [square, street])).toBe(street);
  expect(findElement({ wikidata: 'Q1' }, [square])).toBeNull();
});
