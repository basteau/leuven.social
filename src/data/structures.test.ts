import { expect, test } from 'bun:test';

import { RingIndex } from './props.ts';
import { TANK_CORNERS, bridgeParapets, tankOutline } from './structures.ts';

// A river 10 m wide running along x, from z = 0 to z = 10.
const river = new RingIndex();
river.add([-100, 0, 100, 0, 100, 10, -100, 10]);

test('a bridge gets parapets on the sides that face the water, none on the banks', () => {
  // A deck 6 m wide crossing the river along z, from bank to bank (counter-clockwise).
  const deck = [-3, 0, 3, 0, 3, 10, -3, 10];
  const parapets = bridgeParapets(deck, river);
  expect(parapets).toHaveLength(2);
  // Each runs from bank to bank, along one side.
  for (const line of parapets) {
    expect(line).toHaveLength(4);
    expect(Math.abs(line[0]!)).toBe(3);
    expect(Math.abs(line[1]! - line[3]!)).toBe(10);
  }
});

test('a run of water-facing edges that wraps past the ring start stays one parapet', () => {
  // The same deck, but its first edge is halfway along a wet side.
  const deck = [-3, 5, -3, 0, 3, 0, 3, 10, -3, 10];
  const parapets = bridgeParapets(deck, river);
  expect(parapets).toHaveLength(2);
  expect(parapets.map((l) => l.length).toSorted()).toEqual([4, 6]);
});

test('a bridge over dry ground, a tiny sliver or one all at sea gets none', () => {
  expect(bridgeParapets([-3, 200, 3, 200, 3, 200, 3, 210, -3, 210], river)).toEqual([]);
  expect(bridgeParapets([0, 4, 1, 4, 1, 4.5, 0, 4.5], river)).toEqual([]);
  expect(bridgeParapets([-3, 2, 3, 2, 3, 8, -3, 8], river)).toEqual([]); // all wet
});

test('a round tank keeps a dozen corners, evenly spread; a small polygon keeps all', () => {
  const circle = Array.from({ length: 48 }, (_, i) => [
    Math.cos((i / 48) * Math.PI * 2) * 3,
    Math.sin((i / 48) * Math.PI * 2) * 3,
  ]).flat();
  const outline = tankOutline(circle);
  expect(outline).toHaveLength(TANK_CORNERS * 2);
  for (let i = 0; i < outline.length; i += 2) {
    expect(Math.hypot(outline[i]!, outline[i + 1]!)).toBeCloseTo(3);
  }
  expect(tankOutline([0, 0, 1, 0, 1, 1])).toEqual([0, 0, 1, 0, 1, 1]);
});
