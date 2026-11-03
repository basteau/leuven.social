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
  BIKE,
  FACE,
  FIGURE,
  GAIT,
  HULL_GROW,
  NEAR,
  NEAR_RANGE,
  NEAR_SHAPES,
  NEAR_VIEW,
  PART,
  RIDER,
  SHAPES,
  TINT,
  TINT_GLSL,
  addFigure,
  addRiddenBike,
  boxOf,
  createTrafficLayer,
  settle,
  tintOf,
  tintsOf,
  vehicleVertexShader,
} from './vehicles.ts';
import { BONES, CHARACTER_SCALE } from './figure.ts';
import { BIKES, GUESTS, WALKER } from './palette.ts';

const way = (line: number[], over: Partial<Omit<Way, 'line'>> = {}): Way => ({
  kind: 'street',
  oneway: false,
  bikesBoth: false,
  surface: 'asphalt',
  right: { kerb: 0, edge: 4 },
  left: { kerb: 0, edge: 4 },
  through: true,
  minor: false,
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

/** The triangles a builder holds. */
const trianglesIn = (b: MeshBuilder) => unindexed(b.build()).getAttribute('position').count / 3;
/** Whether a colour as sRGB fractions is one of a palette's. */
const from = (list: readonly number[], colour: readonly number[]) => list.includes(hex(colour));
/** A colour as sRGB fractions, back to hex. */
const hex = ([r, g, b]: readonly number[]) =>
  (Math.round(r! * 255) << 16) | (Math.round(g! * 255) << 8) | Math.round(b! * 255);

/** How many faces a unit box gets with these faces asked for. */
const count = (faces: number) => {
  const mesh = new MeshBuilder();
  boxOf(mesh, [0, 1], [0, 1], [0, 1], 0xffffff, PART.plain, faces);
  return unindexed(mesh.build()).getAttribute('position').count / 6;
};

/** The most triangles a kind may cost, body and hull alike: the fleet is hundreds of each. */
const MOST: Record<VehicleKind, number> = { car: 160, bus: 160, bike: 360, person: 300 };

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
      if (kind === 'car' || kind === 'bus') {
        expect(parts.has(PART.paint)).toBe(true);
        expect(parts.has(PART.signalL) && parts.has(PART.signalR) && parts.has(PART.beam)).toBe(
          true,
        );
      } else {
        // The coarse figure: its bones, tinted, on foot or riding; a cyclist's lamps lit.
        const base = kind === 'bike' ? RIDER : FIGURE;
        expect([...parts].some((p) => p >= base + 1 && p < base + 14)).toBe(true);
        let tinted = false;
        for (let i = 0; i < facade.count; i++) {
          if (Math.abs((facade.getX(i) % 1) - TINT.shirt) < 0.01) tinted = true;
        }
        expect(tinted).toBe(true);
      }
      if (kind !== 'person') {
        expect(parts.has(PART.head)).toBe(true);
        expect(parts.has(PART.tail)).toBe(true);
      }
      g.computeBoundingBox();
      // Wheels (or feet) on the ground; a vehicle longer than wide, ahead along +x; a figure
      // the walker's height.
      expect(g.boundingBox!.min.y).toBeCloseTo(0, 1);
      if (kind !== 'person') expect(g.boundingBox!.max.x).toBeGreaterThan(g.boundingBox!.max.z);
      else expect(g.boundingBox!.max.y).toBeCloseTo(1.96 * CHARACTER_SCALE, 1);
      // The hull is the boxes grown, without the lamps and the beam: no wider than a lane. A
      // far figure has none: its outline is for the near shape, where it is wider than a pixel.
      const hull = new MeshBuilder();
      SHAPES[kind](hull, HULL_GROW);
      const h = unindexed(hull.build());
      if (kind === 'person') {
        expect(h.getAttribute('position').count).toBe(0);
        continue;
      }
      h.computeBoundingBox();
      expect(h.boundingBox!.max.z - h.boundingBox!.min.z).toBeLessThan(2.8);
      expect(h.getAttribute('position').count).toBeLessThanOrEqual(
        g.getAttribute('position').count,
      );
    }
  });

  test('a beam fades to its far end and its sides; halos round the lamps', () => {
    const car = new MeshBuilder();
    SHAPES.car(car);
    const beam = unindexed(car.build({ facade: true })).getAttribute('facade');
    const fades = new Set<number>();
    for (let i = 0; i < beam.count; i++) {
      const v = beam.getX(i);
      if (Math.floor(v) === PART.beam) fades.add(Math.round((1 - (v - PART.beam)) * 100));
    }
    // Full down the middle at the bumper, dim at the sides, nearly gone at the far end.
    expect([...fades].toSorted((a, b) => a - b)).toEqual([2, 10, 30, 100]);
    // Halos round the lamps, dithered by their own fade.
    const halos = new Set<number>();
    for (let i = 0; i < beam.count; i++) {
      const v = beam.getX(i);
      if (Math.floor(v) === PART.halo || Math.floor(v) === PART.haloTail) halos.add(Math.floor(v));
    }
    expect(halos).toEqual(new Set([PART.halo, PART.haloTail]));
  });

  test("near the view, people are the walker's figure at its size, each face on its bone and tint", () => {
    const body = new MeshBuilder();
    addFigure(body, FIGURE, false);
    const g = unindexed(body.build({ facade: true }));
    const facade = g.getAttribute('facade');
    const bones = new Set<number>();
    const tints = new Set<number>();
    for (let i = 0; i < facade.count; i++) {
      const v = facade.getX(i);
      bones.add(Math.floor(v) - FIGURE);
      tints.add(Math.round((v - Math.floor(v)) * 1000) / 1000);
    }
    // Every bone but the root (the walker's blob shadow stays with the walker).
    expect([...bones].toSorted((a, b) => a - b)).toEqual(BONES.map((_, i) => i).slice(1));
    expect(tints).toEqual(new Set([0, TINT.shirt, TINT.trim, TINT.hair, TINT.skin]));
    // Feet on the ground, the walker's height, facing ahead (+x): the nose is ahead of the head.
    g.computeBoundingBox();
    expect(g.boundingBox!.min.y).toBeCloseTo(0, 1);
    expect(g.boundingBox!.max.y).toBeCloseTo(1.96 * CHARACTER_SCALE, 1);
    expect(g.boundingBox!.max.x).toBeLessThan(0.35);
    const triangles = g.getAttribute('position').count / 3;
    expect(triangles).toBeGreaterThan(400);
    expect(triangles).toBeLessThan(600);
    // The hull is the figure's ink hulls, grown, on the same bones, without the details.
    const hull = new MeshBuilder();
    addFigure(hull, RIDER, true);
    const h = unindexed(hull.build({ facade: true }));
    h.computeBoundingBox();
    expect(h.boundingBox!.max.y).toBeGreaterThan(g.boundingBox!.max.y);
    expect(h.getAttribute('position').count / 3).toBeLessThan(triangles);
    expect(Math.floor(h.getAttribute('facade').getX(0))).toBeGreaterThanOrEqual(RIDER);
    // A face's tint: the shirt's channel is its shade, the skin is white, the rest its own.
    expect(tintOf(0xd10000)).toEqual([TINT.shirt, 0xd10000]);
    expect(tintOf(0x00ff00)).toEqual([TINT.trim, 0x00ff00]);
    expect(tintOf(0x0000ff)).toEqual([TINT.hair, 0x0000ff]);
    expect(tintOf(WALKER.skin)).toEqual([TINT.skin, 0xffffff]);
    expect(tintOf(0x2b2420)).toEqual([0, 0x2b2420]);
  });

  test("a cyclist near the view rides the rideable bike, its frame in the instance's trim", () => {
    const body = new MeshBuilder();
    addRiddenBike(body, false);
    const g = unindexed(body.build({ facade: true }));
    const parts = new Set<number>();
    const facade = g.getAttribute('facade');
    for (let i = 0; i < facade.count; i++) parts.add(facade.getX(i));
    // The frame takes the trim; the lamp and the reflector light up as a car's do.
    expect(parts.has(BIKE + TINT.trim)).toBe(true);
    expect(parts.has(PART.head) && parts.has(PART.tail)).toBe(true);
    // Wheels and crank on their bones, nothing from the figure, no blob shadow.
    expect(parts.has(BIKE + 2) && parts.has(BIKE + 3) && parts.has(BIKE + 4)).toBe(true);
    expect([...parts].some((p) => p >= FIGURE && p < BIKE)).toBe(false);
    g.computeBoundingBox();
    expect(g.boundingBox!.min.y).toBeGreaterThanOrEqual(0);
    // The lamp's pool reaches 3.5 m ahead of the lamp on the fork crown.
    expect(g.boundingBox!.max.x).toBeCloseTo(0.52 * CHARACTER_SCALE + 3.5, 1);
    const hull = new MeshBuilder();
    addRiddenBike(hull, true);
    const h = unindexed(hull.build({ facade: true }));
    expect(h.getAttribute('position').count).toBeLessThan(g.getAttribute('position').count);
    // With its rider: one shape, under 1,700 triangles with its hull.
    const whole = new MeshBuilder();
    NEAR_SHAPES.bike(whole, false);
    const wholeHull = new MeshBuilder();
    NEAR_SHAPES.bike(wholeHull, true);
    expect(trianglesIn(whole) + trianglesIn(wholeHull)).toBeLessThan(1700);
    const person = new MeshBuilder();
    NEAR_SHAPES.person(person, false);
    expect(trianglesIn(person)).toBeGreaterThan(400);
    // A car and a bus near the view carry their detail, their far shapes a few boxes.
    for (const kind of ['car', 'bus'] as const) {
      const nearShape = new MeshBuilder();
      NEAR_SHAPES[kind](nearShape, false);
      const farShape = new MeshBuilder();
      SHAPES[kind](farShape);
      expect(trianglesIn(nearShape)).toBeGreaterThan(trianglesIn(farShape) + 40);
      expect(trianglesIn(nearShape)).toBeLessThan(260);
      const nearHull = new MeshBuilder();
      NEAR_SHAPES[kind](nearHull, true);
      expect(trianglesIn(nearHull)).toBeLessThan(trianglesIn(nearShape));
    }
  });

  test('the far figure is the near one squared off: same bones and height, far fewer faces', () => {
    const near = new MeshBuilder();
    addFigure(near, FIGURE, false);
    const far = new MeshBuilder();
    addFigure(far, FIGURE, false, true);
    const [n, f] = [
      unindexed(near.build({ facade: true })),
      unindexed(far.build({ facade: true })),
    ];
    expect(f.getAttribute('position').count).toBeLessThan(n.getAttribute('position').count * 0.6);
    const bones = (g: typeof n) => {
      const out = new Set<number>();
      const a = g.getAttribute('facade');
      for (let i = 0; i < a.count; i++) out.add(Math.floor(a.getX(i)));
      return out;
    };
    expect(bones(f)).toEqual(bones(n));
    n.computeBoundingBox();
    f.computeBoundingBox();
    expect(f.boundingBox!.max.y).toBeCloseTo(n.boundingBox!.max.y, 1);
    const v = { kind: 'person', paint: [0.1, 0.2, 0.3], blink: 0.37 } as Parameters<
      typeof tintsOf
    >[0];
    const [shirt, trim, skin, hair] = tintsOf(v);
    expect(shirt).toEqual([0.1, 0.2, 0.3]);
    expect(from(GUESTS.legs, trim)).toBe(true);
    expect(from(GUESTS.skin, skin)).toBe(true);
    expect(from(GUESTS.hair, hair)).toBe(true);
    expect(from(BIKES, tintsOf({ ...v, kind: 'bike' })[1])).toBe(true);
    // The same instance always dresses the same; others dress differently now and then.
    expect(tintsOf(v)).toEqual(tintsOf({ ...v }));
    const others = Array.from({ length: 20 }, (_, i) => hex(tintsOf({ ...v, blink: i / 20 })[2]));
    expect(new Set(others).size).toBeGreaterThan(2);
  });

  test('boxOf writes the faces asked for', () => {
    expect(count(FACE.top)).toBe(1);
    expect(count(FACE.top | FACE.bottom)).toBe(2);
    expect(count(FACE.front | FACE.back | FACE.left | FACE.right)).toBe(4);
  });

  test('the vertex shader swings the limbs about their joints with the stride', () => {
    const out = vehicleVertexShader('#include <common>\n#include <begin_vertex>');
    expect(out).toContain('attribute vec4 state');
    // The figure's chains: ankle, knee and hip; elbow and shoulder; the bike's wheels and crank.
    expect(out).toContain(`part >= ${FIGURE}.0`);
    expect(out.match(/turn\(transformed/g)!.length).toBeGreaterThanOrEqual(12);
    expect(out).toContain('harm(');
    for (const c of GAIT.ride.knee) expect(out).toContain(c.toFixed(3));
    // A stroller's shorter stride swings the walking legs less than the walker's.
    expect(out).toContain(GAIT.walk.thigh[0].toFixed(3));
    expect(out).toContain((GAIT.walk.thigh[2] * (2 / 2.6)).toFixed(3));
    // The tints: each face's colour times the instance's, after the paint swap.
    expect(TINT_GLSL).toContain('vColor.rgb = paint * shade');
    expect(TINT_GLSL).toContain(`${TINT.skin}`);
    // The gait tables: a leg's swing is about the walker's, and pedalling bends the knee most.
    expect(Math.abs(GAIT.walk.thigh[2])).toBeGreaterThan(0.5);
    expect(GAIT.ride.knee[0]).toBeGreaterThan(GAIT.walk.knee[0]);
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
    // A square over the town's north-west corner; the ground climbs gently eastward.
    city: { ways: town, plazas: [new Float32Array([-10, -10, 60, -10, 60, 60, -10, 60])] },
    ground: (x: number, z: number) => x * 0.01 + z * 0.0001,
    lift: { street: 0.156, square: 0.2 },
    gradientMap: new DataTexture(new Uint8Array([255]), 1, 1),
    night: { value: 0 },
    ink: OUTLINE,
  };

  test('draws a body and an ink hull per kind, moving every instance and its state each update', () => {
    const layer = createTrafficLayer(kit, 2);
    // A body and a hull per kind, far and near.
    expect(layer.meshes).toHaveLength(VEHICLE_KINDS.length * 4);
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
    // On the drawn street (or a square's higher setts), pitched to the slope under its wheels.
    const onSquare = p.x < 60 && p.z < 60;
    expect(p.y).toBeCloseTo(kit.ground(p.x, p.z) + (onSquare ? 0.2 : 0.156) + 0.03, 3);
    const stood = { y: 0 };
    expect(settle(kit.ground, 0, 0, 1, 0, 4, stood)).toBeCloseTo(Math.atan2(0.04, 4));
    expect(stood.y).toBeCloseTo(0);
    expect(settle(kit.ground, 10, 0, -1, 0, 4, stood)).toBeCloseTo(-Math.atan2(0.04, 4));
    expect(stood.y).toBeCloseTo(0.1);
    // Heading east up the slope, the car's nose is up: its front wheels on the ground ahead.
    const nose = new Vector3(2.1, 0, 0).applyMatrix4(m);
    const heel = new Vector3(-2.1, 0, 0).applyMatrix4(m);
    const ahead = new Vector3(1, 0, 0).transformDirection(m);
    const slope = kit.ground(nose.x, nose.z) - kit.ground(heel.x, heel.z);
    expect(nose.y - heel.y).toBeCloseTo(slope, 2);
    expect(Math.abs(ahead.y)).toBeGreaterThan(0);
    const state = cars.geometry.getAttribute('state');
    expect(state.getX(i)).toBeCloseTo(v.phase, 3);
    expect(state.getW(i)).toBeCloseTo(v.blink, 5);
    // The vehicles' shaders: the paint and the lamps go in where the toon shader has its hooks.
    // Close in, the nearest people and cyclists are drawn as the figure, the far instance of
    // each gone; zoomed out, none are.
    // Each kind's far pair then its near pair: the people's far at 12, near at 14.
    const nearPeople = layer.meshes[14]!;
    const farPeople = layer.meshes[12]!;
    for (let k = 0; k < 30; k++) layer.update(1 / 30, 100, 100, NEAR_VIEW);
    expect(nearPeople.count).toBeGreaterThan(0);
    expect(nearPeople.count).toBeLessThanOrEqual(NEAR.person);
    const people = layer.traffic.vehicles.filter((o) => o.kind === 'person');
    let shown = 0;
    let farthestNear = 0;
    let nearestFar = Infinity;
    for (const [j, o] of people.entries()) {
      if (!o.active) continue;
      const [ox, oz] = layer.traffic.place(o);
      const d = Math.hypot(ox - 100, oz - 100);
      farPeople.getMatrixAt(j, m);
      const scale = new Vector3().setFromMatrixScale(m).x;
      if (scale === 0) {
        shown++;
        farthestNear = Math.max(farthestNear, d);
      } else nearestFar = Math.min(nearestFar, d);
    }
    expect(shown).toBe(nearPeople.count);
    // The nearest are the ones drawn near, none of them beyond the range.
    expect(farthestNear).toBeLessThanOrEqual(NEAR_RANGE);
    expect(nearestFar).toBeGreaterThanOrEqual(farthestNear - 1e-6);
    nearPeople.getMatrixAt(0, m);
    expect(new Vector3().setFromMatrixScale(m).x).toBeCloseTo(1);
    expect(nearPeople.geometry.getAttribute('skin').count).toBe(NEAR.person);
    for (let k = 0; k < 30; k++) layer.update(1 / 30, 100, 100, NEAR_VIEW + 1);
    expect(nearPeople.count).toBe(0);
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
