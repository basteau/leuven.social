import { describe, expect, test } from 'bun:test';

import type { Way } from '../data/city.ts';
import { roadGraph, splitAtJunctions } from '../data/traffic.ts';
import {
  CLASS,
  COUNTS,
  DENSITY,
  FLOOR,
  LENGTH,
  Traffic,
  VEHICLE_KINDS,
  laneFor,
  motor,
  mulberry32,
  turnTowards,
} from './traffic.ts';
import type { Vehicle, VehicleKind } from './traffic.ts';

const way = (line: number[], over: Partial<Omit<Way, 'line'>> = {}): Way => ({
  kind: 'street',
  oneway: false,
  bikesBoth: false,
  halfWidth: 4,
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
  raw([0, 0, 100, 100], { kind: 'path', halfWidth: 1 }),
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
/** An edge of a street this wide, for the lanes. */
const edgeOf = (halfWidth: number, kind: Way['kind'] = 'street') =>
  roadGraph([way([0, 0, 50, 0], { halfWidth, kind })]).edges[0]!;

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
    const goals = new Set(routed.map((v) => v.goal));
    for (let i = 0; i < 60 * 120; i++) t.step(1 / 60);
    // Two minutes on, some have arrived and set off for somewhere else.
    expect(t.vehicles.some((v) => v.goal >= 0 && !goals.has(v.goal))).toBe(true);
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

  test('one at a time through a junction: a second car from another street waits', () => {
    // Two cars meeting at the square's north-east corner from the west and from the south.
    const t = new Traffic(town, 1, counts({ car: 2 }));
    t.focus(100, 100, 2000);
    const { edges, nodes } = t.graph;
    const corner = nodes.findIndex((n) => n.x === 200 && n.z === 0);
    const into = (fx: number, fz: number) =>
      edges.findIndex(
        (e) => e.cars && e.to === corner && nodes[e.from]!.x === fx && nodes[e.from]!.z === fz,
      );
    const fromWest = into(100, 0);
    const fromSouth = into(200, 100);
    const onSouth = edges.findIndex((e) => e.cars && e.from === corner && nodes[e.to]!.z === 100);
    const onWest = edges.findIndex((e) => e.cars && e.from === corner && nodes[e.to]!.x === 100);
    expect([fromWest, fromSouth, onSouth, onWest].every((e) => e >= 0)).toBe(true);
    const [a, b] = t.vehicles as [Vehicle, Vehicle];
    // Both 20 m out, rolling at 8 m/s, each turning into the other's street: the first to the
    // box holds it, the other brakes short of it.
    put(t, a, fromWest, onSouth, 17, 8);
    put(t, b, fromSouth, onWest, 20, 8);
    let bWaited = false;
    const inBox = (v: Vehicle, from: number) => v.edge === from && v.s > edges[from]!.length - 4;
    for (let i = 0; i < 60 * 10; i++) {
      t.step(1 / 60);
      if (b.edge === fromSouth && b.speed < 0.3) bWaited = true;
      expect(inBox(a, fromWest) && inBox(b, fromSouth)).toBe(false);
    }
    expect(bWaited).toBe(true);
    // Both got through in the end.
    expect(a.edge).not.toBe(fromWest);
    expect(b.edge).not.toBe(fromSouth);
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
    const t = settle(new Traffic([way([0, 0, 100, 0])], 1, counts({ car: 1, person: 1 })));
    const [car, person] = t.vehicles as [Vehicle, Vehicle];
    for (const v of [car, person]) {
      const [x, z, dx, dz] = t.place(v);
      const e = t.graph.edges[v.edge]!;
      // Eastward (+x) traffic keeps to the south (+z) side; westward to the north.
      expect(Math.abs(x - (e.from === 0 ? v.s : 100 - v.s))).toBeLessThan(1e-3);
      expect(z).toBeCloseTo(dx > 0 ? v.lane : -v.lane);
      expect([dx, dz]).toEqual(e.from === 0 ? [1, 0] : [-1, 0]);
    }
    expect(Math.abs(person.lane)).toBeGreaterThan(Math.abs(car.lane));
  });

  test('lanes keep inside the street: narrow streets put everyone nearer the line', () => {
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
    expect(Math.abs(laneFor('person', edgeOf(4, 'cycle'), true, -1))).toBe(2);
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
    // Narrowed in place (no jump), the surplus is parked as it drives out of reach.
    t.focus(100, 100, 120);
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
