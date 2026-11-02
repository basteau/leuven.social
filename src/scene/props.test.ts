import { expect, test } from 'bun:test';

import { PROP_KINDS, isMonument } from '../data/city.ts';
import type { Prop, PropKind } from '../data/city.ts';
import { monumentFromOsm, plinthOf } from '../data/monuments.ts';
import { MeshBuilder, unindexed } from './mesh-builder.ts';
import { BIKE_SHIFT, STAND_SPACING, propFootprint, propSeed } from '../data/props.ts';
import {
  LOOK,
  PARKED,
  STEER,
  YAW,
  addBike,
  addProp,
  handlebar,
  isLarge,
  parkedBike,
  rackSlots,
} from './props.ts';

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
    const { triangles, box } = built(prop(kind, kind === 'bikes' ? { size: 6, fill: 1 } : {}));
    expect(triangles).toBeGreaterThan(0);
    // A group is a plinth and three figures; a statue a plinth and one; a rack its rail and bikes.
    const most = { bikes: 12 + 6 * 88, group: 180, statue: 90, fountain: 90 }[kind as string] ?? 64;
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
  const [bx, bz] = span(prop('bikes', { size: 12, fill: 1 }));
  expect(bz).toBeGreaterThan(bx); // a row of twelve along the kerb
});

/** A rack's bikes, as `buildFurniture` notes them: one row of `PARKED` each. */
function parked(p: Prop) {
  const mesh = new MeshBuilder();
  const notes: number[] = [];
  addProp(mesh, p, notes);
  const bikes = Array.from({ length: notes.length / PARKED.stride }, (_, i) =>
    notes.slice(i * PARKED.stride, (i + 1) * PARKED.stride),
  );
  return { mesh, bikes };
}

test('a rack holds its fill of bikes in a run, every other one turned round, on its rails', () => {
  const rails = (size: number) => built(prop('bikes', { size })).triangles;
  expect(rails(6)).toBe(12); // an empty rack is still a rack: a rail on two legs
  expect(rails(24)).toBe(24); // two rows
  const p = prop('bikes', { size: 12, fill: 5 / 12 });
  const { bikes } = parked(p);
  expect(bikes).toHaveLength(5);
  // Parked side by side from a random stand, a gap now and then, not sprinkled.
  const slots = rackSlots(p, propSeed(p.x, p.z));
  const gaps = slots.slice(1).map((s, i) => (s - slots[i]! + 12) % 12);
  expect(Math.max(...gaps)).toBeLessThanOrEqual(2);
  // Neighbours face opposite ways, each a few degrees off square.
  const facing = bikes.map((b) => Math.cos(b[PARKED.heading]! - p.angle));
  for (const [i, c] of facing.entries()) {
    expect(Math.abs(c)).toBeGreaterThan(Math.cos(YAW) - 1e-6);
    expect(Math.sign(c)).toBe(slots[i]! % 2 ? -1 : 1);
  }
  // A full rack fills every stand; the same rack looks the same every time.
  expect(new Set(rackSlots({ ...p, fill: 1 }, 3)).size).toBe(12);
  expect(parked(p).bikes).toEqual(bikes);
  const double = built(prop('bikes', { size: 24, fill: 1 }));
  expect(double.box.max.x - double.box.min.x).toBeGreaterThan(2.5); // two rows deep
});

const rangeTriangles = (b: number[]) => (b[PARKED.to]! - b[PARKED.from]!) / 3;

function bikeTriangles(look: number): number {
  const mesh = new MeshBuilder();
  addBike(mesh, { x: 0, z: 0, fx: 1, fz: 0, scale: 1 }, 0.2, look);
  return mesh.indices / 3;
}

test('a bike is 78 triangles plain, 84 with a carrier, 88 with a crate or a basket', () => {
  expect(
    [0, LOOK.carrier, LOOK.crate, LOOK.basket, LOOK.crate | LOOK.carrier].map(bikeTriangles),
  ).toEqual([78, 84, 88, 88, 88]);
  expect(bikeTriangles(LOOK.step | (6 * LOOK.colour))).toBe(78);
  // In the city's racks, at most 88 and about 83 on average, every look among them.
  const { mesh, bikes } = parked(prop('bikes', { size: 24, fill: 1, x: 3.7 }));
  expect(Math.max(...bikes.map(rangeTriangles))).toBeLessThanOrEqual(88);
  expect(bikes.at(-1)![PARKED.to]).toBe(mesh.indices);
  // Each one notes where it stands and how it looks, in a byte.
  expect(bikes.every((b) => b[PARKED.y] === 0 && b[PARKED.look]! < 128)).toBe(true);
  expect(new Set(bikes.map((b) => b[PARKED.x])).size).toBe(24);
  let [sum, n] = [0, 0];
  const looks = new Set<number>();
  for (let x = 0; x < 40; x++) {
    for (const b of parked(prop('bikes', { size: 24, fill: 1, x: x * 3.1 })).bikes) {
      [sum, n] = [sum + rangeTriangles(b), n + 1];
      looks.add(b[PARKED.look]! % LOOK.colour);
    }
  }
  expect(sum / n).toBeGreaterThan(81);
  expect(sum / n).toBeLessThan(86);
  for (const part of [LOOK.carrier, LOOK.crate, LOOK.basket])
    expect([...looks].some((look) => look & part)).toBe(true);
});

test('its wheels are round, spoked inside a ring of tyre, and touch the ground', () => {
  const mesh = new MeshBuilder();
  addBike(mesh, { x: 0, z: 0, fx: 1, fz: 0, scale: 1 }, 0, 0);
  const g = unindexed(mesh.build());
  const [p, c] = [g.getAttribute('position'), g.getAttribute('color')];
  const tyre = new Set<string>();
  let reach = 0;
  for (let i = 0; i < p.count; i++) {
    const [x, y] = [p.getX(i), p.getY(i)];
    // The rear wheel, round its axle at x -0.55, 0.34 up.
    const r = Math.hypot(x + 0.55, y - 0.34);
    if (r > 0.35 || Math.abs(p.getZ(i)) > 0.02) continue;
    const pale = c.getX(i) > 0.5;
    if (pale) reach = Math.max(reach, r);
    else if (r > 0.33) tyre.add(`${x.toFixed(3)},${y.toFixed(3)}`);
  }
  expect(tyre.size).toBe(8); // an octagon
  expect(reach).toBeGreaterThan(0.2); // spokes most of the way out, the tyre showing round them
  expect(reach).toBeLessThan(0.3);
  expect(Math.min(...Array.from({ length: p.count }, (_, i) => p.getY(i)))).toBeCloseTo(0, 6);
});

test('every look of bike, however it is parked, stays inside its rack footprint', () => {
  const p = prop('bikes', { size: 2, angle: 0.4 });
  const f = propFootprint(p);
  const s = f.u1 - f.u0; // for a frame scale
  expect(s).toBeGreaterThan(0);
  for (let look = 0; look < LOOK.colour; look++) {
    for (const flip of [0, Math.PI]) {
      for (const yaw of [-YAW, 0, YAW]) {
        for (const steer of [-STEER, -STEER / 2, 0, STEER / 2, STEER]) {
          for (const shift of [-BIKE_SHIFT, BIKE_SHIFT]) {
            // The end bike of the rack, at its first stand.
            const [u, v] = [-STAND_SPACING / 2, shift];
            const turn = p.angle + yaw + flip;
            const mesh = new MeshBuilder();
            const scale = 1.3;
            addBike(
              mesh,
              {
                x: f.x + (-f.fz * u + f.fx * v) * scale,
                z: f.z + (f.fx * u + f.fz * v) * scale,
                fx: Math.cos(turn),
                fz: Math.sin(turn),
                scale,
              },
              steer,
              look,
            );
            const position = mesh.build().getAttribute('position');
            for (let i = 0; i < position.count; i++) {
              const [dx, dz] = [position.getX(i) - f.x, position.getZ(i) - f.z];
              const [pu, pv] = [-dx * f.fz + dz * f.fx, dx * f.fx + dz * f.fz];
              expect([look, pu >= f.u0 - 1e-4, pv >= f.v0 - 1e-4, pv <= f.v1 + 1e-4]).toEqual([
                look,
                true,
                true,
                true,
              ]);
            }
          }
        }
      }
    }
  }
});

/** Whether two convex polygons (x, z) overlap: no gap along any of their edges' normals. */
function overlap(a: [number, number][], b: [number, number][]): boolean {
  for (const poly of [a, b]) {
    for (const [i, [x0, z0]] of poly.entries()) {
      const [x1, z1] = poly[(i + 1) % poly.length]!;
      const [nx, nz] = [z0 - z1, x1 - x0];
      const pa = a.map(([x, z]) => x * nx + z * nz);
      const pb = b.map(([x, z]) => x * nx + z * nz);
      if (Math.max(...pa) < Math.min(...pb) || Math.max(...pb) < Math.min(...pa)) return false;
    }
  }
  return true;
}

test('no two bikes in a rack lock handlebars, however full', () => {
  expect(
    overlap(
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ],
      [
        [0.5, 0.5],
        [2, 0.5],
        [2, 2],
        [0.5, 2],
      ],
    ),
  ).toBe(true);
  for (const size of [2, 6, 12, 13, 24]) {
    for (const [i, angle] of [0, 0.7, 2].entries()) {
      const p = prop('bikes', { size, angle, fill: 1, x: 10 + i / 3 + size / 7 });
      const seed = propSeed(p.x, p.z);
      const bars = rackSlots(p, seed).map((slot) => {
        const { f, steer } = parkedBike(p, slot, seed);
        return handlebar(f, steer);
      });
      for (let a = 0; a < bars.length; a++) {
        for (let b = a + 1; b < bars.length; b++) {
          expect([size, a, b, overlap(bars[a]!, bars[b]!)]).toEqual([size, a, b, false]);
        }
      }
    }
  }
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
        const over = { angle, x: 10 + size / 7, fill: kind === 'bikes' ? 1 : undefined };
        const p = prop(kind, { ...over, size: kind === 'needle' ? 23 : size });
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
