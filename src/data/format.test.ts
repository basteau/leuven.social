import { describe, expect, test } from 'bun:test';

import type { City } from './city.ts';
import { CityFormatError, decodeCity, encodeCity, packCity, unpackCity } from './format.ts';
import { MAX_STANDS, bikesIn } from './props.ts';
import { FLAT_GRID } from './terrain.ts';

const square = (x: number, z: number, s: number) =>
  new Float32Array([x, z, x + s, z, x + s, z + s, x, z + s]);

const exact = (ring: Float32Array) => Array.from(ring, (v) => Math.fround(v));

const city: City = {
  area: [
    { minX: -600, minZ: -400, maxX: 600, maxZ: 450 },
    { minX: -650, minZ: 450, maxX: 0, maxZ: 900 },
  ],
  bounds: { minX: -650, minZ: -400, maxX: 600, maxZ: 900 },
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
      tower: { x: 6.3, z: -2.1, radius: 4.1, top: 26.4, tip: 43.7 },
    },
    {
      id: 9,
      tier: 'core',
      kind: 'house',
      roof: 'across',
      height: 11.2,
      eave: 11.2,
      roofColor: 0x000000,
      ring: square(3.3, 8.8, 6),
      holes: [],
    },
    {
      // Ids are stored as the change from the one before, which can go down.
      id: 3,
      tier: 'fringe',
      kind: 'shed',
      roof: 'flat',
      height: 3,
      eave: 3,
      roofColor: 0xfedcba,
      ring: square(-480.2, 300.1, 4),
      holes: [],
      tower: { x: -478, z: 302, radius: 1.4, top: 3, tip: 9.5 },
    },
  ],
  roads: [square(0, 0, 100)],
  carriageways: [
    { kind: 'main', surface: 'asphalt', ring: square(0, 0, 100) },
    { kind: 'cycleway', surface: 'asphalt', ring: square(100, 0, 4) },
  ],
  markings: [
    { kind: 'dashed', line: new Float32Array([0, 50, 100, 50]) },
    { kind: 'zebra', line: new Float32Array([20, 0, 20, 10]) },
  ],
  plazas: [square(-50, -50, 30), square(200, 0, 10)],
  green: [square(-200, 100, 30)],
  water: [square(-300, -300, 12.5)],
  woods: [square(40, 40, 9)],
  pitches: [square(60, 40, 9), square(0, 300, 40)],
  pitchSurfaces: ['clay', 'tartan'],
  fields: [
    { sport: 'tennis', x: 60.1, z: -40.3, angle: 2.5, length: 34.2, width: 37.1, count: 2 },
    { sport: 'track', x: 0, z: 300, angle: 0, length: 158, width: 73, count: 6 },
  ],
  parking: [square(80, 40, 9)],
  paths: [{ width: 2.5, surface: 'gravel', line: new Float32Array([0, 0, 10, 5, 20, 5]) }],
  rails: [
    { kind: 'main', bridge: true, electrified: true, line: new Float32Array([0, 0, 100, 40]) },
    { kind: 'yard', bridge: false, electrified: false, line: new Float32Array([5, 5, 50, 5]) },
  ],
  platforms: [square(20, 20, 8)],
  railLand: [square(-20, 20, 40)],
  canopies: [square(15, 15, 18)],
  trees: new Float32Array([1.5, 2.5, -40, 60.1]),
  islands: [],
  treeKinds: new Uint8Array([1, 0]),
  hedges: [new Float32Array([1, 2, 3, 4])],
  flowerbeds: [],
  treeHeights: new Float32Array([8, 21.5]),
  props: [
    { kind: 'bikes', x: 12.3, z: -4.5, angle: Math.PI / 2, size: 12, fill: 5 / 12 },
    {
      kind: 'needle',
      x: -100,
      z: 200.7,
      angle: 0,
      size: 23,
      width: 1.6,
      depth: 1.6,
      material: 'steel',
    },
    { kind: 'statue', x: 4, z: 3, angle: 1, size: 5.9, width: 3.2, depth: 3.1, material: 'bronze' },
  ],
  tanks: [{ height: 14.5, ring: square(500, -1000, 6) }],
  bridges: [square(-60, 0, 10)],
  decks: [
    {
      carries: 'road',
      ring: square(80, 80, 10),
      axis: Float32Array.of(75, 85, 95, 85),
      rise: Float32Array.of(0.5, 5.2),
      piers: Float32Array.of(82, 82),
      lanes: [{ width: 6.4, surface: 'asphalt', line: Float32Array.of(80, 85, 90, 85) }],
    },
  ],
  ramps: [
    {
      line: Float32Array.of(95, 85, 120, 85),
      rise: Float32Array.of(5.2, 0),
      half: 6.5,
      left: Float32Array.of(6.5, 4),
      right: Float32Array.of(6, 3.5),
      rail: false,
    },
    { line: Float32Array.of(0, 200, 0, 300), rise: Float32Array.of(-6.8, 0), half: 3, rail: true },
  ],
  tunnels: [
    {
      carries: 'path',
      line: Float32Array.of(-10, -10, 10, -10),
      half: 1.5,
      depth: 3.4,
      mouths: [true, false],
    },
  ],
  parapets: [new Float32Array([-3, 0, -3, 10]), new Float32Array([3, 0, 3, 5, 3.5, 10])],
  streetNames: ['Grote Markt', 'Naamsestraat'],
  streets: [
    { name: 1, line: new Float32Array([0, 10, 0, 300]) },
    { name: 0, line: new Float32Array([-60, 0, -10, 0, 10, 5]) },
  ],
  plazaNames: [0, -1],
  terrain: FLAT_GRID,
  fronts: [],
};

/** Fifty small rings in a row, starting at x. */
const block = (x: number) => Array.from({ length: 50 }, (_, i) => square(x + i * 7, 3000, 5));

// A kind byte past the end of its list: find it where two cities differ only in that kind.
const badKind = (a: City, b: City) => {
  const [x, y] = [encodeCity(a), encodeCity(b)];
  x[x.findIndex((v, i) => v !== y[i])] = 200;
  return x;
};

describe('city format', () => {
  test("a rack's fill byte keeps its count of bikes, for every count in every rack", () => {
    const props: City['props'] = [];
    for (let size = 2; size <= MAX_STANDS; size++) {
      for (let bikes = 0; bikes <= size; bikes++) {
        props.push({ kind: 'bikes', x: 0, z: 0, angle: 0, size, fill: bikes / size });
      }
    }
    const decoded = decodeCity(encodeCity({ ...city, props })).props;
    expect(decoded.map(bikesIn)).toEqual(props.map(bikesIn));
  });

  test('round-trips every field at decimetre precision', () => {
    const decoded = decodeCity(encodeCity(city));
    expect(decoded.area).toEqual(city.area);
    expect(decoded.bounds).toEqual(city.bounds);
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
    expect(decoded.plazas.map((p) => Array.from(p))).toEqual(city.plazas.map(exact));
    expect(decoded.paths).toEqual(city.paths);
    expect(decoded.rails).toEqual(city.rails);
    expect(decoded.platforms.map((p) => Array.from(p))).toEqual(city.platforms.map(exact));
    expect(decoded.railLand.map((p) => Array.from(p))).toEqual(city.railLand.map(exact));
    expect(decoded.canopies.map((p) => Array.from(p))).toEqual(city.canopies.map(exact));
    expect([...decoded.trees]).toEqual([1.5, 2.5, -40, 60.1].map((v) => Math.fround(v)));
    expect([...decoded.treeHeights]).toEqual([8, 21.5]);
    expect(decoded.props.map((p) => [p.kind, p.size])).toEqual([
      ['bikes', 12],
      ['needle', 23],
      ['statue', 5.9],
    ]);
    // Monuments keep their plinth and material; furniture carries neither.
    expect(decoded.props[2]).toMatchObject({ width: 3.2, depth: 3.1, material: 'bronze' });
    expect(decoded.props[0]!.material).toBeUndefined();
    // A rack keeps its fill to a 255th: the same bikes, and only a rack carries one.
    expect(decoded.props[0]!.fill).toBeCloseTo(5 / 12, 2);
    expect(bikesIn(decoded.props[0]!)).toBe(5);
    expect(decoded.props[1]!.fill).toBeUndefined();
    for (const [i, p] of decoded.props.entries()) {
      const original = city.props[i]!;
      expect(p.x).toBeCloseTo(original.x, 4);
      expect(p.z).toBeCloseTo(original.z, 4);
      expect(p.angle).toBeCloseTo(original.angle, 1); // a 256th of a turn
    }
    expect(decoded.tanks).toEqual(city.tanks);
    expect(decoded.bridges.map((p) => Array.from(p))).toEqual(city.bridges.map(exact));
    expect(decoded.parapets).toEqual(city.parapets);
    expect(decoded.streetNames).toEqual(city.streetNames);
    expect(decoded.streets).toEqual(city.streets);
    expect(decoded.plazaNames).toEqual(city.plazaNames);
    expect(decoded.pitchSurfaces).toEqual(city.pitchSurfaces);
    expect(decoded.fields.map(({ angle: _, ...f }) => f)).toEqual(
      city.fields.map(({ angle: _, ...f }) => f),
    );
    // A 4096th of half a turn: under 4 cm off at the end of a 100 m pitch.
    for (const [i, f] of decoded.fields.entries()) {
      expect(Math.abs(f.angle - city.fields[i]!.angle) * 50).toBeLessThan(0.04);
    }
  });

  test('gzip pack and unpack, and accepts already-inflated bytes', async () => {
    const packed = await packCity(city);
    expect(packed[0]).toBe(0x1f);
    expect((await unpackCity(packed)).buildings).toHaveLength(3);
    expect((await unpackCity(encodeCity(city))).buildings).toHaveLength(3);
  });

  test('each ring starts from the one before it: a block of them costs the same anywhere', () => {
    const size = (x: number) => encodeCity({ ...city, green: block(x) }).length;
    // Only the first ring's start moves, by a varint byte or two.
    expect(size(-3000) - size(0)).toBeLessThanOrEqual(2);
    expect(decodeCity(encodeCity({ ...city, green: block(-3000) })).green).toEqual(
      block(-3000).map((r) => Float32Array.from(exact(r))),
    );
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
    const ground = (surface: 'clay' | 'grass') => ({ ...city, pitchSurfaces: [surface, surface] });
    expect(() => decodeCity(badKind(ground('clay'), ground('grass')))).toThrow('Bad pitch surface');
    const sport = (kind: 'tennis' | 'soccer') => ({
      ...city,
      fields: [{ ...city.fields[0]!, sport: kind }],
    });
    expect(() => decodeCity(badKind(sport('tennis'), sport('soccer')))).toThrow('Bad field sport');
    const prop = (kind: 'lamp' | 'bench') => ({ ...city, props: [{ ...city.props[0]!, kind }] });
    expect(() => decodeCity(badKind(prop('lamp'), prop('bench')))).toThrow('Bad prop kind');
    const made = (material: 'bronze' | 'stone') => ({
      ...city,
      props: [{ ...city.props[2]!, material }],
    });
    expect(() => decodeCity(badKind(made('bronze'), made('stone')))).toThrow(
      'Bad monument material',
    );
    const bytes = encodeCity(city);
    expect(() => decodeCity(bytes.subarray(0, bytes.length - 3))).toThrow();
    const trailing = new Uint8Array(bytes.length + 1);
    trailing.set(bytes);
    expect(() => decodeCity(trailing)).toThrow(CityFormatError);
    // A rail kind this version doesn't know: find the flags byte where main and yard differ.
    const rail = (kind: 'main' | 'yard') =>
      encodeCity({ ...city, rails: [{ ...city.rails[1]!, kind }] });
    const [main, yard] = [rail('main'), rail('yard')];
    const flags = main.findIndex((b, i) => b !== yard[i]);
    main[flags] = 2 << 2;
    expect(() => decodeCity(main)).toThrow(CityFormatError);
    // A street or a square naming past the end of the name table.
    const street = { ...city, streets: [{ ...city.streets[0]!, name: 2 }] };
    expect(() => decodeCity(encodeCity(street))).toThrow('Bad street name');
    expect(() => decodeCity(encodeCity({ ...city, plazaNames: [0, 2] }))).toThrow('Bad square');
    // A tower on a building past the end of the list. Its eight bytes are the building's place,
    // the centre and radius (a byte each here), then top and tip (two each), before the level
    // terrain's nine and the shop fronts' count.
    const towered = encodeCity({ ...city, buildings: [city.buildings[0]!] });
    const place = towered.length - 1 - 9 - 8;
    expect(towered[place]).toBe(0);
    towered[place] = 5;
    expect(() => decodeCity(towered)).toThrow('Bad tower building');
  });
});

describe('terrain', () => {
  const hill = {
    step: 60,
    minX: -120,
    minZ: 60,
    cols: 3,
    rows: 2,
    heights: Float32Array.of(-2.5, 0, 1.35, 4.05, 8.4, 70),
  };

  test('round-trips to the nearest 5 cm, anchored on whole steps', () => {
    const { terrain } = decodeCity(encodeCity({ ...city, terrain: hill }));
    expect({ ...terrain, heights: [] }).toEqual({ ...hill, heights: [] });
    expect(Array.from(terrain.heights)).toEqual(
      Array.from(hill.heights, (h) => Math.fround(Math.round(h * 20) / 20)),
    );
  });

  test('rejects a grid larger than the file', () => {
    // Gentle enough that each height takes a byte: columns and rows are the two bytes before
    // them, and the fronts' count follows them.
    const gentle = { ...hill, heights: Float32Array.of(-0.5, 0, 1.35, 2.05, 2.4, 3) };
    const bytes = encodeCity({ ...city, terrain: gentle });
    const cols = bytes.length - 1 - 6 - 2;
    expect(bytes[cols]).toBe(3);
    bytes[cols] = 100;
    expect(() => decodeCity(bytes)).toThrow('Bad terrain grid');
  });
});

describe('shop fronts', () => {
  const fronts: City['fronts'] = [
    { building: 1, edge: 0, along: 2.5, kind: 'bakery', terrace: false },
    { building: 1, edge: 3, along: 1.2, kind: 'service', terrace: false },
    { building: 2, edge: 1, along: 3.9, kind: 'cafe', terrace: true },
  ];

  test('round-trip by building, each building wearing its first as its front', () => {
    const decoded = decodeCity(encodeCity({ ...city, fronts }));
    expect(decoded.fronts).toEqual(fronts);
    expect(decoded.buildings.map((b) => b.front)).toEqual([undefined, fronts[0], fronts[2]]);
  });

  test('a public place is no building’s main front, even its only one', () => {
    const school = { building: 0, edge: 0, along: 2, kind: 'school', terrace: false } as const;
    const decoded = decodeCity(encodeCity({ ...city, fronts: [school, ...fronts] }));
    expect(decoded.fronts[0]).toEqual(school);
    expect(decoded.buildings[0]!.front).toBeUndefined();
  });

  test('rejects a front on a missing building, wall or kind', () => {
    const bad = (front: Partial<City['fronts'][number]>) => {
      const one = [{ ...fronts[2]!, ...front }];
      return () => decodeCity(encodeCity({ ...city, fronts: one }));
    };
    expect(bad({ building: 3 })).toThrow('Bad shop front');
    expect(bad({ edge: 4 })).toThrow('Bad shop front');
    const kinds = encodeCity({ ...city, fronts: [fronts[0]!] });
    kinds[kinds.length - 1] = 0x7f; // the kind byte, the file's last
    expect(() => decodeCity(kinds)).toThrow('Bad shop front');
  });
});
