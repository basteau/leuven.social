import { expect, test } from 'bun:test';

import { PROP_KINDS, isMonument } from '../data/city.ts';
import type { Prop, PropKind } from '../data/city.ts';
import { monumentFromOsm, plinthOf } from '../data/monuments.ts';
import { MeshBuilder, unindexed } from './mesh-builder.ts';
import { propFootprint } from '../data/props.ts';
import { addProp, isLarge } from './props.ts';

/** Heights a monument of each kind is typically drawn at (m). */
const TYPICAL: Partial<Record<PropKind, number>> = {
  needle: 23,
  column: 6,
  stone: 1.4,
  bust: 2.4,
  fountain: 3.2,
  pump: 2.6,
};

/** A prop as the bake writes it: a monument with its kind's height, plinth and material. */
function prop(kind: PropKind, over: Partial<Prop> = {}): Prop {
  const p: Prop = { kind, x: 10, z: -20, angle: 0, size: 0, ...over };
  if (!isMonument(kind)) return p;
  const size = over.size || TYPICAL[kind] || 4;
  const [width, depth] = plinthOf(kind, size);
  return { width, depth, material: 'bronze', ...p, size };
}

function built(...props: Prop[]) {
  const mesh = new MeshBuilder();
  for (const p of props) addProp(mesh, p);
  const g = unindexed(mesh.build());
  g.computeBoundingBox();
  return { triangles: g.getAttribute('position').count / 3, box: g.boundingBox!, g };
}

test('every kind stands on the ground at its place, a few dozen triangles at most', () => {
  for (const kind of PROP_KINDS) {
    const { triangles, box } = built(prop(kind, { size: kind === 'bikes' ? 6 : 0 }));
    expect(triangles).toBeGreaterThan(0);
    // A group is a plinth and three figures; a statue a plinth and one.
    const most = { bikes: 6 * 41, group: 180, statue: 90, fountain: 90 }[kind as string] ?? 64;
    expect([kind, triangles <= most]).toEqual([kind, true]);
    expect(box.min.y).toBeCloseTo(0);
    expect(box.max.y).toBeLessThan(kind === 'needle' ? 24 : 7);
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

test('monuments grow to their height, the needle carries its beetle near the top', () => {
  expect(built(prop('statue', { size: 5.9 })).box.max.y).toBeCloseTo(5.9);
  // The raised arm of a figure reaches past its head.
  const poses = [0, 1, 2, 3].map((i) => built(prop('statue', { x: i / 7 })).box.max.y);
  expect(Math.max(...poses)).toBeGreaterThan(4);
  expect(Math.min(...poses)).toBeCloseTo(4);
  expect(built(prop('column', { size: 20 })).box.max.y).toBeCloseTo(20);
  const needle = built(prop('needle'));
  expect(needle.box.max.y).toBeCloseTo(23);
  expect(needle.box.max.z - needle.box.min.z).toBeGreaterThan(2); // the beetle's width
  // Tall ones join the cell's main mesh, to show at every zoom.
  expect([prop('needle'), prop('column', { size: 20 }), prop('column')].map(isLarge)).toEqual([
    true,
    true,
    false,
  ]);
});

test('each archetype reads its data: its material, its plinth, its kind of fountain', () => {
  const colours = (p: Prop) => {
    const c = built(p).g.getAttribute('color');
    return new Set(Array.from({ length: c.count }, (_, i) => c.getX(i)));
  };
  // Bronze on pale stone; marble on dark bluestone.
  expect(colours(prop('statue', { material: 'marble' }))).not.toEqual(colours(prop('statue')));
  // A fountain of water has a jet, one with a sculpture a figure (Fonske).
  const jet = built(prop('fountain', { material: 'water' }));
  const fonske = built(prop('fountain'));
  expect(fonske.triangles).toBeGreaterThan(jet.triangles);
  // A wide plinth takes three figures, a narrow one two.
  expect(built(prop('group', { width: 4 })).triangles).toBeGreaterThan(
    built(prop('group', { width: 2 })).triangles,
  );
  // Abstract sculpture comes in a few forms, picked by where it stands.
  const forms = new Set(
    [0, 1, 2, 3, 4, 5].map((i) => built(prop('sculpture', { x: i / 7 })).triangles),
  );
  expect(forms.size).toBeGreaterThanOrEqual(3);
  // A real monument, read from its tags, is drawn on its plinth.
  const lipsius = monumentFromOsm({ tourism: 'artwork', artwork_type: 'statue', _height: '5.9' })!;
  expect(built(prop('statue', lipsius)).box.max.y).toBeCloseTo(5.9);
});

test('faces point outward, so the toon shading lights the sunny side', () => {
  const { g } = built(prop('lamp'));
  const normals = g.getAttribute('normal');
  const ups = Array.from({ length: normals.count }, (_, i) => normals.getY(i));
  expect(Math.max(...ups)).toBeGreaterThan(0.9); // the lantern's lid
});

test('every model stays inside the footprint the bake keeps clear, below head height', () => {
  for (const kind of PROP_KINDS) {
    for (const size of kind === 'bikes' ? [2, 7, 12, 13, 24] : [0, 2.6, 4, 9]) {
      for (const angle of [0, 0.7, 2]) {
        const p = prop(kind, { size: kind === 'needle' ? 23 : size, angle, x: 10 + size / 7 });
        const f = propFootprint(p);
        const position = built(p).g.getAttribute('position');
        for (let i = 0; i < position.count; i++) {
          if (position.getY(i) > 2.5) continue; // lanterns, signs and roofs hang above it all
          const [dx, dz] = [position.getX(i) - f.x, position.getZ(i) - f.z];
          const [u, v] = [-dx * f.fz + dz * f.fx, dx * f.fx + dz * f.fz];
          expect([
            kind,
            u >= f.u0 - 1e-4 && u <= f.u1 + 1e-4, // a float32 position's rounding
            v >= f.v0 - 1e-4 && v <= f.v1 + 1e-4,
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
