import { expect, test } from 'bun:test';

import type { Cell } from './cells.ts';
import { addGarden } from './gardens.ts';

const ring = (...p: number[]) => Float32Array.from(p);
const lot = ring(0, 0, 100, 0, 100, 100, 0, 100);
const terrain = { height: () => 3 };

function cellWith(over: Partial<Cell['ground']> = {}, rest: Partial<Cell> = {}): Cell {
  return {
    buildings: [],
    trees: [],
    hedges: [],
    ground: {
      woods: [],
      flowerbeds: [],
      water: [],
      roads: [],
      plazas: [],
      parking: [],
      bridges: [],
      decks: [],
      ramps: [],
      tunnels: [],
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

test('only what is mapped grows: nothing on a plain lawn, the same every time where it is', () => {
  expect(grown(cellWith()).count).toBe(0);
  const { spots, colors, count } = grown(cellWith({ woods: [lot] }));
  expect(count).toBeGreaterThan(40);
  expect(colors.length).toBe(count * 4);
  for (let i = 0; i < count; i++) expect(spots[i * 4 + 1]!).toBeGreaterThan(3);
  expect(grown(cellWith({ woods: [lot] })).spots).toEqual(spots);
});

test('shrubs keep off what is already there', () => {
  for (const over of [
    { roads: [lot] },
    { water: [lot] },
    { pitches: [{ surface: 'grass', ring: lot }] },
    { carriageways: [{ kind: 'street', surface: 'asphalt', ring: lot }] },
  ] as Partial<Cell['ground']>[]) {
    expect(grown(cellWith({ woods: [lot], ...over })).count).toBe(0);
  }
  const house = ring(40, 40, 60, 40, 60, 60, 40, 60);
  const built = grown(
    cellWith({ woods: [lot] }, { buildings: [{ ring: house }] as Cell['buildings'] }),
  );
  for (let i = 0; i < built.count; i++) {
    const [x, z] = [built.spots[i * 4]!, built.spots[i * 4 + 2]!];
    // A puff spreads a little from where its shrub stands.
    expect(x > 41.5 && x < 58.5 && z > 41.5 && z < 58.5).toBe(false);
  }
  const line = Float32Array.from([0, 50, 100, 50]);
  const walked = grown(
    cellWith({
      woods: [lot],
      paths: [{ width: 2, surface: 'gravel', line }] as Cell['ground']['paths'],
    }),
  );
  expect(walked.count).toBeGreaterThan(0);
  for (let i = 0; i < walked.count; i++) {
    expect(Math.abs(walked.spots[i * 4 + 2]! - 50)).toBeGreaterThan(0.5);
  }
  const tree = grown(cellWith({ woods: [lot] }, { trees: [50, 50, 1, 8, 0] }));
  for (let i = 0; i < tree.count; i++) {
    expect(Math.hypot(tree.spots[i * 4]! - 50, tree.spots[i * 4 + 2]! - 50)).toBeGreaterThan(0.6);
  }
});

test('a hedge grows along its line', () => {
  const whole = grown(cellWith({}, { hedges: [Float32Array.from([0, 10, 20, 10])] }));
  expect(whole.count).toBeGreaterThan(16);
  for (let i = 0; i < whole.count; i++) {
    expect(whole.spots[i * 4 + 2]).toBeCloseTo(10);
    expect(whole.spots[i * 4 + 1]!).toBeGreaterThan(3.5);
  }
});

test('a flower bed is planted, in its own colour or two', () => {
  const bed = ring(0, 0, 8, 0, 8, 8, 0, 8);
  const { count, colors } = grown(cellWith({ flowerbeds: [bed] }));
  expect(count).toBeGreaterThan(10);
  const shades = new Set(
    Array.from({ length: count }, (_, i) => colors.slice(i * 4, i * 4 + 3).join()),
  );
  expect(shades.size).toBeLessThanOrEqual(2);
});
