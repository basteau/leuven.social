import { describe, expect, test } from 'bun:test';

import type { City } from './city.ts';
import { CityFormatError, decodeCity, encodeCity, packCity, unpackCity } from './format.ts';

const square = (x: number, z: number, s: number) =>
  new Float32Array([x, z, x + s, z, x + s, z + s, x, z + s]);

const exact = (ring: Float32Array) => Array.from(ring, (v) => Math.fround(v));

const city: City = {
  area: [
    { minX: -600, minZ: -400, maxX: 600, maxZ: 450 },
    { minX: -650, minZ: 450, maxX: 0, maxZ: 900 },
  ],
  bounds: { minX: -650, minZ: -400, maxX: 600, maxZ: 900 },
  labels: [
    { name: 'Grote Markt', x: 0, z: 0, minZoom: 0 },
    { name: 'Totem', x: 348.5, z: 57.2, minZoom: 2.5 },
  ],
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
  carriageways: [
    { kind: 'main', ring: square(0, 0, 100) },
    { kind: 'cycleway', ring: square(100, 0, 4) },
  ],
  markings: [
    { kind: 'dashed', line: new Float32Array([0, 50, 100, 50]) },
    { kind: 'zebra', line: new Float32Array([20, 0, 20, 10]) },
  ],
  plazas: [],
  green: [square(-200, 100, 30)],
  water: [square(-300, -300, 12.5)],
  woods: [square(40, 40, 9)],
  pitches: [square(60, 40, 9)],
  parking: [square(80, 40, 9)],
  paths: [{ width: 2.5, paved: false, line: new Float32Array([0, 0, 10, 5, 20, 5]) }],
  trees: new Float32Array([1.5, 2.5, -40, 60.1]),
  treeHeights: new Float32Array([8, 21.5]),
  props: [
    { kind: 'bikes', x: 12.3, z: -4.5, angle: Math.PI / 2, size: 12 },
    { kind: 'needle', x: -100, z: 200.7, angle: 0, size: 23 },
  ],
  tanks: [{ height: 14.5, ring: square(500, -1000, 6) }],
  parapets: [new Float32Array([-3, 0, -3, 10]), new Float32Array([3, 0, 3, 5, 3.5, 10])],
};

// A kind byte past the end of its list: find it where two cities differ only in that kind.
const badKind = (a: City, b: City) => {
  const [x, y] = [encodeCity(a), encodeCity(b)];
  x[x.findIndex((v, i) => v !== y[i])] = 200;
  return x;
};

describe('city format', () => {
  test('round-trips every field at decimetre precision', () => {
    const decoded = decodeCity(encodeCity(city));
    expect(decoded.area).toEqual(city.area);
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
    expect(decoded.carriageways.map((r) => r.kind)).toEqual(['main', 'cycleway']);
    expect(decoded.carriageways.map((r) => [...r.ring])).toEqual(
      city.carriageways.map((r) => exact(r.ring)),
    );
    expect(decoded.markings).toEqual(city.markings);
    expect(decoded.plazas).toHaveLength(0);
    expect(decoded.paths).toEqual(city.paths);
    expect([...decoded.trees]).toEqual([1.5, 2.5, -40, 60.1].map((v) => Math.fround(v)));
    expect([...decoded.treeHeights]).toEqual([8, 21.5]);
    expect(decoded.props.map((p) => [p.kind, p.size])).toEqual([
      ['bikes', 12],
      ['needle', 23],
    ]);
    for (const [i, p] of decoded.props.entries()) {
      const original = city.props[i]!;
      expect(p.x).toBeCloseTo(original.x, 4);
      expect(p.z).toBeCloseTo(original.z, 4);
      expect(p.angle).toBeCloseTo(original.angle, 1); // a 256th of a turn
    }
    expect(decoded.tanks).toEqual(city.tanks);
    expect(decoded.parapets).toEqual(city.parapets);
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
    const road = (kind: 'main' | 'street') => ({
      ...city,
      carriageways: [{ ...city.carriageways[0]!, kind }],
    });
    expect(() => decodeCity(badKind(road('main'), road('street')))).toThrow(CityFormatError);
    const mark = (kind: 'solid' | 'zebra') => ({
      ...city,
      markings: [{ ...city.markings[0]!, kind }],
    });
    expect(() => decodeCity(badKind(mark('solid'), mark('zebra')))).toThrow(CityFormatError);
    const prop = (kind: 'lamp' | 'bench') => ({ ...city, props: [{ ...city.props[0]!, kind }] });
    expect(() => decodeCity(badKind(prop('lamp'), prop('bench')))).toThrow('Bad prop kind');
    const bytes = encodeCity(city);
    expect(() => decodeCity(bytes.subarray(0, bytes.length - 3))).toThrow();
    const trailing = new Uint8Array(bytes.length + 1);
    trailing.set(bytes);
    expect(() => decodeCity(trailing)).toThrow(CityFormatError);
  });
});
