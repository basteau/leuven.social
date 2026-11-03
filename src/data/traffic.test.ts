import { describe, expect, test } from 'bun:test';

import type { Way } from './city.ts';
import {
  PAVEMENT,
  TAGGED_PAVEMENT,
  alongEdge,
  carAccess,
  coreEdges,
  pavementOf,
  roadGraph,
  roadRouter,
  sidesOf,
  sidesWithTags,
  sidewalksOf,
  splitAtJunctions,
  turnBetween,
  wayFromOsm,
} from './traffic.ts';
import type { Side } from './city.ts';

describe('wayFromOsm', () => {
  test('main roads, streets and cycle tracks, with links counted with their road', () => {
    expect(wayFromOsm({ highway: 'primary' })?.kind).toBe('main');
    expect(wayFromOsm({ highway: 'secondary_link' })?.kind).toBe('main');
    expect(wayFromOsm({ highway: 'residential' })?.kind).toBe('street');
    expect(wayFromOsm({ highway: 'living_street' })?.kind).toBe('street');
    expect(wayFromOsm({ highway: 'tertiary_link' })?.kind).toBe('street');
    expect(wayFromOsm({ highway: 'cycleway' })?.kind).toBe('cycle');
    expect(wayFromOsm({ highway: 'pedestrian' })?.kind).toBe('pedestrian');
  });

  test('paths of their own carry people, not sidewalks and crossings on the road', () => {
    expect(wayFromOsm({ highway: 'footway' })?.kind).toBe('path');
    expect(wayFromOsm({ highway: 'path', access: 'private' })?.kind).toBe('path');
    expect(wayFromOsm({ highway: 'steps' })?.kind).toBe('path');
    expect(wayFromOsm({ highway: 'footway', footway: 'sidewalk' })).toBeNull();
    expect(wayFromOsm({ highway: 'footway', footway: 'crossing' })).toBeNull();
  });

  test('service roads, tunnels and closed streets carry no traffic', () => {
    expect(wayFromOsm({ highway: 'service' })).toBeNull();
    expect(wayFromOsm({ highway: 'corridor' })).toBeNull();
    expect(wayFromOsm({ highway: 'primary', tunnel: 'yes' })).toBeNull();
    expect(wayFromOsm({ highway: 'residential', layer: '-1' })).toBeNull();
    expect(wayFromOsm({ highway: 'residential', motor_vehicle: 'no' })).toBeNull();
    expect(wayFromOsm({ highway: 'residential', access: 'private' })).toBeNull();
    expect(wayFromOsm({ highway: 'pedestrian', area: 'yes' })).toBeNull();
    // A cycle track closed to cars is still a cycle track.
    expect(wayFromOsm({ highway: 'cycleway', motor_vehicle: 'no' })?.kind).toBe('cycle');
  });

  test('a road for permits, deliveries, farm traffic or an F99 sign carries no cars', () => {
    expect(wayFromOsm({ highway: 'residential', motor_vehicle: 'permit' })).toBeNull();
    expect(wayFromOsm({ highway: 'unclassified', access: 'agricultural' })).toBeNull();
    expect(wayFromOsm({ highway: 'residential', vehicle: 'delivery' })).toBeNull();
    expect(wayFromOsm({ highway: 'residential', motorcar: 'no' })).toBeNull();
    expect(wayFromOsm({ highway: 'unclassified', traffic_sign: 'BE:F99c' })).toBeNull();
    // The most specific tag wins: a road open to cars though closed to vehicles at large.
    expect(wayFromOsm({ highway: 'residential', vehicle: 'no', motorcar: 'yes' })?.kind).toBe(
      'street',
    );
    expect(carAccess({ access: 'no', motor_vehicle: 'destination' })).toBe('destination');
    // Destination-only and living streets stay, marked.
    expect(wayFromOsm({ highway: 'residential', motor_vehicle: 'destination' })).toMatchObject({
      through: false,
      minor: false,
    });
    expect(wayFromOsm({ highway: 'living_street' })).toMatchObject({ through: true, minor: true });
    expect(wayFromOsm({ highway: 'cycleway', motor_vehicle: 'agricultural' })?.kind).toBe('cycle');
  });

  test('one-way streets, turned round when OSM runs them backwards, and cycle streets', () => {
    expect(wayFromOsm({ highway: 'residential' })).toMatchObject({
      oneway: false,
      reverse: false,
      bikesBoth: false,
    });
    expect(wayFromOsm({ highway: 'residential', oneway: 'yes' })).toMatchObject({
      oneway: true,
      reverse: false,
    });
    expect(wayFromOsm({ highway: 'residential', oneway: '-1' })).toMatchObject({
      oneway: true,
      reverse: true,
    });
    expect(
      wayFromOsm({ highway: 'residential', oneway: 'yes', 'oneway:bicycle': 'no' })?.bikesBoth,
    ).toBe(true);
    expect(wayFromOsm({ highway: 'residential', 'oneway:bicycle': 'no' })?.bikesBoth).toBe(false);
    // A roundabout is one way round unless it says otherwise.
    expect(wayFromOsm({ highway: 'tertiary', junction: 'roundabout' })?.oneway).toBe(true);
    expect(wayFromOsm({ highway: 'tertiary', junction: 'circular', oneway: 'no' })?.oneway).toBe(
      false,
    );
  });
});

describe('sidewalks', () => {
  test('OSM says which sides have a pavement, right and left of the way as stored', () => {
    expect(sidewalksOf({ sidewalk: 'both' }, false)).toEqual({ right: true, left: true });
    expect(sidewalksOf({ sidewalk: 'separate' }, false)).toEqual({ right: true, left: true });
    expect(sidewalksOf({ sidewalk: 'no' }, false)).toEqual({ right: false, left: false });
    expect(sidewalksOf({ sidewalk: 'right' }, false)).toEqual({ right: true, left: false });
    expect(sidewalksOf({ sidewalk: 'left' }, true)).toEqual({ right: true, left: false });
    expect(sidewalksOf({ 'sidewalk:left': 'yes' }, false)).toEqual({
      right: undefined,
      left: true,
    });
    expect(sidewalksOf({ 'sidewalk:both': 'no', 'sidewalk:right': 'separate' }, false)).toEqual({
      right: true,
      left: false,
    });
    expect(sidewalksOf({}, false)).toEqual({ right: undefined, left: undefined });
    expect(wayFromOsm({ highway: 'residential', sidewalk: 'both' })?.sidewalks).toEqual({
      right: true,
      left: true,
    });
  });

  test('where the GRB cut no kerb, a tagged pavement is a pavement and a tagged lack is none', () => {
    const measured: [Side, Side] = [
      { kerb: 0, edge: 5 },
      { kerb: 3, edge: 5 },
    ];
    // A pavement's width in from the facade on the right; the left was measured and stays.
    expect(sidesWithTags(measured, { right: true, left: true })).toEqual([
      { kerb: 3.2, edge: 5 },
      { kerb: 3, edge: 5 },
    ]);
    // No pavement: the kerb at the facade.
    expect(sidesWithTags(measured, { right: false, left: undefined })[0]).toEqual({
      kerb: 5,
      edge: 5,
    });
    // OSM silent: as measured.
    expect(sidesWithTags(measured, { right: undefined, left: undefined })).toEqual(measured);
    // Where OSM says nothing either, a built-up street is taken to have pavements where there
    // is room for them; a living street, or a lane too narrow, is not.
    const silent = { right: undefined, left: undefined };
    expect(
      sidesWithTags(
        [
          { kerb: 0, edge: 5 },
          { kerb: 0, edge: 2 },
        ],
        silent,
        true,
      ),
    ).toEqual([
      { kerb: 3.2, edge: 5 },
      { kerb: 0, edge: 2 },
    ]);
    expect(
      sidesWithTags(
        [
          { kerb: 0, edge: 5 },
          { kerb: 0, edge: 5 },
        ],
        silent,
        false,
      )[0]!.kerb,
    ).toBe(0);
    // A narrow street keeps most of its width for the carriageway.
    expect(
      sidesWithTags(
        [
          { kerb: 0, edge: 2 },
          { kerb: 0, edge: 2 },
        ],
        { right: true, left: true },
      )[0],
    ).toEqual({ kerb: 0.8, edge: 2 });
    expect(TAGGED_PAVEMENT).toBeGreaterThan(PAVEMENT);
  });
});

describe('splitAtJunctions', () => {
  test('cuts a line where another ends on it, and keeps the rest whole', () => {
    const through = { name: 'a', line: [0, 0, 10, 0, 20, 0, 30, 0] };
    const side = { name: 'b', line: [20, 10, 20, 0] };
    const pieces = splitAtJunctions([through, side]);
    expect(pieces.map((p) => p.line)).toEqual([
      [0, 0, 10, 0, 20, 0],
      [20, 0, 30, 0],
      [20, 10, 20, 0],
    ]);
    expect(pieces.map((p) => p.name)).toEqual(['a', 'a', 'b']);
  });

  test('two lines crossing at a shared node both split there; a loop splits where it meets itself', () => {
    const ew = { line: [0, 5, 5, 5, 10, 5] };
    const ns = { line: [5, 0, 5, 5, 5, 10] };
    expect(splitAtJunctions([ew, ns])).toHaveLength(4);
    const loop = { line: [0, 0, 10, 0, 10, 10, 0, 10, 0, 0, -10, 0] };
    expect(splitAtJunctions([loop]).map((p) => p.line.length / 2)).toEqual([5, 2]);
  });

  test('points that merely lie near each other are not junctions', () => {
    const a = { line: [0, 0, 10, 0] };
    const b = { line: [5, 0.01, 5, 10] };
    expect(splitAtJunctions([a, b])).toHaveLength(2);
  });
});

/**
 * An eastward street at z = 0: the carriageway 3 m either side, the facades 6 m to the south
 * (right) and 4.5 m to the north, but for a house at the west end 2 m from the line.
 */
const open = (x: number, z: number) => (x < 20 ? z > -2 : z > -4.5) && z < 6;
const carriageway = (_x: number, z: number) => Math.abs(z) < 3;

const way = (over: Partial<Omit<Way, 'line'>> & { line: number[] }): Way => ({
  kind: 'street',
  oneway: false,
  bikesBoth: false,
  surface: 'asphalt',
  right: { kerb: 2.5, edge: 4 },
  left: { kerb: 2.5, edge: 4 },
  through: true,
  minor: false,
  ...over,
  line: new Float32Array(over.line),
});

/** Who may go along each edge of a graph: cars, bikes, feet. */
const who = (ways: Way[]) => roadGraph(ways).edges.map((e) => [e.cars, e.bikes, e.feet]);

describe('roadGraph', () => {
  test('a street is two edges between two nodes: who may go each way depends on the way', () => {
    const both = roadGraph([way({ line: [0, 0, 100, 0] })]);
    expect(both.nodes).toHaveLength(2);
    expect(both.edges).toHaveLength(2);
    expect(both.edges.map((e) => [e.from, e.to])).toEqual([
      [0, 1],
      [1, 0],
    ]);
    expect(both.nodes[0]!.out).toEqual([0]);
    expect(both.edges.every((e) => e.cars && e.bikes && e.feet && e.length === 100)).toBe(true);
    // The backward edge's right side is the way's left.
    const sided = roadGraph([
      way({ line: [0, 0, 100, 0], right: { kerb: 3, edge: 5 }, left: { kerb: 2, edge: 2.5 } }),
    ]);
    expect(sided.edges.map((e) => [e.right.edge, e.left.edge])).toEqual([
      [5, 2.5],
      [2.5, 5],
    ]);
    // One way: cars and bikes forward only; people walk back along the pavement.
    expect(who([way({ line: [0, 0, 100, 0], oneway: true })])).toEqual([
      [true, true, true],
      [false, false, true],
    ]);
    // A cycle street lets bikes back too.
    expect(who([way({ line: [0, 0, 100, 0], oneway: true, bikesBoth: true })])).toEqual([
      [true, true, true],
      [false, true, true],
    ]);
    expect(who([way({ line: [0, 0, 50, 0], kind: 'cycle' })])).toEqual([
      [false, true, true],
      [false, true, true],
    ]);
    expect(who([way({ line: [0, 0, 50, 0], kind: 'pedestrian' })])).toEqual([
      [false, true, true],
      [false, true, true],
    ]);
    expect(who([way({ line: [0, 0, 50, 0], kind: 'path' })])).toEqual([
      [false, false, true],
      [false, false, true],
    ]);
  });

  test('nobody walks a main road without a pavement on either side', () => {
    const main = (right: Way['right'], left: Way['left']) =>
      who([way({ line: [0, 0, 50, 0], kind: 'main', right, left })]).map((w) => w[2]);
    // Kerb to facade on one side is enough; a kerb at the facade on both is not.
    expect(main({ kerb: 7, edge: 7.2 }, { kerb: 7, edge: 7 })).toEqual([false, false]);
    expect(main({ kerb: 7, edge: 7 }, { kerb: 7, edge: 9 })).toEqual([true, true]);
    // Without a kerb the ground is shared, and a street is always walked.
    expect(main({ kerb: 0, edge: 7 }, { kerb: 0, edge: 7 })).toEqual([true, true]);
    expect(
      who([
        way({ line: [0, 0, 50, 0], right: { kerb: 3, edge: 3 }, left: { kerb: 3, edge: 3 } }),
      ])[0]![2],
    ).toBe(true);
    expect(pavementOf({ kerb: 3, edge: 5 })).toBe(2);
    expect(pavementOf({ kerb: 0, edge: 5 })).toBe(0);
    expect(pavementOf({ kerb: 4, edge: 3 })).toBe(0);
    expect(PAVEMENT).toBeLessThan(1.5);
  });

  test('routes the shortest way for a class, or none where it may not go', () => {
    // A square block with a path cutting the corner: cars round it, people across.
    const g = roadGraph([
      way({ line: [0, 0, 100, 0] }),
      way({ line: [100, 0, 100, 100] }),
      way({ line: [0, 0, 0, 100], oneway: true }),
      way({ line: [0, 100, 100, 100] }),
      way({ line: [0, 0, 100, 100], kind: 'path' }),
    ]);
    const router = roadRouter(g);
    const at = (x: number, z: number) => g.nodes.findIndex((n) => n.x === x && n.z === z);
    const cars = router.route(at(0, 0), at(100, 100), (e) => g.edges[e]!.cars)!;
    expect(cars.map((e) => g.edges[e]!.to)).toEqual([at(100, 0), at(100, 100)]);
    const feet = router.route(at(0, 0), at(100, 100), (e) => g.edges[e]!.feet)!;
    expect(feet).toHaveLength(1);
    expect(g.edges[feet[0]!]!.kind).toBe('path');
    // Back down the one-way street is no route for a car, and a route for anyone on foot.
    expect(router.route(at(0, 100), at(0, 0), (e) => g.edges[e]!.cars)!.length).toBe(3);
    expect(router.route(at(0, 100), at(0, 0), (e) => g.edges[e]!.feet)).toHaveLength(1);
    expect(router.route(at(0, 0), at(0, 0), () => true)).toEqual([]);
    expect(router.route(at(0, 0), at(100, 100), () => false)).toBeNull();
    expect(router.route(at(0, 0), at(100, 100), (e) => g.edges[e]!.cars, 150)).toBeNull();
  });

  test('pieces meet at their ends, to the decimetre, and a stub too short to drive is dropped', () => {
    const g = roadGraph([
      way({ line: [0, 0, 100, 0] }),
      way({ line: [100.04, 0.02, 100, 80] }),
      way({ line: [100, 80, 100, 80.2] }),
    ]);
    expect(g.nodes).toHaveLength(3);
    expect(g.edges).toHaveLength(4);
    // From the corner, on down the second street or back along the first.
    expect(g.nodes[1]!.out).toHaveLength(2);
  });

  test('the core of the network: what stays connected when any one road goes, less small appendages', () => {
    // A block of four streets with a lane off it to a yard (short) and a district behind one
    // bridge road (long enough to count).
    const g = roadGraph([
      way({ line: [0, 0, 100, 0] }),
      way({ line: [100, 0, 100, 50] }),
      way({ line: [100, 50, 100, 100] }),
      way({ line: [100, 100, 0, 100] }),
      way({ line: [0, 100, 0, 50] }),
      way({ line: [0, 50, 0, 0] }),
      way({ line: [100, 50, 140, 50] }),
      way({ line: [140, 50, 140, 70] }),
      way({ line: [0, 50, -300, 50] }),
      way({ line: [-300, 50, -300, 1050] }),
      way({ line: [-300, 1050, -1300, 1050] }),
      way({ line: [-1300, 1050, -1300, 50] }),
      way({ line: [-1300, 50, -300, 50] }),
    ]);
    const core = coreEdges(g, (i) => g.edges[i]!.cars, 300);
    const at = (x: number, z: number) => g.nodes.findIndex((n) => n.x === x && n.z === z);
    const edge = (fx: number, fz: number, tx: number, tz: number) =>
      g.edges.findIndex((e) => e.from === at(fx, fz) && e.to === at(tx, tz));
    // The block is the main body; the yard's lane hangs off a bridge and is tiny.
    expect(core[edge(0, 0, 100, 0)]).toBe(1);
    expect(core[edge(100, 50, 140, 50)]).toBe(0);
    expect(core[edge(140, 50, 140, 70)]).toBe(0);
    // The road to the district is a bridge; the district beyond holds 4 km, so it counts, and
    // being the largest piece it is the main body: asked for 10 km, the block drops out, not it.
    expect(core[edge(0, 50, -300, 50)]).toBe(0);
    expect(core[edge(-300, 50, -300, 1050)]).toBe(1);
    const strict = coreEdges(g, (i) => g.edges[i]!.cars, 10_000);
    expect(strict[edge(-300, 50, -300, 1050)]).toBe(1);
    expect(strict[edge(0, 0, 100, 0)]).toBe(0);
    expect(coreEdges(g, () => false, 0).every((c) => c === 0)).toBe(true);
  });

  test('sidesOf measures the kerb and the facade either side, the narrowest of three probes', () => {
    const [right, left] = sidesOf([0, 0, 100, 0], open, carriageway);
    expect(right).toEqual({ kerb: 2.5, edge: 5.5 });
    // The kerb is never past the facade.
    expect(left).toEqual({ kerb: 1.5, edge: 1.5 });
    // A centre line a little off its carriageway still finds it; a line on none has no kerb.
    expect(sidesOf([0, 0, 100, 0], open, (_x, z) => z > 0.6 && z < 3)[0]!.kerb).toBe(2.5);
    expect(sidesOf([0, 0, 100, 0], open, (_x, z) => z > 1.6 && z < 3)[0]!.kerb).toBe(0);
    expect(sidesOf([0, 0, 100, 0], open, () => false)[0]!.kerb).toBe(0);
    // Open ground all the way out stops at the probe.
    expect(
      sidesOf(
        [0, 0, 100, 0],
        () => true,
        () => true,
        12,
      )[1],
    ).toEqual({ kerb: 12, edge: 12 });
    // Run westward, the sides swap.
    expect(sidesOf([100, 0, 0, 0], open, carriageway)[0]).toEqual({ kerb: 1.5, edge: 1.5 });
  });

  test('alongEdge walks the polyline and heads along it; turnBetween measures the corner', () => {
    const g = roadGraph([way({ line: [0, 0, 30, 0, 30, 40] }), way({ line: [30, 40, 60, 40] })]);
    const [e] = g.edges;
    expect(e!.length).toBe(70);
    expect(alongEdge(e!, 10)).toEqual([10, 0, 1, 0]);
    const [x, z, dx, dz] = alongEdge(e!, 50);
    expect([x, z]).toEqual([30, 20]);
    expect([dx, dz]).toEqual([0, 1]);
    expect(alongEdge(e!, 999).slice(0, 2)).toEqual([30, 40]);
    expect(alongEdge(e!, -5).slice(0, 2)).toEqual([0, 0]);
    const on = g.edges.find((f) => f.from === e!.to && f.to !== e!.from)!;
    expect(turnBetween(e!, on)).toBeCloseTo(Math.PI / 2);
    const back = g.edges.find((f) => f.from === e!.to && f.to === e!.from)!;
    expect(turnBetween(e!, back)).toBeCloseTo(Math.PI);
  });
});
