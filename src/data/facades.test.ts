import { describe, expect, test } from 'bun:test';

import { Facades, footprintOf, frontWall, nearestOn, streetSegments } from './facades.ts';

const box = (x0: number, z0: number, x1: number, z1: number) =>
  new Float32Array([x0, z0, x1, z0, x1, z1, x0, z1]);

// Street A runs east along z = 0, street B south along x = 0; they cross at the origin.
// House 0 stands on the south-east corner, house 1 behind it, out of sight of street A.
const A = 0;
const B = 1;
const streets = [
  { name: A, line: new Float32Array([-50, 0, 50, 0]) },
  { name: B, line: new Float32Array([0, -50, 0, 50]) },
];
const rings = [box(5, 5, 15, 15), box(5, 20, 15, 30), box(-60, 10, -40, 20)];
const facades = new Facades(rings);
const segments = streetSegments(streets);
const square = [box(-40, 5, -20, 30)];
const nowhere = { square: [], open: () => false };

describe('Facades', () => {
  test('files each wall with its outward normal', () => {
    // A counter-clockwise box: its first wall runs east and faces north (-z).
    const [first] = facades.byBuilding[0]!;
    expect(facades.walls[first!]).toMatchObject({ building: 0, ax: 5, az: 5, ux: 1, length: 10 });
    expect(facades.walls[first!]!.nz).toBe(-1);
    expect(facades.byBuilding[0]).toHaveLength(4);
  });

  test('leaves out walls too short to front anything', () => {
    const tiny = new Facades([new Float32Array([0, 0, 0.5, 0, 0.5, 0.5, 0, 0.5])]);
    expect(tiny.walls).toHaveLength(0);
    expect(tiny.buildingAt(0.25, 0.25)).toBe(0);
  });

  test('knows which building a point is in', () => {
    expect(facades.buildingAt(10, 10)).toBe(0);
    expect(facades.buildingAt(10, 25)).toBe(1);
    expect(facades.buildingAt(10, 17)).toBe(-1);
  });

  test('finds the walls near a point', () => {
    const near = facades.near(10, 17, 3.5);
    expect(near.map((w) => facades.walls[w]!.building).toSorted()).toEqual([0, 1]);
    expect(facades.near(1000, 1000, 5)).toEqual([]);
  });

  test('projects onto a wall, within its ends', () => {
    const [north] = facades.byBuilding[0]!;
    expect(facades.project(north!, 8, -3)).toBe(3);
    expect(facades.project(north!, -20, 0)).toBe(0);
    expect(facades.along(north!, 3)).toEqual([8, 5]);
  });

  test('sees past open ground but not through a building', () => {
    expect(facades.clear(18, 4, 18, -10)).toBe(true);
    expect(facades.clear(10, 19, 10, -10)).toBe(false);
    expect(facades.clear(3, 3, 3, 3)).toBe(true);
  });
});

test('nearestOn finds the closest point of any segment', () => {
  const [x, z, d] = nearestOn(segments.get(A)!, 7, 3);
  expect(x).toBeCloseTo(7);
  expect([z, d]).toEqual([0, 3]);
  expect(nearestOn([], 1, 1)[2]).toBe(Infinity);
  // A segment of no length is its one point.
  expect(nearestOn([2, 2, 2, 2], 2, 5)).toEqual([2, 2, 3]);
});

test('streetSegments collects each street’s pieces under its name', () => {
  const more = streetSegments([...streets, { name: A, line: new Float32Array([50, 0, 60, 5]) }]);
  expect(more.get(A)).toEqual([-50, 0, 50, 0, 50, 0, 60, 5]);
  expect(more.get(B)).toHaveLength(4);
});

test('footprintOf takes the footprint a point is in, or the nearest just outside it', () => {
  expect(footprintOf(facades, 10, 10)).toBe(0);
  expect(footprintOf(facades, 16.5, 10)).toBe(0);
  expect(footprintOf(facades, 100, 100)).toBe(-1);
});

describe('frontWall', () => {
  test('takes the wall that faces its street, where the door meets it', () => {
    const front = frontWall(facades, 0, 9, 10, { segments: segments.get(A)!, ...nowhere });
    expect(front).toMatchObject({ px: 9, pz: 5, how: 'facing its street' });
    expect(facades.walls[front!.w]!.nz).toBe(-1);
  });

  test('picks the wall that faces the street it names, on a corner', () => {
    const front = frontWall(facades, 0, 10, 10, { segments: segments.get(B)!, ...nowhere });
    expect(front).toMatchObject({ px: 5, how: 'facing its street' });
  });

  test('keeps the point off the wall’s ends', () => {
    const front = frontWall(facades, 0, 20, 10, { segments: segments.get(A)!, ...nowhere });
    expect(front!.px).toBeCloseTo(14.5);
  });

  test('takes the wall onto its square', () => {
    const front = frontWall(facades, 2, -50, 15, { segments: [], square, open: () => false });
    expect(front).toMatchObject({ px: -40, how: 'facing its square' });
  });

  test('a house out of sight of its street opens onto public ground, or has no front', () => {
    const street = { segments: segments.get(A)!, square: [] };
    expect(frontWall(facades, 1, 10, 25, { ...street, open: () => false })).toBeNull();
    const lane = frontWall(facades, 1, 10, 25, { ...street, open: (x) => x < 5 });
    expect(lane).toMatchObject({ px: 5, how: 'onto public ground' });
  });
});
