import { describe, expect, test } from 'bun:test';

import {
  Facades,
  centroid,
  junctions,
  nearestOn,
  placeHouseNumbers,
  placeStreetPlates,
  plateText,
  housePlateWidth,
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
  // Across street A from house 0: the corner's north side.
  box(5, -15, 15, -5),
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

test('a plate is as wide as its name or number needs', () => {
  expect(streetPlateWidth('Naamsestraat', 1)).toBeCloseTo(4.2);
  expect(streetPlateWidth('A', 2)).toBeGreaterThan(1);
  expect(housePlateWidth('1', 1)).toBe(1.45);
  expect(housePlateWidth('12–14', 1)).toBeCloseTo(2.36);
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

  test('hangs a number over its door, where OSM maps one in its front wall', () => {
    const doors = [
      { x: 12.5, z: 5.3, number: null },
      // Too far off the wall, too far along it, and on another wall.
      { x: 8, z: 7, number: null },
      { x: 14.9, z: 5, number: '4' },
      { x: 5, z: 9, number: null },
    ];
    const one = placeHouseNumbers([{ x: 9, z: 10, street: A, number: '3' }], facades, segments, {
      doors,
    });
    expect(one.plates[0]!.x).toBeCloseTo(12.5);
    expect(one.placed).toEqual({ 'facing its street': 1, 'over a mapped door': 1 });
    // A door that carries the number wins over a nearer one; each door takes one number.
    const two = placeHouseNumbers(
      [
        { x: 9, z: 10, street: A, number: '3' },
        { x: 9, z: 10, street: A, number: '4' },
        { x: 9, z: 10, street: A, number: '5' },
      ],
      facades,
      segments,
      { doors },
    );
    expect(two.plates.map((p) => Number(p.x.toFixed(2)))).toEqual([12.5, 14.5, 9]);
    // Out of reach along the wall, the door is not this number's.
    const far = placeHouseNumbers([{ x: 5.5, z: 10, street: A, number: '7' }], facades, segments, {
      doors: [{ x: 14, z: 5, number: null }],
    });
    expect(far.plates[0]!.x).toBeCloseTo(5.5);
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
        { x: 9, z: 10, street: A, number: '3C' },
        { x: 9, z: 10, street: A, number: '3D' },
        { x: 9, z: 10, street: A, number: ';' },
        { x: 100, z: 100, street: A, number: '4' },
        { x: 25, z: 10, street: A, number: '6' },
        { x: 10, z: 10, street: -1, number: '8' },
      ],
      facades,
      segments,
      { skip: new Set([2]) },
    );
    // 3B and 3C move along the wall to clear 3; 3D finds no room within a metre.
    expect(plates.map((p) => p.text)).toEqual(['3', '3B', '3C']);
    expect(plates[1]!.x).toBeCloseTo(9.7);
    expect(plates[2]!.x).toBeCloseTo(8.25);
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
    eaves: [10, 10, 10, 2.5, 8, 10],
    height: 0.4,
  };

  test('hangs plates for each street on the corners, facing it, from both sides', () => {
    const { plates, placed, skipped } = placeStreetPlates(input);
    const [a, across, b] = plates;
    expect(a).toMatchObject({ name: A });
    expect(a!.z).toBeCloseTo(5 - PROUD);
    expect(a!.x).toBeLessThan(7);
    expect(a!.angle).toBeCloseTo(-Math.PI / 2);
    // The same name on the house across the street, facing the other way.
    expect(across).toMatchObject({ name: A });
    expect(across!.z).toBeCloseTo(-5 + PROUD);
    expect(across!.angle).toBeCloseTo(Math.PI / 2);
    // B's west side has no house: one plate, on the corner house's west wall.
    expect(b).toMatchObject({ name: B });
    expect(b!.x).toBeCloseTo(5 - PROUD);
    expect(plates.filter((p) => p.name === B)).toHaveLength(1);
    // The square has no centre line, so no plate: there is no wall to say it faces.
    expect(skipped).toEqual({ 'no corner wall': 1 });
    expect(placed).toEqual({ 'at junctions': 3, 'along stretches': 1 });
  });

  test('hangs one along a long street without junctions', () => {
    const { plates } = placeStreetPlates(input);
    const long = plates.filter((p) => p.name === LONG);
    expect(long).toHaveLength(1);
    expect(long[0]!.z).toBeCloseTo(205 - PROUD);
  });

  test('a building lower than a storey takes no plate', () => {
    const low = placeStreetPlates({ ...input, eaves: [2.5, 2.5, 2.5, 2.5, 2.5, 2.5] });
    expect(low.plates).toHaveLength(0);
  });

  test('skips landmark buildings and repeats near the same junction', () => {
    const twice = placeStreetPlates({
      ...input,
      junctions: [input.junctions[0]!, { x: 3, z: -3, names: [A] }],
      skip: new Set([4]),
    });
    // Each side of A once, though two junctions are within a few metres.
    expect(twice.plates.filter((p) => p.name === A)).toHaveLength(2);
    expect(twice.placed['along stretches']).toBe(0);
  });
});
