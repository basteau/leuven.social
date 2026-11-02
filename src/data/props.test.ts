import { expect, test } from 'bun:test';

import type { Prop } from './city.ts';
import {
  CLEARANCE,
  DEFAULT_STANDS,
  EdgeIndex,
  MAX_STANDS,
  ROW,
  RingIndex,
  Shapes,
  directionFromOsm,
  discInFootprint,
  turnOf,
  footprintsOverlap,
  placeProps,
  propFootprint,
  propFromOsm,
  segmentInFootprint,
  standsAlong,
} from './props.ts';
import type { PropPoint, Surroundings } from './props.ts';

test('OSM points become the props they are', () => {
  expect(propFromOsm({ highway: 'street_lamp' })).toEqual({
    kind: 'lamp',
    size: 0,
    facing: null,
    axis: null,
  });
  expect(propFromOsm({ amenity: 'bench' })).toEqual({
    kind: 'bench',
    size: 0,
    facing: null,
    axis: null,
  });
  expect(propFromOsm({ highway: 'bus_stop', shelter: 'yes' })).toEqual({
    kind: 'shelter',
    size: 0,
    facing: null,
    axis: null,
  });
  expect(propFromOsm({ highway: 'bus_stop', shelter: 'no' })).toEqual({
    kind: 'busstop',
    size: 0,
    facing: null,
    axis: null,
  });
  expect(propFromOsm({ man_made: 'water_well', historic: 'yes' })).toEqual({
    kind: 'pump',
    size: 2.6,
    facing: null,
    axis: null,
    width: 0.8,
    depth: 1.3,
    material: 'bluestone',
  });
  // Lamp posts that carry flags are lamps.
  expect(propFromOsm({ highway: 'street_lamp', man_made: 'flagpole' })?.kind).toBe('lamp');
  expect(propFromOsm({ amenity: 'restaurant' })).toBeNull();
  expect(propFromOsm({ tourism: 'artwork', artwork_type: 'mural' })).toBeNull();
});

test('monuments carry their archetype, height, plinth and material (src/data/monuments.ts)', () => {
  expect(propFromOsm({ tourism: 'artwork', artwork_type: 'statue' })).toEqual({
    kind: 'statue',
    size: 4,
    facing: null,
    axis: null,
    width: 1.2,
    depth: 1.2,
    material: 'bronze',
  });
  expect(propFromOsm({ historic: 'memorial', memorial: 'statue', height: '4.5' })?.size).toBe(4.5);
  expect(
    propFromOsm({ tourism: 'artwork', artwork_type: 'sculpture', name: 'Totem', height: '23' }),
  ).toMatchObject({ kind: 'needle', size: 23 });
  // A statue on a bench (De Kotmadam) is the statue; Fonske is a fountain.
  expect(propFromOsm({ amenity: 'bench', tourism: 'artwork', artwork_type: 'statue' })?.kind).toBe(
    'statue',
  );
  expect(
    propFromOsm({ amenity: 'fountain', tourism: 'artwork', artwork_type: 'sculpture' }),
  ).toMatchObject({ kind: 'fountain', material: 'bronze' });
  // A tagged direction turns it; a plinth the GRB maps lines it up.
  expect(
    propFromOsm({ historic: 'memorial', memorial: 'stone', direction: 'S' })?.facing,
  ).toBeCloseTo(Math.PI / 2);
  const plinth = { _bearing: '90.0', _length: '4', _width: '3' };
  expect(propFromOsm({ tourism: 'artwork', artwork_type: 'statue', ...plinth })?.axis).toBeCloseTo(
    0,
  );
  // A furniture way's bearing isn't a plinth's.
  expect(
    propFromOsm({ tourism: 'artwork', artwork_type: 'statue', _bearing: '90' })?.axis,
  ).toBeNull();
});

test('bike racks hold their tagged capacity, within reason, unless out of sight', () => {
  expect(propFromOsm({ amenity: 'bicycle_parking', capacity: '10' })).toEqual({
    kind: 'bikes',
    size: 10,
    facing: null,
    axis: null,
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

test('lamps on a façade or hung over the street have no post to draw', () => {
  expect(propFromOsm({ highway: 'street_lamp', lamp_mount: 'wall' })).toBeNull();
  expect(propFromOsm({ highway: 'street_lamp', support: 'wall_mounted' })).toBeNull();
  expect(propFromOsm({ highway: 'street_lamp', lamp_mount: 'suspended' })).toBeNull();
  expect(propFromOsm({ highway: 'street_lamp', lamp_mount: 'bent_mast' })?.kind).toBe('lamp');
});

test('a tagged direction turns benches, lamps and statues, in degrees or compass points', () => {
  // North is -z, east +x: the map's turn runs from +x towards +z.
  expect(directionFromOsm('90')).toBeCloseTo(0);
  expect(directionFromOsm('0')).toBeCloseTo(-Math.PI / 2);
  expect(directionFromOsm('S')).toBeCloseTo(Math.PI / 2);
  expect(directionFromOsm('nw')).toBeCloseTo((-3 * Math.PI) / 4);
  expect(directionFromOsm('45-90')).toBeNull();
  expect(directionFromOsm(undefined)).toBeNull();
  expect(propFromOsm({ amenity: 'bench', direction: 'E' })?.facing).toBeCloseTo(0);
  // A bus stop's direction is the buses', not its own.
  expect(propFromOsm({ highway: 'bus_stop', direction: 'E' })?.facing).toBeNull();
});

test('a bench or rack drawn as a way runs along it; a bench line faces its side', () => {
  // Drawn eastwards: the run turns to +x, its right is south (+z), its left north.
  const east = { _bearing: '90.0', _length: '4.8' };
  const bench = propFromOsm({ amenity: 'bench', ...east })!;
  expect([bench.kind, bench.size, bench.facing]).toEqual(['bench', 0, null]);
  expect(bench.axis).toBeCloseTo(0);
  expect(propFromOsm({ amenity: 'bench', side: 'right', ...east })?.facing).toBeCloseTo(
    Math.PI / 2,
  );
  expect(propFromOsm({ amenity: 'bench', side: 'left', ...east })?.facing).toBeCloseTo(
    -Math.PI / 2,
  );
  expect(propFromOsm({ amenity: 'bench', side: 'both', ...east })?.facing).toBeNull();
  // A tagged direction still wins.
  expect(
    propFromOsm({ amenity: 'bench', side: 'left', direction: 'S', ...east })?.facing,
  ).toBeCloseTo(Math.PI / 2);
  expect(propFromOsm({ amenity: 'bicycle_parking', ...east })?.axis).toBeCloseTo(0);
  // Only benches and racks run along their way.
  expect(propFromOsm({ highway: 'street_lamp', ...east })?.axis).toBeNull();
});

test('a rack drawn as a way without a capacity fills its length, in one row', () => {
  expect(standsAlong(4.8)).toBe(DEFAULT_STANDS); // Leuven's typical rack
  expect(standsAlong(1)).toBe(2);
  expect(standsAlong(60)).toBe(ROW);
  // Drawn, its stands span about the way.
  const rack = propFootprint(at({ kind: 'bikes', size: standsAlong(7) }));
  expect(rack.u1 - rack.u0).toBeGreaterThan(6.3);
  expect(rack.u1 - rack.u0).toBeLessThan(7.7);
  const way = { amenity: 'bicycle_parking', _bearing: '0.0' };
  expect(propFromOsm({ ...way, _length: '7' })?.size).toBe(standsAlong(7));
  expect(propFromOsm({ ...way, _length: '7', capacity: '20' })?.size).toBe(20);
});

const at = (over: Partial<Prop>): Prop => ({
  kind: 'bench',
  x: 0,
  z: 0,
  angle: 0,
  size: 0,
  ...over,
});

test('footprints are drawn to scale and turn with the prop', () => {
  const bench = propFootprint(at({}));
  expect(bench.u1 - bench.u0).toBeCloseTo(1.8 * 1.3);
  expect(bench.v1).toBeGreaterThan(-bench.v0); // room for the legs in front
  const rack = propFootprint(at({ kind: 'bikes', size: 24 }));
  expect(rack.u1 - rack.u0).toBeGreaterThan(rack.v1 - rack.v0); // two rows of twelve, along u
  expect(propFootprint(at({ kind: 'needle', size: 23 })).u1).toBe(0.8); // life size
  // Facing +z, a bench's length runs along x.
  const turned = propFootprint(at({ angle: Math.PI / 2 }));
  expect(discInFootprint(turned, 1, 0, 0.01)).toBe(true);
  expect(discInFootprint(turned, 0, 0.8, 0.01)).toBe(true); // the legroom
  expect(discInFootprint(turned, 0, -1, 0.01)).toBe(false);
});

test('footprints know what crosses and overlaps them', () => {
  const f = propFootprint(at({}));
  expect(segmentInFootprint(f, -5, 0, 5, 0)).toBe(true); // straight through
  expect(segmentInFootprint(f, 0.1, 0.1, 0.2, 0.2)).toBe(true); // inside
  expect(segmentInFootprint(f, -5, 3, 5, 3)).toBe(false); // beside it
  expect(segmentInFootprint(f, 3, -5, 3, 5)).toBe(false); // parallel, beyond its end
  expect(segmentInFootprint(f, 5, 0, 5, 0)).toBe(false); // a point outside
  expect(footprintsOverlap(f, propFootprint(at({ x: 0.5 })))).toBe(true);
  expect(footprintsOverlap(f, propFootprint(at({ z: 3 })))).toBe(false);
  // Turned a quarter, each pokes past the other's long side without touching it.
  expect(footprintsOverlap(f, propFootprint(at({ z: 2.5, angle: Math.PI / 2 })))).toBe(false);
  expect(discInFootprint(f, 0, 2, 0.5)).toBe(false);
  expect(discInFootprint(f, 0, 2, 1.5)).toBe(true);
});

test('shapes tell areas from lines', () => {
  const shapes = new Shapes();
  shapes.ring([0, 0, 10, 0, 10, 10, 0, 10]);
  shapes.line([20, -10, 20, 10]);
  expect(shapes.contains(5, 5)).toBe(true);
  expect(shapes.contains(20, 0)).toBe(false);
  expect(shapes.touches(propFootprint(at({ x: 5, z: 5 })))).toBe(true); // well inside
  expect(shapes.touches(propFootprint(at({ x: 5, z: -0.4 })))).toBe(true); // across its edge
  expect(shapes.touches(propFootprint(at({ x: 20.5, z: 0, angle: Math.PI / 2 })))).toBe(true);
  expect(shapes.touches(propFootprint(at({ x: 15, z: 5 })))).toBe(false);
});

/**
 * A street running east to west: houses north of z = -6, a pavement to z = -2, the carriageway
 * to z = 4, a pavement and then a small square south of z = 6.
 */
function street(): Surroundings {
  const roads = new Shapes();
  roads.ring([-100, -2, 100, -2, 100, 4, -100, 4]);
  const solid = new Shapes();
  solid.ring([-100, -20, 100, -20, 100, -6, -100, -6]);
  const water = new Shapes();
  water.ring([60, 6, 80, 6, 80, 30, 60, 30]);
  const edges = new EdgeIndex();
  edges.add([-100, -6, 100, -6], false);
  const squares = new RingIndex();
  squares.add([-30, 6, 30, 6, 30, 40, -30, 40]);
  return { roads, solid, water, edges, squares, trunks: [[-40, -4, 0.5]] };
}

const point = (x: number, z: number, tags: PropPoint['tags']): PropPoint => ({ x, z, tags });
const LAMP = { highway: 'street_lamp' };
const BENCH = { amenity: 'bench' };
const NORTH = -Math.PI / 2;
const SOUTH = Math.PI / 2;

test('a lamp turns its head over the road, a shelter its open side, a rack runs along the kerb', () => {
  const s = street();
  expect(turnOf('lamp', 0, -3, s)).toBeCloseTo(SOUTH);
  expect(turnOf('lamp', 0, 5, s)).toBeCloseTo(NORTH);
  expect(turnOf('shelter', 10, 5.5, s)).toBeCloseTo(NORTH);
  expect(Math.abs(Math.sin(turnOf('bikes', 0, -4, s)))).toBeCloseTo(1);
  // Far from any kerb, a lamp lines up with the nearest edge; with none, it keeps its own turn.
  expect(turnOf('lamp', 0, -12 + 100, { ...s, roads: new Shapes() })).toBe(0);
});

test('a bench turns its back to a wall, faces into a square, else towards the edge', () => {
  const s = street();
  expect(turnOf('bench', 0, -5, s)).toBeCloseTo(SOUTH); // the house behind, the street ahead
  expect(turnOf('bench', 0, 7, s)).toBeCloseTo(SOUTH); // on the square's edge, facing into it
  expect(turnOf('bench', 50, 7, s)).toBeCloseTo(NORTH); // a pavement: towards the kerb
  expect(turnOf('statue', 0, 7, s)).toBeCloseTo(SOUTH);
});

test('monuments stand on their plinth, true to size, first; one mapped twice stands once', () => {
  const statue = { kind: 'statue', x: 0, z: 0, angle: 0, size: 5 } as const;
  const plinth = propFootprint({ ...statue, width: 4, depth: 3 });
  expect([plinth.u1 - plinth.u0, plinth.v1 - plinth.v0]).toEqual([4, 3]); // not 1.3 times
  // Built before the bake gave it one, its kind's.
  expect(propFootprint(statue).u1).toBeCloseTo(0.75);
  const s = street();
  const { props, dropped } = placeProps(
    [
      point(30, 10, { ...LAMP, _osm: 'node/1' }),
      point(30, 10, { tourism: 'artwork', artwork_type: 'sculpture', _osm: 'node/8' }),
      point(30.2, 10, { man_made: 'water_well', _osm: 'node/9' }), // the well it stands at
    ],
    s,
  );
  expect(props.map((p) => p.kind)).toEqual(['pump', 'lamp']);
  expect(props[0]).toMatchObject({ x: 30.2, width: 0.8, depth: 1.3, material: 'bluestone' });
  expect(dropped).toBe(1);
});

test('drawn as a way, a rack or bench faces across it, to the side its rule picks', () => {
  const s = street();
  // Along the houses, whichever way it was drawn: stands across the pavement, as mapped.
  expect(turnOf('bikes', 0, -4, s, 0)).toBeCloseTo(SOUTH);
  expect(turnOf('bikes', 0, -4, s, Math.PI)).toBeCloseTo(SOUTH);
  // Drawn across the pavement, it stays across, where the kerb rule would turn it along.
  expect(Math.abs(Math.cos(turnOf('bikes', 0, -4, s, SOUTH)))).toBeCloseTo(1);
  expect(Math.abs(Math.sin(turnOf('bikes', 0, -4, s)))).toBeCloseTo(1);
  // A bench along the houses turns its back to them; drawn across, it faces along the street.
  expect(turnOf('bench', 0, -5, s, 0)).toBeCloseTo(SOUTH);
  expect(Math.abs(Math.cos(turnOf('bench', 0, -5, s, SOUTH)))).toBeCloseTo(1);
  // With nothing near, it faces across the run all the same.
  expect(turnOf('bench', 0, 500, s, 0)).toBeCloseTo(SOUTH);
  const sided = placeProps(
    [point(0, -4, { ...BENCH, _bearing: '90.0', _length: '3', side: 'left', _osm: 'way/1' })],
    s,
  );
  expect(sided.props[0]!.angle).toBeCloseTo(NORTH); // facing the houses, as mapped
});

test('props move off walls and the carriageway, onto the nearest free ground', () => {
  const { props, nudged, dropped } = placeProps(
    [
      point(0, -2.1, LAMP), // on the pavement, touching the kerb
      point(10, -1.5, LAMP), // just on the carriageway
      point(20, 1, LAMP), // in the middle of it: a median, mapped there
      point(30, -6.5, { amenity: 'bicycle_parking' }), // against the houses
      point(40, -6.5, BENCH), // just inside a house
      point(50, -15, BENCH), // deep inside a house
      point(70, 10, LAMP), // in the river
      point(70, 10, { amenity: 'fountain' }), // a fountain in its basin
      point(-40, -4, BENCH), // on a tree's trunk
    ],
    street(),
  );
  const [fountain, lamp, kerbLamp, median, bench, treeBench, rack] = props;
  expect(props.map((p) => p.kind)).toEqual([
    'fountain',
    'lamp',
    'lamp',
    'lamp',
    'bench',
    'bench',
    'bikes',
  ]);
  expect(dropped).toBe(2);
  expect(nudged).toBe(5);
  expect([fountain!.x, fountain!.z]).toEqual([70, 10]);
  expect(lamp!.z).toBeLessThan(-2 - 0.12 * 1.3 - CLEARANCE + 1e-9);
  expect(kerbLamp!.z).toBeLessThan(-2);
  expect([median!.x, median!.z]).toEqual([20, 1]);
  expect(bench!.z).toBeGreaterThan(-6 + 0.25 * 1.3);
  expect(Math.hypot(treeBench!.x + 40, treeBench!.z + 4)).toBeGreaterThan(0.5);
  // A rack keeps its length along the houses and stays off the carriageway.
  expect(rack!.z).toBeGreaterThan(-6);
  expect(rack!.z).toBeLessThan(-2);
});

test('props claim ground by priority, then id; one standing on its twin is a second mapping', () => {
  const s = street();
  const { props, dropped } = placeProps(
    [
      point(0, -4, { amenity: 'bicycle_parking', capacity: '2', _osm: 'node/1' }),
      point(0, -4, { ...LAMP, _osm: 'node/9' }),
      point(0.3, -4, { ...LAMP, _osm: 'node/5' }), // the same lamp, mapped twice
      point(-20, -4, { ...BENCH, _osm: 'node/7' }),
      point(-20.4, -4, { ...BENCH, _osm: 'node/3' }),
      point(5, -4, { amenity: 'restaurant' }),
    ],
    s,
  );
  expect(dropped).toBe(2);
  const [lamp, bench, rack] = props;
  expect([lamp!.kind, lamp!.x]).toEqual(['lamp', 0.3]); // the lower id stays
  expect(bench!.x).toBe(-20.4);
  expect(rack!.kind).toBe('bikes'); // moved aside for the lamp
  const lampBox = propFootprint(lamp!);
  expect(footprintsOverlap(propFootprint(rack!), lampBox)).toBe(false);
  // The same points always settle the same way.
  expect(placeProps([point(0, -4, LAMP), point(0, -4, BENCH)], s)).toEqual(
    placeProps([point(0, -4, BENCH), point(0, -4, LAMP)], s),
  );
});
