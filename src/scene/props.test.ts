import { expect, test } from 'bun:test';

import { PROP_KINDS } from '../data/city.ts';
import type { Prop, PropKind } from '../data/city.ts';
import { MeshBuilder } from './mesh-builder.ts';
import { propFootprint, propScale } from '../data/props.ts';
import { addProp } from './props.ts';

const prop = (kind: PropKind, over: Partial<Prop> = {}): Prop => ({
  kind,
  x: 10,
  z: -20,
  angle: 0,
  size: 0,
  ...over,
});

function built(...props: Prop[]) {
  const mesh = new MeshBuilder();
  for (const p of props) addProp(mesh, p);
  const g = mesh.build();
  g.computeBoundingBox();
  return { triangles: g.getAttribute('position').count / 3, box: g.boundingBox!, g };
}

test('every kind stands on the ground at its place, a few dozen triangles at most', () => {
  for (const kind of PROP_KINDS) {
    const size = { needle: 23, bikes: 6 }[kind as string] ?? 0;
    const { triangles, box } = built(prop(kind, { size }));
    expect(triangles).toBeGreaterThan(0);
    expect(triangles).toBeLessThanOrEqual(kind === 'bikes' ? 6 * 41 : 48);
    expect(box.min.y).toBeCloseTo(0);
    expect(box.max.y).toBeLessThan(kind === 'needle' ? 24 : 6);
    expect(Math.abs((box.min.x + box.max.x) / 2 - 10)).toBeLessThan(1);
    expect(Math.abs((box.min.z + box.max.z) / 2 + 20)).toBeLessThan(1);
  }
});

function span(p: Prop): [number, number] {
  const { box } = built(p);
  return [box.max.x - box.min.x, box.max.z - box.min.z];
}

test('a prop turns to its facing: a bench lies across it, a rack of bikes along it', () => {
  const [ex, ez] = span(prop('bench'));
  expect(ez).toBeGreaterThan(ex); // facing +x, the seat runs along z
  const [nx, nz] = span(prop('bench', { angle: Math.PI / 2 }));
  expect(nx).toBeGreaterThan(nz);
  const [bx, bz] = span(prop('bikes', { size: 12 }));
  expect(bz).toBeGreaterThan(bx); // a row of twelve along the kerb
});

test('a rack holds most of its stands, a big one in two rows', () => {
  const small = built(prop('bikes', { size: 4 })).triangles;
  const full = built(prop('bikes', { size: 12 })).triangles;
  const double = built(prop('bikes', { size: 24 }));
  expect(full).toBeGreaterThan(small);
  expect(full).toBeGreaterThanOrEqual(12 * 0.5 * 41); // 41 triangles a bike
  expect(double.box.max.x - double.box.min.x).toBeGreaterThan(2.5); // two rows deep
  // The same rack looks the same every time.
  expect(built(prop('bikes', { size: 12 })).triangles).toBe(full);
});

test('statues grow to their tagged height, the needle carries its beetle near the top', () => {
  expect(built(prop('statue', { size: 4.5 })).box.max.y).toBeCloseTo(4.5);
  expect(built(prop('statue')).box.max.y).toBeCloseTo(3.2 * propScale('statue'));
  const needle = built(prop('needle', { size: 23 }));
  expect(needle.box.max.y).toBeCloseTo(23);
  expect(needle.box.max.z - needle.box.min.z).toBeGreaterThan(2); // the beetle's width
});

test('faces point outward, so the toon shading lights the sunny side', () => {
  const { g } = built(prop('lamp'));
  const normals = g.getAttribute('normal');
  const ups = Array.from({ length: normals.count }, (_, i) => normals.getY(i));
  expect(Math.max(...ups)).toBeGreaterThan(0.9); // the lantern's lid
});

test('every model stays inside the footprint the bake keeps clear, below head height', () => {
  for (const kind of PROP_KINDS) {
    for (const size of kind === 'bikes' ? [2, 7, 12, 13, 24] : [0, 4]) {
      for (const angle of [0, 0.7, 2]) {
        const p = prop(kind, { size: kind === 'needle' ? 23 : size, angle });
        const f = propFootprint(p);
        const position = built(p).g.getAttribute('position');
        for (let i = 0; i < position.count; i++) {
          if (position.getY(i) > 2.5) continue; // lanterns, signs and roofs hang above it all
          const [dx, dz] = [position.getX(i) - f.x, position.getZ(i) - f.z];
          const [u, v] = [-dx * f.fz + dz * f.fx, dx * f.fx + dz * f.fz];
          expect([
            kind,
            u >= f.u0 - 1e-6 && u <= f.u1 + 1e-6,
            v >= f.v0 - 1e-6 && v <= f.v1 + 1e-6,
          ]).toEqual([kind, true, true]);
        }
      }
    }
  }
});

test('the sign of a bus stop stands across the kerb it faces', () => {
  const { box } = built(prop('busstop'));
  expect(box.max.x - box.min.x).toBeGreaterThan(box.max.z - box.min.z); // facing +x
});
