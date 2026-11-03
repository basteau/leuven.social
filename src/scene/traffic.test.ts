import { describe, expect, test } from 'bun:test';

import type { Way } from '../data/city.ts';
import { alongEdge, roadGraph, roadRouter, splitAtJunctions } from '../data/traffic.ts';
import type { RoadEdge } from '../data/traffic.ts';
import {
  CLASS,
  COUNTS,
  DENSITY,
  FLOOR,
  LENGTH,
  PATIENCE,
  ROUTE_COST,
  Traffic,
  VEHICLE_KINDS,
  laneFor,
  motor,
  mulberry32,
  sharesLane,
  turnTowards,
} from './traffic.ts';
import type { Vehicle, VehicleKind } from './traffic.ts';

const way = (line: number[], over: Partial<Omit<Way, 'line'>> = {}): Way => ({
  kind: 'street',
  oneway: false,
  bikesBoth: false,
  surface: 'asphalt',
  right: { kerb: 0, edge: 4 },
  left: { kerb: 0, edge: 4 },
  ...over,
  line: new Float32Array(line),
});
const raw = (line: number[], over: Partial<Omit<Way, 'line'>> = {}) => ({ line, ...over });
const build = (ways: ReturnType<typeof raw>[]): Way[] =>
  splitAtJunctions(ways).map(({ line, ...rest }) => way(line, rest));

/**
 * A block of streets round a square, a one-way lane and a cycle track, a path across the
 * square and a dead end off the map, split where they meet as the bake splits them.
 */
const rawTown = [
  raw([0, 0, 100, 0, 200, 0], { kind: 'main' }),
  raw([200, 0, 200, 100, 200, 200], { kind: 'main' }),
  raw([200, 200, 100, 200, 0, 200]),
  raw([0, 200, 0, 100, 0, 0]),
  raw([100, 0, 100, 200], { oneway: true, bikesBoth: true }),
  raw([0, 100, 200, 100], { kind: 'cycle' }),
  raw([0, 0, 100, 100], { kind: 'path', right: { kerb: 0, edge: 1 }, left: { kerb: 0, edge: 1 } }),
  raw([200, 100, 300, 100]), // off the map: a dead end
];
const town = build(rawTown);

/** Lets the fleet out round a focus wide enough for the whole town, over a couple of seconds. */
const settle = (t: Traffic, steps = 150) => {
  t.focus(150, 150, 2000);
  for (let i = 0; i < steps; i++) t.step(1 / 60);
  return t;
};
const counts = (over: Partial<Record<VehicleKind, number>>) => ({
  car: 0,
  bus: 0,
  bike: 0,
  person: 0,
  ...over,
});
/** An edge of a way with these sides. */
const sided = (right: Way['right'], left: Way['left'], kind: Way['kind'] = 'street') =>
  roadGraph([way([0, 0, 50, 0], { right, left, kind })]).edges[0]!;
/** An edge of a street this wide, without kerbs, for the lanes. */
const edgeOf = (edge: number, kind: Way['kind'] = 'street') =>
  roadGraph([way([0, 0, 50, 0], { right: { kerb: 0, edge }, left: { kerb: 0, edge }, kind })])
    .edges[0]!;

/** Puts a vehicle on an edge, this far from its end, rolling, bound for `next`. */
const put = (
  t: Traffic,
  v: Vehicle,
  edge: number,
  next: number,
  fromEnd: number,
  speed: number,
): void => {
  const e = t.graph.edges[edge]!;
  Object.assign(v, {
    active: true,
    edge,
    s: e.length - fromEnd,
    speed,
    cruise: speed,
    prev: -1,
    next,
    turn: next >= 0 ? Math.PI / 2 : 0,
    rIn: 0,
    rOut: next >= 0 ? 4 : 0,
    lane: 0,
    laneNext: 0,
    jitter: 0,
    goal: -1,
  });
  v.route.length = 0;
};

describe('Traffic', () => {
  test('lets its fleet out on edges each kind may use, clear of each other, heading somewhere', () => {
    const t = settle(new Traffic(town, 7, counts({ car: 20, bus: 2, bike: 20, person: 20 })));
    expect(t.vehicles).toHaveLength(62);
    expect(t.vehicles.every((v) => v.active)).toBe(true);
    for (const v of t.vehicles) {
      const e = t.graph.edges[v.edge]!;
      expect([e.cars, e.bikes, e.feet][CLASS[v.kind]]).toBe(true);
      expect(v.s).toBeGreaterThanOrEqual(0);
      expect(v.s).toBeLessThanOrEqual(e.length);
      expect(v.next).toBeGreaterThanOrEqual(0);
      expect(v.cruise).toBeGreaterThan(0);
    }
    // Nobody but people takes the path across the square.
    const path = t.graph.edges.findIndex((e) => e.kind === 'path');
    expect(t.vehicles.some((v) => v.kind !== 'person' && v.edge === path)).toBe(false);
    expect(COUNTS.car + COUNTS.bus + COUNTS.bike + COUNTS.person).toBeLessThan(900);
    expect(DENSITY.bike).toBeGreaterThan(DENSITY.car);
  });

  test('follows a route to a destination, then picks another', () => {
    const t = settle(new Traffic(town, 3, counts({ car: 6, person: 6 })), 300);
    // Routed vehicles carry the edges to come, each starting where the last ends.
    const routed = t.vehicles.filter((v) => v.goal >= 0);
    expect(routed.length).toBeGreaterThan(0);
    for (const v of routed) {
      let at = t.graph.edges[v.edge]!.to;
      if (v.next >= 0) {
        expect(t.graph.edges[v.next]!.from).toBe(at);
        at = t.graph.edges[v.next]!.to;
      }
      for (const e of v.route.toReversed()) {
        expect(t.graph.edges[e]!.from).toBe(at);
        at = t.graph.edges[e]!.to;
      }
      expect(at).toBe(v.goal);
    }
    const goals = routed.map((v) => v.goal);
    for (let i = 0; i < 60 * 120; i++) t.step(1 / 60);
    // Two minutes on, some have arrived and set off for somewhere else.
    expect(routed.some((v, i) => v.goal >= 0 && v.goal !== goals[i])).toBe(true);
  });

  test('moves on, keeps its distance, slows for corners and never runs backwards', () => {
    const t = settle(new Traffic(town, 3, counts({ car: 30, bus: 3, bike: 30, person: 30 })));
    const before = t.vehicles.map((v) => [v.edge, v.s] as const);
    for (let i = 0; i < 60 * 30; i++) {
      t.step(1 / 60);
      for (const v of t.vehicles) {
        expect(v.speed).toBeGreaterThanOrEqual(0);
        expect(v.speed).toBeLessThanOrEqual(v.cruise * 1.001);
      }
    }
    let moved = 0;
    for (const [i, v] of t.vehicles.entries()) {
      const [edge, s] = before[i]!;
      if (v.edge !== edge || v.s !== s) moved++;
    }
    expect(moved).toBe(t.vehicles.length);
    // Nobody is inside the one ahead on the same edge and in the same lane class.
    for (const a of t.vehicles) {
      for (const b of t.vehicles) {
        if (a === b || a.edge !== b.edge || CLASS[a.kind] !== CLASS[b.kind]) continue;
        if (b.s <= a.s) continue;
        expect(b.s - a.s).toBeGreaterThan((LENGTH[a.kind] + LENGTH[b.kind]) / 2 - 0.5);
      }
    }
  });

  test('never turns back at the junction ahead, and is not sent into a cul-de-sac', () => {
    // A stub off the south street that ends in nothing: a cul-de-sac.
    const withStub = build([...rawTown, raw([100, 200, 100, 260])]);
    const t = settle(new Traffic(withStub, 5, counts({ car: 24, bike: 24, person: 24 })), 300);
    const { edges, nodes } = t.graph;
    const twin = (i: number) =>
      edges.findIndex((e) => e.from === edges[i]!.to && e.to === edges[i]!.from);
    const stub = edges.findIndex((e) => nodes[e.to]!.z === 260 || nodes[e.from]!.z === 260);
    for (let i = 0; i < 60 * 60; i++) {
      t.step(1 / 60);
      for (const v of t.vehicles) {
        if (!v.active || v.next < 0) continue;
        expect(v.next).not.toBe(twin(v.edge));
        expect(v.edge).not.toBe(stub);
      }
    }
  });

  test('one at a time through a junction: a second car from another street waits', () => {
    // Two cars meeting where the one-way lane leaves the main road, one from the west and one
    // from the east, both turning south into it: a junction, three of the cars' ways meeting.
    const t = new Traffic(town, 1, counts({ car: 2 }));
    t.focus(100, 100, 2000);
    const { edges, nodes } = t.graph;
    const corner = nodes.findIndex((n) => n.x === 100 && n.z === 0);
    const into = (fx: number, fz: number) =>
      edges.findIndex(
        (e) => e.cars && e.to === corner && nodes[e.from]!.x === fx && nodes[e.from]!.z === fz,
      );
    const fromWest = into(0, 0);
    const fromEast = into(200, 0);
    const onSouth = edges.findIndex((e) => e.cars && e.from === corner && nodes[e.to]!.z === 200);
    expect([fromWest, fromEast, onSouth].every((e) => e >= 0)).toBe(true);
    const [a, b] = t.vehicles as [Vehicle, Vehicle];
    // Both rolling at 8 m/s, each turning into the lane: the first to the box holds it, the
    // other brakes short of it and stands till it has crossed.
    put(t, a, fromWest, onSouth, 17, 8);
    put(t, b, fromEast, onSouth, 14, 8);
    // Both bound for the lane's end, so neither is routed straight on instead.
    for (const v of [a, b]) {
      v.goal = edges[onSouth]!.to;
      v.route = [onSouth];
    }
    let bWaited = false;
    const inBox = (v: Vehicle, from: number) => v.edge === from && v.s > edges[from]!.length - 4;
    for (let i = 0; i < 60 * 10; i++) {
      t.step(1 / 60);
      if (b.edge === fromEast && b.speed < 0.3) bWaited = true;
      expect(inBox(a, fromWest) && inBox(b, fromEast)).toBe(false);
    }
    expect(bWaited).toBe(true);
    // Both got through in the end.
    expect(a.edge).not.toBe(fromWest);
    expect(b.edge).not.toBe(fromEast);
  });

  test('a bend, or a path joining the street, is no junction for a car: it drives on', () => {
    // The square's north-east corner is a bend for cars: two of their ways meet, nothing crosses.
    const t = new Traffic(town, 1, counts({ car: 1 }));
    t.focus(100, 100, 2000);
    const { edges, nodes } = t.graph;
    const corner = nodes.findIndex((n) => n.x === 200 && n.z === 0);
    const inEdge = edges.findIndex((e) => e.cars && e.to === corner && nodes[e.from]!.x === 100);
    const outEdge = edges.findIndex((e) => e.cars && e.from === corner && nodes[e.to]!.z === 100);
    const v = t.vehicles[0]!;
    put(t, v, inEdge, outEdge, 15, 6);
    for (let i = 0; i < 60 * 5 && v.edge === inEdge; i++) {
      t.step(1 / 60);
      expect(v.hold).toBe(-1);
      expect(v.speed).toBeGreaterThan(2);
    }
    expect(v.edge).toBe(outEdge);
  });

  test('a car that waited its patience out at a junction crosses anyway', () => {
    const t = new Traffic(town, 1, counts({ car: 2 }));
    t.focus(100, 100, 2000);
    const { edges, nodes } = t.graph;
    const corner = nodes.findIndex((n) => n.x === 100 && n.z === 0);
    const fromWest = edges.findIndex((e) => e.cars && e.to === corner && nodes[e.from]!.x === 0);
    const fromEast = edges.findIndex((e) => e.cars && e.to === corner && nodes[e.from]!.x === 200);
    const onSouth = edges.findIndex((e) => e.cars && e.from === corner && nodes[e.to]!.z === 200);
    const [a, b] = t.vehicles as [Vehicle, Vehicle];
    // A holds the junction and never moves (a jam beyond it); B waits, then goes.
    put(t, a, fromWest, onSouth, 3, 0);
    put(t, b, fromEast, onSouth, 6, 3);
    t.step(1 / 60);
    Object.assign(a, { cruise: 0, speed: 0 });
    let crossed = -1;
    for (let i = 0; i < 60 * 20 && crossed < 0; i++) {
      t.step(1 / 60);
      if (b.edge !== fromEast) crossed = i / 60;
    }
    expect(crossed).toBeGreaterThan(PATIENCE);
    expect(crossed).toBeLessThan(PATIENCE + 6);
  });

  test('rounds a corner on a curve and swings its heading rather than snapping it', () => {
    const t = new Traffic(town, 1, counts({ car: 1 }));
    t.focus(100, 100, 2000);
    const { edges, nodes } = t.graph;
    const corner = nodes.findIndex((n) => n.x === 200 && n.z === 0);
    const inEdge = edges.findIndex((e) => e.cars && e.to === corner && nodes[e.from]!.x === 100);
    const outEdge = edges.findIndex((e) => e.cars && e.from === corner && nodes[e.to]!.z === 100);
    const v = t.vehicles[0]!;
    put(t, v, inEdge, outEdge, 0, 6);
    v.rOut = 5;
    // Before the corner it heads east; in it, the heading turns gradually south.
    v.s = edges[inEdge]!.length - 5;
    const [, , dx0, dz0] = t.place(v);
    expect([dx0, dz0]).toEqual([1, 0]);
    v.s = edges[inEdge]!.length - 2.5;
    const [x, z, dx, dz] = t.place(v);
    expect(dx).toBeGreaterThan(0.3);
    expect(dz).toBeGreaterThan(0.3);
    // The curve cuts inside the corner: south of the first street, west of the second.
    expect(z).toBeGreaterThan(0);
    expect(x).toBeLessThan(200);
    // Over the node onto the next edge, the curve carries on into its first metres.
    for (let i = 0; i < 60 * 2 && v.edge === inEdge; i++) t.step(1 / 60);
    expect(v.edge).toBe(outEdge);
    expect(v.rIn).toBe(5);
    const [x2, z2, dx2, dz2] = t.place(v);
    expect(x2).toBeLessThan(200.01);
    expect(z2).toBeGreaterThan(0);
    expect(Math.hypot(dx2, dz2)).toBeCloseTo(1);
    // And the drawn heading follows at a rate, not at once.
    expect(turnTowards(0, Math.PI / 2, 2, 0.1)).toBeCloseTo(0.2);
    expect(turnTowards(0, Math.PI / 2, 2, 10)).toBeCloseTo(Math.PI / 2);
    expect(turnTowards(0.1, -0.1 + Math.PI * 2, 2, 1)).toBeCloseTo(-0.1);
  });

  test('signals a turn ahead and lights its brakes when it slows', () => {
    const t = new Traffic(town, 1, counts({ car: 1 }));
    t.focus(100, 100, 2000);
    const { edges, nodes } = t.graph;
    const corner = nodes.findIndex((n) => n.x === 200 && n.z === 0);
    const inEdge = edges.findIndex((e) => e.cars && e.to === corner && nodes[e.from]!.x === 100);
    const outEdge = edges.findIndex((e) => e.cars && e.from === corner && nodes[e.to]!.z === 100);
    const v = t.vehicles[0]!;
    put(t, v, inEdge, outEdge, 10, 12);
    t.step(1 / 60);
    // Heading east and turning south, in a city where z runs south, is a right turn.
    expect(v.signal).toBe(1);
    // Braking for the corner from 12 m/s ten metres out lights the brakes.
    expect(v.brake).toBe(1);
  });

  test('a car whose street ends in a cycle track has nowhere to go, and comes back elsewhere', () => {
    const stubs = build([
      ...rawTown,
      raw([300, 100, 350, 100], { oneway: true }),
      raw([350, 100, 400, 100], { kind: 'cycle' }),
    ]);
    const t = settle(new Traffic(stubs, 5, counts({ car: 2 })));
    const stub = t.graph.edges.findIndex((e) => e.cars && t.graph.nodes[e.to]!.x === 350);
    const v = t.vehicles[0]!;
    put(t, v, stub, -1, 49, 5);
    for (let i = 0; i < 60 * 20 && v.edge === stub; i++) t.step(1 / 30);
    expect(v.edge).not.toBe(stub);
  });

  test('places each vehicle in its lane, right of the line, and people on the pavement', () => {
    // A block of four streets, so every edge leads somewhere.
    const block = build([
      raw([0, 0, 100, 0]),
      raw([100, 0, 100, 100]),
      raw([100, 100, 0, 100]),
      raw([0, 100, 0, 0]),
    ]);
    const t = settle(new Traffic(block, 1, counts({ car: 1, person: 1 })));
    const [car, person] = t.vehicles as [Vehicle, Vehicle];
    for (const v of [car, person]) {
      expect(v.active).toBe(true);
      // Mid-edge, clear of the corners' curves.
      const e = t.graph.edges[v.edge]!;
      v.s = e.length / 2;
      v.rIn = 0;
      const [x, z, dx, dz] = t.place(v);
      const [lx, lz, ldx, ldz] = alongEdge(e, v.s);
      // Right-hand traffic: right of the heading in (x east, z south) is (-dz, dx).
      expect(x).toBeCloseTo(lx - ldz * v.lane);
      expect(z).toBeCloseTo(lz + ldx * v.lane);
      expect([dx, dz]).toEqual([ldx, ldz]);
      expect(v.lane).toBeGreaterThan(0);
    }
    expect(person.lane).toBeGreaterThan(car.lane);
  });

  test('without a kerb the ground is shared: narrow streets put everyone nearer the line', () => {
    expect(laneFor('car', edgeOf(5), true, 0)).toBe(1.7);
    expect(laneFor('car', edgeOf(2), true, 0)).toBeCloseTo(0.9);
    expect(laneFor('car', edgeOf(5), false, 0)).toBe(0.3);
    expect(laneFor('bus', edgeOf(0), true, 0)).toBe(0.3);
    expect(laneFor('bike', edgeOf(5), true, 0)).toBeGreaterThan(laneFor('car', edgeOf(5), true, 0));
    expect(laneFor('bike', edgeOf(2), true, 0)).toBeLessThan(laneFor('bike', edgeOf(5), true, 0));
    expect(laneFor('bike', edgeOf(3, 'cycle'), false, 0)).toBe(0);
    expect(laneFor('person', edgeOf(5), true, 0)).toBe(4);
    expect(laneFor('person', edgeOf(2), true, 0)).toBe(1);
    expect(laneFor('person', edgeOf(1, 'path'), true, 1)).toBe(0.4);
    expect(Math.abs(laneFor('person', edgeOf(4, 'pedestrian'), true, -1))).toBe(2);
  });

  test('with a kerb, cars keep to the carriageway, bikes by the kerb and people on the pavement', () => {
    // A street 3.5 m to the kerb on the right and a 2 m pavement beyond it, 3 m and 1.2 m on the left.
    const street = sided({ kerb: 3.5, edge: 5.5 }, { kerb: 3, edge: 4.2 });
    expect(laneFor('car', street, true, 0)).toBe(1.75);
    expect(laneFor('car', street, false, 0)).toBeCloseTo(0.4);
    expect(laneFor('bus', sided({ kerb: 2, edge: 3 }, { kerb: 2, edge: 3 }), true, 0)).toBe(1);
    expect(laneFor('bike', street, true, 0)).toBeCloseTo(2.8);
    expect(laneFor('bike', street, true, 1)).toBeCloseTo(3);
    // People spread across the pavement, 0.45 m off the kerb and off the facade.
    expect(laneFor('person', street, true, -1)).toBeCloseTo(3.95);
    expect(laneFor('person', street, true, 1)).toBeCloseTo(5.05);
    // No pavement on the right (a kerb at the facade): the left one, as a negative lane.
    const leftOnly = sided({ kerb: 4, edge: 4 }, { kerb: 3, edge: 5 });
    expect(laneFor('person', leftOnly, true, 0)).toBeCloseTo(-4);
    // None on either side: by the facade, never through it.
    const none = sided({ kerb: 2.5, edge: 2.5 }, { kerb: 2.5, edge: 2.8 });
    expect(laneFor('person', none, true, 0)).toBe(1.5);
    expect(laneFor('person', sided({ kerb: 1, edge: 1 }, { kerb: 1, edge: 1 }), true, -1)).toBe(
      0.3,
    );
    // A cycle track's kerb is its own edge: bikes keep to its right half, people walk beside it.
    const track = sided({ kerb: 1.5, edge: 3 }, { kerb: 1.5, edge: 1.5 }, 'cycle');
    expect(laneFor('bike', track, true, 0)).toBeCloseTo(0.45);
    expect(laneFor('person', track, true, 0)).toBeCloseTo(2.25);
    // A pedestrian street: people across it, bikes threading the middle.
    const walk = sided({ kerb: 4, edge: 4 }, { kerb: 4, edge: 4 }, 'pedestrian');
    expect(laneFor('bike', walk, true, 0)).toBeCloseTo(1.2);
    expect(laneFor('person', walk, true, 1)).toBe(2);
  });

  test('on a narrow street a car queues behind a cyclist; on a wide one it passes', () => {
    expect(sharesLane(sided({ kerb: 2.5, edge: 4 }, { kerb: 2.5, edge: 4 }), true, true)).toBe(
      true,
    );
    expect(sharesLane(sided({ kerb: 5, edge: 7 }, { kerb: 5, edge: 7 }), true, true)).toBe(false);
    expect(
      sharesLane(sided({ kerb: 2.5, edge: 4 }, { kerb: 2.5, edge: 4 }, 'cycle'), true, true),
    ).toBe(false);
    // A car 20 m behind a cyclist on a narrow two-way street: it closes up and settles at the
    // bike's pace, never through it.
    const narrow = build([
      raw([0, 0, 200, 0], { right: { kerb: 2.5, edge: 4 }, left: { kerb: 2.5, edge: 4 } }),
      raw([200, 0, 200, 200], { right: { kerb: 2.5, edge: 4 }, left: { kerb: 2.5, edge: 4 } }),
      raw([200, 200, 0, 200], { right: { kerb: 2.5, edge: 4 }, left: { kerb: 2.5, edge: 4 } }),
      raw([0, 200, 0, 0], { right: { kerb: 2.5, edge: 4 }, left: { kerb: 2.5, edge: 4 } }),
    ]);
    const t = new Traffic(narrow, 1, counts({ car: 1, bike: 1 }));
    t.focus(100, 100, 2000);
    const { edges } = t.graph;
    const east = edges.findIndex((e) => e.cars && t.graph.nodes[e.to]!.x === 200 && e.from === 0);
    const [car, bike] = t.vehicles as [Vehicle, Vehicle];
    put(t, car, east, -1, 180, 8);
    put(t, bike, east, -1, 160, 4);
    car.next = bike.next = -1;
    for (let i = 0; i < 60 * 12; i++) {
      t.step(1 / 60);
      if (car.edge === east && bike.edge === east) expect(car.s).toBeLessThan(bike.s);
    }
    expect(car.speed).toBeLessThan(5);
  });

  test('routes each class by its own costs: bikes take the cycle track, people the quiet way', () => {
    // West to east: a main road straight along the top, or a cycle track a little longer below.
    const main = { kind: 'main', right: { kerb: 7, edge: 9 }, left: { kerb: 7, edge: 9 } } as const;
    const two = build([
      raw([0, 0, 200, 0], main),
      raw([0, 0, 0, 20]),
      raw([0, 20, 200, 20], { kind: 'cycle' }),
      raw([200, 20, 200, 0]),
      raw([200, 0, 300, 0], main),
    ]);
    const { edges, nodes } = roadGraph(two);
    const at = (x: number, z: number) => nodes.findIndex((n) => n.x === x && n.z === z);
    const kinds = (cls: 0 | 1 | 2) => {
      const allowed = [(e: RoadEdge) => e.cars, (e: RoadEdge) => e.bikes, (e: RoadEdge) => e.feet];
      const router = roadRouter({ nodes, edges }, (i) => ROUTE_COST[cls][edges[i]!.kind]);
      return router
        .route(at(0, 0), at(200, 0), (i) => allowed[cls]!(edges[i]!))!
        .map((i) => edges[i]!.kind);
    };
    expect(kinds(0)).toEqual(['main']);
    expect(kinds(1)).toEqual(['street', 'cycle', 'street']);
    expect(kinds(2)).toEqual(['street', 'cycle', 'street']);
    expect(Object.values(ROUTE_COST).every((c) => Object.values(c).every((k) => k >= 1))).toBe(
      true,
    );
  });

  test('keeps the fleet round the focus: out of its view in, parked beyond what it deserves', () => {
    const t = settle(new Traffic(town, 11, counts({ car: 40, bus: 4, bike: 60, person: 60 })));
    // A small circle in the corner: only what its area deserves is out, and all of it inside.
    t.focus(50, 50, 150);
    for (let i = 0; i < 60 * 20; i++) t.step(1 / 60);
    const active = t.vehicles.filter((v) => v.active);
    expect(active.length).toBeLessThan(t.vehicles.length);
    const cars = active.filter((v) => v.kind === 'car').length;
    expect(cars).toBeGreaterThanOrEqual(FLOOR.car);
    expect(cars).toBeLessThan(40);
    for (const v of active) {
      const [x, z] = t.place(v);
      expect(Math.hypot(x - 50, z - 50)).toBeLessThanOrEqual(1.3 * 150 + 15);
    }
    // A jump parks everyone; they come out again over the next second, all over the circle.
    t.focus(2000, 2000, 150);
    expect(t.vehicles.every((v) => !v.active)).toBe(true);
    t.focus(100, 100, 2000);
    for (let i = 0; i < 60 * 10; i++) t.step(1 / 60);
    expect(t.vehicles.filter((v) => v.active).length).toBe(t.vehicles.length);
    // Narrowed in place (no jump) to a corner of the town, the surplus is parked as it drives
    // out of reach: round the block, now that nobody turns back.
    t.focus(50, 50, 60);
    for (let i = 0; i < 60 * 60; i++) t.step(1 / 60);
    const bikes = t.vehicles.filter((v) => v.active && v.kind === 'bike').length;
    expect(bikes).toBeGreaterThanOrEqual(FLOOR.bike);
    expect(bikes).toBeLessThan(60);
  });

  test('is deterministic for a seed, and paints in sRGB', () => {
    const a = settle(new Traffic(town, 9, counts({ car: 5, bus: 1, bike: 5, person: 5 })));
    const b = settle(new Traffic(town, 9, counts({ car: 5, bus: 1, bike: 5, person: 5 })));
    for (let i = 0; i < 100; i++) {
      a.step(1 / 60);
      b.step(1 / 60);
    }
    expect(a.vehicles).toEqual(b.vehicles);
    expect(a.vehicles.every((v) => v.paint.every((c) => c >= 0 && c <= 1))).toBe(true);
    const r = mulberry32(42);
    const first = r();
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(1);
    expect(mulberry32(42)()).toBe(first);
    expect(VEHICLE_KINDS.filter(motor)).toEqual(['car', 'bus']);
  });
});
