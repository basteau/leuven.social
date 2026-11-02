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
import { splitAtJunctions } from '../data/traffic.ts';
import { MeshBuilder, linearVertexColors, unindexed } from './mesh-builder.ts';
import { OUTLINE } from './palette.ts';
import { VEHICLE_KINDS } from './traffic.ts';
import type { VehicleKind } from './traffic.ts';
import {
  FACE,
  HULL_GROW,
  PART,
  SHAPES,
  boxOf,
  createTrafficLayer,
  vehicleVertexShader,
} from './vehicles.ts';

const way = (line: number[], over: Partial<Omit<Way, 'line'>> = {}): Way => ({
  kind: 'street',
  oneway: false,
  bikesBoth: false,
  halfWidth: 4,
  ...over,
  line: new Float32Array(line),
});
const town: Way[] = splitAtJunctions([
  { line: [0, 0, 100, 0, 200, 0], kind: 'main' as const },
  { line: [200, 0, 200, 100, 200, 200], kind: 'main' as const },
  { line: [200, 200, 100, 200, 0, 200] },
  { line: [0, 200, 0, 100, 0, 0] },
  { line: [100, 0, 100, 200], oneway: true, bikesBoth: true },
  { line: [0, 100, 200, 100], kind: 'cycle' as const },
]).map(({ line, ...rest }) => way(line, rest));

/** How many faces a unit box gets with these faces asked for. */
const count = (faces: number) => {
  const mesh = new MeshBuilder();
  boxOf(mesh, [0, 1], [0, 1], [0, 1], 0xffffff, PART.plain, faces);
  return unindexed(mesh.build()).getAttribute('position').count / 6;
};

/** The most triangles a kind may cost, body and hull alike: the fleet is hundreds of each. */
const MOST: Record<VehicleKind, number> = { car: 120, bus: 100, bike: 125, person: 70 };

describe('vehicle shapes', () => {
  test('each is a few boxes, painted where the instance colours it, lit at the lamps', () => {
    for (const kind of VEHICLE_KINDS) {
      const mesh = new MeshBuilder();
      SHAPES[kind](mesh);
      const g = unindexed(mesh.build({ facade: true }));
      const triangles = g.getAttribute('position').count / 3;
      expect(triangles).toBeGreaterThan(20);
      expect(triangles).toBeLessThanOrEqual(MOST[kind]);
      const parts = new Set<number>();
      const facade = g.getAttribute('facade');
      for (let i = 0; i < facade.count; i++) parts.add(Math.floor(facade.getX(i)));
      expect(parts.has(PART.paint)).toBe(true);
      if (kind !== 'person') {
        expect(parts.has(PART.head)).toBe(true);
        expect(parts.has(PART.tail)).toBe(true);
      }
      if (kind === 'car' || kind === 'bus') {
        expect(parts.has(PART.signalL) && parts.has(PART.signalR) && parts.has(PART.beam)).toBe(
          true,
        );
      }
      if (kind === 'bike' || kind === 'person') {
        expect(parts.has(PART.legL) && parts.has(PART.legR)).toBe(true);
      }
      g.computeBoundingBox();
      // Wheels (or feet) on the ground; a vehicle longer than wide, ahead along +x.
      expect(g.boundingBox!.min.y).toBe(0);
      if (kind !== 'person') expect(g.boundingBox!.max.x).toBeGreaterThan(g.boundingBox!.max.z);
      // The hull is the same shape, grown, without the lamps and the beam: no wider than a lane.
      const hull = new MeshBuilder();
      SHAPES[kind](hull, HULL_GROW);
      const h = unindexed(hull.build());
      h.computeBoundingBox();
      expect(h.boundingBox!.max.z - h.boundingBox!.min.z).toBeLessThan(2.8);
      expect(h.boundingBox!.max.y).toBeGreaterThan(g.boundingBox!.max.y);
      expect(h.getAttribute('position').count).toBeLessThanOrEqual(
        g.getAttribute('position').count,
      );
    }
  });

  test('a limb carries its joint in the fraction of its part code; a beam fades to its far end', () => {
    const mesh = new MeshBuilder();
    SHAPES.person(mesh);
    const facade = unindexed(mesh.build({ facade: true })).getAttribute('facade');
    const codes = new Set<number>();
    for (let i = 0; i < facade.count; i++) codes.add(facade.getX(i));
    const legs = [...codes].filter((c) => Math.floor(c) === PART.legL);
    expect(legs).toHaveLength(1);
    expect((legs[0]! - PART.legL) * 10).toBeCloseTo(0.85, 1);
    const car = new MeshBuilder();
    SHAPES.car(car);
    const beam = unindexed(car.build({ facade: true })).getAttribute('facade');
    const fades = new Set<number>();
    for (let i = 0; i < beam.count; i++) {
      const v = beam.getX(i);
      if (Math.floor(v) === PART.beam) fades.add(Math.round((1 - (v - PART.beam)) * 100));
    }
    expect([...fades].toSorted((a, b) => a - b)).toEqual([5, 100]);
  });

  test('boxOf writes the faces asked for', () => {
    expect(count(FACE.top)).toBe(1);
    expect(count(FACE.top | FACE.bottom)).toBe(2);
    expect(count(FACE.front | FACE.back | FACE.left | FACE.right)).toBe(4);
  });

  test('the vertex shader swings the limbs about their joints with the stride', () => {
    const out = vehicleVertexShader('#include <common>\n#include <begin_vertex>');
    expect(out).toContain('attribute vec4 state');
    expect(out).toContain('fract(facade) * 10.0');
    expect(out).toContain('sin(state.x)');
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
    // The engine's dither, stood in for: the real one is GLSL the browser compiles.
    bayer: 'float bayer4(vec2 a) { return 0.5; }',
    city: { ways: town },
    ground: (x: number, z: number) => 0.155 + x * 0.001 + z * 0.0001,
    gradientMap: new DataTexture(new Uint8Array([255]), 1, 1),
    night: { value: 0 },
    ink: OUTLINE,
  };

  test('draws a body and an ink hull per kind, moving every instance and its state each update', () => {
    const layer = createTrafficLayer(kit, 2);
    expect(layer.meshes).toHaveLength(VEHICLE_KINDS.length * 2);
    let drawn = 0;
    for (let i = 0; i < 90; i++) drawn = layer.update(1 / 30, 100, 100, 400);
    expect(drawn).toBeGreaterThan(0);
    expect(drawn).toBe(layer.traffic.vehicles.filter((v) => v.active).length);
    const [cars, hull] = layer.meshes as [InstancedMesh, InstancedMesh];
    expect(hull.instanceMatrix).toBe(cars.instanceMatrix);
    expect(hull.geometry.getAttribute('state')).toBe(cars.geometry.getAttribute('state'));
    const fleet = layer.traffic.vehicles.filter((o) => o.kind === 'car');
    expect(cars.count).toBe(fleet.length);
    const i = fleet.findIndex((v) => v.active);
    const v = fleet[i]!;
    const m = new Matrix4();
    cars.getMatrixAt(i, m);
    const p = new Vector3().setFromMatrixPosition(m);
    const [sx, sz] = layer.traffic.place(v);
    expect(p.x).toBeCloseTo(sx);
    expect(p.z).toBeCloseTo(sz);
    expect(p.y).toBeCloseTo(kit.ground(p.x, p.z) + 0.03);
    const state = cars.geometry.getAttribute('state');
    expect(state.getX(i)).toBeCloseTo(v.phase, 3);
    expect(state.getW(i)).toBeCloseTo(v.blink, 5);
    // The vehicles' shaders: the paint and the lamps go in where the toon shader has its hooks.
    const material = cars.material as MeshToonMaterial;
    const shader = {
      uniforms: {} as Record<string, unknown>,
      vertexShader: '#include <common>\n#include <begin_vertex>\n#include <color_vertex>',
      fragmentShader:
        '#include <common>\n#include <clipping_planes_fragment>\n#include <emissivemap_fragment>',
    };
    (material.onBeforeCompile as (s: typeof shader) => void)(shader);
    expect(shader.uniforms.uNight).toBe(kit.night);
    expect(shader.uniforms.uTime).toBeDefined();
    // The paint swaps in before the colours are linearised, so it is linearised once.
    expect(shader.vertexShader.indexOf('vColor.rgb = paint')).toBeLessThan(
      shader.vertexShader.indexOf('pow(vColor.rgb'),
    );
    expect(shader.fragmentShader).toContain('totalEmissiveRadiance');
    expect(shader.fragmentShader).toContain('bayer4');
    expect(material.customProgramCacheKey()).toContain('vehicle');
    const ink = hull.material as MeshBasicMaterial;
    expect(ink.customProgramCacheKey()).toContain('ink');
    const inkShader = { ...shader, uniforms: {} };
    (ink.onBeforeCompile as (s: typeof shader) => void)(inkShader);
    expect(inkShader.fragmentShader).toContain('discard');
    layer.dispose();
  });
});
