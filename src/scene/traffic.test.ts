import { describe, expect, test } from 'bun:test';
import {
  BackSide,
  DataTexture,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  MeshToonMaterial,
  Vector3,
} from 'three';

import type { Way } from '../data/city.ts';
import { MeshBuilder, linearVertexColors, unindexed } from './mesh-builder.ts';
import { splitAtJunctions } from '../data/traffic.ts';
import { OUTLINE } from './palette.ts';
import {
  COUNTS,
  DENSITY,
  FLOOR,
  HULL_GROW,
  LENGTH,
  PART,
  SHAPES,
  Traffic,
  VEHICLE_KINDS,
  createTrafficLayer,
  mulberry32,
} from './traffic.ts';
import type { VehicleKind } from './traffic.ts';

const way = (line: number[], over: Partial<Omit<Way, 'line'>> = {}): Way => ({
  kind: 'street',
  oneway: false,
  bikesBoth: false,
  ...over,
  line: new Float32Array(line),
});

/**
 * A block of streets round a square, a one-way lane and a cycle track, with a dead end, split
 * where they meet as the bake splits them.
 */
const raw = (line: number[], over: Partial<Omit<Way, 'line'>> = {}) => ({ line, ...over });
const rawTown = [
  raw([0, 0, 100, 0, 200, 0], { kind: 'main' }),
  raw([200, 0, 200, 100, 200, 200], { kind: 'main' }),
  raw([200, 200, 100, 200, 0, 200]),
  raw([0, 200, 0, 100, 0, 0]),
  raw([100, 0, 100, 200], { oneway: true, bikesBoth: true }),
  raw([0, 100, 200, 100], { kind: 'cycle' }),
  raw([200, 100, 300, 100]), // off the map: a dead end
];
const build = (ways: ReturnType<typeof raw>[]): Way[] =>
  splitAtJunctions(ways).map(({ line, ...rest }) => way(line, rest));
const town = build(rawTown);

const motor = (kind: VehicleKind) => kind !== 'bike';

/** Lets the fleet out round a focus wide enough for the whole town, over a second. */
const settle = (t: Traffic) => {
  t.focus(150, 150, 2000);
  for (let i = 0; i < 90; i++) t.step(1 / 60);
  return t;
};

describe('Traffic', () => {
  test('spawns its counts on edges each may drive, clear of each other, and heads somewhere', () => {
    const t = settle(new Traffic(town, 7, { car: 20, bus: 2, bike: 20 }));
    expect(t.vehicles).toHaveLength(42);
    expect(t.vehicles.every((v) => v.active)).toBe(true);
    for (const v of t.vehicles) {
      const e = t.graph.edges[v.edge]!;
      expect(motor(v.kind) ? e.cars : e.bikes).toBe(true);
      expect(v.s).toBeGreaterThanOrEqual(0);
      expect(v.s).toBeLessThanOrEqual(e.length);
      expect(v.next).toBeGreaterThanOrEqual(0);
      expect(v.cruise).toBeGreaterThan(0);
    }
    // At the dead end a two-way street offers, the only way on is back; the bikes keep further
    // right than the cars.
    const dead = t.graph.edges.findIndex(
      (e) => e.to === t.graph.nodes.findIndex((n) => n.x === 300),
    );
    for (const v of t.vehicles.filter((o) => o.edge === dead)) {
      expect(t.graph.edges[v.next]!.to).toBe(t.graph.edges[dead]!.from);
      expect(v.turn).toBeCloseTo(Math.PI);
    }
    const lane = (kind: VehicleKind) => t.vehicles.find((v) => v.kind === kind)!.lane;
    expect(lane('bike')).toBeGreaterThan(lane('car'));
    expect(COUNTS.car + COUNTS.bus + COUNTS.bike).toBeLessThan(600);
  });

  test('moves on, keeps its distance, slows for corners and never runs backwards', () => {
    const t = settle(new Traffic(town, 3, { car: 30, bus: 3, bike: 30 }));
    const before = t.vehicles.map((v) => [v.edge, v.s] as const);
    let moved = 0;
    for (let i = 0; i < 60 * 30; i++) {
      t.step(1 / 60);
      for (const v of t.vehicles) {
        expect(v.speed).toBeGreaterThanOrEqual(0);
        expect(v.speed).toBeLessThanOrEqual(v.cruise * 1.001);
      }
    }
    for (const [i, v] of t.vehicles.entries()) {
      const [edge, s] = before[i]!;
      if (v.edge !== edge || v.s !== s) moved++;
    }
    expect(moved).toBe(t.vehicles.length);
    // Nobody is inside the one ahead on the same edge and in the same lane class.
    for (const a of t.vehicles) {
      for (const b of t.vehicles) {
        if (a === b || a.edge !== b.edge || motor(a.kind) !== motor(b.kind)) continue;
        if (b.s <= a.s) continue;
        expect(b.s - a.s).toBeGreaterThan((LENGTH[a.kind] + LENGTH[b.kind]) / 2 - 0.5);
      }
    }
  });

  test('a car whose street ends in a cycle track has nowhere to go, and comes back elsewhere', () => {
    // A one-way stub that ends where only a cycle track goes on.
    const stubs = build([
      ...rawTown,
      raw([300, 100, 350, 100], { oneway: true }),
      raw([350, 100, 400, 100], { kind: 'cycle' }),
    ]);
    const t = settle(new Traffic(stubs, 5, { car: 2, bus: 0, bike: 0 }));
    const stub = t.graph.edges.findIndex((e) => e.cars && t.graph.nodes[e.to]!.x === 350);
    const v = t.vehicles[0]!;
    Object.assign(v, { edge: stub, s: 1, speed: 5 });
    for (let i = 0; i < 60 * 20 && v.edge === stub; i++) t.step(1 / 30);
    expect(v.edge).not.toBe(stub);
  });

  test('a vehicle driven off the dead end comes back somewhere it may drive', () => {
    const t = settle(new Traffic(town, 5, { car: 3, bus: 0, bike: 0 }));
    const dead = t.graph.edges.findIndex((e) => t.graph.nodes[e.to]!.x === 300);
    const v = t.vehicles[0]!;
    Object.assign(v, { edge: dead, s: t.graph.edges[dead]!.length - 1, next: -1, speed: 5 });
    for (let i = 0; i < 60; i++) t.step(1 / 30);
    expect(v.edge).not.toBe(dead);
    expect(t.graph.edges[v.edge]!.cars).toBe(true);
  });

  test('places each vehicle in its lane, right of the line, heading along it', () => {
    const t = settle(new Traffic([way([0, 0, 100, 0])], 1, { car: 1, bus: 0, bike: 0 }));
    const v = t.vehicles[0]!;
    const [x, z, dx, dz] = t.place(v);
    const e = t.graph.edges[v.edge]!;
    // Eastward (+x) traffic keeps to the south (+z) side; westward to the north.
    expect(Math.abs(x - (e.from === 0 ? v.s : 100 - v.s))).toBeLessThan(1e-3);
    expect(z).toBeCloseTo(dx > 0 ? v.lane : -v.lane);
    expect([dx, dz]).toEqual(e.from === 0 ? [1, 0] : [-1, 0]);
  });

  test('keeps the fleet round the focus: out of its view in, parked beyond what it deserves', () => {
    const t = settle(new Traffic(town, 11, { car: 40, bus: 4, bike: 60 }));
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
    // A jump re-places everyone at once, out of the new view but within reach.
    t.focus(2000, 2000, 150);
    expect(
      t.vehicles.every(
        (v) => !v.active || Math.hypot(...(t.place(v).slice(0, 2) as [number, number])) < 2200,
      ),
    ).toBe(true);
    // A wide focus lets the whole fleet out again, all over its circle.
    t.focus(100, 100, 2000);
    for (let i = 0; i < 60 * 10; i++) t.step(1 / 60);
    expect(t.vehicles.filter((v) => v.active).length).toBe(t.vehicles.length);
    // Narrowed in place (no jump), the surplus is parked as it drives out of reach.
    t.focus(100, 100, 120);
    for (let i = 0; i < 60 * 60; i++) t.step(1 / 60);
    const bikes = t.vehicles.filter((v) => v.active && v.kind === 'bike').length;
    expect(bikes).toBeGreaterThanOrEqual(FLOOR.bike);
    expect(bikes).toBeLessThan(60);
    expect(DENSITY.bike).toBeGreaterThan(DENSITY.car);
  });

  test('is deterministic for a seed', () => {
    const a = settle(new Traffic(town, 9, { car: 5, bus: 1, bike: 5 }));
    const b = settle(new Traffic(town, 9, { car: 5, bus: 1, bike: 5 }));
    for (let i = 0; i < 100; i++) {
      a.step(1 / 60);
      b.step(1 / 60);
    }
    expect(a.vehicles).toEqual(b.vehicles);
    const r = mulberry32(42);
    const first = r();
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(1);
    expect(mulberry32(42)()).toBe(first);
  });
});

describe('vehicle shapes', () => {
  test('each is a few boxes, painted where the instance colours it, lit at the lamps', () => {
    for (const kind of VEHICLE_KINDS) {
      const mesh = new MeshBuilder();
      SHAPES[kind](mesh);
      const g = unindexed(mesh.build({ facade: true }));
      const triangles = g.getAttribute('position').count / 3;
      expect(triangles).toBeGreaterThan(20);
      expect(triangles).toBeLessThan(140);
      const parts = new Set<number>();
      const facade = g.getAttribute('facade');
      for (let i = 0; i < facade.count; i++) parts.add(facade.getX(i));
      expect(parts.has(PART.paint)).toBe(true);
      if (kind !== 'bike') {
        expect(parts.has(PART.head)).toBe(true);
        expect(parts.has(PART.tail)).toBe(true);
      }
      g.computeBoundingBox();
      // Wheels on the ground, the body ahead along +x, no wider than a lane.
      expect(g.boundingBox!.min.y).toBe(0);
      expect(g.boundingBox!.max.x).toBeGreaterThan(g.boundingBox!.max.z);
      expect(g.boundingBox!.max.z - g.boundingBox!.min.z).toBeLessThan(2.6);
      // The hull is the same shape, grown.
      const hull = new MeshBuilder();
      SHAPES[kind](hull, HULL_GROW);
      const h = unindexed(hull.build());
      h.computeBoundingBox();
      expect(h.boundingBox!.max.y).toBeGreaterThan(g.boundingBox!.max.y);
    }
  });
});

describe('createTrafficLayer', () => {
  const kit = {
    three: {
      BackSide,
      InstancedBufferAttribute,
      InstancedMesh,
      Matrix4,
      MeshBasicMaterial,
      MeshToonMaterial,
    },
    MeshBuilder,
    linearVertexColors,
    city: { ways: town },
    ground: (x: number, z: number) => 0.155 + x * 0.001 + z * 0.0001,
    gradientMap: new DataTexture(new Uint8Array([255]), 1, 1),
    night: { value: 0 },
    ink: OUTLINE,
  };

  test('draws a body and an ink hull per kind, moving every instance each update', () => {
    const layer = createTrafficLayer(kit, 2);
    expect(layer.meshes).toHaveLength(VEHICLE_KINDS.length * 2);
    let drawn = 0;
    for (let i = 0; i < 60; i++) drawn = layer.update(1 / 30, 100, 100, 400);
    expect(drawn).toBeGreaterThan(0);
    expect(drawn).toBe(layer.traffic.vehicles.filter((v) => v.active).length);
    const [cars, hull] = layer.meshes as [InstancedMesh, InstancedMesh];
    expect(hull.instanceMatrix).toBe(cars.instanceMatrix);
    expect(cars.count).toBe(layer.traffic.vehicles.filter((v) => v.kind === 'car').length);
    const m = new Matrix4();
    cars.getMatrixAt(0, m);
    const p = new Vector3().setFromMatrixPosition(m);
    const v = layer.traffic.vehicles.find((o) => o.kind === 'car' && o.active)!;
    cars.getMatrixAt(layer.traffic.vehicles.filter((o) => o.kind === 'car').indexOf(v), m);
    p.setFromMatrixPosition(m);
    const [x, , z] = [p.x, p.y, p.z];
    const [sx, sz] = layer.traffic.place(v);
    expect(x).toBeCloseTo(sx);
    expect(z).toBeCloseTo(sz);
    expect(p.y).toBeCloseTo(kit.ground(x, z) + 0.03);
    // The vehicles' shader: the paint and the lamps go in where the toon shader has its hooks.
    const material = cars.material as MeshToonMaterial;
    const shader = {
      uniforms: {} as Record<string, unknown>,
      vertexShader: '#include <common>\n#include <color_vertex>',
      fragmentShader: '#include <common>\n#include <emissivemap_fragment>',
    };
    (material.onBeforeCompile as (s: typeof shader) => void)(shader);
    expect(shader.uniforms.uNight).toBe(kit.night);
    expect(shader.vertexShader).toContain('vColor.rgb = paint');
    expect(shader.fragmentShader).toContain('totalEmissiveRadiance');
    layer.dispose();
  });
});
