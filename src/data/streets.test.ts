import { describe, expect, test } from 'bun:test';

import {
  STREET_REACH,
  STREET_STICKINESS,
  StreetIndex,
  joinLines,
  nameTable,
  streetName,
} from './streets.ts';

test('a road is signed with its OSM name; platforms and pedestrian areas are not streets', () => {
  expect(streetName({ highway: 'residential', name: 'Naamsestraat' })).toBe('Naamsestraat');
  expect(streetName({ highway: 'footway', name: ' Dijlepad ' })).toBe('Dijlepad');
  expect(streetName({ highway: 'residential' })).toBeNull();
  expect(streetName({ highway: 'service', name: '  ' })).toBeNull();
  expect(streetName({ highway: 'platform', name: 'Leuven Station' })).toBeNull();
  expect(streetName({ highway: 'pedestrian', area: 'yes', name: 'Ladeuzeplein' })).toBeNull();
  expect(streetName({ building: 'yes', name: 'Stadhuis' })).toBeNull();
});

test('names are stored once, sorted, and referred to by place', () => {
  expect(nameTable(['Tiensestraat', null, 'Bondgenotenlaan', 'Tiensestraat'])).toEqual({
    table: ['Bondgenotenlaan', 'Tiensestraat'],
    index: [1, -1, 0, 1],
  });
  expect(nameTable([])).toEqual({ table: [], index: [] });
});

test('ways that meet end to end become one line, whichever way each runs', () => {
  expect(
    joinLines([
      [10, 0, 20, 0],
      [0, 0, 10, 0],
      [30, 5, 20, 0], // runs backwards
      [100, 100, 110, 100], // apart
      [5], // not a line
    ]),
  ).toEqual([
    [0, 0, 10, 0, 20, 0, 30, 5],
    [100, 100, 110, 100],
  ]);
  // A loop closes on itself and stops; a fork keeps the branch it didn't take.
  expect(
    joinLines([
      [0, 0, 10, 0],
      [10, 0, 0, 10],
      [0, 10, 0, 0],
    ]),
  ).toEqual([[0, 0, 10, 0, 0, 10, 0, 0]]);
  expect(
    joinLines([
      [0, 0, 10, 0],
      [10, 0, 20, 0],
      [10, 0, 10, 10],
    ]),
  ).toEqual([
    [0, 0, 10, 0, 20, 0],
    [10, 0, 10, 10],
  ]);
});

describe('StreetIndex', () => {
  // Two streets crossing at the origin, a third one far off, and a named and an unnamed square.
  const index = new StreetIndex({
    streetNames: ['Bondgenotenlaan', 'Grote Markt', 'Naamsestraat', 'Tiensestraat'],
    streets: [
      { name: 2, line: new Float32Array([0, -200, 0, 0, 0, 200]) },
      { name: 3, line: new Float32Array([-200, 0, 200, 0]) },
      { name: 0, line: new Float32Array([1000, 1000, 1000, 1000]) }, // a single point
    ],
    plazas: [
      new Float32Array([40, 40, 80, 40, 80, 80, 40, 80]),
      new Float32Array([-80, 40, -40, 40, -40, 80, -80, 80]),
    ],
    plazaNames: [1, -1],
  });

  test('reads the nearest street within reach', () => {
    expect(index.nameAt(3, 90)).toBe('Naamsestraat');
    expect(index.nameAt(-120, -6)).toBe('Tiensestraat');
    expect(index.nameAt(1003, 1000)).toBe('Bondgenotenlaan');
    expect(index.nameAt(STREET_REACH + 1, 150)).toBeNull();
    expect(index.nameAt(5000, 5000)).toBeNull();
  });

  test('a named square wins over the streets round it; an unnamed one does not', () => {
    expect(index.nameAt(41, 41)).toBe('Grote Markt');
    expect(index.nameAt(-41, 41)).toBeNull();
    expect(index.nameAt(-41, 15)).toBe('Tiensestraat');
  });

  test('keeps the street on the sign at a corner until another is clearly closer', () => {
    expect(index.nameAt(8, 6)).toBe('Tiensestraat');
    expect(index.nameAt(8, 6, 'Naamsestraat')).toBe('Naamsestraat');
    expect(index.nameAt(STREET_STICKINESS + 6, 1, 'Naamsestraat')).toBe('Tiensestraat');
    expect(index.nameAt(8, 6, 'Bondgenotenlaan')).toBe('Tiensestraat'); // not nearby at all
    expect(index.nameAt(8, 6, 'Diestsestraat')).toBe('Tiensestraat'); // not in the table
  });
});
