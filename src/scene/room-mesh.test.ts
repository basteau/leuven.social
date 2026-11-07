import { describe, expect, test } from 'bun:test';

import { HALL } from '../data/rooms.fixture.ts';
import { PROP_SIZES } from '../data/rooms.ts';
import { corners } from './mesh-builder.ts';
import { LineBuilder, MeshBuilder } from './mesh-builder.ts';
import { addProp, addUnderfloor, addWall, buildDoor, buildFloor } from './room-mesh.ts';

/** The unit normals of a built mesh, one per vertex. */
function normals(mesh: MeshBuilder): [number, number, number][] {
  const n = mesh.build({ keep: true }).getAttribute('normal');
  return Array.from({ length: n.count }, (_, i) => [n.getX(i), n.getY(i), n.getZ(i)]);
}

describe('a room’s walls', () => {
  test('face into the room from inside: an outer wall shows the room its inner face', () => {
    // The hall's south wall runs along z 11.5; the room lies north of it (smaller z).
    const mesh = new MeshBuilder();
    addWall(mesh, new LineBuilder(), HALL.floors[0]!.walls[0]!, 5);
    const n = normals(mesh);
    expect(n.some(([x, y, z]) => z < -0.9 && Math.abs(x) < 0.1 && Math.abs(y) < 0.1)).toBe(true);
    expect(n.some(([, y]) => y > 0.9)).toBe(true); // its top
  });

  test('leave their doorways open', () => {
    const mesh = new MeshBuilder();
    const lines = new LineBuilder();
    addWall(mesh, lines, HALL.floors[0]!.walls[0]!, 5);
    const position = mesh.build({ keep: true }).getAttribute('position');
    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i);
      expect(x <= 0.5 + 8.3 + 1e-6 || x >= 0.5 + 10.7 - 1e-6).toBe(true);
    }
    // Two pieces, each a box: ten faces.
    expect(mesh.indices).toBe(2 * 6 * 6 - 2 * 6);
    const none = new MeshBuilder();
    addWall(none, lines, { x0: 1, z0: 1, x1: 1, z1: 1, gaps: [] }, 5);
    expect(none.indices).toBe(0);
  });

  test('a balustrade stands its own height', () => {
    const mesh = new MeshBuilder();
    addWall(mesh, new LineBuilder(), HALL.floors[1]!.walls[0]!, 3);
    const position = mesh.build({ keep: true }).getAttribute('position');
    let top = 0;
    for (let i = 0; i < position.count; i++) top = Math.max(top, position.getY(i));
    expect(top).toBeCloseTo(1);
  });
});

test('every furnishing is drawn, at the height the grid gives it', () => {
  for (const kind of [...Object.keys(PROP_SIZES), 'thing']) {
    const mesh = new MeshBuilder();
    addProp(mesh, new LineBuilder(), { kind, x: 0, z: 0, angle: 0.3 }, 6);
    const position = mesh.build({ keep: true }).getAttribute('position');
    let top = 0;
    for (let i = 0; i < position.count; i++) top = Math.max(top, position.getY(i));
    const tall = PROP_SIZES[kind]?.[2] || (kind === 'thing' ? 1 : 6);
    expect(top).toBeGreaterThanOrEqual(tall - 0.01);
    expect(top).toBeLessThan(tall + 0.2);
  }
});

describe('a floor', () => {
  test('is its slab, walls, furnishings and stairs, at its height, in a couple of thousand triangles', () => {
    const { mesh, lines } = buildFloor(HALL, HALL.floors[0]!, 2);
    const geometry = mesh.build({ keep: true });
    expect(corners(geometry) / 3).toBeGreaterThan(50);
    expect(corners(geometry) / 3).toBeLessThan(2500);
    expect(lines.segments).toBeGreaterThan(10);
    expect(geometry.boundingBox!.min.y).toBeCloseTo(2);
    // The stair climbs to the gallery, 4 m up.
    expect(geometry.boundingBox!.max.y).toBeCloseTo(2 + 5, 0);
  });

  test('an upper floor stands at its level, its slab edged round its hole', () => {
    const { mesh } = buildFloor(HALL, HALL.floors[1]!, 0);
    const geometry = mesh.build({ keep: true });
    expect(geometry.boundingBox!.min.y).toBeCloseTo(4 - 0.35);
    const n = normals(mesh);
    // The hole's edges face into it, the slab's out of it: both ways along z.
    expect(n.some(([, , z]) => z > 0.9)).toBe(true);
    expect(n.some(([, , z]) => z < -0.9)).toBe(true);
  });
});

test('the door is a dark arch on the outside of the wall, facing the street', () => {
  const mesh = buildDoor(HALL, 0);
  const n = normals(mesh);
  // The hall's door faces in toward -z; its arch faces out, toward +z.
  expect(n.every(([, , z]) => z > 0.9)).toBe(true);
  expect(mesh.indices).toBe(7 * 3);
});

test('under the room, the whole footprint is floored, facing up', () => {
  const mesh = new MeshBuilder();
  addUnderfloor(mesh, [0, 0, 20, 0, 20, 12, 0, 12], 1.5);
  const geometry = mesh.build({ keep: true });
  expect(mesh.indices).toBe(6);
  expect(geometry.boundingBox!.max.y).toBeCloseTo(1.5);
  expect(normals(mesh).every(([, y]) => y > 0.9)).toBe(true);
});
