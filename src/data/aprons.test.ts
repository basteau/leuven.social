import { expect, test } from 'bun:test';

import { wallAprons } from './aprons.ts';
import type { ApronTests } from './aprons.ts';

// A 10 m wall along z = 0, the building north of it (z < 0), the ground open to the south.
const ring = [0, 0, 0, -8, 10, -8, 10, 0];

const street = (edge: number, paved: 'road' | 'square' = 'road'): ApronTests => ({
  base: (_x, z) => z > 0 && z < edge,
  paved: (_x, z) => (z >= edge ? paved : null),
});

test('a gap between a wall and the road is paved over, under the wall and up to the road', () => {
  const [apron, ...rest] = wallAprons(ring, street(0.9));
  expect(rest).toEqual([]);
  expect(apron!.surface).toBe('road');
  const xs = apron!.ring.filter((_, i) => i % 2 === 0);
  const zs = apron!.ring.filter((_, i) => i % 2 === 1);
  expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
  expect(Math.max(...xs)).toBeLessThanOrEqual(10);
  expect(Math.min(...zs)).toBeLessThan(0);
  expect(Math.max(...zs)).toBeGreaterThan(0.9);
});

test('a wider gap is a front garden, on a road; on a square it is paved', () => {
  expect(wallAprons(ring, street(2.2))).toEqual([]);
  const [onSquare] = wallAprons(ring, street(2.2, 'square'));
  expect(onSquare!.surface).toBe('square');
  // Wider than anything: left alone.
  expect(wallAprons(ring, street(10, 'square'))).toEqual([]);
});

test('no gap, or a lawn in it, no strip', () => {
  // Paved right up to the wall.
  expect(wallAprons(ring, { base: () => false, paved: () => 'road' })).toEqual([]);
  // A garden starts at the wall: nothing to pave.
  expect(wallAprons(ring, { base: () => false, paved: () => null })).toEqual([]);
  // Open ground, then a garden before any road: left alone.
  const garden: ApronTests = {
    base: (_x, z) => z > 0 && z < 0.5,
    paved: (_x, z) => (z > 2 ? 'road' : null),
  };
  expect(wallAprons(ring, garden)).toEqual([]);
});

test('a wall too short to matter is passed over; a run of a wall gets one strip', () => {
  expect(wallAprons([0, 0, 0.5, 0, 0.5, -3, 0, -3], street(0.5))).toEqual([]);
  // A gap along half the wall only.
  const half: ApronTests = {
    base: (x, z) => x < 5 && z > 0 && z < 0.5,
    paved: (x, z) => (x < 5 && z >= 0.5 ? 'road' : null),
  };
  const [strip, ...rest] = wallAprons(ring, half);
  expect(rest).toEqual([]);
  expect(Math.max(...strip!.ring.filter((_, i) => i % 2 === 0))).toBeLessThan(6);
});
