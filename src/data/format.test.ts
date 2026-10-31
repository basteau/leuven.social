import { describe, expect, test } from 'bun:test';

import type { City } from './city.ts';
import { CityFormatError, decodeCity, encodeCity, packCity, unpackCity } from './format.ts';

const square = (x: number, z: number, s: number) =>
  new Float32Array([x, z, x + s, z, x + s, z + s, x, z + s]);

const exact = (ring: Float32Array) => Array.from(ring, (v) => Math.fround(v));

const city: City = {
  bounds: { minX: -600, minZ: -400, maxX: 600, maxZ: 450 },
  labels: [{ name: 'Grote Markt', x: 0, z: 0 }],
  buildings: [
    {
      id: 7,
      tier: 'hero',
      kind: 'church',
      roof: 'auto',
      height: 35.4,
      eave: 18.2,
      roofColor: null,
      ring: square(-10, -5, 20),
      holes: [new Float32Array([-5, 0, -5, 4, -1, 4, -1, 0])],
    },
    {
      id: 9,
      tier: 'core',
      kind: 'house',
      roof: 'gabled',
      height: 11.2,
      eave: 11.2,
      roofColor: 0x000000,
      ring: square(3.3, 8.8, 6),
      holes: [],
    },
  ],
  roads: [square(0, 0, 100)],
  plazas: [],
  green: [square(-200, 100, 30)],
  water: [square(-300, -300, 12.5)],
  trees: new Float32Array([1.5, 2.5, -40, 60.1]),
  treeHeights: new Float32Array([8, 21.5]),
};

describe('city format', () => {
  test('round-trips every field at decimetre precision', () => {
    const decoded = decodeCity(encodeCity(city));
    expect(decoded.bounds).toEqual(city.bounds);
    expect(decoded.labels).toEqual(city.labels);
    expect(decoded.buildings.map(({ ring: _, holes: __, ...b }) => b)).toEqual(
      city.buildings.map(({ ring: _, holes: __, ...b }) => b),
    );
    for (const [i, b] of decoded.buildings.entries()) {
      const original = city.buildings[i]!;
      expect([...b.ring]).toEqual(exact(original.ring));
      expect(b.holes.map((h) => Array.from(h))).toEqual(original.holes.map(exact));
    }
    expect(decoded.roads).toHaveLength(1);
    expect(decoded.plazas).toHaveLength(0);
    expect([...decoded.trees]).toEqual([1.5, 2.5, -40, 60.1].map((v) => Math.fround(v)));
    expect([...decoded.treeHeights]).toEqual([8, 21.5]);
  });

  test('gzip pack and unpack, and accepts already-inflated bytes', async () => {
    const packed = await packCity(city);
    expect(packed[0]).toBe(0x1f);
    expect((await unpackCity(packed)).buildings).toHaveLength(2);
    expect((await unpackCity(encodeCity(city))).buildings).toHaveLength(2);
  });

  test('rejects foreign or truncated data', () => {
    expect(() => decodeCity(new TextEncoder().encode('nope'))).toThrow(CityFormatError);
    const bytes = encodeCity(city);
    expect(() => decodeCity(bytes.subarray(0, bytes.length - 3))).toThrow();
    const trailing = new Uint8Array(bytes.length + 1);
    trailing.set(bytes);
    expect(() => decodeCity(trailing)).toThrow(CityFormatError);
  });
});
