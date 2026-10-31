import { describe, expect, test } from 'bun:test';

import type { City } from './city.ts';
import { CityFormatError, decodeCity, encodeCity, packCity, unpackCity } from './format.ts';

const square = (x: number, z: number, s: number) =>
  new Float32Array([x, z, x + s, z, x + s, z + s, x, z + s]);

const city: City = {
  area: [
    { minX: -600, minZ: -400, maxX: 600, maxZ: 450 },
    { minX: -650, minZ: 450, maxX: 0, maxZ: 900 },
  ],
  bounds: { minX: -650, minZ: -400, maxX: 600, maxZ: 900 },
  labels: [{ name: 'Grote Markt', x: 0, z: 0 }],
  buildings: [
    { id: 7, tier: 'hero', kind: 'church', roof: 'auto', height: 35.4, ring: square(-10, -5, 20) },
    { id: 9, tier: 'core', kind: 'house', roof: 'gabled', height: 11.2, ring: square(3.3, 8.8, 6) },
  ],
  roads: [square(0, 0, 100)],
  plazas: [],
  green: [square(-200, 100, 30)],
  water: [square(-300, -300, 12.5)],
  trees: new Float32Array([1.5, 2.5, -40, 60.1]),
};

describe('city format', () => {
  test('round-trips every field at decimetre precision', () => {
    const decoded = decodeCity(encodeCity(city));
    expect(decoded.area).toEqual(city.area);
    expect(decoded.bounds).toEqual(city.bounds);
    expect(decoded.labels).toEqual(city.labels);
    expect(decoded.buildings.map(({ ring: _, ...b }) => b)).toEqual(
      city.buildings.map(({ ring: _, ...b }) => b),
    );
    for (const [i, b] of decoded.buildings.entries()) {
      expect([...b.ring]).toEqual([...city.buildings[i]!.ring].map((v) => Math.fround(v)));
    }
    expect(decoded.roads).toHaveLength(1);
    expect(decoded.plazas).toHaveLength(0);
    expect([...decoded.trees]).toEqual([1.5, 2.5, -40, 60.1].map((v) => Math.fround(v)));
  });

  test('gzip pack and unpack, and accepts already-inflated bytes', async () => {
    const packed = await packCity(city);
    expect(packed[0]).toBe(0x1f);
    expect((await unpackCity(packed)).buildings).toHaveLength(2);
    expect((await unpackCity(encodeCity(city))).buildings).toHaveLength(2);
  });

  test('rejects foreign or truncated data', () => {
    expect(() => decodeCity(new TextEncoder().encode('nope'))).toThrow(CityFormatError);
    expect(() => decodeCity(encodeCity({ ...city, area: [] }))).toThrow(CityFormatError);
    const bytes = encodeCity(city);
    expect(() => decodeCity(bytes.subarray(0, bytes.length - 3))).toThrow();
    const trailing = new Uint8Array(bytes.length + 1);
    trailing.set(bytes);
    expect(() => decodeCity(trailing)).toThrow(CityFormatError);
  });
});
