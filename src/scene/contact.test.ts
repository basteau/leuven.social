import { expect, test } from 'bun:test';

import type { Building } from '../data/city.ts';
import { CONTACT, SHORE, addContacts, addShores } from './contact.ts';
import { MeshBuilder, unindexed } from './mesh-builder.ts';

const house = (ring: number[], tier = 'core') =>
  ({ ring: new Float32Array(ring), tier }) as unknown as Pick<Building, 'ring' | 'tier'>;
const square = [0, 0, 10, 0, 10, 10, 0, 10];
const ground = () => 2;

function built(buildings: Pick<Building, 'ring' | 'tier'>[]) {
  const mesh = new MeshBuilder();
  addContacts(mesh, buildings, ground);
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

test('a long wall is cut in pieces that follow the ground', () => {
  const long = house([0, 0, 40, 0, 40, 5, 0, 5]);
  const mesh = new MeshBuilder();
  addContacts(mesh, [long], (x) => Math.sin(x / 8) * 4);
  const g = unindexed(mesh.build({ facade: true }));
  // Two walls of 40 m in four pieces each, and two of 5 m whole.
  expect(g.getAttribute('position').count / 6).toBe(4 + 4 + 2);
});

test('a bank has a lip of stone and a shade on the water, but not where a cell cut the river', () => {
  const within = { minX: 0, minZ: 0, maxX: 20, maxZ: 20 };
  const river = new Float32Array([0, 5, 20, 5, 20, 15, 0, 15]);
  const [dark, stone] = [new MeshBuilder(), new MeshBuilder()];
  addShores(dark, stone, [river], within, () => 1);
  const [d, s] = [unindexed(dark.build({ facade: true })), unindexed(stone.build())];
  // The two long banks: the two ends lie along the cell's edge, so the water runs on.
  expect(s.getAttribute('position').count / 6).toBe(2);
  expect(d.getAttribute('position').count / 6).toBe(2);
  const p = s.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    expect(p.getY(i)).toBeCloseTo(1 + SHORE.y);
    expect(p.getZ(i)).toBeGreaterThanOrEqual(5 - 1e-6); // inside the water
    expect(p.getZ(i)).toBeLessThanOrEqual(15 + 1e-6);
  }
  // A ring wound the other way has the same banks on the same side.
  const reversed = new Float32Array([0, 15, 20, 15, 20, 5, 0, 5]);
  const again = new MeshBuilder();
  addShores(new MeshBuilder(), again, [reversed], within, () => 1);
  const q = unindexed(again.build()).getAttribute('position');
  for (let i = 0; i < q.count; i++) {
    expect(q.getZ(i)).toBeGreaterThanOrEqual(5 - 1e-6);
    expect(q.getZ(i)).toBeLessThanOrEqual(15 + 1e-6);
  }
});
