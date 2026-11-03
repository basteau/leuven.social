import { describe, expect, test } from 'bun:test';

import {
  AXLE,
  BIKES,
  BIKE_BONES,
  BIKE_MOST,
  LOOK,
  PARTS,
  STEERING,
  WHEEL,
  bakeBike,
  bikeArrays,
  bonePivot,
} from './bike-rig.ts';
import type { BikeArrays } from './bike-rig.ts';
import { BIKES as PALETTE_BIKES, OUTLINE, PROPS } from './palette.ts';
import { LOOK as PROPS_LOOK } from './props.ts';

const looks = [
  0,
  LOOK.step,
  LOOK.carrier,
  LOOK.crate,
  LOOK.step | LOOK.carrier | (5 * LOOK.colour),
];
const triangles = (a: BikeArrays) => a.index.length / 3;

const has = (a: BikeArrays, hex: number) => {
  for (let i = 0; i < a.color.length; i += 3) {
    const c =
      (Math.round(a.color[i]! * 255) << 16) |
      (Math.round(a.color[i + 1]! * 255) << 8) |
      Math.round(a.color[i + 2]! * 255);
    if (c === hex) return true;
  }
  return false;
};

const empty = (): BikeArrays => ({
  position: new Float32Array(BIKE_MOST.vertices * 6),
  normal: new Float32Array(BIKE_MOST.vertices * 6),
  color: new Float32Array(BIKE_MOST.vertices * 6),
  bone: new Uint8Array(BIKE_MOST.vertices * 2),
  dither: new Uint8Array(BIKE_MOST.vertices * 2),
  hull: new Uint8Array(BIKE_MOST.vertices * 2),
  index: new Uint16Array(BIKE_MOST.indices * 2),
});

describe('the rideable bike', () => {
  test('is at most 800 triangles in any look, ink and shadow included', () => {
    for (const look of [...looks, LOOK.basket]) {
      expect(triangles(bikeArrays(look))).toBeLessThanOrEqual(800);
      expect(triangles(bikeArrays(look))).toBeGreaterThan(650);
    }
    const most = Math.max(...[...looks, LOOK.basket].map((look) => triangles(bikeArrays(look))));
    expect(BIKE_MOST.indices / 3).toBe(most);
  });

  test('is richer than a parked one: spokes, a chain, mudguards, a lamp, a bell, a reflector', () => {
    const a = bikeArrays(0);
    expect(has(a, PROPS.lantern)).toBe(true); // the lamp's lens
    expect(has(a, PROPS.spokes)).toBe(true); // spokes, hubs and the bell
    // Spokes on each wheel: thin beams through its axle, turning with it.
    for (const wheel of ['front', 'rear'] as const) {
      const b = BIKE_BONES.indexOf(wheel);
      const [, y, z] = bonePivot(b);
      let spokes = 0;
      for (let v = 0; v < a.bone.length; v++) {
        const at = [a.position[v * 3 + 1]! - y, a.position[v * 3 + 2]! - z];
        if (
          a.bone[v] === b &&
          Math.hypot(at[0]!, at[1]!) > WHEEL - 0.06 &&
          Math.hypot(at[0]!, at[1]!) < WHEEL - 0.04
        )
          spokes++;
      }
      expect(spokes).toBeGreaterThanOrEqual(12 * 4); // twelve spoke ends, four corners each
    }
    // A carrier stands on stays, and a basket hangs on the bars, turning with them.
    expect(triangles(bikeArrays(LOOK.carrier))).toBeGreaterThan(triangles(a) + 30);
    const basket = bikeArrays(LOOK.basket);
    expect(has(basket, PROPS.crateInside)).toBe(true);
    const steer = BIKE_BONES.indexOf('steer');
    let high = 0;
    for (let v = 0; v < basket.bone.length; v++)
      if (basket.bone[v] === steer) high = Math.max(high, basket.position[v * 3 + 1]!);
    expect(high).toBeGreaterThan(1.02);
  });

  test('wears the look and colours the racks use', () => {
    expect(JSON.stringify(LOOK)).toBe(JSON.stringify(PROPS_LOOK));
    expect([...BIKES]).toEqual([...PALETTE_BIKES]);
    expect(PARTS.tyre).toBe(PROPS.wheel);
    expect(PARTS.spokes).toBe(PROPS.spokes);
    expect(PARTS.iron).toBe(PROPS.iron);
    expect(PARTS.crate).toBe(PROPS.crate);
    expect(PARTS.crateInside).toBe(PROPS.crateInside);
    expect(PARTS.lantern).toBe(PROPS.lantern);
    expect(PARTS.leather).toBe(PROPS.wood);
    expect(PARTS.ink).toBe(OUTLINE);
    const red = bikeArrays(2 * LOOK.colour);
    expect(has(red, BIKES[2])).toBe(true);
    expect(has(bikeArrays(LOOK.crate), PROPS.crateInside)).toBe(true);
    expect(has(bikeArrays(0), PROPS.crateInside)).toBe(false);
  });

  test('every part hangs on one of its seven bones, and only the shadow dithers', () => {
    const a = bikeArrays(LOOK.carrier);
    expect(BIKE_BONES).toHaveLength(7);
    const used = new Set(a.bone);
    for (let b = 0; b < 7; b++) expect(used.has(b)).toBe(true);
    let shadow = 0;
    for (let v = 0; v < a.dither.length; v++) {
      if (a.dither[v]) {
        shadow++;
        expect(a.position[v * 3 + 1]).toBeCloseTo(0.02);
      }
    }
    expect(shadow).toBe(8);
  });

  test('stands on its wheels: nothing but the shadow below the tyres, the wheels about their axles', () => {
    const a = bikeArrays(0);
    let low = Infinity;
    for (let v = 0; v < a.bone.length; v++)
      if (!a.dither[v]) low = Math.min(low, a.position[v * 3 + 1]!);
    expect(low).toBeGreaterThan(-0.06);
    expect(low).toBeLessThan(0.02);
    expect(bonePivot(BIKE_BONES.indexOf('front'))).toEqual([0, WHEEL, AXLE]);
    expect(bonePivot(BIKE_BONES.indexOf('rear'))).toEqual([0, WHEEL, -AXLE]);
    expect(bonePivot(BIKE_BONES.indexOf('steer'))[2]).toBe(STEERING);
  });

  test('faces face out, and their normals are unit length', () => {
    const a = bikeArrays(LOOK.crate);
    for (let v = 0; v < a.bone.length; v++) {
      const n = a.normal.subarray(v * 3, v * 3 + 3);
      expect(Math.hypot(n[0]!, n[1]!, n[2]!)).toBeCloseTo(1);
    }
    // Each triangle's winding agrees with its normal: it faces the way it is lit.
    for (let t = 0; t < a.index.length; t += 3) {
      const [i, j, k] = [a.index[t]!, a.index[t + 1]!, a.index[t + 2]!];
      const p = (n: number) => [a.position[n * 3]!, a.position[n * 3 + 1]!, a.position[n * 3 + 2]!];
      const [A, B, C] = [p(i), p(j), p(k)];
      const u = B.map((x, m) => x - A[m]!);
      const w = C.map((x, m) => x - A[m]!);
      const n = [
        u[1]! * w[2]! - u[2]! * w[1]!,
        u[2]! * w[0]! - u[0]! * w[2]!,
        u[0]! * w[1]! - u[1]! * w[0]!,
      ];
      const face = a.normal.subarray(i * 3, i * 3 + 3);
      expect(n[0]! * face[0]! + n[1]! * face[1]! + n[2]! * face[2]!).toBeGreaterThanOrEqual(-1e-12);
    }
  });
});

describe('a bike left on its stand', () => {
  test('bakes where it stands, scaled, turned and leaning, two bikes into one mesh', () => {
    const into = empty();
    const at = { vertices: 0, indices: 0 };
    const stand = { x: 10, y: 2, z: -5, heading: Math.PI / 2, lean: 0.1, steer: 0.4, look: 0 };
    bakeBike(stand, 1.3, into, at);
    const first = { ...at };
    bakeBike({ ...stand, x: 20, look: LOOK.carrier }, 1.3, into, at);
    expect(at.vertices).toBe(first.vertices + BIKE_MOST.vertices);
    expect(into.index[first.indices]).toBeGreaterThanOrEqual(first.vertices);
    expect(Math.max(...into.bone)).toBe(0);
    // Heading east, the bike runs along x: its wheels 1.43 m apart, about its middle.
    let [minX, maxX, minY, maxY] = [Infinity, -Infinity, Infinity, -Infinity];
    for (let v = 0; v < first.vertices; v++) {
      if (into.dither[v]) continue;
      minX = Math.min(minX, into.position[v * 3]!);
      maxX = Math.max(maxX, into.position[v * 3]!);
      minY = Math.min(minY, into.position[v * 3 + 1]!);
      maxY = Math.max(maxY, into.position[v * 3 + 1]!);
    }
    expect((minX + maxX) / 2).toBeCloseTo(10, 0);
    expect(maxX - minX).toBeGreaterThan(2 * (AXLE + WHEEL) * 1.3 * 0.9);
    expect(minY).toBeGreaterThan(2 - 0.1);
    expect(maxY).toBeLessThan(2 + 1.1 * 1.3 + 0.1);
    for (let v = 0; v < at.vertices; v++) {
      const n = into.normal.subarray(v * 3, v * 3 + 3);
      expect(Math.hypot(n[0]!, n[1]!, n[2]!)).toBeCloseTo(1);
    }
  });
});
