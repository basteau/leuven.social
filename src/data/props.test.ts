import { expect, test } from 'bun:test';

import {
  DEFAULT_STANDS,
  EdgeIndex,
  MAX_STANDS,
  RingIndex,
  placeProps,
  propFromOsm,
} from './props.ts';

test('OSM points become the props they are', () => {
  expect(propFromOsm({ highway: 'street_lamp' })).toEqual({ kind: 'lamp', size: 0 });
  expect(propFromOsm({ amenity: 'bench' })).toEqual({ kind: 'bench', size: 0 });
  expect(propFromOsm({ highway: 'bus_stop', shelter: 'yes' })).toEqual({
    kind: 'shelter',
    size: 0,
  });
  expect(propFromOsm({ highway: 'bus_stop', shelter: 'no' })).toEqual({ kind: 'busstop', size: 0 });
  expect(propFromOsm({ man_made: 'water_well', historic: 'yes' })).toEqual({
    kind: 'pump',
    size: 0,
  });
  // Lamp posts that carry flags are lamps.
  expect(propFromOsm({ highway: 'street_lamp', man_made: 'flagpole' })?.kind).toBe('lamp');
  expect(propFromOsm({ amenity: 'restaurant' })).toBeNull();
  expect(propFromOsm({ tourism: 'artwork', artwork_type: 'mural' })).toBeNull();
});

test('a sculpture is a statue, a tall one a needle, a fountain sculpture a fountain', () => {
  expect(propFromOsm({ tourism: 'artwork', artwork_type: 'statue' })).toEqual({
    kind: 'statue',
    size: 0,
  });
  expect(propFromOsm({ historic: 'memorial', memorial: 'statue', height: '4' })).toEqual({
    kind: 'statue',
    size: 4,
  });
  expect(
    propFromOsm({ tourism: 'artwork', artwork_type: 'sculpture', name: 'Totem', height: '23' }),
  ).toEqual({ kind: 'needle', size: 23 });
  // A statue on a bench (De Kotmadam) is the statue; Fonske is a fountain.
  expect(propFromOsm({ amenity: 'bench', tourism: 'artwork', artwork_type: 'statue' })?.kind).toBe(
    'statue',
  );
  expect(
    propFromOsm({ amenity: 'fountain', tourism: 'artwork', artwork_type: 'sculpture' }),
  ).toEqual({ kind: 'fountain', size: 0 });
  // Nonsense heights are ignored.
  expect(propFromOsm({ tourism: 'artwork', artwork_type: 'bust', height: '300' })?.size).toBe(0);
});

test('bike racks hold their tagged capacity, within reason, unless out of sight', () => {
  expect(propFromOsm({ amenity: 'bicycle_parking', capacity: '10' })).toEqual({
    kind: 'bikes',
    size: 10,
  });
  expect(propFromOsm({ amenity: 'bicycle_parking' })?.size).toBe(DEFAULT_STANDS);
  expect(propFromOsm({ amenity: 'bicycle_parking', capacity: '400' })?.size).toBe(MAX_STANDS);
  expect(propFromOsm({ amenity: 'bicycle_parking', capacity: '1' })?.size).toBe(2);
  expect(propFromOsm({ amenity: 'bicycle_parking', location: 'underground' })).toBeNull();
  expect(propFromOsm({ amenity: 'bicycle_parking', bicycle_parking: 'building' })).toBeNull();
});

test('the edge index finds the nearest edge within reach', () => {
  const edges = new EdgeIndex(10);
  edges.add([0, 0, 40, 0, 40, 40, 0, 40]); // a square
  edges.add([100, 0, 100, 0]); // a degenerate line is ignored
  edges.add([60, -20, 60, 60], false);
  const near = edges.nearest(5, 3, 10)!;
  expect(near.distance).toBeCloseTo(3);
  expect([near.dx, near.dz]).toEqual([0, -3]);
  expect(Math.abs(near.ux)).toBe(1);
  expect(edges.nearest(55, 20, 10)!.dx).toBeCloseTo(5); // the open line
  expect(edges.nearest(20, 20, 10)).toBeNull(); // the square's middle is 20 m from every side
  expect(edges.nearest(100, 0, 1)).toBeNull();
});

test('the ring index knows what lies inside', () => {
  const rings = new RingIndex(10);
  rings.add([0, 0, 25, 0, 25, 25, 0, 25]);
  expect(rings.contains(20, 20)).toBe(true);
  expect(rings.contains(30, 20)).toBe(false);
  expect(rings.contains(-500, 20)).toBe(false);
});

test('props face the nearest edge, skip blocked ground and come once', () => {
  const edges = new EdgeIndex();
  edges.add([-50, 10, 50, 10], false); // a kerb along x, south of the props
  const blocked = new RingIndex();
  blocked.add([20, -5, 30, -5, 30, 5, 20, 5]);
  const props = placeProps(
    [
      { x: 0, z: 0, tags: { amenity: 'bench' } },
      { x: 0.2, z: 0.1, tags: { amenity: 'bench' } }, // the same bench mapped twice
      { x: 0.2, z: 0.1, tags: { highway: 'street_lamp' } }, // but a lamp beside it is new
      { x: 25, z: 0, tags: { highway: 'street_lamp' } }, // inside a building
      { x: 5, z: 10, tags: { highway: 'street_lamp' } }, // right on the kerb
      { x: 0, z: -200, tags: { highway: 'street_lamp' } }, // nothing to face
      { x: 1, z: 1, tags: { amenity: 'cafe' } },
    ],
    edges,
    blocked,
  );
  expect(props.map((p) => p.kind)).toEqual(['bench', 'lamp', 'lamp', 'lamp']);
  expect(props[0]!.angle).toBeCloseTo(Math.PI / 2); // towards +z, the kerb
  expect(Math.abs(Math.sin(props[2]!.angle))).toBeCloseTo(1); // across the kerb
  expect(props[3]!.angle).toBe(0);
});
