import { describe, expect, test } from 'bun:test';

import {
  Facades,
  centroid,
  junctions,
  nearestOn,
  placeHouseNumbers,
  placeStreetPlates,
  plateText,
  streetPlateWidth,
  streetSegments,
} from './plate-placement.ts';
import { PROUD } from './plates.ts';

const box = (x0: number, z0: number, x1: number, z1: number) =>
  new Float32Array([x0, z0, x1, z0, x1, z1, x0, z1]);

// Street A runs east along z = 0, street B south along x = 0; they cross at the origin.
// House 0 stands on the south-east corner, house 1 behind it, out of sight of street A.
const A = 0;
const B = 1;
const SQUARE = 2;
const LONG = 3;
const streets = [
  { name: A, line: new Float32Array([-50, 0, 50, 0]) },
  { name: B, line: new Float32Array([0, -50, 0, 50]) },
  { name: LONG, line: new Float32Array([0, 200, 400, 200]) },
];
const rings = [
  box(5, 5, 15, 15),
  box(5, 20, 15, 30),
  // A landmark, a house on a square, and one along a long street with no junction.
  box(20, 5, 30, 15),
  box(-60, 10, -40, 20),
  box(290, 205, 310, 215),
];
const facades = new Facades(rings);
const segments = streetSegments(streets);
const square = new Map([[SQUARE, [box(-40, 5, -20, 30)]]]);

describe('plateText', () => {
  test('keeps a plain number', () => {
    expect(plateText('12')).toBe('12');
    expect(plateText('12A')).toBe('12A');
    expect(plateText(' Blok 1 ')).toBe('Blok 1');
  });

  test('shows a list of numbers as the range from first to last', () => {
    expect(plateText('80;82;84')).toBe('80–84');
    expect(plateText('5,7')).toBe('5–7');
    expect(plateText('34;34A-34O')).toBe('34–34O');
  });

  test('gives a range an en dash', () => {
    expect(plateText('3-5')).toBe('3–5');
    expect(plateText('3 - 5')).toBe('3–5');
  });

  test('refuses an empty or overlong number', () => {
    expect(plateText(' ; ')).toBeNull();
    expect(plateText('123456789')).toBeNull();
  });
});

test('a street plate is as wide as its name needs', () => {
  expect(streetPlateWidth('Naamsestraat', 1)).toBeCloseTo(4.2);
  expect(streetPlateWidth('A', 2)).toBeGreaterThan(1);
});

describe('Facades', () => {
  test('files each wall with its outward normal', () => {
    // A counter-clockwise box: its first wall runs east and faces north (-z).
    const [first] = facades.byBuilding[0]!;
    expect(facades.walls[first!]).toMatchObject({ building: 0, ax: 5, az: 5, ux: 1, length: 10 });
    expect(facades.walls[first!]!.nz).toBe(-1);
    expect(facades.byBuilding[0]).toHaveLength(4);
  });

  test('leaves out walls too short for a plate', () => {
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
    expect(facades.clear(10, 4, 10, -10)).toBe(true);
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

test('centroid is the middle of an area, or of the points of a line', () => {
  expect(centroid([0, 0, 4, 0, 4, 2, 0, 2])).toEqual([2, 1]);
  expect(centroid([0, 0, 2, 2, 4, 4])).toEqual([2, 2]);
});

describe('placeHouseNumbers', () => {
  const around = {
    squares: square,
    open: (x: number) => x < 5,
    skip: new Set([2]),
  };

  test('hangs a number on the wall that faces its street', () => {
    const { plates, placed } = placeHouseNumbers(
      [{ x: 9, z: 10, street: A, number: '3' }],
      facades,
      segments,
    );
    expect(placed).toEqual({ 'facing its street': 1 });
    const [plate] = plates;
    expect(plate!.text).toBe('3');
    // Where the address meets the north wall, just proud of it, facing north.
    expect(plate!.x).toBeCloseTo(9);
    expect(plate!.z).toBeCloseTo(5 - PROUD);
    expect(plate!.angle).toBeCloseTo(-Math.PI / 2);
  });

  test('picks the wall that faces the street it names, on a corner', () => {
    const { plates } = placeHouseNumbers(
      [{ x: 10, z: 10, street: B, number: '1' }],
      facades,
      segments,
    );
    expect(plates[0]!.x).toBeCloseTo(5 - PROUD);
    expect(Math.abs(plates[0]!.angle)).toBeCloseTo(Math.PI);
  });

  test('takes the nearest footprint for an address just outside one', () => {
    const { plates } = placeHouseNumbers(
      [{ x: 16.5, z: 10, street: A, number: '5' }],
      facades,
      segments,
    );
    expect(plates[0]!.x).toBeCloseTo(14.5);
    expect(plates[0]!.z).toBeCloseTo(5 - PROUD);
  });

  test('hangs a number on its square', () => {
    const { plates, placed } = placeHouseNumbers(
      [{ x: -50, z: 15, street: SQUARE, number: '7' }],
      facades,
      segments,
      around,
    );
    expect(placed).toEqual({ 'facing its square': 1 });
    expect(plates[0]!.x).toBeCloseTo(-40 + PROUD);
    expect(plates[0]!.angle).toBeCloseTo(0);
  });

  test('a house out of sight of its street opens onto public ground', () => {
    const address = [{ x: 10, z: 25, street: A, number: '9' }];
    expect(placeHouseNumbers(address, facades, segments).skipped).toEqual({
      'no wall facing the street': 1,
    });
    const { plates, placed } = placeHouseNumbers(address, facades, segments, around);
    expect(placed).toEqual({ 'onto public ground': 1 });
    expect(plates[0]!.x).toBeCloseTo(5 - PROUD);
  });

  test('says why it left an address out', () => {
    const { plates, skipped } = placeHouseNumbers(
      [
        { x: 9, z: 10, street: A, number: '3' },
        { x: 9, z: 10, street: A, number: '3' },
        { x: 9.2, z: 10, street: A, number: '3B' },
        { x: 9, z: 10, street: A, number: ';' },
        { x: 100, z: 100, street: A, number: '4' },
        { x: 25, z: 10, street: A, number: '6' },
        { x: 10, z: 10, street: -1, number: '8' },
      ],
      facades,
      segments,
      { skip: new Set([2]) },
    );
    expect(plates.map((p) => p.text)).toEqual(['3']);
    expect(skipped).toEqual({
      duplicate: 1,
      crowded: 1,
      'unreadable number': 1,
      'no footprint': 1,
      landmark: 1,
      'no wall facing the street': 1,
    });
  });
});

describe('junctions', () => {
  test('finds where streets of different names share a node, merged nearby', () => {
    const found = junctions([
      { name: A, line: [-50, 0, 0, 0] },
      { name: A, line: [0, 0, 10, 0, 50, 0] },
      { name: B, line: [0, -50, 0, 0, 0, 50] },
      { name: SQUARE, line: [10, 0, 10, -30] },
      { name: LONG, line: [0, 200, 400, 200] },
    ]);
    expect(found).toEqual([{ x: 0, z: 0, names: [A, B, SQUARE] }]);
  });

  test('a street meeting only itself is no junction', () => {
    expect(junctions([{ name: A, line: [0, 0, 5, 0, 0, 0] }])).toEqual([]);
  });
});

describe('placeStreetPlates', () => {
  const names = ['A street', 'B street', 'C', 'Long street'];
  const input = {
    junctions: [{ x: 0, z: 0, names: [A, B, SQUARE] }],
    facades,
    streets: segments,
    lines: streets,
    names,
    eaves: [10, 10, 10, 2.5, 8],
    height: 0.4,
  };

  test('hangs one plate for each street on the corner, facing it', () => {
    const { plates, placed, skipped } = placeStreetPlates(input);
    const [a, b] = plates;
    expect(a).toMatchObject({ name: A, y: 3 });
    expect(a!.z).toBeCloseTo(5 - PROUD);
    expect(a!.x).toBeLessThan(7);
    expect(a!.angle).toBeCloseTo(-Math.PI / 2);
    expect(b).toMatchObject({ name: B });
    expect(b!.x).toBeCloseTo(5 - PROUD);
    // The square has no centre line, so no plate: there is no wall to say it faces.
    expect(skipped).toEqual({ 'no corner wall': 1 });
    expect(placed).toEqual({ 'at junctions': 2, 'along stretches': 1 });
  });

  test('hangs one along a long street without junctions', () => {
    const { plates } = placeStreetPlates(input);
    const long = plates.filter((p) => p.name === LONG);
    expect(long).toHaveLength(1);
    expect(long[0]!.z).toBeCloseTo(205 - PROUD);
    expect(long[0]!.y).toBe(3);
  });

  test('a plate hangs under a low eave, or not at all', () => {
    const low = placeStreetPlates({ ...input, eaves: [0.5, 0.5, 0.5, 0.5, 0.5] });
    expect(low.plates).toHaveLength(0);
    const under = placeStreetPlates({ ...input, eaves: [3.2, 3.2, 3.2, 3.2, 3.2] });
    expect(under.plates[0]!.y).toBeCloseTo(2.7);
  });

  test('skips landmark buildings and repeats near the same junction', () => {
    const twice = placeStreetPlates({
      ...input,
      junctions: [input.junctions[0]!, { x: 3, z: -3, names: [A] }],
      skip: new Set([4]),
    });
    expect(twice.plates.filter((p) => p.name === A)).toHaveLength(1);
    expect(twice.placed['along stretches']).toBe(0);
  });
});
