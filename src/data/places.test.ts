import { describe, expect, test } from 'bun:test';

import { placesOf } from './places.ts';

const line = (...xz: number[]) => new Float32Array(xz);

describe('placesOf', () => {
  test('a square sits in the middle of its outline', () => {
    const places = placesOf({
      streetNames: ['Grote Markt'],
      streets: [],
      plazas: [line(0, 0, 10, 0, 10, 20, 0, 20)],
      plazaNames: [0],
    });
    expect(places).toEqual([{ name: 'Grote Markt', kind: 'square', x: 5, z: 10 }]);
  });

  test('a street sits on itself, at the point nearest the middle of its stretches', () => {
    // An L round a block: the middle of its points is off the street, at (6.7, 3.3).
    const places = placesOf({
      streetNames: ['Hoek'],
      streets: [
        { name: 0, line: line(0, 0, 10, 0) },
        { name: 0, line: line(10, 0, 10, 10) },
      ],
      plazas: [],
      plazaNames: [],
    });
    expect(places).toEqual([{ name: 'Hoek', kind: 'street', x: 10, z: 0 }]);
  });

  test('a name that is a square and a street is the square; nameless squares are left out', () => {
    const places = placesOf({
      streetNames: ['Ladeuzeplein', 'Naamsestraat'],
      streets: [
        { name: 0, line: line(100, 100, 110, 100) },
        { name: 1, line: line(0, 0, 0, 50, 0, 100) },
      ],
      plazas: [line(0, 0, 2, 0, 2, 2, 0, 2), line(9, 9, 9, 9)],
      plazaNames: [0, -1],
    });
    expect(places).toEqual([
      { name: 'Ladeuzeplein', kind: 'square', x: 1, z: 1 },
      { name: 'Naamsestraat', kind: 'street', x: 0, z: 50 },
    ]);
  });

  test('a name with nowhere to stand, or a stretch with no points, is left out', () => {
    const places = placesOf({
      streetNames: ['Nergens', 'Leeg'],
      streets: [{ name: 1, line: line() }],
      plazas: [line()],
      plazaNames: [0],
    });
    expect(places).toEqual([]);
  });
});
