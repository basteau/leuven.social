import { expect, test } from 'bun:test';

import { pointInRing, signedArea } from './geometry.ts';
import { areaKind, bridgeHoles, coverOf, groundRings, osmAreas } from './landcover.ts';
import type { OsmElement } from './landcover.ts';

test.each([
  [{ amenity: 'parking', parking: 'surface' }, 'parking'],
  [{ amenity: 'parking' }, 'parking'],
  [{ amenity: 'parking', parking: 'underground' }, null],
  [{ amenity: 'parking', parking: 'multi-storey' }, null],
  [{ amenity: 'parking', parking: 'rooftop' }, null],
  [{ leisure: 'schoolyard' }, 'parking'],
  [{ leisure: 'pitch' }, 'pitches'],
  [{ leisure: 'pitch', landuse: 'grass' }, 'pitches'],
  [{ leisure: 'track' }, 'pitches'],
  [{ place: 'square' }, 'plazas'],
  [{ 'area:highway': 'pedestrian' }, 'plazas'],
  [{ natural: 'water' }, 'water'],
  [{ landuse: 'basin' }, 'water'],
  [{ waterway: 'riverbank' }, 'water'],
  [{ landuse: 'railway' }, 'railLand'],
  [{ landuse: 'forest' }, 'woods'],
  [{ landuse: 'forest', leisure: 'park' }, 'woods'],
  [{ landuse: 'orchard' }, 'woods'],
  [{ natural: 'scrub' }, 'woods'],
  [{ landcover: 'trees' }, 'woods'],
  [{ leisure: 'park' }, 'green'],
  [{ leisure: 'garden' }, 'green'],
  [{ landuse: 'cemetery' }, 'green'],
  [{ amenity: 'grave_yard' }, 'green'],
  [{ landuse: 'allotments' }, 'green'],
  [{ natural: 'grassland' }, 'green'],
  [{ landcover: 'grass' }, 'green'],
  [{ landuse: 'residential' }, null],
  [{ amenity: 'school' }, null],
  [{ amenity: 'university' }, null],
  [{ landuse: 'construction' }, null],
  [{ leisure: 'sports_centre' }, null],
  [{}, null],
])('%o is drawn as %s', (tags, cover) => {
  expect(coverOf(tags)).toBe(cover as ReturnType<typeof coverOf>);
});

test('an area is named by the tags that say what it is', () => {
  expect(areaKind({ amenity: 'parking', parking: 'surface', name: 'Bodart' })).toBe(
    'amenity=parking + parking=surface',
  );
  expect(areaKind({ name: 'Nothing' })).toBe('(none)');
});

const flat = (lon: number, lat: number) => [lon, lat] as const;
const geometry = (...points: [number, number][]) => points.map(([lon, lat]) => ({ lon, lat }));

test('closed ways are areas, counter-clockwise; open ways are not', () => {
  const elements: OsmElement[] = [
    {
      type: 'way',
      id: 1,
      tags: { leisure: 'park' },
      geometry: geometry([0, 0], [0, 10], [10, 10], [10, 0], [0, 0]),
    },
    { type: 'way', id: 2, tags: { railway: 'rail' }, geometry: geometry([0, 0], [5, 5], [9, 0]) },
    { type: 'node', id: 3 },
  ];
  const areas = osmAreas(elements, flat);
  expect(areas.map((a) => a.id)).toEqual(['w1']);
  expect(areas[0]!.polygons[0]!.outer).toHaveLength(8);
  expect(signedArea(areas[0]!.polygons[0]!.outer)).toBe(100);
});

test('a multipolygon joins its outer ways and nests its inner rings', () => {
  const relation: OsmElement = {
    type: 'relation',
    id: 14333531,
    tags: { type: 'multipolygon', amenity: 'parking', name: 'Bodart' },
    members: [
      { type: 'way', role: 'outer', geometry: geometry([0, 0], [20, 0], [20, 20]) },
      { type: 'way', role: 'outer', geometry: geometry([0, 0], [0, 20], [20, 20]) },
      { type: 'way', role: 'inner', geometry: geometry([5, 5], [5, 8], [8, 8], [8, 5], [5, 5]) },
      // A second outer, drawn as one closed way with an empty role, and a stray point.
      {
        type: 'way',
        role: '',
        geometry: [...geometry([30, 0], [40, 0], [40, 10]), null, ...geometry([30, 0])],
      },
      { type: 'node', role: 'label', geometry: geometry([1, 1]) },
      // An inner ring outside every outer is dropped.
      { role: 'inner', geometry: geometry([50, 50], [51, 50], [51, 51], [50, 50]) },
    ],
  };
  const [area] = osmAreas([relation], flat);
  expect(area!.id).toBe('r14333531');
  expect(area!.polygons).toHaveLength(2);
  const [square, triangle] = area!.polygons.toSorted((a, b) => a.outer[0]! - b.outer[0]!);
  expect(signedArea(square!.outer)).toBe(400);
  expect(square!.holes).toHaveLength(1);
  expect(signedArea(square!.holes[0]!)).toBe(-9);
  expect(signedArea(triangle!.outer)).toBe(50);
  expect(triangle!.holes).toEqual([]);
});

test('relations that are not multipolygons, or have no ring, are left out', () => {
  const elements: OsmElement[] = [
    { type: 'relation', id: 1, tags: { type: 'route' }, members: [] },
    { type: 'relation', id: 2, tags: { type: 'multipolygon' } },
    {
      type: 'relation',
      id: 3,
      tags: { type: 'multipolygon' },
      members: [{ role: 'outer', geometry: geometry([0, 0], [1, 0], [1, 1]) }],
    },
  ];
  expect(osmAreas(elements, flat)).toEqual([]);
});

const square = (x: number, z: number, size: number) => [
  x,
  z,
  x + size,
  z,
  x + size,
  z + size,
  x,
  z + size,
];
const cw = (ring: number[]) => {
  const out: number[] = [];
  for (let i = ring.length - 2; i >= 0; i -= 2) out.push(ring[i]!, ring[i + 1]!);
  return out;
};

test('holes are bridged into one ring that fills and triangulates as the polygon with holes', () => {
  const outer = square(0, 0, 100);
  const holes = [cw(square(10, 10, 20)), cw(square(60, 60, 10)), cw(square(60, 10, 20))];
  const ring = bridgeHoles(outer, holes);
  expect(signedArea(ring)).toBeCloseTo(10000 - 400 - 100 - 400, 6);
  expect(pointInRing(ring, 5, 5)).toBe(true);
  expect(pointInRing(ring, 20, 20)).toBe(false);
  expect(pointInRing(ring, 65, 65)).toBe(false);
  expect(pointInRing(ring, 70, 20)).toBe(false);
  expect(pointInRing(ring, 45, 50)).toBe(true);
  // No cut runs along an edge or reuses a corner (src/scene/ground.test.ts triangulates it).
  const corners = new Map<string, number>();
  for (let i = 0; i < ring.length; i += 2) {
    const key = `${ring[i]},${ring[i + 1]}`;
    corners.set(key, (corners.get(key) ?? 0) + 1);
  }
  expect(Math.max(...corners.values())).toBe(2);
});

test('a bridge goes round what stands between a hole and the nearest corner', () => {
  // The nearest corner to the right hole's east end is across the left hole's cut, so the
  // bridge must reach another corner without crossing anything.
  const outer = [0, 0, 100, 0, 100, 100, 0, 100];
  const ring = bridgeHoles(outer, [cw(square(40, 40, 20)), cw(square(70, 45, 10))]);
  expect(signedArea(ring)).toBeCloseTo(10000 - 400 - 100, 6);
  expect(pointInRing(ring, 50, 50)).toBe(false);
  expect(pointInRing(ring, 75, 50)).toBe(false);
  expect(pointInRing(ring, 65, 50)).toBe(true);
});

test('ground rings are simplified, cut to each rectangle, with holes in the piece they lie in', () => {
  const area = [
    { minX: 0, minZ: 0, maxX: 50, maxZ: 100 },
    { minX: 50, minZ: 0, maxX: 100, maxZ: 100 },
  ];
  // A square across both rectangles, a hole in the right one and a speck of a hole on the left.
  const outer = [...square(10, 10, 80).slice(0, 2), 50, 10.1, ...square(10, 10, 80).slice(2)];
  const polygons = [{ outer, holes: [cw(square(60, 30, 20)), cw(square(20, 20, 1))] }];
  const rings = groundRings(polygons, area, 0.3, 25);
  expect(rings).toHaveLength(2);
  const [left, right] = rings.toSorted((a, b) => a[0]! - b[0]!);
  expect(left).toHaveLength(8);
  expect(signedArea(left!)).toBeCloseTo(40 * 80, 6);
  expect(signedArea(right!)).toBeCloseTo(40 * 80 - 400, 6);
  // Pieces too small to keep are left out.
  expect(groundRings([{ outer: square(45, 0, 10), holes: [] }], area, 0.3, 60)).toEqual([]);
  expect(groundRings([{ outer: square(200, 0, 10), holes: [] }], area, 0.3)).toEqual([]);
});
