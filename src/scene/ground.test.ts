import { expect, test } from 'bun:test';

import type { City } from '../data/city.ts';
import { SLAB_DEPTH, groundGeometry } from './ground.ts';

const square = new Float32Array([0, 0, 10, 0, 10, 10, 0, 10]);
const city: City = {
  bounds: { minX: -50, minZ: -50, maxX: 50, maxZ: 50 },
  labels: [],
  buildings: [],
  roads: [square],
  plazas: [square],
  green: [square],
  water: [square],
  trees: new Float32Array(),
};

test('the diorama is a slab plus one face-up layer per ground type', () => {
  const g = groundGeometry(city);
  // top + 4 sides = 10 triangles, then 2 per layer square.
  expect(g.getAttribute('position').count).toBe((10 + 4 * 2) * 3);
  g.computeBoundingBox();
  expect(g.boundingBox!.min.y).toBe(-SLAB_DEPTH);
  expect(g.boundingBox!.max.y).toBeCloseTo(0.2);
  const normals = g.getAttribute('normal');
  for (let i = 10 * 3; i < normals.count; i++) expect(normals.getY(i)).toBe(1);
});
