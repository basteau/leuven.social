import { describe, expect, test } from 'bun:test';

import type { Way } from './city.ts';
import { alongEdge, roadGraph, splitAtJunctions, turnBetween, wayFromOsm } from './traffic.ts';

describe('wayFromOsm', () => {
  test('main roads, streets and cycle tracks, with links counted with their road', () => {
    expect(wayFromOsm({ highway: 'primary' })?.kind).toBe('main');
    expect(wayFromOsm({ highway: 'secondary_link' })?.kind).toBe('main');
    expect(wayFromOsm({ highway: 'residential' })?.kind).toBe('street');
    expect(wayFromOsm({ highway: 'living_street' })?.kind).toBe('street');
    expect(wayFromOsm({ highway: 'tertiary_link' })?.kind).toBe('street');
    expect(wayFromOsm({ highway: 'cycleway' })?.kind).toBe('cycle');
    expect(wayFromOsm({ highway: 'pedestrian' })?.kind).toBe('cycle');
  });

  test('service roads, paths, tunnels and closed streets carry no traffic', () => {
    expect(wayFromOsm({ highway: 'service' })).toBeNull();
    expect(wayFromOsm({ highway: 'footway' })).toBeNull();
    expect(wayFromOsm({ highway: 'track' })).toBeNull();
    expect(wayFromOsm({ highway: 'primary', tunnel: 'yes' })).toBeNull();
    expect(wayFromOsm({ highway: 'residential', layer: '-1' })).toBeNull();
    expect(wayFromOsm({ highway: 'residential', motor_vehicle: 'no' })).toBeNull();
    expect(wayFromOsm({ highway: 'residential', access: 'private' })).toBeNull();
    expect(wayFromOsm({ highway: 'pedestrian', area: 'yes' })).toBeNull();
    // A cycle track closed to cars is still a cycle track.
    expect(wayFromOsm({ highway: 'cycleway', motor_vehicle: 'no' })?.kind).toBe('cycle');
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

const way = (over: Partial<Omit<Way, 'line'>> & { line: number[] }): Way => ({
  kind: 'street',
  oneway: false,
  bikesBoth: false,
  ...over,
  line: new Float32Array(over.line),
});

describe('roadGraph', () => {
  test('a two-way street is two edges between two nodes; one-way, one for cars', () => {
    const both = roadGraph([way({ line: [0, 0, 100, 0] })]);
    expect(both.nodes).toHaveLength(2);
    expect(both.edges).toHaveLength(2);
    expect(both.edges.map((e) => [e.from, e.to])).toEqual([
      [0, 1],
      [1, 0],
    ]);
    expect(both.nodes[0]!.out).toEqual([0]);
    expect(both.edges.every((e) => e.cars && e.bikes && e.length === 100)).toBe(true);
    const one = roadGraph([way({ line: [0, 0, 100, 0], oneway: true })]);
    expect(one.edges).toHaveLength(1);
    const cycleStreet = roadGraph([way({ line: [0, 0, 100, 0], oneway: true, bikesBoth: true })]);
    expect(cycleStreet.edges.map((e) => [e.cars, e.bikes])).toEqual([
      [true, true],
      [false, true],
    ]);
    const track = roadGraph([way({ line: [0, 0, 50, 0], kind: 'cycle' })]);
    expect(track.edges.every((e) => !e.cars && e.bikes)).toBe(true);
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
