import { describe, expect, test } from 'bun:test';
import {
  BackSide,
  DataTexture,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  MeshToonMaterial,
  Scene,
  Vector3,
} from 'three';
import type { InstancedBufferAttribute as Attribute } from 'three';

import { BONES, CHARACTER_SCALE } from './figure.ts';
import { MeshBuilder, linearVertexColors, unindexed } from './mesh-builder.ts';
import { OUTLINE, WALKER } from './palette.ts';
import {
  BIKE,
  PART,
  PEDAL,
  RIDER,
  TINT,
  TINT_GLSL,
  addRiddenBike,
  addRider,
  addRiderFigure,
  createRiders,
  riderVertexShader,
  tintOf,
} from './rider.ts';

/** The triangles a builder holds. */
const trianglesIn = (b: MeshBuilder) => unindexed(b.build()).getAttribute('position').count / 3;
/** Every value of a geometry's `facade` attribute. */
function facades(b: MeshBuilder): number[] {
  const a = unindexed(b.build({ facade: true })).getAttribute('facade');
  return Array.from({ length: a.count }, (_, i) => a.getX(i));
}

describe('the rider', () => {
  test("is the walker's figure at its size, each face on its bone and tint", () => {
    const body = new MeshBuilder();
    addRiderFigure(body, false);
    const g = unindexed(body.build({ facade: true }));
    const bones = new Set<number>();
    const tints = new Set<number>();
    for (const v of facades(body)) {
      bones.add(Math.floor(v) - RIDER);
      tints.add(Math.round((v - Math.floor(v)) * 1000) / 1000);
    }
    // Every bone but the root (the walker's blob shadow stays with the walker).
    expect([...bones].toSorted((a, b) => a - b)).toEqual(BONES.map((_, i) => i).slice(1));
    expect(tints).toEqual(new Set([0, TINT.shirt, TINT.shorts, TINT.hair, TINT.skin]));
    // Feet on the ground, the walker's height, facing ahead (+x): the nose is ahead of the head.
    g.computeBoundingBox();
    expect(g.boundingBox!.min.y).toBeCloseTo(0, 1);
    expect(g.boundingBox!.max.y).toBeCloseTo(1.96 * CHARACTER_SCALE, 1);
    expect(g.boundingBox!.max.x).toBeLessThan(0.35);
    // The hull is the figure's ink hulls, grown, on the same bones, without the details.
    const hull = new MeshBuilder();
    addRiderFigure(hull, true);
    const h = unindexed(hull.build({ facade: true }));
    h.computeBoundingBox();
    expect(h.boundingBox!.max.y).toBeGreaterThan(g.boundingBox!.max.y);
    expect(trianglesIn(hull)).toBeLessThan(trianglesIn(body));
    expect(facades(hull).every((v) => v >= RIDER && v === Math.floor(v))).toBe(true);
  });

  test("a face's tint: the shirt's channel is its shade, the skin is white, the rest its own", () => {
    expect(tintOf(0xd10000)).toEqual([TINT.shirt, 0xd10000]);
    expect(tintOf(0x00ff00)).toEqual([TINT.shorts, 0x00ff00]);
    expect(tintOf(0x0000ff)).toEqual([TINT.hair, 0x0000ff]);
    expect(tintOf(WALKER.skin)).toEqual([TINT.skin, 0xffffff]);
    expect(tintOf(0x2b2420)).toEqual([0, 0x2b2420]);
  });

  test('rides the rideable bike, its frame in the instance’s colour, its lamps lit', () => {
    const body = new MeshBuilder();
    addRiddenBike(body, false);
    const parts = new Set(facades(body));
    expect(parts.has(BIKE + TINT.frame)).toBe(true);
    expect(parts.has(PART.head) && parts.has(PART.tail)).toBe(true);
    // Wheels and crank on their bones, nothing from the figure.
    expect(parts.has(BIKE + 2) && parts.has(BIKE + 3) && parts.has(BIKE + 4)).toBe(true);
    expect([...parts].some((p) => p >= RIDER && p < BIKE)).toBe(false);
    // Halos round the lamp and the reflector, and a pool of light that fades out from the lamp.
    const floors = new Set([...parts].map(Math.floor));
    expect(floors.has(PART.halo) && floors.has(PART.haloTail)).toBe(true);
    const fades = new Set(
      [...parts]
        .filter((v) => Math.floor(v) === PART.beam)
        .map((v) => Math.round((1 - (v - PART.beam)) * 100)),
    );
    expect([...fades].toSorted((a, b) => a - b)).toEqual([2, 10, 30, 100]);
    const g = unindexed(body.build());
    g.computeBoundingBox();
    expect(g.boundingBox!.min.y).toBeGreaterThanOrEqual(0);
    expect(g.boundingBox!.max.x).toBeCloseTo(0.52 * CHARACTER_SCALE + 3.5, 1);
    // With its rider: one shape, under 1,700 triangles with its hull.
    const [whole, wholeHull] = [new MeshBuilder(), new MeshBuilder()];
    addRider(whole, false);
    addRider(wholeHull, true);
    expect(trianglesIn(whole) + trianglesIn(wholeHull)).toBeLessThan(1700);
    expect(trianglesIn(wholeHull)).toBeLessThan(trianglesIn(whole));
  });

  test('the vertex shader pedals: the legs about their joints, the wheels and the crank', () => {
    const out = riderVertexShader('#include <common>\n#include <begin_vertex>');
    expect(out).toContain('attribute vec4 state');
    expect(out).toContain(`part >= ${RIDER}.0`);
    expect(out.match(/turn\(transformed/g)!.length).toBeGreaterThanOrEqual(12);
    for (const c of PEDAL.knee) expect(out).toContain(c.toFixed(3));
    // The tints: each face's colour times the instance's.
    for (const name of ['shirt', 'shorts', 'skin', 'hair', 'frame']) {
      expect(TINT_GLSL).toContain(`vColor.rgb = ${name} * shade`);
    }
    // Pedalling bends the knee a lot, and the thigh comes up.
    expect(PEDAL.knee[0]).toBeGreaterThan(1);
    expect(PEDAL.thigh[0]).toBeLessThan(-0.5);
  });
});

/** A material's shaders and program key, as its `onBeforeCompile` leaves them. */
function compiled(m: InstancedMesh) {
  const shader = {
    uniforms: {},
    vertexShader:
      '#include <common>\n#include <begin_vertex>\n#include <color_vertex>\nvoid main() {}',
    fragmentShader:
      '#include <common>\n#include <clipping_planes_fragment>\n#include <emissivemap_fragment>',
  };
  const material = m.material as MeshBasicMaterial;
  material.onBeforeCompile(shader as never, undefined as never);
  return { shader, key: material.customProgramCacheKey() };
}

describe('createRiders', () => {
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
    bayer: 'float bayer4(vec2 p) { return 0.0; }',
    gradientMap: new DataTexture(new Uint8Array([255]), 1, 1),
    night: { value: 0 },
    ink: OUTLINE,
    xray: { color: 0x2f62a8 },
  };

  test('draws as many as ride, each where it is, dressed as asked', () => {
    const scene = new Scene();
    const riders = createRiders(kit, scene, 4);
    const [body, ink, xray] = riders.meshes as [InstancedMesh, InstancedMesh, InstancedMesh];
    expect(scene.children).toHaveLength(3);
    // The x-ray draws first, the body and its hull after: one matrix each, shared.
    expect(xray.renderOrder).toBeLessThan(body.renderOrder);
    expect(ink.instanceMatrix).toBe(body.instanceMatrix);
    expect(xray.instanceMatrix).toBe(body.instanceMatrix);
    // Nothing shows until someone rides.
    expect(riders.meshes.every((m) => !m.visible && m.count === 0)).toBe(true);
    riders.count = 2;
    expect(riders.count).toBe(2);
    expect(riders.meshes.every((m) => m.visible && m.count === 2)).toBe(true);
    riders.pose(1, {
      x: 10,
      y: 2,
      z: -5,
      heading: Math.PI / 2,
      lean: 0,
      pedal: 1.5,
      braking: true,
    });
    const at = new Matrix4();
    body.getMatrixAt(1, at);
    const p = new Vector3().setFromMatrixPosition(at);
    expect([p.x, p.z]).toEqual([10, -5]);
    expect(p.y).toBeGreaterThan(2);
    // Heading east (+x), the rider's frame (x ahead) points east too.
    const ahead = new Vector3(1, 0, 0).transformDirection(at);
    expect(ahead.x).toBeCloseTo(1);
    const state = body.geometry.getAttribute('state') as Attribute;
    expect([state.getX(1), state.getY(1)]).toEqual([1.5, 1]);
    riders.dress(1, {
      shirt: 0xff0000,
      shorts: 0x00ff00,
      skin: 0x0000ff,
      hair: 0,
      frame: 0xffffff,
    });
    const look = (name: string) => {
      const a = body.geometry.getAttribute(name) as Attribute;
      return [a.getX(1), a.getY(1), a.getZ(1)];
    };
    expect(look('shirt')).toEqual([1, 0, 0]);
    expect(look('shorts')).toEqual([0, 1, 0]);
    expect(look('skin')).toEqual([0, 0, 1]);
    expect(look('frame')).toEqual([1, 1, 1]);
    riders.count = 0;
    expect(riders.meshes.every((m) => !m.visible)).toBe(true);
    riders.dispose();
    expect(scene.children).toHaveLength(0);
  });

  test('its materials compile the pedalling, the tints and the lamps into their shaders', () => {
    const riders = createRiders(kit, new Scene(), 1);
    const [body, ink, xray] = riders.meshes as [InstancedMesh, InstancedMesh, InstancedMesh];
    const lit = compiled(body);
    expect(lit.shader.vertexShader).toContain('vColor.rgb = shirt * shade');
    expect(lit.shader.fragmentShader).toContain('totalEmissiveRadiance');
    expect(lit.shader.uniforms).toHaveProperty('uNight');
    expect(compiled(ink).shader.vertexShader).toContain('attribute vec4 state');
    expect(compiled(xray).shader.fragmentShader).toContain(`vPart < ${RIDER}.0`);
    expect(new Set([lit.key, compiled(ink).key, compiled(xray).key]).size).toBe(3);
    riders.dispose();
  });
});
