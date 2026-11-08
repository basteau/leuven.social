import { expect, test } from 'bun:test';

import type { Cell } from './cells.ts';
import { addGarden } from './gardens.ts';

const ring = (...p: number[]) => Float32Array.from(p);
const lawn = ring(0, 0, 100, 0, 100, 100, 0, 100);
const terrain = { height: () => 3 };

function cellWith(over: Partial<Cell['ground']> = {}, rest: Partial<Cell> = {}): Cell {
  return {
    buildings: [],
    trees: [],
    ground: {
      green: [lawn],
      water: [],
      roads: [],
      plazas: [],
      parking: [],
      bridges: [],
      carriageways: [],
      pitches: [],
      paths: [],
      ...over,
    },
    ...rest,
  } as unknown as Cell;
}

function grown(cell: Cell) {
  const [spots, colors]: [number[], number[]] = [[], []];
  addGarden(spots, colors, cell, terrain);
  return { spots, colors, count: spots.length / 4 };
}

test('a lawn grows shrubs and beds of flowers, on the ground, the same every time', () => {
  const { spots, colors, count } = grown(cellWith());
  expect(count).toBeGreaterThan(40);
  expect(colors.length).toBe(count * 4);
  for (let i = 0; i < count; i++) expect(spots[i * 4 + 1]!).toBeGreaterThan(3);
  expect(grown(cellWith()).spots).toEqual(spots);
});

test('nothing grows without a lawn, or on what is already there', () => {
  expect(grown(cellWith({ green: [] })).count).toBe(0);
  const paved = cellWith({ roads: [lawn] });
  expect(grown(paved).count).toBe(0);
  const flooded = cellWith({ water: [lawn] });
  expect(grown(flooded).count).toBe(0);
  const ball = cellWith({ pitches: [{ surface: 'grass', ring: lawn }] });
  expect(grown(ball).count).toBe(0);
  const street = cellWith({ carriageways: [{ kind: 'street', surface: 'asphalt', ring: lawn }] });
  expect(grown(street).count).toBe(0);
});

test('it keeps off houses, paths and trunks', () => {
  const house = ring(40, 40, 60, 40, 60, 60, 40, 60);
  const built = grown(cellWith({}, { buildings: [{ ring: house }] as Cell['buildings'] }));
  for (let i = 0; i < built.count; i++) {
    const [x, z] = [built.spots[i * 4]!, built.spots[i * 4 + 2]!];
    // A puff spreads a little from where its shrub stands.
    expect(x > 41 && x < 59 && z > 41 && z < 59).toBe(false);
  }
  const line = Float32Array.from([0, 50, 100, 50]);
  const walked = grown(
    cellWith({ paths: [{ width: 2, surface: 'gravel', line }] as Cell['ground']['paths'] }),
  );
  expect(walked.count).toBeGreaterThan(0);
  for (let i = 0; i < walked.count; i++) {
    expect(Math.abs(walked.spots[i * 4 + 2]! - 50)).toBeGreaterThan(0.5);
  }
  const tree = grown(cellWith({}, { trees: [50, 50, 1, 8] }));
  for (let i = 0; i < tree.count; i++) {
    expect(Math.hypot(tree.spots[i * 4]! - 50, tree.spots[i * 4 + 2]! - 50)).toBeGreaterThan(0.6);
  }
});
