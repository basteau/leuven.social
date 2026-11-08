import { expect, test } from 'bun:test';

import type { Building, Prop } from '../data/city.ts';
import { CONTACT, addContacts } from './contact.ts';
import { MeshBuilder, unindexed } from './mesh-builder.ts';

const house = (ring: number[], tier = 'core') =>
  ({ ring: new Float32Array(ring), tier }) as unknown as Pick<Building, 'ring' | 'tier'>;
const square = [0, 0, 10, 0, 10, 10, 0, 10];
const ground = () => 2;

function built(buildings: Pick<Building, 'ring' | 'tier'>[], racks: Prop[] = []) {
  const mesh = new MeshBuilder();
  addContacts(mesh, buildings, racks, ground);
  return unindexed(mesh.build({ facade: true }));
}

test('every open wall has a band, dark at the wall and gone at its edge', () => {
  const g = built([house(square)]);
  const [p, f] = [g.getAttribute('position'), g.getAttribute('facade')];
  expect(p.count / 3).toBe(4 * 2);
  for (let i = 0; i < p.count; i++) {
    expect(p.getY(i)).toBeCloseTo(2 + CONTACT.lift);
    // On the wall the value is 1; out at the band's edge, 0, outside the house.
    const inside = p.getX(i) >= 0 && p.getX(i) <= 10 && p.getZ(i) >= 0 && p.getZ(i) <= 10;
    expect(f.getX(i)).toBe(inside ? 1 : 0);
  }
});

test('a wall shared with a neighbour has none, a short jog none, the fringe none', () => {
  const left = house(square);
  const right = house([10, 0, 20, 0, 20, 10, 10, 10]);
  expect(built([left, right]).getAttribute('position').count / 3).toBe(6 * 2);
  const jog = house([0, 0, 10, 0, 10, 11, 0.5, 11, 0.5, 10, 0, 10]);
  expect(built([jog]).getAttribute('position').count / 3).toBe(4 * 2);
  expect(built([house(square, 'fringe')]).getAttribute('position').count).toBe(0);
});

test('a rack has a patch of its own, about its size', () => {
  const rack = { kind: 'bikes', x: 5, z: 5, angle: 0, size: 12 } as unknown as Prop;
  const g = built([], [rack]);
  g.computeBoundingBox();
  expect(g.getAttribute('position').count / 3).toBe(10); // the middle, and its rim
  const [wide, deep] = [
    g.boundingBox!.max.z - g.boundingBox!.min.z,
    g.boundingBox!.max.x - g.boundingBox!.min.x,
  ];
  expect(wide).toBeGreaterThan(5);
  expect(deep).toBeGreaterThan(1);
});
